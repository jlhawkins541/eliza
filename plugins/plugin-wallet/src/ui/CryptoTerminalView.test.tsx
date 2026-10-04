// @vitest-environment jsdom
/**
 * Drives the crypto terminal through its rendered DOM with every API call
 * served by the real terminal market route handler over recorded CoinGecko
 * payloads. Only the shared `@elizaos/ui` primitives are replaced with plain
 * DOM stand-ins, and the separately tested wallet dashboard with a marker.
 * Covers loading, live list, search, watchlist, chart, paper market and limit
 * orders, reservations, persistence, the unavailable-data state, confirmed
 * HUNT / SLEEP / OFF mode changes, price alerts fired by a later live price
 * and paused in OFF, the PIN lock over real Web Crypto (set, lock, wrong PIN,
 * unlock, idle auto-lock, forgot-PIN reset), the GoPlus token safety
 * check (served by the real token safety route over a recorded payload), and
 * the Real trade tab, served by the real wallet trade routes with Jupiter and
 * Solana RPC doubles and a real signer over a generated key; the agent's
 * trade-permission route is the one stand-in there.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalTradeHarness,
  type TerminalTradeHarness,
} from "../api/__tests__/terminal-trade-harness";
import { __resetTerminalTradesForTests } from "../api/terminal-trade";
import {
  __expireWalletTerminalCachesForTests,
  __resetWalletTerminalMarketRouteForTests,
  __setWalletTerminalFetchForTests,
  handleWalletTerminalMarketRoute,
} from "../routes/wallet-terminal-market-route";
import {
  __resetWalletTerminalTokenSafetyRouteForTests,
  __setWalletTerminalTokenSafetyFetchForTests,
  handleWalletTerminalTokenSafetyRoute,
} from "../routes/wallet-terminal-token-safety-route";

const routeClient = vi.hoisted(() => ({
  fetch: async (path: string, _init?: RequestInit): Promise<unknown> => {
    throw new Error(`route client not installed for ${path}`);
  },
  setTradePermissionMode: async (mode: string): Promise<unknown> => {
    throw new Error(`trade permission not installed for ${mode}`);
  },
}));

vi.mock("@elizaos/ui", () => {
  type Item = { value: string; label: React.ReactNode };
  const h = React.createElement;
  return {
    client: routeClient,
    shellLocalStorage: {
      setItem: (key: string, value: string) =>
        globalThis.window.localStorage.setItem(key, value),
      removeItem: (key: string) =>
        globalThis.window.localStorage.removeItem(key),
      clear: () => globalThis.window.localStorage.clear(),
    },
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: string;
      size?: string;
    }) => h("button", { type: "button", ...props }),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
      h("input", props),
    SegmentedControl: ({
      value,
      onValueChange,
      items,
      "aria-label": label,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      items: Item[];
      "aria-label"?: string;
    }) =>
      h(
        "div",
        { role: "group", "aria-label": label },
        items.map((item) =>
          h(
            "button",
            {
              key: item.value,
              type: "button",
              "aria-pressed": item.value === value,
              onClick: () => onValueChange(item.value),
            },
            item.label,
          ),
        ),
      ),
    Dialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? h("div", { role: "dialog" }, children) : null),
    DialogContent: ({ children }: { children: React.ReactNode }) =>
      h("div", null, children),
    DialogHeader: ({ children }: { children: React.ReactNode }) =>
      h("div", null, children),
    DialogFooter: ({ children }: { children: React.ReactNode }) =>
      h("div", null, children),
    DialogTitle: ({ children }: { children: React.ReactNode }) =>
      h("h2", null, children),
    DialogDescription: ({ children }: { children: React.ReactNode }) =>
      h("p", null, children),
  };
});

vi.mock("./components/InventoryAppView.tsx", () => ({
  InventoryAppView: () =>
    React.createElement("div", { "data-testid": "wallet-rich-dashboard" }),
}));

import { CryptoTerminalView } from "./CryptoTerminalView";
import { createPinLock } from "./terminal/pin-lock";
import {
  OPERATING_MODE_STORAGE_KEY,
  PAPER_LEDGER_STORAGE_KEY,
  PIN_LOCK_STORAGE_KEY,
  PRICE_ALERTS_STORAGE_KEY,
  TERMINAL_MARKETS_POLL_MS,
  WATCHLIST_STORAGE_KEY,
} from "./terminal/terminal-data";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../routes/__fixtures__/coingecko-markets.recorded.json",
    ),
    "utf8",
  ),
) as { coinGeckoMarkets: Array<Record<string, unknown>> };

const goplus = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../routes/__fixtures__/goplus-solana-token-security.recorded.json",
    ),
    "utf8",
  ),
) as { mint: string; goplus: unknown };

let upstreamDown = false;
let bitcoinPriceOverride: number | null = null;
let routeCalls: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let trade: TerminalTradeHarness | null = null;

// Real-trade calls go through the real wallet routes in the trade harness.
async function viaTradeRoute(path: string, init?: RequestInit) {
  if (!trade) throw new Error(`no trade harness for ${path}`);
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : undefined;
  routeCalls.push(path);
  const res = await trade.request(
    init?.method === "POST" ? "POST" : "GET",
    path,
    body,
  );
  if (res.status !== 200) {
    throw new Error(String(res.body.error ?? `HTTP ${res.status}`));
  }
  return res.body;
}

// Serve the view's client calls through the real route handler.
async function viaRoute(path: string, init?: RequestInit): Promise<unknown> {
  if (path.startsWith("/api/wallet/terminal/trade/")) {
    return viaTradeRoute(path, init);
  }
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
  };
  routeCalls.push(path);
  const req = {
    method: "GET",
    url: path,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  const handled = await handleWalletTerminalMarketRoute(
    req,
    res as unknown as http.ServerResponse,
  );
  if (!handled) {
    await handleWalletTerminalTokenSafetyRoute(
      req,
      res as unknown as http.ServerResponse,
    );
  }
  const body = JSON.parse(res.body) as { error?: string };
  if (res.statusCode !== 200) {
    throw new Error(body.error ?? `HTTP ${res.statusCode}`);
  }
  return body;
}

beforeEach(() => {
  upstreamDown = false;
  bitcoinPriceOverride = null;
  routeCalls = [];
  trade = null;
  __resetTerminalTradesForTests();
  routeClient.fetch = viaRoute;
  // Stand-in for the agent's PUT /api/permissions/trade-mode.
  routeClient.setTradePermissionMode = async (mode: string) => {
    if (!trade) throw new Error("no trade harness");
    trade.config.features.tradePermissionMode =
      mode as TerminalTradeHarness["config"]["features"]["tradePermissionMode"];
    return { ok: true, tradePermissionMode: mode };
  };
  __setWalletTerminalTokenSafetyFetchForTests(async () =>
    jsonResponse(goplus.goplus),
  );
  __setWalletTerminalFetchForTests(async (input) => {
    if (upstreamDown) return jsonResponse({}, 503);
    const href = String(input);
    if (href.includes("/market_chart")) {
      return jsonResponse({
        prices: [
          [1_700_000_000_000, 64_000],
          [1_700_000_060_000, 65_000],
          [1_700_000_120_000, 65_757],
        ],
      });
    }
    return jsonResponse(
      recorded.coinGeckoMarkets.map((row) =>
        row.id === "bitcoin" && bitcoinPriceOverride !== null
          ? { ...row, current_price: bitcoinPriceOverride }
          : row,
      ),
    );
  });
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetWalletTerminalMarketRouteForTests();
  __resetWalletTerminalTokenSafetyRouteForTests();
});

async function openBitcoin() {
  fireEvent.click(await screen.findByTestId("terminal-market-row-bitcoin"));
  await screen.findByTestId("terminal-price-chart");
}

describe("CryptoTerminalView", () => {
  it("shows a loading state, then live markets with their source", async () => {
    render(<CryptoTerminalView />);
    expect(screen.getByRole("status").textContent).toMatch(
      /Loading live markets/,
    );
    const bitcoinRow = await screen.findByTestId("terminal-market-row-bitcoin");
    expect(bitcoinRow.textContent).toContain("$65,757.00");
    expect(screen.getByTestId("terminal-market-status").textContent).toMatch(
      /Live prices from CoinGecko/,
    );
    expect(screen.getByTestId("terminal-market-row-tether")).toBeTruthy();
  });

  it("filters by search and keeps a starred watchlist", async () => {
    render(<CryptoTerminalView />);
    await screen.findByTestId("terminal-market-row-bitcoin");
    fireEvent.change(screen.getByTestId("terminal-market-search"), {
      target: { value: "eth" },
    });
    expect(screen.queryByTestId("terminal-market-row-bitcoin")).toBeNull();
    expect(screen.getByTestId("terminal-market-row-ethereum")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Ethereum from watchlist" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Watchlist" }));
    expect(screen.getByTestId("terminal-market-row-bitcoin")).toBeTruthy();
    expect(screen.queryByTestId("terminal-market-row-ethereum")).toBeNull();
    expect(screen.queryByTestId("terminal-market-row-tether")).toBeNull();
  });

  it("charts live history and fills a paper market buy at the live price", async () => {
    render(<CryptoTerminalView />);
    await openBitcoin();
    expect(
      screen.getByTestId("terminal-price-chart").getAttribute("aria-valuetext"),
    ).toBe("$65,757.00");

    const review = screen.getByTestId(
      "paper-order-review",
    ) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("paper-order-amount"), {
      target: { value: "20000" },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Amount exceeds available paper cash.",
    );
    fireEvent.change(screen.getByTestId("paper-order-amount"), {
      target: { value: "6575.70" },
    });
    fireEvent.click(review);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/No wallet is used/);
    expect(dialog.textContent).toContain("0.1 BTC");
    fireEvent.click(within(dialog).getByTestId("paper-order-place"));

    expect(screen.getByRole("status").textContent).toContain(
      "Paper buy filled: 0.1 BTC at $65,757.00.",
    );
    const saved = JSON.parse(
      window.localStorage.getItem(PAPER_LEDGER_STORAGE_KEY) ?? "null",
    );
    expect(saved.cashUsd).toBeCloseTo(3_424.3);
    expect(saved.holdings.bitcoin.units).toBeCloseTo(0.1);

    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByTestId("paper-total").textContent).toContain(
      "$10,000.00",
    );
    expect(screen.getByTestId("paper-activity").textContent).toMatch(/filled/i);
  });

  it("queues a limit buy, reserves its cash, and releases it on cancel", async () => {
    render(<CryptoTerminalView />);
    await openBitcoin();
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByTestId("paper-order-amount"), {
      target: { value: "4000" },
    });
    fireEvent.change(screen.getByTestId("paper-order-limit"), {
      target: { value: "50000" },
    });
    fireEvent.click(screen.getByTestId("paper-order-review"));
    fireEvent.click(screen.getByTestId("paper-order-place"));
    expect(screen.getByRole("status").textContent).toMatch(
      /queued at \$50,000/,
    );

    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByText(/\$6,000\.00 available/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/\$10,000\.00 available/)).toBeTruthy();
    expect(screen.getByTestId("paper-activity").textContent).toMatch(
      /cancelled/i,
    );
  });

  it("restores a saved paper portfolio and flags a corrupt one", async () => {
    window.localStorage.setItem(PAPER_LEDGER_STORAGE_KEY, "{broken");
    render(<CryptoTerminalView />);
    await screen.findByTestId("terminal-market-row-bitcoin");
    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByRole("alert").textContent).toMatch(/not valid JSON/);
    expect(screen.getByTestId("paper-total").textContent).toContain(
      "$10,000.00",
    );
  });

  it("pauses paper trading when live data is unavailable", async () => {
    upstreamDown = true;
    render(<CryptoTerminalView />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Live market data is unavailable \(Failed to load terminal markets\)/,
    );
    expect(screen.queryByTestId("paper-order-review")).toBeNull();
  });

  it("keeps the real wallet dashboard on its own tab", async () => {
    render(<CryptoTerminalView />);
    fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
    expect(screen.getByTestId("wallet-rich-dashboard")).toBeTruthy();
  });

  it("switches mode only after confirmation and records the change", async () => {
    render(<CryptoTerminalView />);
    await screen.findByTestId("terminal-market-row-bitcoin");
    expect(screen.getByTestId("terminal-mode-status").textContent).toBe(
      "SLEEP",
    );
    expect(screen.queryByTestId("terminal-scout")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hunt" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/No mode signs or sends a real trade/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("terminal-mode-status").textContent).toBe(
      "SLEEP",
    );

    fireEvent.click(screen.getByRole("button", { name: "Hunt" }));
    fireEvent.click(screen.getByTestId("terminal-mode-confirm"));
    expect(screen.getByTestId("terminal-mode-status").textContent).toMatch(
      /^HUNT since /,
    );
    expect(screen.getByTestId("terminal-scout")).toBeTruthy();
    const saved = JSON.parse(
      window.localStorage.getItem(OPERATING_MODE_STORAGE_KEY) ?? "null",
    );
    expect(saved.mode).toBe("hunt");
    expect(saved.history[0]).toMatchObject({ from: "sleep", to: "hunt" });

    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByTestId("mode-history").textContent).toContain(
      "SLEEP → HUNT",
    );
  });

  it("makes no market request in OFF until prices are refreshed", async () => {
    window.localStorage.setItem(
      OPERATING_MODE_STORAGE_KEY,
      JSON.stringify({ mode: "off", history: [] }),
    );
    render(<CryptoTerminalView />);
    expect(screen.getByTestId("terminal-market-status").textContent).toMatch(
      /Terminal is off/,
    );
    await new Promise((settle) => setTimeout(settle, 20));
    expect(routeCalls).toEqual([]);

    fireEvent.click(screen.getByTestId("terminal-refresh-prices"));
    await screen.findByTestId("terminal-market-row-bitcoin");
    expect(routeCalls).toEqual(["/api/wallet/terminal/markets"]);
    expect(screen.getByTestId("terminal-market-status").textContent).toMatch(
      /automatic updates are off/,
    );
  });

  it("checks a Solana mint and shows the GoPlus verdict and checks", async () => {
    render(<CryptoTerminalView />);
    fireEvent.click(screen.getByRole("button", { name: "Token safety" }));

    fireEvent.change(screen.getByTestId("token-safety-mint"), {
      target: { value: "not a mint" },
    });
    fireEvent.click(screen.getByTestId("token-safety-check"));
    expect(screen.getByRole("alert").textContent).toMatch(
      /Enter a Solana mint address/,
    );
    expect(routeCalls.some((path) => path.includes("token-safety"))).toBe(
      false,
    );

    fireEvent.change(screen.getByTestId("token-safety-mint"), {
      target: { value: `  ${goplus.mint} ` },
    });
    fireEvent.click(screen.getByTestId("token-safety-check"));
    const report = await screen.findByTestId("token-safety-report");
    expect(report.textContent).toContain("Caution · Bonk");
    expect(report.textContent).toMatch(/Top 10 holders own 38\.4%/);
    expect(report.textContent).toContain("From GoPlus Security");
    expect(routeCalls).toContain(
      `/api/wallet/terminal/token-safety?mint=${goplus.mint}`,
    );
  });

  describe("Real trade", () => {
    // jsdom replaces the global Uint8Array, which breaks web3.js serialization
    // of Node Buffers in the real routes; restore Node's for these tests.
    const jsdomUint8Array = globalThis.Uint8Array;
    beforeEach(() => {
      globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype)
        .constructor as Uint8ArrayConstructor;
    });
    afterEach(() => {
      globalThis.Uint8Array = jsdomUint8Array;
    });

    async function openRealTrade() {
      fireEvent.click(screen.getByRole("button", { name: "Real trade" }));
      return screen.findByTestId("real-trade-wallet");
    }

    async function reviewBuy(mint: string, amount = "0.25") {
      fireEvent.change(screen.getByTestId("real-trade-mint"), {
        target: { value: mint },
      });
      fireEvent.change(screen.getByTestId("real-trade-amount"), {
        target: { value: amount },
      });
      fireEvent.click(screen.getByTestId("real-trade-review"));
      return screen.findByTestId("real-trade-simulation");
    }

    it("turns real trading on only after a confirm, then sends a reviewed buy on tap", async () => {
      trade = await createTerminalTradeHarness({ mode: "user-sign-only" });
      render(<CryptoTerminalView />);
      expect((await openRealTrade()).textContent).toContain(
        "Trade permission: sign-only",
      );
      expect(screen.getByText("Real funds")).toBeTruthy();
      expect(screen.getByTestId("real-trade-off")).toBeTruthy();
      expect(screen.queryByTestId("real-trade-mint")).toBeNull();

      fireEvent.click(screen.getByTestId("real-trade-enable"));
      expect(trade.config.features.tradePermissionMode).toBe("user-sign-only");
      fireEvent.click(screen.getByTestId("real-trade-enable-confirm"));
      await screen.findByTestId("real-trade-mint");
      expect(trade.config.features.tradePermissionMode).toBe(
        "manual-local-key",
      );

      const simulation = await reviewBuy(trade.tokenMint);
      expect(simulation.textContent).toBe("Passed · 61,250 compute units");
      expect(screen.getByTestId("real-trade-pay").textContent).toBe("0.25 SOL");
      expect(screen.getByTestId("real-trade-receive").textContent).toContain(
        "2500 ",
      );
      expect(screen.getByTestId("real-trade-minimum").textContent).toContain(
        "2475 ",
      );
      expect(screen.getByTestId("real-trade-fee").textContent).toBe(
        "0.000005 SOL base + 0.00012 SOL priority",
      );
      expect(screen.getByRole("dialog").textContent).toContain(
        "Private and Jito bundle routing are not set up.",
      );
      expect(screen.getByTestId("real-trade-expiry").textContent).toBe(
        "Quote held for 60s.",
      );
      expect(trade.sent).toEqual([]);

      fireEvent.click(screen.getByTestId("real-trade-confirm"));
      const result = await screen.findByTestId("real-trade-result");
      expect(result.textContent).toContain("Trade confirmed on Solana.");
      expect(trade.sent).toHaveLength(1);
      const link = result.querySelector("a");
      expect(link?.getAttribute("href")).toMatch(
        /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{64,88}$/,
      );
      expect(screen.queryByTestId("real-trade-confirm")).toBeNull();
    });

    it("shows a refused buy and never sends a failed simulation", async () => {
      trade = await createTerminalTradeHarness();
      render(<CryptoTerminalView />);
      await openRealTrade();

      fireEvent.change(screen.getByTestId("real-trade-mint"), {
        target: { value: trade.tokenMint },
      });
      fireEvent.change(screen.getByTestId("real-trade-amount"), {
        target: { value: "3" },
      });
      fireEvent.click(screen.getByTestId("real-trade-review"));
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /over the 1 SOL per-trade limit/,
      );
      expect(screen.queryByRole("dialog")).toBeNull();

      trade.simulationErr = { InstructionError: [2, { Custom: 1 }] };
      const simulation = await reviewBuy(trade.tokenMint);
      expect(simulation.textContent).toContain("Failed:");
      expect(
        (screen.getByTestId("real-trade-confirm") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(trade.sent).toEqual([]);
    });

    it("lets a quote expire and asks for a fresh review", async () => {
      trade = await createTerminalTradeHarness();
      render(<CryptoTerminalView />);
      await openRealTrade();
      vi.useFakeTimers({
        toFake: ["setInterval", "clearInterval", "Date"],
        now: Date.now(),
      });
      await reviewBuy(trade.tokenMint);
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(screen.queryByTestId("real-trade-confirm")).toBeNull();
      expect(screen.getByRole("dialog").textContent).toContain(
        "This quote expired.",
      );
      fireEvent.click(screen.getByTestId("real-trade-review-again"));
      expect((await screen.findByTestId("real-trade-expiry")).textContent).toBe(
        "Quote held for 60s.",
      );
      expect(
        trade.jupiterCalls.filter((url) => url.endsWith("/swap")),
      ).toHaveLength(2);
      expect(trade.sent).toEqual([]);
    });

    it("carries a checked mint from Token safety into the ticket and its review", async () => {
      trade = await createTerminalTradeHarness({ tokenMint: goplus.mint });
      render(<CryptoTerminalView />);
      fireEvent.click(screen.getByRole("button", { name: "Token safety" }));
      fireEvent.change(screen.getByTestId("token-safety-mint"), {
        target: { value: goplus.mint },
      });
      fireEvent.click(screen.getByTestId("token-safety-check"));
      fireEvent.click(await screen.findByTestId("token-safety-trade"));

      const mint = (await screen.findByTestId(
        "real-trade-mint",
      )) as HTMLInputElement;
      expect(mint.value).toBe(goplus.mint);
      fireEvent.change(screen.getByTestId("real-trade-amount"), {
        target: { value: "0.1" },
      });
      fireEvent.click(screen.getByTestId("real-trade-review"));
      expect(
        (await screen.findByText(/Caution: GoPlus reported risks/)).textContent,
      ).toContain("Caution");
    });

    it("explains a wallet that can't sign instead of offering a ticket", async () => {
      trade = await createTerminalTradeHarness({ solanaSigner: false });
      render(<CryptoTerminalView />);
      await openRealTrade();
      expect(screen.getByRole("alert").textContent).toBe(
        "This wallet can't place trades: This wallet can't sign Solana transactions here.",
      );
      expect(screen.queryByTestId("real-trade-mint")).toBeNull();
    });
  });

  it("sets a price alert, refuses one already met, and fires on a later live price", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<CryptoTerminalView />);
    await openBitcoin();

    fireEvent.change(screen.getByTestId("price-alert-target"), {
      target: { value: "60000" },
    });
    fireEvent.click(screen.getByTestId("price-alert-add"));
    expect(
      screen.getByText("The live price is already past that target."),
    ).toBeTruthy();

    fireEvent.change(screen.getByTestId("price-alert-target"), {
      target: { value: "66000" },
    });
    fireEvent.click(screen.getByTestId("price-alert-add"));
    expect(
      screen.queryByText("The live price is already past that target."),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove alert BTC above $66,000.00" }),
    ).toBeTruthy();
    const waiting = JSON.parse(
      window.localStorage.getItem(PRICE_ALERTS_STORAGE_KEY) ?? "null",
    );
    expect(waiting.alerts).toHaveLength(1);
    expect(waiting.alerts[0]).toMatchObject({
      assetId: "bitcoin",
      direction: "above",
      targetUsd: 66_000,
      triggeredAt: null,
    });
    expect(screen.queryByTestId("price-alerts-fired")).toBeNull();

    bitcoinPriceOverride = 66_500;
    __expireWalletTerminalCachesForTests();
    act(() => {
      vi.advanceTimersByTime(TERMINAL_MARKETS_POLL_MS);
    });
    const fired = await screen.findByTestId("price-alerts-fired");
    expect(fired.textContent).toContain(
      "BTC rose above $66,000.00 (now $66,500.00)",
    );
    const saved = JSON.parse(
      window.localStorage.getItem(PRICE_ALERTS_STORAGE_KEY) ?? "null",
    );
    expect(saved.alerts[0].triggeredPriceUsd).toBe(66_500);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss alert BTC above $66,000.00",
      }),
    );
    expect(screen.queryByTestId("price-alerts-fired")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to markets" }));
    fireEvent.click(screen.getByRole("button", { name: "Watchlist" }));
    expect(screen.getByTestId("price-alerts").textContent).toMatch(
      /BTC above \$66,000\.00Triggered/,
    );
  });

  it("pauses alerts in OFF and checks them again after leaving OFF", async () => {
    window.localStorage.setItem(
      OPERATING_MODE_STORAGE_KEY,
      JSON.stringify({ mode: "off", history: [] }),
    );
    window.localStorage.setItem(
      PRICE_ALERTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        alerts: [
          {
            id: "seeded",
            assetId: "bitcoin",
            symbol: "BTC",
            direction: "above",
            targetUsd: 60_000,
            createdAt: 1,
            triggeredAt: null,
            triggeredPriceUsd: null,
          },
        ],
      }),
    );
    render(<CryptoTerminalView />);
    fireEvent.click(screen.getByTestId("terminal-refresh-prices"));
    await screen.findByTestId("terminal-market-row-bitcoin");
    fireEvent.click(screen.getByRole("button", { name: "Watchlist" }));
    expect(screen.getByTestId("price-alerts").textContent).toMatch(
      /Price alerts · paused.*Waiting/,
    );
    expect(screen.queryByTestId("price-alerts-fired")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sleep" }));
    fireEvent.click(screen.getByTestId("terminal-mode-confirm"));
    expect(
      (await screen.findByTestId("price-alerts-fired")).textContent,
    ).toContain("BTC rose above $60,000.00 (now $65,757.00)");
  });

  describe("PIN lock", () => {
    const PIN = "2580";

    const seedAlert = (targetUsd: number) =>
      window.localStorage.setItem(
        PRICE_ALERTS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          alerts: [
            {
              id: "seeded",
              assetId: "bitcoin",
              symbol: "BTC",
              direction: "above",
              targetUsd,
              createdAt: 1,
              triggeredAt: null,
              triggeredPriceUsd: null,
            },
          ],
        }),
      );

    async function seedPin(autoLockMinutes: 5 | 15 | 30 = 15) {
      const created = await createPinLock(PIN, autoLockMinutes, 1_000);
      if (!created.ok) throw new Error(created.reason);
      window.localStorage.setItem(
        PIN_LOCK_STORAGE_KEY,
        JSON.stringify(created.record),
      );
    }

    async function enterPin(pin: string) {
      fireEvent.change(screen.getByTestId("terminal-pin-input"), {
        target: { value: pin },
      });
      fireEvent.click(screen.getByTestId("terminal-pin-unlock"));
    }

    it("sets a PIN, locks, refuses a wrong PIN, and unlocks with the right one", async () => {
      render(<CryptoTerminalView />);
      await screen.findByTestId("terminal-market-row-bitcoin");
      fireEvent.click(screen.getByTestId("terminal-pin-settings"));
      fireEvent.change(screen.getByTestId("terminal-pin-new"), {
        target: { value: PIN },
      });
      fireEvent.change(screen.getByTestId("terminal-pin-confirm"), {
        target: { value: "2581" },
      });
      fireEvent.click(screen.getByTestId("terminal-pin-save"));
      expect(screen.getByRole("alert").textContent).toBe(
        "The two new PINs don't match.",
      );
      fireEvent.change(screen.getByTestId("terminal-pin-confirm"), {
        target: { value: PIN },
      });
      fireEvent.click(screen.getByTestId("terminal-pin-save"));
      await screen.findByTestId("terminal-lock-now");
      expect(screen.queryByRole("dialog")).toBeNull();
      const stored = window.localStorage.getItem(PIN_LOCK_STORAGE_KEY) ?? "";
      expect(JSON.parse(stored)).toMatchObject({ version: 1, failures: 0 });
      expect(stored).not.toContain(PIN);

      fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
      fireEvent.click(screen.getByTestId("terminal-lock-now"));
      expect(screen.getByTestId("terminal-lock-screen")).toBeTruthy();
      expect(screen.queryByText("Crypto Terminal")).toBeNull();
      expect(screen.queryByTestId("wallet-rich-dashboard")).toBeNull();

      await enterPin("1111");
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Wrong PIN. 4 more tries before a short wait.",
      );
      expect(screen.getByTestId("terminal-lock-screen")).toBeTruthy();

      await enterPin(PIN);
      await screen.findByTestId("wallet-rich-dashboard");
      expect(screen.queryByTestId("terminal-lock-screen")).toBeNull();
    });

    it("starts locked from a saved PIN, keeps checking alerts, and locks again when idle", async () => {
      await seedPin(5);
      seedAlert(60_000);
      vi.useFakeTimers({
        toFake: ["setInterval", "clearInterval", "Date"],
        now: Date.now(),
      });
      render(<CryptoTerminalView />);
      expect(screen.getByTestId("terminal-lock-screen")).toBeTruthy();
      expect(
        (await screen.findByTestId("terminal-lock-alerts")).textContent,
      ).toBe("1 price alert fired while locked. Unlock to see it.");
      expect(screen.queryByText(/BTC rose above/)).toBeNull();

      await enterPin(PIN);
      expect(
        (await screen.findByTestId("price-alerts-fired")).textContent,
      ).toContain("BTC rose above $60,000.00 (now $65,757.00)");

      act(() => {
        vi.advanceTimersByTime(4 * 60_000);
      });
      fireEvent.keyDown(window, { key: "Shift" });
      act(() => {
        vi.advanceTimersByTime(4 * 60_000);
      });
      expect(screen.queryByTestId("terminal-lock-screen")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(60_000 + TERMINAL_MARKETS_POLL_MS);
      });
      expect(screen.getByTestId("terminal-lock-screen")).toBeTruthy();
    });

    it("resets every saved terminal record when the PIN is forgotten", async () => {
      await seedPin();
      seedAlert(70_000);
      window.localStorage.setItem(WATCHLIST_STORAGE_KEY, '["tether"]');
      window.localStorage.setItem(
        OPERATING_MODE_STORAGE_KEY,
        JSON.stringify({ mode: "hunt", history: [] }),
      );
      render(<CryptoTerminalView />);
      fireEvent.click(screen.getByTestId("terminal-pin-forgot"));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toMatch(/real wallet and its keys are not/);
      fireEvent.click(within(dialog).getByTestId("terminal-pin-reset-confirm"));

      await screen.findByTestId("terminal-market-row-bitcoin");
      expect(screen.queryByTestId("terminal-lock-screen")).toBeNull();
      expect(screen.getByTestId("terminal-pin-settings").textContent).toBe(
        "Set PIN",
      );
      expect(screen.getByTestId("terminal-mode-status").textContent).toBe(
        "SLEEP",
      );
      for (const key of [
        PIN_LOCK_STORAGE_KEY,
        PRICE_ALERTS_STORAGE_KEY,
        WATCHLIST_STORAGE_KEY,
        OPERATING_MODE_STORAGE_KEY,
      ]) {
        expect(window.localStorage.getItem(key)).toBeNull();
      }
    });

    it("stays locked when the saved PIN cannot be read", async () => {
      window.localStorage.setItem(PIN_LOCK_STORAGE_KEY, "{broken");
      render(<CryptoTerminalView />);
      expect(screen.getByRole("alert").textContent).toMatch(
        /not valid JSON, so the terminal can't check your PIN/,
      );
      expect(screen.queryByTestId("terminal-pin-input")).toBeNull();
      expect(screen.queryByText("Crypto Terminal")).toBeNull();
    });
  });
});
