/**
 * LunarCrush API v4 client for a coin's social signal: Galaxy Score, AltRank,
 * sentiment and social activity, looked up by ticker symbol with the
 * server-side `LUNARCRUSH_API_KEY`.
 *
 * Consumers are the terminal's social route and the agent's
 * `WALLET action=social_signal` handler. The result is a corroborating signal
 * only: a Galaxy Score under {@link LOW_GALAXY_SCORE} adds a caution beside the
 * GoPlus verdict, but it never changes that verdict or permits a trade. A symbol
 * LunarCrush doesn't track is its own `not-tracked` state, never a zero score,
 * and a rejected key or rate limit is a typed error so callers can show it
 * distinctly. The key is sent only as a bearer header and never appears in a
 * result, error message, or log line.
 */
import type {
  WalletSocialSignalScores,
  WalletSocialSignalSource,
  WalletTerminalSocialSignalResponse,
} from "../../contracts.js";

export const LUNARCRUSH_API_KEY_SETTING = "LUNARCRUSH_API_KEY";
const LUNARCRUSH_COIN_URL = "https://lunarcrush.com/api4/public/coins";
const FETCH_TIMEOUT_MS = 10_000;

/** A Galaxy Score under this adds a caution next to the GoPlus verdict. */
export const LOW_GALAXY_SCORE = 30;

/** Ticker symbols LunarCrush looks coins up by: letters and digits only. */
export const SOCIAL_SYMBOL_PATTERN = /^[A-Za-z0-9]{1,20}$/;

export type LunarCrushFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export type LunarCrushErrorKind = "key-rejected" | "rate-limited" | "failed";

/** LunarCrush refused, throttled, or failed the request. */
export class LunarCrushError extends Error {
  constructor(
    readonly kind: LunarCrushErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LunarCrushError";
  }
}

export const defaultLunarCrushFetch: LunarCrushFetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export function lunarCrushSource(
  stale: boolean,
  error: string | null,
): WalletSocialSignalSource {
  return {
    providerId: "lunarcrush",
    providerName: "LunarCrush",
    providerUrl: "https://lunarcrush.com",
    stale,
    error,
  };
}

/** Upper-case a valid symbol, or null when it isn't one. */
export function normalizeSocialSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.trim().replace(/^\$/, "");
  return SOCIAL_SYMBOL_PATTERN.test(symbol) ? symbol.toUpperCase() : null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Read the coin object of a LunarCrush `/coins/<symbol>/v1` payload. */
export function parseLunarCrushCoin(
  payload: unknown,
): WalletSocialSignalScores {
  if (!isObject(payload)) {
    throw new LunarCrushError(
      "failed",
      "LunarCrush response was not an object",
    );
  }
  const data = payload.data;
  if (!isObject(data)) {
    const message = optionalText(payload.error);
    throw new LunarCrushError(
      "failed",
      message
        ? `LunarCrush responded: ${message}`
        : "LunarCrush response had no coin data",
    );
  }
  const galaxyScore = finiteNumber(data.galaxy_score);
  return {
    coin: {
      id: finiteNumber(data.id),
      name: optionalText(data.name),
      symbol: optionalText(data.symbol),
    },
    galaxyScore,
    altRank: finiteNumber(data.alt_rank),
    sentimentPct: finiteNumber(data.sentiment),
    socialVolume24h: finiteNumber(data.social_volume_24h),
    interactions24h: finiteNumber(data.interactions_24h),
    addsCaution: galaxyScore !== null && galaxyScore < LOW_GALAXY_SCORE,
  };
}

/**
 * Fetch one symbol's signal. Returns `not-tracked` on a 404 and throws
 * {@link LunarCrushError} for a rejected key, a rate limit, or any other
 * failure. `apiKey` must be non-empty; callers handle the no-key state.
 */
