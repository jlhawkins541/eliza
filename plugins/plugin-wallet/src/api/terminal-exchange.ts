/**
 * Real spot limit orders on Kraken and OKX placed from the crypto terminal, in
 * two requests like its Solana trades. Review checks the exact order with the
 * venue without placing it (Kraken's validate-only AddOrder; OKX's live
 * instrument rules), reads the available balance it would spend, and holds
 * the order for {@link TERMINAL_EXCHANGE_REVIEW_TTL_MS}; execute places that
 * same order once. Nothing is re-entered in between.
 *
 * This path shares the terminal's confirmation gate: every step needs a trade
 * permission mode that lets a person trade and refuses requests marked as
 * agent automation, so an exchange order always rests on a person's tap. A
 * review is single-use and expires, and each order's value is capped by
 * `WALLET_TERMINAL_MAX_ORDER_USD`; a sell is valued at the market's best bid
 * when that is above its limit, since that is roughly where it would fill. The client order id is fixed at review, so
 * a send whose answer was lost is recorded as `unknown` and can be looked up
 * on the venue instead of being placed twice. Orders placed in this process
 * are listed, refreshed and cancelled from an in-memory journal. Failures are
 * `ElizaError`s whose codes map to HTTP statuses through
 * {@link TERMINAL_EXCHANGE_ERROR_STATUS}.
 */
import crypto from "node:crypto";
import { ElizaError, type IAgentRuntime, isElizaError } from "@elizaos/core";
import type { TradePermissionMode } from "@elizaos/shared";
import type {
  WalletExchangeBase,
  WalletExchangeOrder,
  WalletExchangeQuote,
  WalletExchangeReviewCheck,
  WalletExchangeVenue,
  WalletTerminalExchangeOrdersResponse,
  WalletTerminalExchangeReview,
  WalletTerminalExchangeStatusResponse,
  WalletTerminalTradeSide,
} from "../contracts.js";
import { canUseLocalTradeExecution } from "../lib/server-wallet-trade.js";
import {
  compareDecimals,
  isMultipleOf,
  isPlainDecimal,
  maxDecimal,
  multiplyDecimals,
} from "./decimal-strings.js";
import {
  type ExchangeOrderIntent,
  ExchangeVenueError,
  exchangeClient,
  missingVenueSettings,
} from "./exchange-venues.js";

export const TERMINAL_EXCHANGE_REVIEW_TTL_MS = 60_000;
export const TERMINAL_MAX_ORDER_USD_SETTING = "WALLET_TERMINAL_MAX_ORDER_USD";
export const DEFAULT_TERMINAL_MAX_ORDER_USD = 100;
export const EXCHANGE_VENUES: readonly WalletExchangeVenue[] = [
  "kraken",
  "okx",
];
export const EXCHANGE_BASES: readonly WalletExchangeBase[] = [
  "SOL",
  "USDC",
  "USDT",
  "PYUSD",
];
export const EXCHANGE_QUOTES: readonly WalletExchangeQuote[] = [
  "USD",
  "USDT",
  "USDC",
];
const DECIMAL_PATTERN = /^\d{1,12}(?:\.\d{1,18})?$/;
const VENUE_NAME: Record<WalletExchangeVenue, string> = {
  kraken: "Kraken",
  okx: "OKX",
};

export const TERMINAL_EXCHANGE_ERROR_STATUS = {
  TERMINAL_EXCHANGE_INVALID_REQUEST: 400,
  TERMINAL_EXCHANGE_NOT_PERMITTED: 403,
  TERMINAL_EXCHANGE_NOT_FOUND: 404,
  TERMINAL_EXCHANGE_REVIEW_CLOSED: 409,
  TERMINAL_EXCHANGE_REFUSED: 422,
  TERMINAL_EXCHANGE_LIMIT_INVALID: 500,
  TERMINAL_EXCHANGE_UPSTREAM_FAILED: 502,
  TERMINAL_EXCHANGE_NOT_CONFIGURED: 503,
  TERMINAL_EXCHANGE_AGENT_UNAVAILABLE: 503,
} as const;

export type TerminalExchangeErrorCode =
  keyof typeof TERMINAL_EXCHANGE_ERROR_STATUS;

