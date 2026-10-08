/**
 * Drives the WALLET `token_pairs` handler with a sample DexScreener
 * token-pairs payload through an injected fetch, and the real
 * `walletRouterAction` dispatch for an input that resolves before any network
 * call. Deterministic and keyless; covers mint resolution, the complete
 * planner-facing text, the liquidity cautions, no-pairs, and typed failures.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { walletRouterAction } from "../../chains/wallet-action";
import type { DexScreenerFetch } from "./pairs";
import { resolvePairsMint, tokenPairsHandler } from "./pairs-action";

const sample = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../routes/__fixtures__/dexscreener-token-pairs.sample.json",
    ),
    "utf8",
  ),
) as { mint: string; dexscreener: Array<Record<string, unknown>> };

const MINT = sample.mint;
const OTHER = "So11111111111111111111111111111111111111112";
const runtime = {} as IAgentRuntime;

const msg = (text: string): Memory =>
  ({ content: { text } }) as unknown as Memory;

function recordingFetch(response: () => Response): {
  fetcher: DexScreenerFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (input) => {
      calls.push(String(input));
      return response();
    },
  };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

describe("resolvePairsMint", () => {
  it("prefers a mint param, then a single mint in the text", () => {
    expect(resolvePairsMint(msg("liquidity?"), { address: MINT })).toEqual({
      mint: MINT,
    });
    expect(resolvePairsMint(msg(`how deep is ${MINT}?`))).toEqual({
      mint: MINT,
    });
  });

  it("refuses two mints and none", () => {
    expect(resolvePairsMint(msg(`${MINT} or ${OTHER}`))).toEqual({
      error: "AMBIGUOUS_MINT",
    });
    expect(resolvePairsMint(msg("how deep is bonk"))).toEqual({
      error: "MISSING_MINT",
    });
  });

  it("ignores an invalid mint param and falls back to the text", () => {
    expect(
      resolvePairsMint(msg(`check ${MINT}`), { address: "not-a-mint" }),
    ).toEqual({ mint: MINT });
  });
});

describe("tokenPairsHandler", () => {
  it("returns the complete liquidity text for found pairs", async () => {
    const { fetcher, calls } = recordingFetch(json(sample.dexscreener));
    const result = await tokenPairsHandler(
      runtime,
      msg("liquidity"),
      undefined,
      { address: MINT },
      undefined,
      fetcher,
    );
    expect(calls).toEqual([
      `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`,
    ]);
    expect(result.success).toBe(true);
    expect(result.text).toContain(`Liquidity for ${MINT} (DexScreener)`);
    expect(result.text).toContain("Pairs: 2");
    expect(result.text).toContain("Total liquidity: $5.02M");
    expect(result.text).toContain("BONK/SOL on raydium");
    expect(result.text).toContain("BONK/USDC on meteora");
    expect(result.text).not.toContain("CAUTION");
    expect(result.text).toContain("never clears a GoPlus flag");
  });

  it("adds the thin-liquidity and new-pool cautions", async () => {
    const thin = [
      {
        ...sample.dexscreener[0],
        liquidity: { usd: 2_500 },
        pairCreatedAt: Date.now() - 2 * 3_600_000,
      },
    ];
    const { fetcher } = recordingFetch(json(thin));
    const result = await tokenPairsHandler(
      runtime,
      msg(MINT),
      undefined,
      {},
      undefined,
      fetcher,
    );
    expect(result.text).toContain("CAUTION: total liquidity is under $10.0K");
    expect(result.text).toContain(
      "CAUTION: the oldest pool is less than a day old",
    );
  });

  it("says no pool exists rather than reporting a zero price", async () => {
    const { fetcher } = recordingFetch(json([]));
    const result = await tokenPairsHandler(
      runtime,
      msg(MINT),
      undefined,
      {},
      undefined,
      fetcher,
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("knows no trading pairs");
    expect(result.data).toMatchObject({ pairs: { status: "no-pairs" } });
  });

  it("fails with a typed rate-limit code", async () => {
    const { fetcher } = recordingFetch(json({}, 429));
    const result = await tokenPairsHandler(
      runtime,
      msg(MINT),
      undefined,
      {},
      undefined,
      fetcher,
    );
    expect(result).toMatchObject({
      success: false,
      error: "TOKEN_PAIRS_RATE_LIMITED",
    });
  });

  it("fails with a typed unavailable code when DexScreener errors", async () => {
    const { fetcher } = recordingFetch(json({}, 503));
    const result = await tokenPairsHandler(
      runtime,
      msg(MINT),
      undefined,
      {},
      undefined,
      fetcher,
    );
    expect(result).toMatchObject({
      success: false,
      error: "TOKEN_PAIRS_UNAVAILABLE",
    });
    expect(result.text).toContain("HTTP 503");
  });

  it("asks for a mint and sends nothing when none is given", async () => {
    const { fetcher, calls } = recordingFetch(json([]));
    const result = await tokenPairsHandler(
      runtime,
      msg("how liquid is it"),
      undefined,
      {},
      undefined,
      fetcher,
    );
    expect(result).toMatchObject({ success: false, error: "MISSING_MINT" });
    expect(calls).toHaveLength(0);
  });
});

describe("walletRouterAction token_pairs dispatch", () => {
  it("routes token_pairs to the liquidity handler", async () => {
    const result = await walletRouterAction.handler(
      runtime,
      msg("how liquid is it?"),
      undefined,
      { parameters: { action: "token_pairs" } },
    );
    expect(result).toMatchObject({
      success: false,
      error: "MISSING_MINT",
      data: { subaction: "token_pairs" },
    });
  });
});
