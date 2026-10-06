/**
 * DexScreener client for the trading pairs behind one Solana mint: price,
 * liquidity, 24-hour volume and change, fully diluted valuation, and how long
 * the pool has existed.
 *
 * Consumers are the terminal's pairs route and the agent's
 * `WALLET action=token_pairs` handler. DexScreener needs no API key, so the
 * route serving this is public. The numbers are liquidity context, not a
 * verdict: thin liquidity or a pool minutes old adds a caution next to the
 * GoPlus verdict, and never clears one or permits a trade. A mint DexScreener
 * knows no pairs for is its own `no-pairs` state rather than a zero price, and
 * a rate limit is a typed error so the caller can show it distinctly.
 */
import type {
  WalletTerminalTokenPairsResponse,
  WalletTokenPair,
  WalletTokenPairsSource,
} from "../../contracts.js";

const DEXSCREENER_TOKEN_PAIRS_URL =
  "https://api.dexscreener.com/token-pairs/v1/solana";
const FETCH_TIMEOUT_MS = 10_000;

/** Pairs with less liquidity than this add a caution beside the verdict. */
export const THIN_LIQUIDITY_USD = 10_000;

/** Pools younger than this add a caution beside the verdict. */
export const NEW_POOL_AGE_MS = 24 * 60 * 60 * 1000;

/** Base58 Solana mint addresses, the only input this client accepts. */
export const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type DexScreenerFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export type DexScreenerErrorKind = "rate-limited" | "failed";

/** DexScreener throttled or failed the request. */
export class DexScreenerError extends Error {
  constructor(
    readonly kind: DexScreenerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DexScreenerError";
  }
}

export const defaultDexScreenerFetch: DexScreenerFetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export function dexScreenerSource(
  stale: boolean,
  error: string | null,
): WalletTokenPairsSource {
  return {
    providerId: "dexscreener",
    providerName: "DexScreener",
    providerUrl: "https://dexscreener.com",
    stale,
    error,
  };
}

/** Return a valid Solana mint unchanged, or null when it isn't one. */
export function normalizePairsMint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mint = value.trim();
  return SOLANA_MINT_PATTERN.test(mint) ? mint : null;
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

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parsePair(raw: unknown): WalletTokenPair | null {
  if (!isObject(raw)) return null;
  const pairAddress = text(raw.pairAddress);
  if (pairAddress === null) return null;
  const base = isObject(raw.baseToken) ? raw.baseToken : {};
  const quote = isObject(raw.quoteToken) ? raw.quoteToken : {};
  const liquidity = isObject(raw.liquidity) ? raw.liquidity : {};
  const volume = isObject(raw.volume) ? raw.volume : {};
  const change = isObject(raw.priceChange) ? raw.priceChange : {};
  const createdAtMs = finiteNumber(raw.pairCreatedAt);
  return {
    pairAddress,
    dexId: text(raw.dexId),
    url: text(raw.url),
    baseSymbol: text(base.symbol),
    baseName: text(base.name),
    baseAddress: text(base.address),
    quoteSymbol: text(quote.symbol),
    priceUsd: text(raw.priceUsd),
    priceChange24hPct: finiteNumber(change.h24),
    liquidityUsd: finiteNumber(liquidity.usd),
    volume24hUsd: finiteNumber(volume.h24),
    fdvUsd: finiteNumber(raw.fdv),
    pairCreatedAt:
      createdAtMs !== null && createdAtMs > 0
        ? new Date(createdAtMs).toISOString()
        : null,
  };
}

function liquidityOf(pair: WalletTokenPair): number {
  return pair.liquidityUsd ?? 0;
}

/**
 * Sort every parsed pair by liquidity and derive the totals and cautions the
 * terminal shows beside them. No pair is dropped: the list is model context.
 */
export function summarizePairs(
  mint: string,
  pairs: WalletTokenPair[],
  now: Date = new Date(),
): WalletTerminalTokenPairsResponse {
  const checkedAt = now.toISOString();
  const source = dexScreenerSource(false, null);
  if (pairs.length === 0) {
    return { status: "no-pairs", mint, checkedAt, stale: false, source };
  }
  const ranked = [...pairs].sort((a, b) => liquidityOf(b) - liquidityOf(a));
  const totalLiquidityUsd = pairs.reduce(
    (total, pair) => total + liquidityOf(pair),
    0,
  );
  const totalVolume24hUsd = pairs.reduce(
    (total, pair) => total + (pair.volume24hUsd ?? 0),
    0,
  );
  const createdTimes = pairs
    .map((pair) =>
      pair.pairCreatedAt === null ? null : Date.parse(pair.pairCreatedAt),
    )
    .filter((time): time is number => time !== null && Number.isFinite(time));
  const oldestPairCreatedAt =
    createdTimes.length > 0
      ? new Date(Math.min(...createdTimes)).toISOString()
      : null;
  const thinLiquidity = totalLiquidityUsd < THIN_LIQUIDITY_USD;
  const newPool =
    oldestPairCreatedAt !== null &&
    now.getTime() - Date.parse(oldestPairCreatedAt) < NEW_POOL_AGE_MS;
  // A pool with no reported age could be minutes old, so it is not assumed
  // safe; an unknown age on every pool adds the same caution as a new pool.
  const poolAgeUnknown = oldestPairCreatedAt === null;
  return {
    status: "found",
    mint,
    checkedAt,
    stale: false,
    source,
    pairs: ranked,
    pairCount: pairs.length,
    totalLiquidityUsd,
    totalVolume24hUsd,
    oldestPairCreatedAt,
    thinLiquidity,
    newPool,
    poolAgeUnknown,
    addsCaution: thinLiquidity || newPool || poolAgeUnknown,
  };
}

