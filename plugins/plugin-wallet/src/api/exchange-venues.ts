/**
 * Signed REST clients for the two exchanges the crypto terminal can place
 * spot limit orders on: Kraken (`KRAKEN_API_KEY`, `KRAKEN_API_SECRET`) and OKX
 * (`OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`). Each client exposes
 * the same five steps `terminal-exchange.ts` needs: check an order without
 * placing it, read available funds, place it, read its state, and cancel it.
 *
 * Keys are read from runtime settings for each request and appear only in the
 * signed headers; they are never put in an error, a result, or a log line.
 * Amounts stay decimal strings end to end. A venue that answers with an error
 * becomes a typed {@link ExchangeVenueError} whose `kind` says whether the
 * venue refused the request or could not be reached, because a lost send must
 * be shown as "unknown", not as "rejected".
 */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  WalletExchangeBase,
  WalletExchangeOrderState,
  WalletExchangeQuote,
  WalletExchangeVenue,
  WalletTerminalTradeSide,
} from "../contracts.js";

export const KRAKEN_API_URL = "https://api.kraken.com";
export const DEFAULT_OKX_API_URL = "https://www.okx.com";
export const OKX_API_URL_SETTING = "OKX_API_BASE_URL";
const REQUEST_TIMEOUT_MS = 20_000;

/** Settings each venue needs before it can be used. */
export const EXCHANGE_VENUE_SETTINGS: Record<WalletExchangeVenue, string[]> = {
  kraken: ["KRAKEN_API_KEY", "KRAKEN_API_SECRET"],
  okx: ["OKX_API_KEY", "OKX_API_SECRET", "OKX_API_PASSPHRASE"],
};

export type ExchangeVenueErrorKind =
  /** The venue answered and said no: bad pair, funds, precision, key rights. */
  | "refused"
  /** No usable answer arrived; the request may or may not have taken effect. */
  | "unreachable"
  /** A required setting is missing. */
  | "not-configured";

export class ExchangeVenueError extends Error {
  constructor(
    readonly kind: ExchangeVenueErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ExchangeVenueError";
  }
}

/** An order as the terminal asks a venue to place it. */
export interface ExchangeOrderIntent {
  base: WalletExchangeBase;
  quote: WalletExchangeQuote;
  side: WalletTerminalTradeSide;
  quantity: string;
  price: string;
  clientOrderId: string;
}

/** Market rules a venue reports, used to check an order before placing it. */
export interface ExchangeMarketRules {
  market: string;
  /** Smallest quantity step, as a decimal string, when the venue reports it. */
  quantityStep: string | null;
  /** Smallest price step, as a decimal string, when the venue reports it. */
  priceStep: string | null;
  minimumQuantity: string | null;
}

export interface ExchangeOrderSnapshot {
  orderId: string | null;
  state: WalletExchangeOrderState;
  filledQuantity: string | null;
}

