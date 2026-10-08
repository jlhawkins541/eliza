/**
 * CoinPaprika as the crypto terminal's backup market feed, used only when
 * CoinGecko fails. Builds the keyless CoinPaprika URLs and parses its ticker
 * list and price history into the terminal's market rows and chart points.
 *
 * Backup market rows carry CoinPaprika ids (`btc-bitcoin`), which the chart
 * route resolves directly; a CoinGecko id (`bitcoin`) is resolved through
 * CoinPaprika's search. Parsers reject malformed payloads rather than
 * returning a short or empty list as if it were healthy.
 */
import type {
  WalletTerminalChartDays,
  WalletTerminalChartPoint,
  WalletTerminalMarket,
} from "../contracts.js";

export const COINPAPRIKA_API_BASE = "https://api.coinpaprika.com/v1";

export const COINPAPRIKA_MARKET_PROVIDER = {
  providerId: "coinpaprika",
  providerName: "CoinPaprika (backup)",
  providerUrl: "https://coinpaprika.com/",
} as const;

/** CoinPaprika ids: lowercase symbol, a dash, then the name slug. */
export const COINPAPRIKA_ID_PATTERN = /^[a-z0-9]+-[a-z0-9-]+$/;

/** History interval per chart window, keeping each series a few hundred points. */
const HISTORY_INTERVAL: Record<WalletTerminalChartDays, string> = {
  1: "15m",
  7: "1h",
  30: "6h",
  90: "1d",
  365: "1d",
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coinPaprikaTickersUrl(): URL {
  const url = new URL(`${COINPAPRIKA_API_BASE}/tickers`);
  url.searchParams.set("quotes", "USD");
  return url;
}

export function coinPaprikaSearchUrl(query: string): URL {
  const url = new URL(`${COINPAPRIKA_API_BASE}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("c", "currencies");
  url.searchParams.set("limit", "1");
  return url;
}

export function coinPaprikaHistoryUrl(
  paprikaId: string,
  days: WalletTerminalChartDays,
  now: Date,
): URL {
  const url = new URL(
    `${COINPAPRIKA_API_BASE}/tickers/${encodeURIComponent(paprikaId)}/historical`,
  );
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("interval", HISTORY_INTERVAL[days]);
  url.searchParams.set("quote", "usd");
  url.searchParams.set("limit", "5000");
  return url;
}

/**
 * The top `limit` ranked rows of a CoinPaprika `/tickers` payload, by rank.
 * Rows without a positive rank, a finite USD price or a 24h change are
 * skipped; a payload that is not a list throws.
 */
export function parseCoinPaprikaTickers(
  payload: unknown,
  limit: number,
): WalletTerminalMarket[] {
  if (!Array.isArray(payload)) {
    throw new Error("CoinPaprika tickers payload was not a list");
  }
  const rows: WalletTerminalMarket[] = [];
  for (const entry of payload) {
    if (!isObject(entry)) continue;
    const usd =
      isObject(entry.quotes) && isObject(entry.quotes.USD)
        ? entry.quotes.USD
        : null;
    const { id, symbol, name, rank } = entry;
    const price = usd?.price;
    const change = usd?.percent_change_24h;
    if (
      typeof id !== "string" ||
      !COINPAPRIKA_ID_PATTERN.test(id) ||
      typeof symbol !== "string" ||
      typeof name !== "string" ||
      typeof rank !== "number" ||
      rank <= 0 ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0 ||
      typeof change !== "number" ||
      !Number.isFinite(change)
    ) {
      continue;
    }
    rows.push({
      id,
      symbol: symbol.toUpperCase(),
      name,
      priceUsd: price,
      change24hPct: change,
      marketCapRank: rank,
      imageUrl: null,
    });
  }
  rows.sort(
    (left, right) => (left.marketCapRank ?? 0) - (right.marketCapRank ?? 0),
  );
  return rows.slice(0, limit);
}

/** The first currency id in a CoinPaprika `/search` payload, or null. */
export function parseCoinPaprikaSearch(payload: unknown): string | null {
  if (!isObject(payload) || !Array.isArray(payload.currencies)) {
    throw new Error("CoinPaprika search payload had no currencies list");
  }
  const first = payload.currencies[0];
  return isObject(first) &&
    typeof first.id === "string" &&
    COINPAPRIKA_ID_PATTERN.test(first.id)
    ? first.id
    : null;
}

/** Parse CoinPaprika `/tickers/{id}/historical` into ordered USD points. */
export function parseCoinPaprikaHistory(
  payload: unknown,
): WalletTerminalChartPoint[] {
  if (!Array.isArray(payload)) {
    throw new Error("CoinPaprika history payload was not a list");
  }
  const points: WalletTerminalChartPoint[] = [];
  for (const entry of payload) {
    const t = isObject(entry)
      ? Date.parse(String(entry.timestamp))
      : Number.NaN;
    const priceUsd = isObject(entry) ? entry.price : undefined;
    if (
      !Number.isFinite(t) ||
      typeof priceUsd !== "number" ||
      !Number.isFinite(priceUsd) ||
      priceUsd < 0
    ) {
      throw new Error("CoinPaprika history entry was malformed");
    }
    points.push({ t, priceUsd });
  }
  points.sort((left, right) => left.t - right.t);
  return points;
}