/** Who is asking: the configured permission mode and whether an agent sent it. */
export interface TerminalExchangeAccess {
  mode: TradePermissionMode;
  fromAgent: boolean;
}

interface PendingExchangeOrder {
  readonly expiresAt: number;
  readonly venue: WalletExchangeVenue;
  readonly market: string;
  readonly intent: ExchangeOrderIntent;
  used: boolean;
}

interface JournalEntry {
  order: WalletExchangeOrder;
  readonly intent: ExchangeOrderIntent;
}

const pendingOrders = new Map<string, PendingExchangeOrder>();
const journal = new Map<string, JournalEntry>();

/** Forget every pending review and journaled order. Test-only. */
export function __resetTerminalExchangeForTests(): void {
  pendingOrders.clear();
  journal.clear();
}

function exchangeError(
  code: TerminalExchangeErrorCode,
  message: string,
  extra: { context?: Record<string, unknown>; cause?: unknown } = {},
): ElizaError {
  return new ElizaError(message, {
    code,
    context: extra.context,
    cause: extra.cause,
    severity:
      code === "TERMINAL_EXCHANGE_UPSTREAM_FAILED" ? "ephemeral" : "fatal",
  });
}

export function isTerminalExchangeError(
  error: unknown,
): error is ElizaError & { code: TerminalExchangeErrorCode } {
  return (
    isElizaError(error) &&
    Object.hasOwn(TERMINAL_EXCHANGE_ERROR_STATUS, error.code)
  );
}

/** Translate a venue failure into the terminal's typed error. */
function fromVenueError(error: unknown, venue: WalletExchangeVenue): never {
  if (error instanceof ExchangeVenueError) {
    const code =
      error.kind === "refused"
        ? "TERMINAL_EXCHANGE_REFUSED"
        : error.kind === "not-configured"
          ? "TERMINAL_EXCHANGE_NOT_CONFIGURED"
          : "TERMINAL_EXCHANGE_UPSTREAM_FAILED";
    throw exchangeError(code, error.message, {
      cause: error,
      context: { venue },
    });
  }
  throw error;
}

function requireRuntime(runtime: IAgentRuntime | null): IAgentRuntime {
  if (!runtime) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_AGENT_UNAVAILABLE",
      "The agent isn't running yet, so the terminal can't reach the exchange.",
    );
  }
  return runtime;
}

function assertPermitted(access: TerminalExchangeAccess): void {
  if (access.fromAgent) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_NOT_PERMITTED",
      "Exchange orders need a person's tap; agent requests are refused.",
    );
  }
  if (!canUseLocalTradeExecution(access.mode, false)) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_NOT_PERMITTED",
      "Real trading is off. Turn it on in the terminal's Real trade tab first.",
      { context: { mode: access.mode } },
    );
  }
}

function invalid(message: string): ElizaError {
  return exchangeError("TERMINAL_EXCHANGE_INVALID_REQUEST", message);
}

/** The per-order value cap, as a number for display and an exact decimal string. */
function resolveMaxOrderUsd(runtime: IAgentRuntime): {
  amount: number;
  text: string;
} {
  const raw = runtime.getSetting(TERMINAL_MAX_ORDER_USD_SETTING);
  if (raw === null || raw === undefined || raw === "") {
    return {
      amount: DEFAULT_TERMINAL_MAX_ORDER_USD,
      text: String(DEFAULT_TERMINAL_MAX_ORDER_USD),
    };
  }
  const text = String(raw).trim();
  const amount = Number(text);
  if (!DECIMAL_PATTERN.test(text) || !(amount > 0)) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_LIMIT_INVALID",
      `${TERMINAL_MAX_ORDER_USD_SETTING} must be a positive amount in USD, written like 100 or 250.50.`,
      { context: { value: text } },
    );
  }
  return { amount, text };
}

