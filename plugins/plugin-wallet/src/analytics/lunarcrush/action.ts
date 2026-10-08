/**
 * Handler for the WALLET `social_signal` subaction: looks up a coin's
 * LunarCrush Galaxy Score, AltRank, sentiment and social activity by ticker so
 * the agent can weigh social momentum next to the GoPlus safety check.
 *
 * The symbol comes from the `symbol`/`token`/`query` params, or from the one
 * `$TICKER` in the message text. The handler is read-only and never touches a
 * wallet. With no `LUNARCRUSH_API_KEY` it returns that as its result and sends
 * no request. Its text always says the signal can only add caution and never
 * clears a GoPlus flag.
 */
import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { WalletTerminalSocialSignalResponse } from "../../contracts.js";
import { readParams, readStringParam } from "../token-info/params.js";
import {
  defaultLunarCrushFetch,
  fetchLunarCrushSocialSignal,
  formatSocialSignal,
  LUNARCRUSH_API_KEY_SETTING,
  LunarCrushError,
  type LunarCrushFetch,
  normalizeSocialSymbol,
} from "./social-signal.js";

const TICKER_IN_TEXT = /\$([A-Za-z][A-Za-z0-9]{0,19})\b/g;

type SignalData = Parameters<HandlerCallback>[0]["data"];

function result(
  callback: HandlerCallback | undefined,
  success: boolean,
  text: string,
  data: Record<string, unknown>,
): ActionResult {
  const payload = { actionName: "WALLET", subaction: "social_signal", ...data };
  callback?.({ text, actions: ["WALLET"], data: payload as SignalData });
  return success
    ? { success, text, data: payload as ActionResult["data"] }
    : {
        success,
        text,
        error: String(data.error),
        data: payload as ActionResult["data"],
      };
}

/** Resolve the ticker from params first, then from a single `$TICKER` in text. */
export function resolveSocialSymbol(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>,
): { symbol: string } | { error: "MISSING_SYMBOL" | "AMBIGUOUS_SYMBOL" } {
  const fromParams = normalizeSocialSymbol(
    readStringParam(readParams(options), "symbol", "token", "query"),
  );
  if (fromParams) return { symbol: fromParams };
  const text =
    typeof message.content.text === "string" ? message.content.text : "";
  const found = [
    ...new Set(
      [...text.matchAll(TICKER_IN_TEXT)].map((match) =>
        (match[1] ?? "").toUpperCase(),
      ),
    ),
  ];
  if (found.length === 1 && found[0]) return { symbol: found[0] };
  return {
    error: found.length > 1 ? "AMBIGUOUS_SYMBOL" : "MISSING_SYMBOL",
  };
}

export async function socialSignalHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions | Record<string, unknown>,
  callback?: HandlerCallback,
  fetcher: LunarCrushFetch = defaultLunarCrushFetch,
): Promise<ActionResult> {
  const resolved = resolveSocialSymbol(message, options);
  if ("error" in resolved) {
    return result(
      callback,
      false,
      resolved.error === "AMBIGUOUS_SYMBOL"
        ? "The message names more than one $ticker. Say which coin to look up."
        : "Give the coin's ticker symbol, such as SOL or BONK, to look up its social signal.",
      { error: resolved.error },
    );
  }
  const rawKey = runtime.getSetting(LUNARCRUSH_API_KEY_SETTING);
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (apiKey === "") {
    const signal: WalletTerminalSocialSignalResponse = {
      status: "no-key",
      symbol: resolved.symbol,
    };
    return result(callback, true, formatSocialSignal(signal), {
      target: "lunarcrush",
      symbol: resolved.symbol,
      signal,
    });
  }
  try {
    const signal = await fetchLunarCrushSocialSignal(
      resolved.symbol,
      apiKey,
      fetcher,
    );
    return result(callback, true, formatSocialSignal(signal), {
      target: "lunarcrush",
      symbol: resolved.symbol,
      signal,
    });
  } catch (error) {
    // error-policy:J1 action boundary: the planner receives a typed failure.
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "LunarCrush request failed";
    const kind = error instanceof LunarCrushError ? error.kind : "failed";
    return result(
      callback,
      false,
      `Social signal for ${resolved.symbol} is unavailable: ${detail}`,
      {
        error:
          kind === "key-rejected"
            ? "SOCIAL_SIGNAL_KEY_REJECTED"
            : kind === "rate-limited"
              ? "SOCIAL_SIGNAL_RATE_LIMITED"
              : "SOCIAL_SIGNAL_UNAVAILABLE",
        symbol: resolved.symbol,
        detail,
      },
    );
  }
}