export async function fetchLunarCrushSocialSignal(
  symbol: string,
  apiKey: string,
  fetcher: LunarCrushFetch = defaultLunarCrushFetch,
  now: () => Date = () => new Date(),
): Promise<Exclude<WalletTerminalSocialSignalResponse, { status: "no-key" }>> {
  const url = `${LUNARCRUSH_COIN_URL}/${encodeURIComponent(symbol.toLowerCase())}/v1`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "Eliza Wallet Social Signal/1.0",
      },
    });
  } catch (cause) {
    // error-policy:J2 network failures become the typed provider error.
    throw new LunarCrushError(
      "failed",
      `LunarCrush could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const checkedAt = now().toISOString();
  if (response.status === 401 || response.status === 403) {
    throw new LunarCrushError(
      "key-rejected",
      "The LunarCrush key was rejected. Check LUNARCRUSH_API_KEY and its plan.",
    );
  }
  if (response.status === 429) {
    throw new LunarCrushError(
      "rate-limited",
      "LunarCrush's rate limit for this key was reached.",
    );
  }
  if (response.status === 404) {
    return {
      status: "not-tracked",
      symbol,
      checkedAt,
      stale: false,
      source: lunarCrushSource(false, null),
    };
  }
  if (!response.ok) {
    throw new LunarCrushError(
      "failed",
      `LunarCrush responded ${response.status}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // error-policy:J3 an unreadable body is a typed provider failure.
    throw new LunarCrushError("failed", "LunarCrush response was not JSON");
  }
  return {
    status: "tracked",
    symbol,
    checkedAt,
    stale: false,
    source: lunarCrushSource(false, null),
    ...parseLunarCrushCoin(payload),
  };
}

function scoreLine(
  label: string,
  value: number | null,
  format: (n: number) => string,
) {
  return `- ${label}: ${value === null ? "not reported" : format(value)}.`;
}

/** Render a signal as complete planner-facing text, every field included. */
export function formatSocialSignal(
  signal: WalletTerminalSocialSignalResponse,
): string {
  if (signal.status === "no-key") {
    return `Social signal for ${signal.symbol} is off: add a LunarCrush key (${LUNARCRUSH_API_KEY_SETTING}) to turn it on.`;
  }
  const freshness = signal.stale
    ? `Last good data from ${signal.checkedAt}; the latest refresh failed (${signal.source.error ?? "unknown error"}).`
    : `Checked ${signal.checkedAt}.`;
  const caveat =
    "This is a social signal only. It can add caution but never clears a GoPlus flag or makes a token safe to trade, and a ticker can match a different coin than the mint you mean.";
  if (signal.status === "not-tracked") {
    return [
      `LunarCrush does not track ${signal.symbol}. That is not a low score; there is no social data.`,
      freshness,
      caveat,
    ].join("\n");
  }
  const matched = [
    signal.coin.name,
    signal.coin.symbol ? `(${signal.coin.symbol})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    `LunarCrush social signal for ${signal.symbol}${matched ? `, matched to ${matched}` : ""}${signal.coin.id === null ? "" : ` [id ${signal.coin.id}]`}:`,
    scoreLine("Galaxy Score", signal.galaxyScore, (n) => `${n} of 100`),
    scoreLine(
      "AltRank",
      signal.altRank,
      (n) => `#${n.toLocaleString("en-US")}`,
    ),
    scoreLine("Sentiment", signal.sentimentPct, (n) => `${n}% positive`),
    scoreLine(
      "Social volume (24h)",
      signal.socialVolume24h,
      (n) => `${n.toLocaleString("en-US")} posts`,
    ),
    scoreLine("Interactions (24h)", signal.interactions24h, (n) =>
      n.toLocaleString("en-US"),
    ),
    signal.addsCaution
      ? `CAUTION: the Galaxy Score is below ${LOW_GALAXY_SCORE}, so social activity is weak. Treat the token with more caution.`
      : `No social caution: the Galaxy Score is not below ${LOW_GALAXY_SCORE} or was not reported.`,
    freshness,
    caveat,
  ].join("\n");
}