export function describeTerminalExchange(
  runtime: IAgentRuntime | null,
  mode: TradePermissionMode,
): WalletTerminalExchangeStatusResponse {
  const agentRuntime = requireRuntime(runtime);
  const venue = (name: WalletExchangeVenue) => {
    const missingSettings = missingVenueSettings(agentRuntime, name);
    return { configured: missingSettings.length === 0, missingSettings };
  };
  return {
    tradePermissionMode: mode,
    realTradingEnabled: canUseLocalTradeExecution(mode, false),
    venues: { kraken: venue("kraken"), okx: venue("okx") },
    bases: [...EXCHANGE_BASES],
    quotes: [...EXCHANGE_QUOTES],
    maxOrderUsd: resolveMaxOrderUsd(agentRuntime).amount,
    reviewSeconds: TERMINAL_EXCHANGE_REVIEW_TTL_MS / 1000,
  };
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`${name} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function assertWithinCap(value: string, quote: string, cap: string): void {
  if (compareDecimals(value, cap) > 0) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      `This order is worth ${value} ${quote}, over the ${cap} USD limit per order (${TERMINAL_MAX_ORDER_USD_SETTING}).`,
      { context: { orderValue: value, maxOrderUsd: cap } },
    );
  }
}

function positiveDecimal(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !DECIMAL_PATTERN.test(value) ||
    compareDecimals(value, "0") <= 0
  ) {
    throw invalid(`Enter a positive ${name}, such as 1.5.`);
  }
  return value;
}

export async function reviewTerminalExchangeOrder(
  runtime: IAgentRuntime | null,
  access: TerminalExchangeAccess,
  body: Record<string, unknown>,
): Promise<WalletTerminalExchangeReview> {
  assertPermitted(access);
  const agentRuntime = requireRuntime(runtime);
  const venue = oneOf(body.venue, EXCHANGE_VENUES, "venue");
  const base = oneOf(body.base, EXCHANGE_BASES, "base");
  const quote = oneOf(body.quote, EXCHANGE_QUOTES, "quote");
  if (base === quote) throw invalid("Pick two different currencies.");
  const side = oneOf<WalletTerminalTradeSide>(
    body.side,
    ["buy", "sell"],
    "side",
  );
  const quantity = positiveDecimal(body.quantity, "quantity");
  const price = positiveDecimal(body.price, "limit price");

  const orderValue = multiplyDecimals(quantity, price);
  const maxOrderUsd = resolveMaxOrderUsd(agentRuntime);
  assertWithinCap(orderValue, quote, maxOrderUsd.text);

  const missing = missingVenueSettings(agentRuntime, venue);
  if (missing.length > 0) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_NOT_CONFIGURED",
      `Set ${missing.join(", ")} in packages/agent/.env to use ${VENUE_NAME[venue]}.`,
      { context: { venue } },
    );
  }

  const client = exchangeClient(agentRuntime, venue);
  const intent: ExchangeOrderIntent = {
    base,
    quote,
    side,
    quantity,
    price,
    clientOrderId: crypto.randomUUID(),
  };
  const checks: WalletExchangeReviewCheck[] = [];
  let validated: Awaited<ReturnType<typeof client.validateOrder>>;
  let available: string;
  let bid: string | null = null;
  const spendCurrency = side === "buy" ? quote : base;
  const spendAmount = side === "buy" ? orderValue : quantity;
  try {
    validated = await client.validateOrder(intent);
    available = await client.availableBalance(spendCurrency);
    // A sell limit under the market fills at the bid, so its real value is
    // quantity x max(limit, bid); the limit alone would let a low limit
    // sell far more than the cap.
    if (side === "sell") bid = await client.bestBid(intent);
  } catch (error) {
    // error-policy:J2 venue failures become typed terminal exchange errors.
    fromVenueError(error, venue);
  }

  const { rules } = validated;
  for (const step of [
    rules.quantityStep,
    rules.priceStep,
    rules.minimumQuantity,
    bid,
  ]) {
    if (step !== null && !isPlainDecimal(step)) {
      throw exchangeError(
        "TERMINAL_EXCHANGE_UPSTREAM_FAILED",
        `${VENUE_NAME[venue]} reported a market value the terminal can't read (${step}).`,
      );
    }
  }
  const sellValue =
    bid === null ? null : multiplyDecimals(quantity, maxDecimal(price, bid));
  if (sellValue !== null) assertWithinCap(sellValue, quote, maxOrderUsd.text);
  if (rules.quantityStep && !isMultipleOf(quantity, rules.quantityStep)) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      `${VENUE_NAME[venue]} takes quantities in steps of ${rules.quantityStep} ${base}.`,
    );
  }
  if (rules.priceStep && !isMultipleOf(price, rules.priceStep)) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      `${VENUE_NAME[venue]} takes prices in steps of ${rules.priceStep} ${quote}.`,
    );
  }
  if (
    rules.minimumQuantity &&
    compareDecimals(quantity, rules.minimumQuantity) < 0
  ) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      `${VENUE_NAME[venue]}'s smallest order on ${rules.market} is ${rules.minimumQuantity} ${base}.`,
    );
  }
  if (!DECIMAL_PATTERN.test(available)) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_UPSTREAM_FAILED",
      `${VENUE_NAME[venue]} reported a balance the terminal can't read.`,
    );
  }
  if (compareDecimals(available, spendAmount) < 0) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      `${VENUE_NAME[venue]} shows ${available} ${spendCurrency} available; this order needs ${spendAmount}.`,
    );
  }

  checks.push({
    label: venue === "kraken" ? "Kraken validation" : "OKX market",
    detail:
      venue === "kraken"
        ? `Kraken accepted it in validate-only mode: ${validated.description}`
        : `${rules.market} is live; quantity step ${rules.quantityStep ?? "not reported"}, price step ${rules.priceStep ?? "not reported"}, minimum ${rules.minimumQuantity ?? "not reported"} ${base}.`,
  });
  if (bid !== null && sellValue !== null) {
    checks.push({
      label: "Market bid",
      detail:
        compareDecimals(price, bid) < 0
          ? `${VENUE_NAME[venue]}'s best bid is ${bid} ${quote}, above your limit, so this sell would fill at about ${bid}: worth about ${sellValue} ${quote}.`
          : `${VENUE_NAME[venue]}'s best bid is ${bid} ${quote}; your limit is at or above it.`,
    });
  }
  checks.push({
    label: "Funds",
    detail: `${available} ${spendCurrency} available; this order holds ${spendAmount}.`,
  });

  const now = Date.now();
  for (const [id, entry] of pendingOrders) {
    if (entry.expiresAt <= now) pendingOrders.delete(id);
  }
  const reviewId = crypto.randomUUID();
  const expiresAt = now + TERMINAL_EXCHANGE_REVIEW_TTL_MS;
  pendingOrders.set(reviewId, {
    expiresAt,
    venue,
    market: rules.market,
    intent,
    used: false,
  });
  return {
    reviewId,
    expiresAt: new Date(expiresAt).toISOString(),
    venue,
    market: rules.market,
    base,
    quote,
    side,
    orderType: "limit",
    quantity,
    price,
    orderValue,
    checks,
    clientOrderId: intent.clientOrderId,
  };
}

