/**
 * Read-only LunarCrush social signal for the crypto terminal:
 * `GET /api/wallet/terminal/social?symbol=<ticker>` serves the result of
 * `analytics/lunarcrush/social-signal.ts` using the agent's
 * `LUNARCRUSH_API_KEY`, which never leaves the server.
 *
 * The route is authenticated because every miss spends the key's quota. With
 * no key it answers `no-key` and requests nothing. Answers are cached per
 * symbol and concurrent misses share one request; when a refresh fails the
 * last good answer is served marked `stale`, and with nothing cached the route
 * answers 502 with the reason (a rejected key is logged once, not per call).
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  defaultLunarCrushFetch,
  fetchLunarCrushSocialSignal,
  LUNARCRUSH_API_KEY_SETTING,
  LunarCrushError,
  type LunarCrushFetch,
  normalizeSocialSymbol,
} from "../analytics/lunarcrush/social-signal.js";
import type { WalletTerminalSocialSignalResponse } from "../contracts.js";

export const TERMINAL_SOCIAL_PATH = "/api/wallet/terminal/social";

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_LIMIT = 20;

type FetchedSignal = Exclude<
  WalletTerminalSocialSignalResponse,
  { status: "no-key" }
>;

interface CacheEntry {
  response: FetchedSignal;
  expiresAt: number;
}

/** The setting reader the route needs from the agent runtime. */
export interface SocialRouteSettings {
  getSetting(key: string): unknown;
}

let socialFetch: LunarCrushFetch = defaultLunarCrushFetch;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<FetchedSignal>>();
const refreshBuckets = new Map<string, { count: number; resetAt: number }>();
let keyRejectionLogged = false;

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "LunarCrush request failed";
}

function readApiKey(settings: SocialRouteSettings | null): string | null {
  const raw = settings?.getSetting(LUNARCRUSH_API_KEY_SETTING);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function loadSignal(symbol: string, apiKey: string): Promise<FetchedSignal> {
  let pending = inFlight.get(symbol);
  if (!pending) {
    pending = fetchLunarCrushSocialSignal(symbol, apiKey, socialFetch)
      .then((response) => {
        keyRejectionLogged = false;
        cache.delete(symbol);
        cache.set(symbol, { response, expiresAt: Date.now() + CACHE_TTL_MS });
        while (cache.size > CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return response;
      })
      .finally(() => {
        inFlight.delete(symbol);
      });
    inFlight.set(symbol, pending);
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

function markStale(response: FetchedSignal, error: string): FetchedSignal {
  return {
    ...response,
    stale: true,
    source: { ...response.source, stale: true, error },
  };
}

/** Serve the social signal route; returns false when the path is not ours. */
export async function handleWalletTerminalSocialRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  settings: SocialRouteSettings | null,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== TERMINAL_SOCIAL_PATH) return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const symbol = normalizeSocialSymbol(url.searchParams.get("symbol"));
  if (symbol === null) {
    sendJson(res, 400, {
      error: "symbol must be a ticker of 1 to 20 letters or digits",
    });
    return true;
  }
  res.setHeader("Cache-Control", "private, max-age=60");

  const apiKey = readApiKey(settings);
  if (apiKey === null) {
    const body: WalletTerminalSocialSignalResponse = {
      status: "no-key",
      symbol,
    };
    sendJson(res, 200, body);
    return true;
  }

  const cached = cache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(res, 200, cached.response);
    return true;
  }
  if (!inFlight.has(symbol)) {
    const retryAfter = consumeRefreshSlot(resolveClientAddress(req));
    if (retryAfter !== null) {
      if (cached) {
        sendJson(res, 200, markStale(cached.response, "Refresh rate limited"));
        return true;
      }
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Too many social signal lookups" });
      return true;
    }
  }
  try {
    sendJson(res, 200, await loadSignal(symbol, apiKey));
  } catch (error) {
    // error-policy:J1 transport boundary: stale cache or a structured 502.
    const message = errorMessage(error);
    const kind = error instanceof LunarCrushError ? error.kind : "failed";
    if (kind === "key-rejected") {
      if (!keyRejectionLogged) {
        keyRejectionLogged = true;
        logger.error({ symbol }, "[LunarCrush] API key rejected");
      }
    } else {
      logger.warn(
        { symbol, kind, error: message },
        "[LunarCrush] lookup failed",
      );
    }
    if (cached) {
      sendJson(res, 200, markStale(cached.response, message));
      return true;
    }
    sendJson(res, 502, { error: message });
  }
  return true;
}

export function __resetWalletTerminalSocialRouteForTests(): void {
  socialFetch = defaultLunarCrushFetch;
  cache.clear();
  inFlight.clear();
  refreshBuckets.clear();
  keyRejectionLogged = false;
}

export function __setWalletTerminalSocialFetchForTests(
  fetcher: LunarCrushFetch,
): void {
  socialFetch = fetcher;
}

export function __expireWalletTerminalSocialCacheForTests(): void {
  for (const entry of cache.values()) entry.expiresAt = 0;
}