/** The five venue steps the terminal uses. */
export interface ExchangeVenueClient {
  readonly venue: WalletExchangeVenue;
  marketName(intent: Pick<ExchangeOrderIntent, "base" | "quote">): string;
  /**
   * Ask the venue to check the order without placing it. Returns the rules it
   * enforces and its own description of the order, or throws a refusal.
   */
  validateOrder(
    intent: ExchangeOrderIntent,
  ): Promise<{ rules: ExchangeMarketRules; description: string }>;
  /** Available (not held) balance of one currency, as a decimal string. */
  availableBalance(currency: string): Promise<string>;
  placeOrder(intent: ExchangeOrderIntent): Promise<{ orderId: string }>;
  readOrder(
    intent: ExchangeOrderIntent,
    orderId: string | null,
  ): Promise<ExchangeOrderSnapshot>;
  cancelOrder(intent: ExchangeOrderIntent, orderId: string): Promise<void>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSetting(runtime: IAgentRuntime, key: string): string | null {
  const raw = runtime.getSetting(key);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** Settings a venue still needs, in the order the venue's docs list them. */
export function missingVenueSettings(
  runtime: IAgentRuntime,
  venue: WalletExchangeVenue,
): string[] {
  return EXCHANGE_VENUE_SETTINGS[venue].filter(
    (key) => readSetting(runtime, key) === null,
  );
}

function requireSetting(runtime: IAgentRuntime, key: string): string {
  const value = readSetting(runtime, key);
  if (value === null) {
    throw new ExchangeVenueError(
      "not-configured",
      `Set ${key} in packages/agent/.env to use this exchange.`,
    );
  }
  return value;
}

function fetcherOf(runtime: IAgentRuntime): typeof fetch {
  return runtime.fetch ?? globalThis.fetch;
}

async function send(
  runtime: IAgentRuntime,
  venueName: string,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcherOf(runtime)(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // error-policy:J2 context-adding rethrow: a lost request is "unreachable".
    throw new ExchangeVenueError(
      "unreachable",
      `${venueName} did not answer (${
        error instanceof Error ? error.message : "request failed"
      }).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing: an unreadable body is unreachable.
    throw new ExchangeVenueError(
      "unreachable",
      `${venueName} answered HTTP ${response.status} with a body that is not JSON (${
        error instanceof Error ? error.message : "parse failed"
      }).`,
    );
  }
  if (response.status >= 500) {
    throw new ExchangeVenueError(
      "unreachable",
      `${venueName} answered HTTP ${response.status}.`,
    );
  }
  return body;
}

// ---------------------------------------------------------------- Kraken ----

/** Kraken's REST signature: HMAC-SHA512(secret, path + SHA256(nonce + body)). */
export function krakenSignature(
  path: string,
  nonce: string,
  body: string,
  secret: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(nonce + body)
    .digest();
  return crypto
    .createHmac("sha512", Buffer.from(secret, "base64"))
    .update(Buffer.concat([Buffer.from(path), digest]))
    .digest("base64");
}

/** Kraken's balance keys for the currencies the terminal trades. */
const KRAKEN_BALANCE_KEYS: Record<string, string[]> = {
  USD: ["ZUSD", "USD"],
  SOL: ["SOL"],
  USDC: ["USDC"],
  USDT: ["USDT"],
  PYUSD: ["PYUSD"],
};

let lastKrakenNonce = 0n;

function nextKrakenNonce(): string {
  const now = BigInt(Date.now()) * 1000n;
  lastKrakenNonce = now > lastKrakenNonce ? now : lastKrakenNonce + 1n;
  return lastKrakenNonce.toString();
}

function krakenStateOf(status: unknown, filled: string | null) {
  switch (status) {
    case "pending":
      return "submitted";
    case "open":
      return filled !== null && Number(filled) > 0
        ? "partially-filled"
        : "open";
    case "closed":
      return "filled";
    case "canceled":
    case "expired":
      return "canceled";
    default:
      return "unknown";
  }
}

export function krakenClient(runtime: IAgentRuntime): ExchangeVenueClient {
  async function privateCall(
    method: string,
    params: Record<string, string>,
  ): Promise<Json> {
    const key = requireSetting(runtime, "KRAKEN_API_KEY");
    const secret = requireSetting(runtime, "KRAKEN_API_SECRET");
    const path = `/0/private/${method}`;
    const nonce = nextKrakenNonce();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const answer = await send(runtime, "Kraken", `${KRAKEN_API_URL}${path}`, {
      method: "POST",
      headers: {
        "API-Key": key,
        "API-Sign": krakenSignature(path, nonce, body, secret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!isObject(answer) || !Array.isArray(answer.error)) {
      throw new ExchangeVenueError(
        "unreachable",
        "Kraken answered without its error list.",
      );
    }
    if (answer.error.length > 0) {
      throw new ExchangeVenueError(
        "refused",
        `Kraken: ${answer.error.map(String).join("; ")}`,
      );
    }
    if (!isObject(answer.result)) {
      throw new ExchangeVenueError("unreachable", "Kraken answered no result.");
    }
    return answer.result;
  }

  const marketName = (intent: Pick<ExchangeOrderIntent, "base" | "quote">) =>
    `${intent.base}${intent.quote}`;

  function orderParams(intent: ExchangeOrderIntent): Record<string, string> {
    return {
      pair: marketName(intent),
      type: intent.side,
      ordertype: "limit",
      volume: intent.quantity,
      price: intent.price,
      cl_ord_id: intent.clientOrderId,
    };
  }

  return {
    venue: "kraken",
    marketName,
    async validateOrder(intent) {
      const result = await privateCall("AddOrder", {
        ...orderParams(intent),
        validate: "true",
      });
      const descr = isObject(result.descr) ? result.descr : {};
      return {
        rules: {
          market: marketName(intent),
          quantityStep: null,
          priceStep: null,
          minimumQuantity: null,
        },
        description:
          typeof descr.order === "string"
            ? descr.order
            : "Kraken accepted the order in validate-only mode.",
      };
    },
    async availableBalance(currency) {
      const result = await privateCall("Balance", {});
      for (const key of KRAKEN_BALANCE_KEYS[currency] ?? [currency]) {
        const value = result[key];
        if (typeof value === "string") return value;
      }
      return "0";
    },
    async placeOrder(intent) {
      const result = await privateCall("AddOrder", orderParams(intent));
      const txid = Array.isArray(result.txid) ? result.txid[0] : null;
      if (typeof txid !== "string" || txid === "") {
        throw new ExchangeVenueError(
          "unreachable",
          "Kraken accepted the order but returned no order id.",
        );
      }
      return { orderId: txid };
    },
    async readOrder(intent, orderId) {
      if (orderId === null) {
        const open = await privateCall("OpenOrders", {
          cl_ord_id: intent.clientOrderId,
        });
        const found = isObject(open.open) ? Object.keys(open.open)[0] : null;
        if (!found) {
          return { orderId: null, state: "unknown", filledQuantity: null };
        }
        orderId = found;
      }
      const result = await privateCall("QueryOrders", { txid: orderId });
      const order = result[orderId];
      if (!isObject(order)) {
        return { orderId, state: "unknown", filledQuantity: null };
      }
      const filled = typeof order.vol_exec === "string" ? order.vol_exec : null;
      return {
        orderId,
        state: krakenStateOf(order.status, filled),
        filledQuantity: filled,
      };
    },
    async cancelOrder(_intent, orderId) {
      await privateCall("CancelOrder", { txid: orderId });
    },
  };
}

// ------------------------------------------------------------------- OKX ----

/** OKX's REST signature: HMAC-SHA256(secret, timestamp + method + path + body). */
export function okxSignature(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(timestamp + method + requestPath + body)
    .digest("base64");
}

/** OKX client order ids are 1-32 letters and digits. */
export function okxClientOrderId(clientOrderId: string): string {
  return clientOrderId.replaceAll("-", "");
}

function okxStateOf(state: unknown): WalletExchangeOrderState {
  switch (state) {
    case "live":
      return "open";
    case "partially_filled":
      return "partially-filled";
    case "filled":
      return "filled";
    case "canceled":
    case "mmp_canceled":
      return "canceled";
    default:
      return "unknown";
  }
}

/** The OKX origin to call: `OKX_API_BASE_URL` (https, no path) or the default. */
export function resolveOkxApiUrl(runtime: IAgentRuntime): string {
  const configured = readSetting(runtime, OKX_API_URL_SETTING);
  if (configured === null) return DEFAULT_OKX_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    // error-policy:J3 an unparseable setting is reported, never replaced.
    throw new ExchangeVenueError(
      "not-configured",
      `${OKX_API_URL_SETTING} is not a URL.`,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new ExchangeVenueError(
      "not-configured",
      `${OKX_API_URL_SETTING} must be an https origin with no path or query.`,
    );
  }
  return parsed.origin;
}

export function okxClient(runtime: IAgentRuntime): ExchangeVenueClient {
  async function call(
    method: "GET" | "POST",
    path: string,
    options: {
      query?: Record<string, string>;
      payload?: Json;
      signed: boolean;
    },
  ): Promise<Json[]> {
    const base = resolveOkxApiUrl(runtime);
    const query = options.query
      ? `?${new URLSearchParams(options.query).toString()}`
      : "";
    const requestPath = `${path}${query}`;
    const body = options.payload ? JSON.stringify(options.payload) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.signed) {
      const key = requireSetting(runtime, "OKX_API_KEY");
      const secret = requireSetting(runtime, "OKX_API_SECRET");
      const passphrase = requireSetting(runtime, "OKX_API_PASSPHRASE");
      const timestamp = new Date().toISOString();
      headers["OK-ACCESS-KEY"] = key;
      headers["OK-ACCESS-PASSPHRASE"] = passphrase;
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      headers["OK-ACCESS-SIGN"] = okxSignature(
        timestamp,
        method,
        requestPath,
        body,
        secret,
      );
    }
    const answer = await send(runtime, "OKX", `${base}${requestPath}`, {
      method,
      headers,
      ...(method === "POST" ? { body } : {}),
    });
    if (!isObject(answer) || !Array.isArray(answer.data)) {
      throw new ExchangeVenueError(
        "unreachable",
        "OKX answered without a data list.",
      );
    }
    const rows = answer.data.filter(isObject);
    const failedRow = rows.find(
      (row) => typeof row.sCode === "string" && row.sCode !== "0",
    );
    if (String(answer.code) !== "0" || failedRow) {
      const reason =
        (failedRow && typeof failedRow.sMsg === "string" && failedRow.sMsg) ||
        (typeof answer.msg === "string" && answer.msg) ||
        `code ${String(answer.code)}`;
      throw new ExchangeVenueError("refused", `OKX: ${reason}`);
    }
    return rows;
  }

  const marketName = (intent: Pick<ExchangeOrderIntent, "base" | "quote">) =>
    `${intent.base}-${intent.quote}`;

  return {
    venue: "okx",
    marketName,
    async validateOrder(intent) {
      const rows = await call("GET", "/api/v5/public/instruments", {
        query: { instType: "SPOT", instId: marketName(intent) },
        signed: false,
      });
      const instrument = rows[0];
      if (instrument?.state !== "live") {
        throw new ExchangeVenueError(
          "refused",
          `OKX: ${marketName(intent)} is not a live spot market.`,
        );
      }
      const text = (value: unknown) =>
        typeof value === "string" && value !== "" ? value : null;
      return {
        rules: {
          market: marketName(intent),
          quantityStep: text(instrument.lotSz),
          priceStep: text(instrument.tickSz),
          minimumQuantity: text(instrument.minSz),
        },
        description: `${intent.side} ${intent.quantity} ${intent.base} @ limit ${intent.price} ${intent.quote} on OKX ${marketName(intent)}`,
      };
    },
    async availableBalance(currency) {
      const rows = await call("GET", "/api/v5/account/balance", {
        query: { ccy: currency },
        signed: true,
      });
      const details = Array.isArray(rows[0]?.details) ? rows[0].details : [];
      for (const detail of details) {
        if (
          isObject(detail) &&
          detail.ccy === currency &&
          typeof detail.availBal === "string"
        ) {
          return detail.availBal;
        }
      }
      return "0";
    },
    async placeOrder(intent) {
      const rows = await call("POST", "/api/v5/trade/order", {
        payload: {
          instId: marketName(intent),
          tdMode: "cash",
          side: intent.side,
          ordType: "limit",
          sz: intent.quantity,
          px: intent.price,
          clOrdId: okxClientOrderId(intent.clientOrderId),
        },
        signed: true,
      });
      const orderId = rows[0]?.ordId;
      if (typeof orderId !== "string" || orderId === "") {
        throw new ExchangeVenueError(
          "unreachable",
          "OKX accepted the order but returned no order id.",
        );
      }
      return { orderId };
    },
    async readOrder(intent, orderId) {
      const rows = await call("GET", "/api/v5/trade/order", {
        query: {
          instId: marketName(intent),
          ...(orderId !== null
            ? { ordId: orderId }
            : { clOrdId: okxClientOrderId(intent.clientOrderId) }),
        },
        signed: true,
      });
      const order = rows[0];
      if (!order) return { orderId, state: "unknown", filledQuantity: null };
      return {
        orderId: typeof order.ordId === "string" ? order.ordId : orderId,
        state: okxStateOf(order.state),
        filledQuantity:
          typeof order.accFillSz === "string" ? order.accFillSz : null,
      };
    },
    async cancelOrder(intent, orderId) {
      await call("POST", "/api/v5/trade/cancel-order", {
        payload: { instId: marketName(intent), ordId: orderId },
        signed: true,
      });
    },
  };
}

export function exchangeClient(
  runtime: IAgentRuntime,
  venue: WalletExchangeVenue,
): ExchangeVenueClient {
  return venue === "kraken" ? krakenClient(runtime) : okxClient(runtime);
}