/** Read every DexScreener pair for one Solana mint and summarize them. */
export async function fetchTokenPairs(
  mint: string,
  fetcher: DexScreenerFetch = defaultDexScreenerFetch,
  now: Date = new Date(),
): Promise<WalletTerminalTokenPairsResponse> {
  const url = `${DEXSCREENER_TOKEN_PAIRS_URL}/${encodeURIComponent(mint)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    // error-policy:J2 context-adding rethrow: a typed error for the caller.
    throw new DexScreenerError(
      "failed",
      `DexScreener could not be reached: ${
        error instanceof Error ? error.message : "request failed"
      }`,
    );
  }
  if (response.status === 429) {
    throw new DexScreenerError(
      "rate-limited",
      "DexScreener is rate limiting this terminal. Try again in a minute.",
    );
  }
  if (!response.ok) {
    throw new DexScreenerError(
      "failed",
      `DexScreener returned HTTP ${response.status}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing: an unreadable body is an error.
    throw new DexScreenerError(
      "failed",
      `DexScreener returned a body that is not JSON: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
    );
  }
  const rawPairs = Array.isArray(body)
    ? body
    : isObject(body) && Array.isArray(body.pairs)
      ? body.pairs
      : null;
  if (rawPairs === null) {
    throw new DexScreenerError(
      "failed",
      "DexScreener returned no pair list for this mint",
    );
  }
  const pairs = rawPairs
    .map(parsePair)
    .filter((pair): pair is WalletTokenPair => pair !== null);
  return summarizePairs(mint, pairs, now);
}

function usd(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function ageOf(createdAt: string | null, now: Date): string {
  if (createdAt === null) return "unknown age";
  const ms = now.getTime() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} minutes old`;
  if (hours < 48) return `${Math.round(hours)} hours old`;
  return `${Math.round(hours / 24)} days old`;
}

/** The planner-facing text for one mint's liquidity. */
export function formatTokenPairs(
  response: WalletTerminalTokenPairsResponse,
  now: Date = new Date(),
): string {
  const header = `Liquidity for ${response.mint} (DexScreener)`;
  if (response.status === "no-pairs") {
    return `${header}\nDexScreener knows no trading pairs for this mint. There may be no pool yet, or the mint may be wrong. Treat it as untradeable until a pool exists.`;
  }
  const lines = [
    header,
    `Pairs: ${response.pairCount}`,
    `Total liquidity: ${usd(response.totalLiquidityUsd)}`,
    `24h volume: ${usd(response.totalVolume24hUsd)}`,
    `Oldest pool: ${ageOf(response.oldestPairCreatedAt, now)}`,
  ];
  for (const pair of response.pairs) {
    const pairName = `${pair.baseSymbol ?? "?"}/${pair.quoteSymbol ?? "?"}`;
    const change =
      pair.priceChange24hPct === null
        ? "24h change unknown"
        : `${pair.priceChange24hPct > 0 ? "+" : ""}${pair.priceChange24hPct.toFixed(2)}% 24h`;
    lines.push(
      `- ${pairName} on ${pair.dexId ?? "an unnamed DEX"}: price ${
        pair.priceUsd === null ? "unknown" : `$${pair.priceUsd}`
      }, liquidity ${usd(pair.liquidityUsd)}, ${change}`,
    );
  }
  if (response.thinLiquidity) {
    lines.push(
      `CAUTION: total liquidity is under ${usd(THIN_LIQUIDITY_USD)}. A trade of any size will move the price and may be hard to exit.`,
    );
  }
  if (response.newPool) {
    lines.push(
      "CAUTION: the oldest pool is less than a day old. New pools are where rug pulls happen.",
    );
  }
  if (response.poolAgeUnknown) {
    lines.push(
      "CAUTION: DexScreener reports no creation time for any pool, so it may be brand new.",
    );
  }
  lines.push(
    "Liquidity can add caution but never clears a GoPlus flag and never makes a token safe to buy.",
  );
  return lines.join("\n");
}
