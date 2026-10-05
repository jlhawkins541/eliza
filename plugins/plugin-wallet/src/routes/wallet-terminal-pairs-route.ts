/**
 * Read-only DexScreener liquidity for the crypto terminal:
 * `GET /api/wallet/terminal/pairs?mint=<solana-mint>` serves the result of
 * `analytics/dexscreener/pairs.ts`.
 *
 * The route is public because DexScreener needs no key and the answer is
 * public market data about a mint with no account state in it. Answers are
 * cached per mint and concurrent misses share one request; when a refresh
 * fails the last good answer is served marked `stale`, and with nothing cached
 * the route answers 502 with the reason rather than an empty-but-healthy pair
 * list.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  DexScreenerError,
  type DexScreenerFetch,
  defaultDexScreenerFetch,
  fetchTokenPairs,
  normalizePairsMint,
} from "../analytics/dexscreener/pairs.js";
import type { WalletTerminalTokenPairsResponse } from "../contracts.js";

export const TERMINAL_PAIRS_PATH = "/api/wallet/terminal/pairs";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_LIMIT = 30;

interface CacheEntry {
  response: WalletTerminalTokenPairsResponse;
  expiresAt: number;
}

let pairsFetch: DexScreenerFetch = defaultDexScreenerFetch;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WalletTerminalTokenPairsResponse>>();
const refreshBuckets = new Map<string, { count: number; resetAt: number }>();

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "DexScreener request failed";
}

function loadPairs(mint: string): Promise<WalletTerminalTokenPairsResponse> {
  let pending = inFlight.get(mint);
  if (!pending) {
    pending = fetchTokenPairs(mint, pairsFetch)
      .then((response) => {
        cache.delete(mint);
        cache.set(mint, { response, expiresAt: Date.now() + CACHE_TTL_MS });
        while (cache.size > CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return response;
      })
      .finally(() => {
        inFlight.delete(mint);
      });
    inFlight.set(mint, pending);
  }
  return pending;
}

function resolveClientAddress(req: http.IncomingMessage): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const candidate = first?.split(",")[0]?.trim();
  return candidate || req.socket.remoteAddress || "unknown";
}

function consumeRefreshSlot(clientAddress: string): number | null {
  const now = Date.now();
  for (const [key, bucket] of refreshBuckets) {
    if (bucket.resetAt <= now) refreshBuckets.delete(key);
  }
  const bucket = refreshBuckets.get(clientAddress);
  if (!bucket) {
    refreshBuckets.set(clientAddress, {
      count: 1,
      resetAt: now + REFRESH_WINDOW_MS,
    });
    return null;
  }
  if (bucket.count >= REFRESH_LIMIT) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  bucket.count += 1;
  return null;
}

function markStale(
  response: WalletTerminalTokenPairsResponse,
  error: string,
): WalletTerminalTokenPairsResponse {
  return {
    ...response,
    stale: true,
    source: { ...response.source, stale: true, error },
  };
}

/** Serve the terminal pairs route; returns false when the path is not ours. */
export async function handleWalletTerminalPairsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== TERMINAL_PAIRS_PATH) return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const mint = normalizePairsMint(url.searchParams.get("mint"));
  if (mint === null) {
    sendJson(res, 400, { error: "mint must be a base58 Solana mint address" });
    return true;
  }
  res.setHeader("Cache-Control", "public, max-age=30");

  const cached = cache.get(mint);
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(res, 200, cached.response);
    return true;
  }
  if (!inFlight.has(mint)) {
    const retryAfter = consumeRefreshSlot(resolveClientAddress(req));
    if (retryAfter !== null) {
      if (cached) {
        sendJson(res, 200, markStale(cached.response, "Refresh rate limited"));
        return true;
      }
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Too many liquidity lookups" });
      return true;
    }
  }
  try {
    sendJson(res, 200, await loadPairs(mint));
  } catch (error) {
    // error-policy:J1 transport boundary: stale cache or a structured 502.
    const message = errorMessage(error);
    const kind = error instanceof DexScreenerError ? error.kind : "failed";
    logger.warn({ mint, kind, error: message }, "[DexScreener] lookup failed");
    if (cached) {
      sendJson(res, 200, markStale(cached.response, message));
      return true;
    }
    sendJson(res, 502, { error: message });
  }
  return true;
}

export function __resetWalletTerminalPairsRouteForTests(): void {
  pairsFetch = defaultDexScreenerFetch;
  cache.clear();
  inFlight.clear();
  refreshBuckets.clear();
}

export function __setWalletTerminalPairsFetchForTests(
  fetcher: DexScreenerFetch,
): void {
  pairsFetch = fetcher;
}

export function __expireWalletTerminalPairsCacheForTests(): void {
  for (const entry of cache.values()) entry.expiresAt = 0;
}