function journalOrder(
  pending: PendingExchangeOrder,
  update: Pick<WalletExchangeOrder, "orderId" | "state" | "detail">,
): WalletExchangeOrder {
  const now = new Date().toISOString();
  const order: WalletExchangeOrder = {
    clientOrderId: pending.intent.clientOrderId,
    venue: pending.venue,
    market: pending.market,
    side: pending.intent.side,
    quantity: pending.intent.quantity,
    price: pending.intent.price,
    filledQuantity: null,
    placedAt: now,
    checkedAt: now,
    ...update,
  };
  journal.set(order.clientOrderId, { order, intent: pending.intent });
  return order;
}

export async function executeTerminalExchangeOrder(
  runtime: IAgentRuntime | null,
  access: TerminalExchangeAccess,
  body: Record<string, unknown>,
): Promise<WalletExchangeOrder> {
  assertPermitted(access);
  const agentRuntime = requireRuntime(runtime);
  if (typeof body.reviewId !== "string" || body.reviewId.length === 0) {
    throw invalid("reviewId is required.");
  }
  if (body.confirm !== true) {
    throw invalid("Send confirm: true to place this order.");
  }
  const pending = pendingOrders.get(body.reviewId);
  if (!pending) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_NOT_FOUND",
      "This review wasn't found. Review the order again.",
    );
  }
  if (pending.used) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REVIEW_CLOSED",
      "This order was already sent.",
    );
  }
  if (pending.expiresAt <= Date.now()) {
    pendingOrders.delete(body.reviewId);
    throw exchangeError(
      "TERMINAL_EXCHANGE_REVIEW_CLOSED",
      "This review expired. Review the order again for a fresh check.",
    );
  }
  pending.used = true;

  const name = VENUE_NAME[pending.venue];
  try {
    const { orderId } = await exchangeClient(
      agentRuntime,
      pending.venue,
    ).placeOrder(pending.intent);
    return journalOrder(pending, {
      orderId,
      state: "submitted",
      detail: `${name} accepted the order.`,
    });
  } catch (error) {
    // error-policy:J4 a refused or lost send is recorded as its own order state.
    if (!(error instanceof ExchangeVenueError)) throw error;
    if (error.kind === "refused" || error.kind === "not-configured") {
      return journalOrder(pending, {
        orderId: null,
        state: "rejected",
        detail: error.message,
      });
    }
    return journalOrder(pending, {
      orderId: null,
      state: "unknown",
      detail: `${error.message} The order may or may not be on ${name}. Refresh it here, or look for client order id ${pending.intent.clientOrderId} on ${name}, before placing another.`,
    });
  }
}

