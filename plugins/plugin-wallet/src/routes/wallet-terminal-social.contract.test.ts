/**
 * Drives the real LunarCrush social route and parser with a sample LunarCrush
 * v4 coin payload and failure variants through an injected fetch, so no key
 * or network is used. Covers the no-key state (no request sent), a tracked
 * coin, the low-score caution, not-tracked, a rejected key, rate limits with
 * and without a cached answer, malformed bodies, symbol validation, caching,
 * shared concurrent misses, and that the key travels only in the header.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLunarCrushCoin } from "../analytics/lunarcrush/social-signal";
import type { WalletTerminalSocialSignalResponse } from "../contracts";
import {
  __expireWalletTerminalSocialCacheForTests,
  __resetWalletTerminalSocialRouteForTests,
  __setWalletTerminalSocialFetchForTests,
  handleWalletTerminalSocialRoute,
} from "./wallet-terminal-social-route";

const sample = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "__fixtures__/lunarcrush-coin.sample.json"),
    "utf8",
  ),
) as { symbol: string; lunarcrush: { data: Record<string, unknown> } };
const KEY = "test-lunarcrush-key";
const withKey = {
  getSetting: (key: string) => (key === "LUNARCRUSH_API_KEY" ? KEY : null),
};
const noKey = { getSetting: () => null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withData(patch: Record<string, unknown>): unknown {
  return {
    ...sample.lunarcrush,
    data: { ...sample.lunarcrush.data, ...patch },
  };
}

function installFetch(
  handler: (href: string) => Response | Promise<Response>,
): Array<{ href: string; headers: Record<string, string> }> {
  const calls: Array<{ href: string; headers: Record<string, string> }> = [];
  __setWalletTerminalSocialFetchForTests(async (input, init) => {
    const href = String(input);
    calls.push({ href, headers: init.headers as Record<string, string> });
    return handler(href);
  });
  return calls;
}

async function call(
  url: string,
  settings: { getSetting(key: string): unknown } | null = withKey,
  method = "GET",
) {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
    json<T>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  const handled = await handleWalletTerminalSocialRoute(
    {
      method,
      url,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    settings,
  );
  return { handled, res };
}

const path = (symbol: string) =>
  `/api/wallet/terminal/social?symbol=${encodeURIComponent(symbol)}`;

afterEach(() => {
  __resetWalletTerminalSocialRouteForTests();
});

describe("parseLunarCrushCoin", () => {
  it("reads every score and leaves unreported ones null", () => {
    expect(parseLunarCrushCoin(sample.lunarcrush)).toEqual({
      coin: { id: 59311, name: "Bonk", symbol: "BONK" },
      galaxyScore: 62,
      altRank: 148,
      sentimentPct: 78,
      socialVolume24h: 4210,
      interactions24h: 1_832_400,
      addsCaution: false,
    });
    expect(
      parseLunarCrushCoin(withData({ galaxy_score: null, sentiment: "n/a" })),
    ).toMatchObject({
      galaxyScore: null,
      sentimentPct: null,
      addsCaution: false,
    });
  });

  it("adds caution only for a reported Galaxy Score below 30", () => {
    expect(
      parseLunarCrushCoin(withData({ galaxy_score: 29 })).addsCaution,
    ).toBe(true);
    expect(
      parseLunarCrushCoin(withData({ galaxy_score: 30 })).addsCaution,
    ).toBe(false);
  });

  it("rejects a body with no coin data", () => {
    expect(() => parseLunarCrushCoin([])).toThrow(/not an object/);
    expect(() => parseLunarCrushCoin({ error: "Invalid coin" })).toThrow(
      /LunarCrush responded: Invalid coin/,
    );
    expect(() => parseLunarCrushCoin({ data: null })).toThrow(/no coin data/);
  });
});

describe("GET /api/wallet/terminal/social", () => {
  it("answers no-key without calling LunarCrush when the key is unset", async () => {
    const calls = installFetch(() => jsonResponse(sample.lunarcrush));
    for (const settings of [noKey, null, { getSetting: () => "  " }]) {
      const { res } = await call(path("bonk"), settings);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "no-key", symbol: "BONK" });
    }
    expect(calls).toEqual([]);
  });

  it("serves a tracked coin and sends the key only as a bearer header", async () => {
    const calls = installFetch(() => jsonResponse(sample.lunarcrush));
    const { handled, res } = await call(path("$bonk"));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalSocialSignalResponse>();
    expect(body).toMatchObject({
      status: "tracked",
      symbol: "BONK",
      galaxyScore: 62,
      altRank: 148,
      addsCaution: false,
      stale: false,
      source: { providerId: "lunarcrush", stale: false, error: null },
    });
    expect(calls).toEqual([
      {
        href: "https://lunarcrush.com/api4/public/coins/bonk/v1",
        headers: expect.objectContaining({ authorization: `Bearer ${KEY}` }),
      },
    ]);
    expect(res.body).not.toContain(KEY);
  });

  it("reports a 404 as not tracked, never as a score", async () => {
    installFetch(() => jsonResponse({ error: "not found" }, 404));
    const { res } = await call(path("NOPE"));
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalSocialSignalResponse>();
    expect(body.status).toBe("not-tracked");
    expect(body).not.toHaveProperty("galaxyScore");
  });

  it.each([
    [
      401,
      "The LunarCrush key was rejected. Check LUNARCRUSH_API_KEY and its plan.",
    ],
    [
      403,
      "The LunarCrush key was rejected. Check LUNARCRUSH_API_KEY and its plan.",
    ],
    [429, "LunarCrush's rate limit for this key was reached."],
    [500, "LunarCrush responded 500"],
  ])(
    "answers 502 with the reason for HTTP %i and nothing cached",
    async (status, error) => {
      installFetch(() => jsonResponse({}, status));
      const { res } = await call(path("BONK"));
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error });
      expect(res.body).not.toContain(KEY);
    },
  );

  it("answers 502 for a malformed body", async () => {
    installFetch(() => new Response("<html>", { status: 200 }));
    const { res } = await call(path("BONK"));
    expect(res.json()).toEqual({ error: "LunarCrush response was not JSON" });
  });

  it("serves the last good answer marked stale when a refresh is rate limited", async () => {
    let limited = false;
    installFetch(() =>
      limited ? jsonResponse({}, 429) : jsonResponse(sample.lunarcrush),
    );
    await call(path("BONK"));
    limited = true;
    __expireWalletTerminalSocialCacheForTests();
    const { res } = await call(path("BONK"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "tracked",
      galaxyScore: 62,
      stale: true,
      source: {
        stale: true,
        error: "LunarCrush's rate limit for this key was reached.",
      },
    });
  });

  it("caches per symbol and shares concurrent misses", async () => {
    const calls = installFetch(() => jsonResponse(sample.lunarcrush));
    await Promise.all([
      call(path("BONK")),
      call(path("bonk")),
      call(path("BONK")),
    ]);
    await call(path("BONK"));
    expect(calls).toHaveLength(1);
  });

  it.each([[""], ["BO NK"], ["../coins"], ["A".repeat(21)]])(
    "rejects symbol %j before any request",
    async (symbol) => {
      const calls = installFetch(() => jsonResponse(sample.lunarcrush));
      const { res } = await call(path(symbol));
      expect(res.statusCode).toBe(400);
      expect(calls).toEqual([]);
    },
  );

  it("rejects non-GET methods and ignores foreign paths", async () => {
    installFetch(() => jsonResponse(sample.lunarcrush));
    expect((await call(path("BONK"), withKey, "POST")).res.statusCode).toBe(
      405,
    );
    expect((await call("/api/wallet/terminal/markets")).handled).toBe(false);
  });
});
