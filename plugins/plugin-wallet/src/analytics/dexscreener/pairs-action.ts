/**
 * Handler for the WALLET `token_pairs` subaction: reads the DexScreener pools
 * behind one Solana mint — price, liquidity, 24-hour volume and pool age — so
 * the agent can weigh how tradeable a token is next to the GoPlus safety
 * check.
 *
 * The mint comes from the `mint`/`token`/`address`/`query` params, or from the
 * one base58 mint in the message text. The handler is read-only, needs no API
 * key, and never touches a wallet. Its text always says liquidity can only add
 * caution and never clears a GoPlus flag.
 */
import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { readParams, readStringParam } from "../token-info/params.js";
import {
  DexScreenerError,
  type DexScreenerFetch,
  defaultDexScreenerFetch,
  fetchTokenPairs,
  formatTokenPairs,
  normalizePairsMint,
} from "./pairs.js";

const MINT_IN_TEXT = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

type PairsData = Parameters<HandlerCallback>[0]["data"];

function result(
  callback: HandlerCallback | undefined,
  success: boolean,
  text: string,
  data: Record<string, unknown>,
): ActionResult {
  const payload = { actionName: "WALLET", subaction: "token_pairs", ...data };
  callback?.({ text, actions: ["WALLET"], data: payload as PairsData });
  return success
    ? { success, text, data: payload as ActionResult["data"] }
    : {
        success,
        text,
        error: String(data.error),
        data: payload as ActionResult["data"],
      };
}

/** Resolve the mint from params first, then from a single mint in the text. */
export function resolvePairsMint(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>,
): { mint: string } | { error: "MISSING_MINT" | "AMBIGUOUS_MINT" } {
  const fromParams = normalizePairsMint(
    readStringParam(readParams(options), "mint", "token", "address", "query"),
  );
  if (fromParams) return { mint: fromParams };
  const text =
    typeof message.content.text === "string" ? message.content.text : "";
  const found = [...new Set(text.match(MINT_IN_TEXT) ?? [])];
  if (found.length === 1 && found[0]) return { mint: found[0] };
  return { error: found.length > 1 ? "AMBIGUOUS_MINT" : "MISSING_MINT" };
}

export async function tokenPairsHandler(
  _runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions | Record<string, unknown>,
  callback?: HandlerCallback,
  fetcher: DexScreenerFetch = defaultDexScreenerFetch,
): Promise<ActionResult> {
  const resolved = resolvePairsMint(message, options);
  if ("error" in resolved) {
    return result(
      callback,
      false,
      resolved.error === "AMBIGUOUS_MINT"
        ? "The message names more than one mint address. Say which token to look up."
        : "Give the token's Solana mint address to look up its liquidity.",
      { error: resolved.error },
    );
  }
  try {
    const pairs = await fetchTokenPairs(resolved.mint, fetcher);
    return result(callback, true, formatTokenPairs(pairs), {
      target: "dexscreener",
      mint: resolved.mint,
      pairs,
    });
  } catch (error) {
    // error-policy:J1 action boundary: the planner receives a typed failure.
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "DexScreener request failed";
    const kind = error instanceof DexScreenerError ? error.kind : "failed";
    return result(
      callback,
      false,
      `Liquidity for ${resolved.mint} is unavailable: ${detail}`,
      {
        error:
          kind === "rate-limited"
            ? "TOKEN_PAIRS_RATE_LIMITED"
            : "TOKEN_PAIRS_UNAVAILABLE",
        mint: resolved.mint,
        detail,
      },
    );
  }
}