export function listTerminalExchangeOrders(
  access: TerminalExchangeAccess,
): WalletTerminalExchangeOrdersResponse {
  assertPermitted(access);
  return {
    orders: [...journal.values()].map((entry) => entry.order).reverse(),
  };
}

function journalEntry(body: Record<string, unknown>): JournalEntry {
  if (typeof body.clientOrderId !== "string" || body.clientOrderId === "") {
    throw invalid("clientOrderId is required.");
  }
  const entry = journal.get(body.clientOrderId);
  if (!entry) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_NOT_FOUND",
      "That order wasn't placed from this terminal session.",
    );
  }
  return entry;
}

export async function refreshTerminalExchangeOrder(
  runtime: IAgentRuntime | null,
  access: TerminalExchangeAccess,
  body: Record<string, unknown>,
): Promise<WalletExchangeOrder> {
  assertPermitted(access);
  const agentRuntime = requireRuntime(runtime);
  const entry = journalEntry(body);
  if (entry.order.state === "rejected") return entry.order;
  const name = VENUE_NAME[entry.order.venue];
  let snapshot: Awaited<
    ReturnType<ReturnType<typeof exchangeClient>["readOrder"]>
  >;
  try {
    snapshot = await exchangeClient(agentRuntime, entry.order.venue).readOrder(
      entry.intent,
      entry.order.orderId,
    );
  } catch (error) {
    // error-policy:J2 venue failures become typed terminal exchange errors.
    fromVenueError(error, entry.order.venue);
  }
  entry.order = {
    ...entry.order,
    orderId: snapshot.orderId ?? entry.order.orderId,
    state: snapshot.state,
    filledQuantity: snapshot.filledQuantity,
    checkedAt: new Date().toISOString(),
    detail:
      snapshot.state === "unknown"
        ? `${name} has no open order with client order id ${entry.intent.clientOrderId}. Check its order history before placing another.`
        : `As reported by ${name}.`,
  };
  return entry.order;
}

export async function cancelTerminalExchangeOrder(
  runtime: IAgentRuntime | null,
  access: TerminalExchangeAccess,
  body: Record<string, unknown>,
): Promise<WalletExchangeOrder> {
  assertPermitted(access);
  const agentRuntime = requireRuntime(runtime);
  if (body.confirm !== true) {
    throw invalid("Send confirm: true to cancel this order.");
  }
  const entry = journalEntry(body);
  if (entry.order.orderId === null) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      "This order has no exchange order id yet. Refresh it first.",
    );
  }
  if (["filled", "canceled", "rejected"].includes(entry.order.state)) {
    throw exchangeError(
      "TERMINAL_EXCHANGE_REFUSED",
      `This order is already ${entry.order.state}.`,
    );
  }
  try {
    await exchangeClient(agentRuntime, entry.order.venue).cancelOrder(
      entry.intent,
      entry.order.orderId,
    );
  } catch (error) {
    // error-policy:J2 venue failures become typed terminal exchange errors.
    fromVenueError(error, entry.order.venue);
  }
  return refreshTerminalExchangeOrder(runtime, access, body);
}
