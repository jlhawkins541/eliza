/**
 * Data hooks for the crypto terminal: the polled live market list, one asset's
 * price history, and the per-browser paper ledger and watchlist.
 *
 * It also owns the persisted HUNT / SLEEP / OFF operating mode, price alerts,
 * the PIN lock with its idle auto-lock, the on-demand Solana token safety
 * and LunarCrush social signal lookups, and the client side of real trades (readiness, review, execute),
 * which the server gates and signs; nothing here holds or sees a key.
 *
 * Market reads go through the authenticated app client to the plugin's
 * read-only `/api/wallet/terminal/*` routes. Loading, error, and ready are
 * distinct states; a failed refresh keeps the last list visible but marks it
 * so the view never presents stale prices as live. Paper state persists via
 * the shell's sanctioned `shellLocalStorage` channel under `eliza:wallet:`.
 */
import { client } from "@elizaos/ui/api";
import { shellLocalStorage } from "@elizaos/ui/bridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WalletExchangeOrder,
  WalletTerminalChartDays,
  WalletTerminalChartResponse,
  WalletTerminalExchangeOrdersResponse,
  WalletTerminalExchangeReview,
  WalletTerminalExchangeReviewRequest,
  WalletTerminalExchangeStatusResponse,
  WalletTerminalMarketsResponse,
  WalletTerminalSocialSignalResponse,
  WalletTerminalTokenPairsResponse,
  WalletTerminalTokenSafetyResponse,
  WalletTerminalTradeExecuteResponse,
  WalletTerminalTradeReview,
  WalletTerminalTradeReviewRequest,
  WalletTerminalTradeStatusResponse,
} from "../../contracts.ts";
import {
  changeOperatingMode,
  type OperatingModeState,
  parseOperatingModeState,
  type TerminalOperatingMode,
} from "./operating-mode.ts";
import {
  type PaperLedger,
  type ParsedPaperLedger,
  parsePaperLedger,
  settleOpenPaperOrders,
} from "./paper-ledger.ts";
import {
  type AutoLockMinutes,
  checkPin,
  createPinLock,
  isValidPin,
  type PinLockRecord,
  parsePinLock,
} from "./pin-lock.ts";
import {
  addPriceAlert,
  checkPriceAlerts,
  type PriceAlert,
  type PriceAlertInput,
  type PriceAlertRejection,
  type PriceAlertState,
  parsePriceAlerts,
  removePriceAlert,
} from "./price-alerts.ts";

export const TERMINAL_MARKETS_POLL_MS = 60_000;
export const PAPER_LEDGER_STORAGE_KEY = "eliza:wallet:paper-terminal:v1";
export const WATCHLIST_STORAGE_KEY = "eliza:wallet:terminal-watchlist:v1";
export const OPERATING_MODE_STORAGE_KEY = "eliza:wallet:terminal-mode:v1";
export const PRICE_ALERTS_STORAGE_KEY = "eliza:wallet:terminal-alerts:v1";
export const PIN_LOCK_STORAGE_KEY = "eliza:wallet:terminal-pin:v1";
/** Everything "Reset terminal" erases from this browser. */
export const TERMINAL_STORAGE_KEYS = [
  PAPER_LEDGER_STORAGE_KEY,
  WATCHLIST_STORAGE_KEY,
  OPERATING_MODE_STORAGE_KEY,
  PRICE_ALERTS_STORAGE_KEY,
  PIN_LOCK_STORAGE_KEY,
] as const;
/** How often the idle auto-lock compares the last activity to the limit. */
export const PIN_IDLE_CHECK_MS = 10_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];
const DEFAULT_WATCHLIST = ["bitcoin", "ethereum", "solana"];

export type RemoteState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T; refreshError: string | null };

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Request failed";
}

/** Market list state; `idle` means nothing was requested yet (mode OFF). */
export type TerminalMarketsState =
  | RemoteState<WalletTerminalMarketsResponse>
  | { status: "idle" };

/**
 * The live market list. With `autoRefresh` it loads at once and polls; without
 * it (mode OFF) it makes no request until `refresh` is called.
 */
