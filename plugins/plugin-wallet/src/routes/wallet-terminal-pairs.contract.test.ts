/**
 * Drives the real DexScreener pairs route and parser with a sample
 * token-pairs/v1 payload and failure variants through an injected fetch, so no
 * network is used. Covers the found and no-pairs states, deepest-first
 * ranking, the thin-liquidity and new-pool cautions, mint validation, rate
 * limits with and without a cached answer, malformed bodies, upstream 429 and
 * 500, caching, and shared concurrent misses.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PAIRS,
  summarizePairs,
  THIN_LIQUIDITY_USD,
} from "../analytics/dexscreener/pairs";
import type {
  WalletTerminalTokenPairsResponse,
  WalletTokenPair,
} from "../contracts";
import {
  __expireWalletTerminalPairsCacheForTests,
  __resetWalletTerminalPairsRouteForTests,
  __setWalletTerminalPairsFetchForTests,
  handleWalletTerminalPairsRoute,
} from "./wallet-terminal-pairs-route";

const sample = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "__fixtures__/dexscreener-token-pairs.sample.json",
    ),
    "utf8",
  ),
) as { mint: string; dexscreener: Array<Record<string, unknown>> };

const MINT = sample.mint;
const OTHER_MINT = "So11111111111111111111111111111111111111112";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (href: string) => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  __setWalletTerminalPairsFetchForTests(async (input) => {
    const href = String(input);
    calls.push(href);
    return handler(href);
  });
  return calls;
}

async function call(url: string, method = "GET") {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
    json<T>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  const handled = await handleWalletTerminalPairsRoute(
    {
      method,
      url,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
  );
  return { handled, res };
}

const path = (mint: string) =>
  `/api/wallet/terminal/pairs?mint=${encodeURIComponent(mint)}`;

afterEach(() => {
  __resetWalletTerminalPairsRouteForTests();
});

function pair(overrides: Partial<WalletTokenPair> = {}): WalletTokenPair {
  return {
    pairAddress: "pair-1",
    dexId: "raydium",
    url: null,
    baseSymbol: "BONK",
    baseName: "Bonk",
    baseAddress: MINT,
    quoteSymbol: "SOL",
    priceUsd: "0.0001",
    priceChange24hPct: 1,
    liquidityUsd: 50_000,
    volume24hUsd: 10_000,
    fdvUsd: null,
    pairCreatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizePairs", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("reports no-pairs for a mint with no pool", () => {
    expect(summarizePairs(MINT, [], now)).toEqual({
      status: "no-pairs",
      mint: MINT,
      checkedAt: now.toISOString(),
      stale: false,
      source: {
        providerId: "dexscreener",
        providerName: "DexScreener",
        providerUrl: "https://dexscreener.com",
        stale: false,
        error: null,
      },
    });
  });

  it("ranks pairs deepest first and keeps at most MAX_PAIRS", () => {
    const pairs = Array.from({ length: MAX_PAIRS + 3 }, (_, index) =>
      pair({ pairAddress: `pair-${index}`, liquidityUsd: index * 1_000 }),
    );
    const summary = summarizePairs(MINT, pairs, now);
    if (summary.status !== "found") throw new Error("expected found");
    expect(summary.pairs).toHaveLength(MAX_PAIRS);
    expect(summary.pairCount).toBe(MAX_PAIRS + 3);
    expect(summary.pairs.map((entry) => entry.liquidityUsd)).toEqual(
      [...summary.pairs]
        .map((entry) => entry.liquidityUsd)
        .sort((a, b) => (b ?? 0) - (a ?? 0)),
    );
    expect(summary.pairs[0]?.pairAddress).toBe(`pair-${MAX_PAIRS + 2}`);
  });

  it("totals every reported pair, not only the ranked ones", () => {
    const summary = summarizePairs(
      MINT,
      [
        pair({ pairAddress: "a", liquidityUsd: 30_000, volume24hUsd: 1_000 }),
        pair({ pairAddress: "b", liquidityUsd: 20_000, volume24hUsd: 2_000 }),
        pair({ pairAddress: "c", liquidityUsd: null, volume24hUsd: null }),
      ],
      now,
    );
    if (summary.status !== "found") throw new Error("expected found");
    expect(summary.totalLiquidityUsd).toBe(50_000);
    expect(summary.totalVolume24hUsd).toBe(3_000);
    expect(summary.addsCaution).toBe(false);
  });

  it("cautions on thin liquidity", () => {
    const summary = summarizePairs(
      MINT,
      [pair({ liquidityUsd: THIN_LIQUIDITY_USD - 1 })],
      now,
    );
    if (summary.status !== "found") throw new Error("expected found");
    expect(summary).toMatchObject({
      thinLiquidity: true,
      newPool: false,
      addsCaution: true,
    });
  });

  it("cautions on a pool less than a day old", () => {
    const summary = summarizePairs(
      MINT,
      [
        pair({
          liquidityUsd: 500_000,
          pairCreatedAt: new Date(now.getTime() - 3_600_000).toISOString(),
        }),
      ],
      now,
    );
    if (summary.status !== "found") throw new Error("expected found");
    expect(summary).toMatchObject({
      thinLiquidity: false,
      newPool: true,
      addsCaution: true,
    });
    expect(summary.oldestPairCreatedAt).toBe(
      new Date(now.getTime() - 3_600_000).toISOString(),
    );
  });

  it("takes the oldest pool's age, not the newest", () => {
    const summary = summarizePairs(
      MINT,
      [
        pair({
          pairAddress: "old",
          liquidityUsd: 400_000,
          pairCreatedAt: "2023-01-01T00:00:00.000Z",
        }),
        pair({
          pairAddress: "new",
          liquidityUsd: 400_000,
          pairCreatedAt: now.toISOString(),
        }),
      ],
      now,
    );
    if (summary.status !== "found") throw new Error("expected found");
    expect(summary.oldestPairCreatedAt).toBe("2023-01-01T00:00:00.000Z");
    expect(summary.newPool).toBe(false);
  });
});

describe("terminal pairs route", () => {
  it("parses the sample payload into ranked pairs", async () => {
    installFetch(() => jsonResponse(sample.dexscreener));
    const { handled, res } = await call(path(MINT));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalTokenPairsResponse>();
    if (body.status !== "found") throw new Error("expected found");
    expect(body.pairCount).toBe(2);
    expect(body.pairs[0]).toMatchObject({
      pairAddress: "HVNVi2sqjjnWcBtVwnBDv7nhDiikmvRRbEcA5DtQ2hsK",
      dexId: "raydium",
      baseSymbol: "BONK",
      quoteSymbol: "SOL",
      priceUsd: "0.00002841",
      priceChange24hPct: -3.57,
      liquidityUsd: 4_210_000,
      volume24hUsd: 5_460_000,
      fdvUsd: 2_180_000_000,
      pairCreatedAt: "2023-01-01T00:00:00.000Z",
    });
    expect(body.totalLiquidityUsd).toBe(5_022_000);
    expect(body.addsCaution).toBe(false);
    expect(body.source.stale).toBe(false);
  });

  it("accepts a bare pairs object as well as an array", async () => {
    installFetch(() => jsonResponse({ pairs: sample.dexscreener }));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(200);
    expect(res.json<WalletTerminalTokenPairsResponse>().status).toBe("found");
  });

  it("reports no-pairs for an empty list", async () => {
    installFetch(() => jsonResponse([]));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(200);
    expect(res.json<WalletTerminalTokenPairsResponse>()).toMatchObject({
      status: "no-pairs",
      mint: MINT,
    });
  });

  it("skips pairs with no pair address rather than inventing one", async () => {
    installFetch(() => jsonResponse([{ dexId: "raydium" }]));
    const { res } = await call(path(MINT));
    expect(res.json<WalletTerminalTokenPairsResponse>().status).toBe(
      "no-pairs",
    );
  });

  it("rejects a mint that is not base58", async () => {
    const calls = installFetch(() => jsonResponse([]));
    const { res } = await call("/api/wallet/terminal/pairs?mint=not-a-mint");
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing mint", async () => {
    const { res } = await call("/api/wallet/terminal/pairs");
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-GET method", async () => {
    const { handled, res } = await call(path(MINT), "POST");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
  });

  it("leaves another path alone", async () => {
    const { handled } = await call("/api/wallet/terminal/social?symbol=BONK");
    expect(handled).toBe(false);
  });

  it("serves a cached answer without a second request", async () => {
    const calls = installFetch(() => jsonResponse(sample.dexscreener));
    await call(path(MINT));
    await call(path(MINT));
    expect(calls).toHaveLength(1);
  });

  it("caches per mint", async () => {
    const calls = installFetch(() => jsonResponse([]));
    await call(path(MINT));
    await call(path(OTHER_MINT));
    expect(calls).toHaveLength(2);
  });

  it("shares one request between concurrent misses", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    const calls = installFetch(async () => {
      await gate;
      return jsonResponse(sample.dexscreener);
    });
    const pending = Promise.all([call(path(MINT)), call(path(MINT))]);
    release?.();
    const [first, second] = await pending;
    expect(calls).toHaveLength(1);
    expect(first.res.statusCode).toBe(200);
    expect(second.res.statusCode).toBe(200);
  });

  it("answers 502 when DexScreener fails and nothing is cached", async () => {
    installFetch(() => jsonResponse({ error: "boom" }, 500));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toContain("HTTP 500");
  });

  it("answers 502 with the rate-limit reason", async () => {
    installFetch(() => jsonResponse({ error: "slow down" }, 429));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toContain("rate limiting");
  });

  it("answers 502 for a body that is not a pair list", async () => {
    installFetch(() => jsonResponse({ unexpected: true }));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(502);
  });

  it("answers 502 for a body that is not JSON", async () => {
    installFetch(
      () => new Response("<html>nope</html>", { status: 200 }) as Response,
    );
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(502);
  });

  it("serves the last good answer marked stale after a failure", async () => {
    let fail = false;
    installFetch(() =>
      fail
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse(sample.dexscreener),
    );
    await call(path(MINT));
    __expireWalletTerminalPairsCacheForTests();
    fail = true;
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalTokenPairsResponse>();
    expect(body.stale).toBe(true);
    expect(body.source.error).toContain("HTTP 500");
    if (body.status !== "found") throw new Error("expected found");
    expect(body.pairCount).toBe(2);
  });

  it("rate limits refreshes and then serves a stale answer", async () => {
    const calls = installFetch(() => jsonResponse(sample.dexscreener));
    await call(path(MINT));
    for (let index = 0; index < 40; index += 1) {
      __expireWalletTerminalPairsCacheForTests();
      await call(path(MINT));
    }
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(200);
    expect(res.json<WalletTerminalTokenPairsResponse>().stale).toBe(true);
    expect(calls.length).toBeLessThan(40);
  });

  it("answers 429 when rate limited with nothing cached", async () => {
    installFetch(() => jsonResponse([]));
    for (let index = 0; index < 40; index += 1) {
      await call(path(`Mint${index}1111111111111111111111111111111111`));
    }
    const { res } = await call(
      path("ZzZz1111111111111111111111111111111111111"),
    );
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeDefined();
  });
});
