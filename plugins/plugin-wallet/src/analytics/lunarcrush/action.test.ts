/**
 * Drives the WALLET `social_signal` handler with a sample LunarCrush v4 coin
 * payload through an injected fetch, and the real `walletRouterAction`
 * dispatch for an input that resolves before any network call. Deterministic
 * and keyless; covers symbol resolution, the complete planner-facing text,
 * the low-score caution, the no-key result with no request, not-tracked, and
 * typed failures.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { walletRouterAction } from "../../chains/wallet-action";
import { resolveSocialSymbol, socialSignalHandler } from "./action";
import type { LunarCrushFetch } from "./social-signal";

const sample = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../routes/__fixtures__/lunarcrush-coin.sample.json",
    ),
    "utf8",
  ),
) as { lunarcrush: { data: Record<string, unknown> } };

const msg = (text: string): Memory =>
  ({ content: { text } }) as unknown as Memory;

function runtimeWith(key: string | null): IAgentRuntime {
  return {
    getSetting: (name: string) => (name === "LUNARCRUSH_API_KEY" ? key : null),
  } as unknown as IAgentRuntime;
}

function recordingFetch(response: () => Response): {
  fetcher: LunarCrushFetch;
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

describe("resolveSocialSymbol", () => {
  it("prefers a symbol param, then a single $ticker in the text", () => {
    expect(resolveSocialSymbol(msg("how is it"), { symbol: "bonk" })).toEqual({
      symbol: "BONK",
    });
    expect(resolveSocialSymbol(msg("what's the buzz on $wif?"))).toEqual({
      symbol: "WIF",
    });
    expect(resolveSocialSymbol(msg("$BONK or $WIF?"))).toEqual({
      error: "AMBIGUOUS_SYMBOL",
    });
    expect(resolveSocialSymbol(msg("how is social?"))).toEqual({
      error: "MISSING_SYMBOL",
    });
  });
});

describe("socialSignalHandler", () => {
  it("puts every score, the matched coin and the caveat in the planner text", async () => {
    const { fetcher, calls } = recordingFetch(json(sample.lunarcrush));
    const result = await socialSignalHandler(
      runtimeWith("key"),
      msg("social on $BONK"),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(result.success).toBe(true);
    expect(calls).toEqual(["https://lunarcrush.com/api4/public/coins/bonk/v1"]);
    const text = result.text ?? "";
    for (const line of [
      "LunarCrush social signal for BONK, matched to Bonk (BONK) [id 59311]:",
      "- Galaxy Score: 62 of 100.",
      "- AltRank: #148.",
      "- Sentiment: 78% positive.",
      "- Social volume (24h): 4,210 posts.",
      "- Interactions (24h): 1,832,400.",
      "No social caution",
      "never clears a GoPlus flag",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("says a low Galaxy Score adds caution", async () => {
    const { fetcher } = recordingFetch(
      json({ data: { ...sample.lunarcrush.data, galaxy_score: 12 } }),
    );
    const result = await socialSignalHandler(
      runtimeWith("key"),
      msg("x"),
      undefined,
      { symbol: "BONK" },
      undefined,
      fetcher,
    );
    expect(result.text).toContain(
      "CAUTION: the Galaxy Score is below 30, so social activity is weak.",
    );
  });

  it("returns the missing-key step and sends nothing without a key", async () => {
    const { fetcher, calls } = recordingFetch(json(sample.lunarcrush));
    const result = await socialSignalHandler(
      runtimeWith(null),
      msg("$BONK"),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Social signal for BONK is off: add a LunarCrush key (LUNARCRUSH_API_KEY) to turn it on.",
    );
    expect(calls).toEqual([]);
  });

  it("reports not-tracked as no data, not a low score", async () => {
    const { fetcher } = recordingFetch(json({}, 404));
    const result = await socialSignalHandler(
      runtimeWith("key"),
      msg("$NOPE"),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(result.text).toContain(
      "LunarCrush does not track NOPE. That is not a low score; there is no social data.",
    );
  });

  it.each([
    [401, "SOCIAL_SIGNAL_KEY_REJECTED"],
    [429, "SOCIAL_SIGNAL_RATE_LIMITED"],
    [502, "SOCIAL_SIGNAL_UNAVAILABLE"],
  ])("returns a typed failure for HTTP %i", async (status, code) => {
    const { fetcher } = recordingFetch(json({}, status));
    const result = await socialSignalHandler(
      runtimeWith("secret-key"),
      msg("$BONK"),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("asks which coin when the message names two tickers", async () => {
    const { fetcher, calls } = recordingFetch(json(sample.lunarcrush));
    const result = await socialSignalHandler(
      runtimeWith("key"),
      msg("$BONK vs $WIF"),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(result).toMatchObject({ success: false, error: "AMBIGUOUS_SYMBOL" });
    expect(calls).toEqual([]);
  });

  it("is reached through the WALLET action's social_signal subaction", async () => {
    const result = await walletRouterAction.handler(
      runtimeWith(null),
      msg("how's the buzz?"),
      undefined,
      { parameters: { action: "social_signal", symbol: "bonk" } },
    );
    expect(result).toMatchObject({
      success: true,
      text: "Social signal for BONK is off: add a LunarCrush key (LUNARCRUSH_API_KEY) to turn it on.",
      data: { actionName: "WALLET", subaction: "social_signal" },
    });
  });
});