export function useTerminalMarkets(autoRefresh: boolean): {
  state: TerminalMarketsState;
  refresh: () => void;
} {
  const [state, setState] = useState<TerminalMarketsState>(
    autoRefresh ? { status: "loading" } : { status: "idle" },
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setState((previous) =>
      previous.status === "idle" || previous.status === "error"
        ? { status: "loading" }
        : previous,
    );
    client
      .fetch<WalletTerminalMarketsResponse>("/api/wallet/terminal/markets")
      .then((data) => {
        if (mounted.current)
          setState({ status: "ready", data, refreshError: null });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the view renders a distinct unavailable state.
        if (!mounted.current) return;
        const message = describeError(error);
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, refreshError: message }
            : { status: "error", message },
        );
      });
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    refresh();
    const timer = setInterval(refresh, TERMINAL_MARKETS_POLL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  return { state, refresh };
}

export function useTerminalChart(
  assetId: string,
  days: WalletTerminalChartDays,
): RemoteState<WalletTerminalChartResponse> {
  const [state, setState] = useState<RemoteState<WalletTerminalChartResponse>>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const query = new URLSearchParams({ id: assetId, days: String(days) });
    client
      .fetch<WalletTerminalChartResponse>(
        `/api/wallet/terminal/chart?${query.toString()}`,
      )
      .then((data) => {
        if (active) setState({ status: "ready", data, refreshError: null });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the chart renders a distinct unavailable state.
        if (active)
          setState({ status: "error", message: describeError(error) });
      });
    return () => {
      active = false;
    };
  }, [assetId, days]);

  return state;
}

function readStorage(key: string): string | null {
  return typeof window === "undefined"
    ? null
    : window.localStorage.getItem(key);
}

export interface PaperLedgerState {
  ledger: PaperLedger;
  /** Set when stored practice history could not be read. */
  loadError: string | null;
  update: (next: PaperLedger) => void;
  reset: () => void;
}

export function usePaperLedger(
  livePrices: ReadonlyMap<string, number> | null,
): PaperLedgerState {
  const initial = useMemo<ParsedPaperLedger>(
    () => parsePaperLedger(readStorage(PAPER_LEDGER_STORAGE_KEY)),
    [],
  );
  const [ledger, setLedger] = useState<PaperLedger>(initial.ledger);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  const update = useCallback((next: PaperLedger) => {
    setLedger(next);
    setLoadError(null);
    shellLocalStorage.setItem(PAPER_LEDGER_STORAGE_KEY, JSON.stringify(next));
  }, []);

  const reset = useCallback(() => {
    update(parsePaperLedger(null).ledger);
  }, [update]);

  useEffect(() => {
    if (!livePrices) return;
    const settled = settleOpenPaperOrders(
      ledgerRef.current,
      livePrices,
      Date.now(),
    );
    if (settled.filled.length > 0) update(settled.ledger);
  }, [livePrices, update]);

  return { ledger, loadError, update, reset };
}

function parseWatchlist(raw: string | null): string[] {
  if (raw === null) return DEFAULT_WATCHLIST;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? value
      : DEFAULT_WATCHLIST;
  } catch {
    // error-policy:J3 an unreadable watchlist is a per-browser convenience;
    // fall back to the documented defaults rather than failing the view.
    return DEFAULT_WATCHLIST;
  }
}

export function useWatchlist(): {
  ids: ReadonlySet<string>;
  toggle: (assetId: string) => void;
} {
  const [ids, setIds] = useState<string[]>(() =>
    parseWatchlist(readStorage(WATCHLIST_STORAGE_KEY)),
  );
  const toggle = useCallback((assetId: string) => {
    setIds((current) => {
      const next = current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId];
      shellLocalStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return { ids: useMemo(() => new Set(ids), [ids]), toggle };
}

export interface OperatingModeHandle extends OperatingModeState {
  /** Set when the stored mode could not be read and SLEEP was restored. */
  loadError: string | null;
  change: (to: TerminalOperatingMode) => void;
}

export function useOperatingMode(): OperatingModeHandle {
  const initial = useMemo(
    () => parseOperatingModeState(readStorage(OPERATING_MODE_STORAGE_KEY)),
    [],
  );
  const [state, setState] = useState<OperatingModeState>(initial.state);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const change = useCallback((to: TerminalOperatingMode) => {
    setState((current) => {
      const next = changeOperatingMode(current, to, Date.now());
      if (next !== current) {
        shellLocalStorage.setItem(
          OPERATING_MODE_STORAGE_KEY,
          JSON.stringify(next),
        );
      }
      return next;
    });
    setLoadError(null);
  }, []);
  return { ...state, loadError, change };
}

export type TokenSafetyState =
  | { status: "idle" }
  | { status: "loading"; mint: string }
  | { status: "error"; mint: string; message: string }
  | { status: "ready"; data: WalletTerminalTokenSafetyResponse };

/** On-demand GoPlus safety report for one Solana mint. */
export function useTokenSafety(): {
  state: TokenSafetyState;
  check: (mint: string) => void;
} {
  const [state, setState] = useState<TokenSafetyState>({ status: "idle" });
  const latest = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback((mint: string) => {
    latest.current = mint;
    setState({ status: "loading", mint });
    const query = new URLSearchParams({ mint });
    client
      .fetch<WalletTerminalTokenSafetyResponse>(
        `/api/wallet/terminal/token-safety?${query.toString()}`,
      )
      .then((data) => {
        if (mounted.current && latest.current === mint)
          setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the panel renders a distinct unavailable state.
        if (mounted.current && latest.current === mint)
          setState({ status: "error", mint, message: describeError(error) });
      });
  }, []);

  return { state, check };
}

export type SocialSignalState =
  | { status: "idle" }
  | { status: "loading"; symbol: string }
  | { status: "error"; symbol: string; message: string }
  | { status: "ready"; data: WalletTerminalSocialSignalResponse };

/** On-demand LunarCrush social signal for one ticker; the key stays server-side. */
export function useSocialSignal(): {
  state: SocialSignalState;
  check: (symbol: string) => void;
  clear: () => void;
} {
  const [state, setState] = useState<SocialSignalState>({ status: "idle" });
  const latest = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback((symbol: string) => {
    latest.current = symbol;
    setState({ status: "loading", symbol });
    const query = new URLSearchParams({ symbol });
    client
      .fetch<WalletTerminalSocialSignalResponse>(
        `/api/wallet/terminal/social?${query.toString()}`,
      )
      .then((data) => {
        if (mounted.current && latest.current === symbol)
          setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the Social row renders a distinct unavailable state.
        if (mounted.current && latest.current === symbol)
          setState({ status: "error", symbol, message: describeError(error) });
      });
  }, []);

  const clear = useCallback(() => {
    latest.current = null;
    setState({ status: "idle" });
  }, []);

  return { state, check, clear };
}

export type TokenPairsState =
  | { status: "idle" }
  | { status: "loading"; mint: string }
  | { status: "error"; mint: string; message: string }
  | { status: "ready"; data: WalletTerminalTokenPairsResponse };

/** On-demand DexScreener liquidity for one Solana mint. */
export function useTokenPairs(): {
  state: TokenPairsState;
  check: (mint: string) => void;
  clear: () => void;
} {
  const [state, setState] = useState<TokenPairsState>({ status: "idle" });
  const latest = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback((mint: string) => {
    latest.current = mint;
    setState({ status: "loading", mint });
    const query = new URLSearchParams({ mint });
    client
      .fetch<WalletTerminalTokenPairsResponse>(
        `/api/wallet/terminal/pairs?${query.toString()}`,
      )
      .then((data) => {
        if (mounted.current && latest.current === mint)
          setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the Liquidity row renders a distinct unavailable state.
        if (mounted.current && latest.current === mint)
          setState({ status: "error", mint, message: describeError(error) });
      });
  }, []);

  const clear = useCallback(() => {
    latest.current = null;
    setState({ status: "idle" });
  }, []);

  return { state, check, clear };
}

export interface PriceAlertsHandle {
  alerts: PriceAlert[];
  /** Alerts fired since the terminal opened, newest first, until dismissed. */
  fired: PriceAlert[];
  /** Set when stored alerts could not be read and an empty list was started. */
  loadError: string | null;
  add: (input: PriceAlertInput) => PriceAlertRejection | null;
  remove: (id: string) => void;
  dismiss: (id: string) => void;
}

/** Persisted price alerts, checked against each new live price list while `active`. */
export function usePriceAlerts(
  livePrices: ReadonlyMap<string, number> | null,
  active: boolean,
): PriceAlertsHandle {
  const initial = useMemo(
    () => parsePriceAlerts(readStorage(PRICE_ALERTS_STORAGE_KEY)),
    [],
  );
  const [state, setState] = useState<PriceAlertState>(initial.state);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const [fired, setFired] = useState<PriceAlert[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: PriceAlertState) => {
    stateRef.current = next;
    setState(next);
    setLoadError(null);
    shellLocalStorage.setItem(PRICE_ALERTS_STORAGE_KEY, JSON.stringify(next));
  }, []);

  useEffect(() => {
    if (!active || !livePrices) return;
    const checked = checkPriceAlerts(stateRef.current, livePrices, Date.now());
    if (checked.triggered.length === 0) return;
    commit(checked.state);
    setFired((current) => [...checked.triggered, ...current]);
  }, [livePrices, active, commit]);

  const add = useCallback(
    (input: PriceAlertInput): PriceAlertRejection | null => {
      const result = addPriceAlert(
        stateRef.current,
        input,
        `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        Date.now(),
      );
      if (!result.ok) return result.reason;
      commit(result.state);
      return null;
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => {
      commit(removePriceAlert(stateRef.current, id));
      setFired((current) => current.filter((alert) => alert.id !== id));
    },
    [commit],
  );

  const dismiss = useCallback((id: string) => {
    setFired((current) => current.filter((alert) => alert.id !== id));
  }, []);

  return { alerts: state.alerts, fired, loadError, add, remove, dismiss };
}

export type PinLockOutcome =
  | { status: "ok" }
  | { status: "wrong"; attemptsLeft: number }
  | { status: "cooling-down"; retryAt: number }
  | { status: "invalid-pin" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface PinLockHandle {
  /** `none` means no PIN is set; otherwise the PIN guards the terminal. */
  status: "none" | "locked" | "unlocked";
  autoLockMinutes: AutoLockMinutes | null;
  /** Set when the stored lock could not be read; only a reset opens the terminal. */
  loadError: string | null;
  /** Changes on every reset so the terminal remounts from empty storage. */
  generation: number;
  unlock: (pin: string) => Promise<PinLockOutcome>;
  lock: () => void;
  /** Set the first PIN. */
  setPin: (
    pin: string,
    autoLockMinutes: AutoLockMinutes,
  ) => Promise<PinLockOutcome>;
  /** Change the auto-lock time and, when `newPin` is given, the PIN. */
  changeLock: (
    currentPin: string,
    newPin: string | null,
    autoLockMinutes: AutoLockMinutes,
  ) => Promise<PinLockOutcome>;
  removePin: (currentPin: string) => Promise<PinLockOutcome>;
  /** Erase the PIN and every saved terminal record in this browser. */
  resetTerminal: () => void;
}

async function guardCrypto<T>(
  run: () => Promise<T>,
): Promise<T | { status: "error"; message: string }> {
  try {
    return await run();
  } catch (error) {
    // error-policy:J4 a Web Crypto failure becomes a visible error state and
    // never counts as a correct PIN.
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The terminal's PIN lock. A saved PIN starts the terminal locked, and an
 * unlocked terminal locks again after its auto-lock time without pointer or
 * key activity. An unreadable saved lock fails closed: the terminal stays
 * locked and only a reset opens it.
 */
export function usePinLock(): PinLockHandle {
  const initial = useMemo(
    () => parsePinLock(readStorage(PIN_LOCK_STORAGE_KEY)),
    [],
  );
  const [record, setRecord] = useState<PinLockRecord | null>(initial.record);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const [locked, setLocked] = useState(initial.status !== "empty");
  const [generation, setGeneration] = useState(0);
  const recordRef = useRef(record);
  recordRef.current = record;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const persist = useCallback((next: PinLockRecord | null) => {
    recordRef.current = next;
    setRecord(next);
    if (next) {
      shellLocalStorage.setItem(PIN_LOCK_STORAGE_KEY, JSON.stringify(next));
    } else {
      shellLocalStorage.removeItem(PIN_LOCK_STORAGE_KEY);
    }
  }, []);

  const verify = useCallback(
    async (pin: string): Promise<PinLockOutcome> => {
      const current = recordRef.current;
      if (!current) return { status: "unavailable" };
      const checked = await guardCrypto(() =>
        checkPin(current, pin, Date.now()),
      );
      if ("message" in checked) return checked;
      if (checked.status === "unavailable") return checked;
      persist(checked.record);
      if (checked.status === "ok") return { status: "ok" };
      if (checked.status === "wrong") {
        return { status: "wrong", attemptsLeft: checked.attemptsLeft };
      }
      return { status: "cooling-down", retryAt: checked.retryAt };
    },
    [persist],
  );

  const store = useCallback(
    async (
      pin: string,
      autoLockMinutes: AutoLockMinutes,
    ): Promise<PinLockOutcome> => {
      const created = await guardCrypto(() =>
        createPinLock(pin, autoLockMinutes),
      );
      if ("message" in created) return created;
      if (!created.ok) return { status: created.reason };
      persist(created.record);
      return { status: "ok" };
    },
    [persist],
  );

  const unlock = useCallback(
    async (pin: string): Promise<PinLockOutcome> => {
      const outcome = await verify(pin);
      if (outcome.status === "ok") setLocked(false);
      return outcome;
    },
    [verify],
  );

  const lock = useCallback(() => {
    if (recordRef.current) setLocked(true);
  }, []);

  const setPin = useCallback(
    async (
      pin: string,
      autoLockMinutes: AutoLockMinutes,
    ): Promise<PinLockOutcome> => {
      if (recordRef.current || lockedRef.current)
        return { status: "unavailable" };
      if (!isValidPin(pin)) return { status: "invalid-pin" };
      return store(pin, autoLockMinutes);
    },
    [store],
  );

  const changeLock = useCallback(
    async (
      currentPin: string,
      newPin: string | null,
      autoLockMinutes: AutoLockMinutes,
    ): Promise<PinLockOutcome> => {
      if (lockedRef.current) return { status: "unavailable" };
      if (newPin !== null && !isValidPin(newPin)) {
        return { status: "invalid-pin" };
      }
      const verified = await verify(currentPin);
      if (verified.status !== "ok") return verified;
      if (newPin !== null) return store(newPin, autoLockMinutes);
      const current = recordRef.current;
      if (current) persist({ ...current, autoLockMinutes });
      return { status: "ok" };
    },
    [persist, store, verify],
  );

  const removePin = useCallback(
    async (currentPin: string): Promise<PinLockOutcome> => {
      if (lockedRef.current) return { status: "unavailable" };
      const verified = await verify(currentPin);
      if (verified.status === "ok") persist(null);
      return verified;
    },
    [persist, verify],
  );

  const resetTerminal = useCallback(() => {
    for (const key of TERMINAL_STORAGE_KEYS) shellLocalStorage.removeItem(key);
    recordRef.current = null;
    setRecord(null);
    setLoadError(null);
    setLocked(false);
    setGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    if (locked || !record || typeof window === "undefined") return;
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, touch, { passive: true });
    }
    const limitMs = record.autoLockMinutes * 60_000;
    const timer = setInterval(() => {
      if (Date.now() - lastActivity >= limitMs) setLocked(true);
    }, PIN_IDLE_CHECK_MS);
    return () => {
      clearInterval(timer);
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, touch);
      }
    };
  }, [locked, record]);

  return {
    status: locked ? "locked" : record ? "unlocked" : "none",
    autoLockMinutes: record?.autoLockMinutes ?? null,
    loadError,
    generation,
    unlock,
    lock,
    setPin,
    changeLock,
    removePin,
    resetTerminal,
  };
}

export type RealTradingState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: WalletTerminalTradeStatusResponse };

export type RealTradeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface RealTradingHandle {
  state: RealTradingState;
  refresh: () => void;
  /** Let a person trade with the local wallet (`manual-local-key`), then reload. */
  enable: () => Promise<RealTradeOutcome<null>>;
  review: (
    request: WalletTerminalTradeReviewRequest,
  ) => Promise<RealTradeOutcome<WalletTerminalTradeReview>>;
  execute: (
    reviewId: string,
  ) => Promise<RealTradeOutcome<WalletTerminalTradeExecuteResponse>>;
}

async function attempt<T>(run: () => Promise<T>): Promise<RealTradeOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    // error-policy:J4 the trade panel shows the server's refusal as an error.
    return { ok: false, message: describeError(error) };
  }
}

/** Real-trade readiness plus review and execute calls for the Real trade tab. */
export function useRealTrading(): RealTradingHandle {
  const [state, setState] = useState<RealTradingState>({ status: "loading" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<RealTradingState> => {
    const next = await attempt(() =>
      client.fetch<WalletTerminalTradeStatusResponse>(
        "/api/wallet/terminal/trade/status",
      ),
    );
    const loaded: RealTradingState = next.ok
      ? { status: "ready", data: next.value }
      : { status: "error", message: next.message };
    if (mounted.current) setState(loaded);
    return loaded;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  const enable = useCallback(async (): Promise<RealTradeOutcome<null>> => {
    const changed = await attempt(() =>
      client.setTradePermissionMode("manual-local-key"),
    );
    if (!changed.ok) return changed;
    const loaded = await load();
    if (loaded.status === "error")
      return { ok: false, message: loaded.message };
    if (loaded.status === "ready" && !loaded.data.realTradingEnabled) {
      return {
        ok: false,
        message: "The trade permission did not change. Try again.",
      };
    }
    return { ok: true, value: null };
  }, [load]);

  const review = useCallback(
    (request: WalletTerminalTradeReviewRequest) =>
      attempt(() =>
        client.fetch<WalletTerminalTradeReview>(
          "/api/wallet/terminal/trade/review",
          { method: "POST", body: JSON.stringify(request) },
        ),
      ),
    [],
  );

  const execute = useCallback(
    (reviewId: string) =>
      attempt(() =>
        client.fetch<WalletTerminalTradeExecuteResponse>(
          "/api/wallet/terminal/trade/execute",
          {
            method: "POST",
            body: JSON.stringify({ reviewId, confirm: true }),
          },
        ),
      ),
    [],
  );

  return { state, refresh, enable, review, execute };
}

export type ExchangeTradingState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: WalletTerminalExchangeStatusResponse };

export interface ExchangeTradingHandle {
  state: ExchangeTradingState;
  /** Orders placed from this terminal session, newest first. */
  orders: WalletExchangeOrder[];
  refresh: () => void;
  review: (
    request: WalletTerminalExchangeReviewRequest,
  ) => Promise<RealTradeOutcome<WalletTerminalExchangeReview>>;
  execute: (reviewId: string) => Promise<RealTradeOutcome<WalletExchangeOrder>>;
  refreshOrder: (
    clientOrderId: string,
  ) => Promise<RealTradeOutcome<WalletExchangeOrder>>;
  cancelOrder: (
    clientOrderId: string,
  ) => Promise<RealTradeOutcome<WalletExchangeOrder>>;
}

/** Kraken and OKX readiness, review, execute, and this session's orders. */
export function useExchangeTrading(): ExchangeTradingHandle {
  const [state, setState] = useState<ExchangeTradingState>({
    status: "loading",
  });
  const [orders, setOrders] = useState<WalletExchangeOrder[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await attempt(() =>
      client.fetch<WalletTerminalExchangeStatusResponse>(
        "/api/wallet/terminal/exchange/status",
      ),
    );
    if (!mounted.current) return;
    setState(
      next.ok
        ? { status: "ready", data: next.value }
        : { status: "error", message: next.message },
    );
    if (next.ok && next.value.realTradingEnabled) {
      const listed = await attempt(() =>
        client.fetch<WalletTerminalExchangeOrdersResponse>(
          "/api/wallet/terminal/exchange/orders",
        ),
      );
      if (mounted.current && listed.ok) setOrders(listed.value.orders);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  const upsert = useCallback((order: WalletExchangeOrder) => {
    if (!mounted.current) return;
    setOrders((current) => [
      order,
      ...current.filter((entry) => entry.clientOrderId !== order.clientOrderId),
    ]);
  }, []);

  const post = useCallback(
    async <T>(path: string, body: Record<string, unknown>) =>
      attempt(() =>
        client.fetch<T>(path, { method: "POST", body: JSON.stringify(body) }),
      ),
    [],
  );

  const review = useCallback(
    (request: WalletTerminalExchangeReviewRequest) =>
      post<WalletTerminalExchangeReview>(
        "/api/wallet/terminal/exchange/review",
        { ...request },
      ),
    [post],
  );

  const withOrder = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const outcome = await post<WalletExchangeOrder>(path, body);
      if (outcome.ok) upsert(outcome.value);
      return outcome;
    },
    [post, upsert],
  );

  const execute = useCallback(
    (reviewId: string) =>
      withOrder("/api/wallet/terminal/exchange/execute", {
        reviewId,
        confirm: true,
      }),
    [withOrder],
  );
  const refreshOrder = useCallback(
    (clientOrderId: string) =>
      withOrder("/api/wallet/terminal/exchange/refresh", { clientOrderId }),
    [withOrder],
  );
  const cancelOrder = useCallback(
    (clientOrderId: string) =>
      withOrder("/api/wallet/terminal/exchange/cancel", {
        clientOrderId,
        confirm: true,
      }),
    [withOrder],
  );

  return {
    state,
    orders,
    refresh,
    review,
    execute,
    refreshOrder,
    cancelOrder,
  };
}
