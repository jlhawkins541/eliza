/**
 * The terminal's Liquidity row: the DexScreener pools behind the token being
 * checked or traded, shown beside the GoPlus verdict in the Token safety tab
 * and the Real trade review. Loading, no pools, unavailable, stale and found
 * are each their own visible state; "no pools" is never drawn as a zero price.
 * Thin liquidity or a pool less than a day old shows as an added caution and
 * never softens the GoPlus verdict.
 */
import { cn } from "@elizaos/ui/utils";
import * as React from "react";
import type { WalletTerminalTokenPairsResponse } from "../../contracts.ts";
import type { TokenPairsState } from "./terminal-data.ts";

void React;

function ageOf(checkedAt: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(checkedAt)) / 60_000),
  );
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function usd(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function poolAge(createdAt: string | null): string {
  if (createdAt === null) return "age unknown";
  const ms = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "age unknown";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min old`;
  if (hours < 48) return `${Math.round(hours)} h old`;
  return `${Math.round(hours / 24)} d old`;
}

function foundText(
  data: Extract<WalletTerminalTokenPairsResponse, { status: "found" }>,
): string {
  const deepest = data.pairs[0];
  const parts = [
    `${usd(data.totalLiquidityUsd)} across ${data.pairCount} ${
      data.pairCount === 1 ? "pool" : "pools"
    }`,
    `${usd(data.totalVolume24hUsd)} 24h volume`,
    poolAge(data.oldestPairCreatedAt),
  ];
  if (deepest?.dexId) {
    parts.push(
      `deepest on ${deepest.dexId}${
        deepest.quoteSymbol ? ` vs ${deepest.quoteSymbol}` : ""
      }`,
    );
  }
  return parts.join(" · ");
}

function cautionText(
  data: Extract<WalletTerminalTokenPairsResponse, { status: "found" }>,
): string | null {
  const reasons: string[] = [];
  if (data.thinLiquidity)
    reasons.push("liquidity is thin, so a trade will move the price");
  if (data.newPool) reasons.push("the oldest pool is less than a day old");
  if (reasons.length === 0) return null;
  return `Caution: ${reasons.join(" and ")}. This adds caution and never clears a GoPlus flag.`;
}

export function LiquidityRow({
  state,
  mint,
}: {
  state: TokenPairsState;
  /** The mint being checked, or null when there is nothing to look up. */
  mint: string | null;
}) {
  let tone = "text-muted";
  let text: string;
  if (mint === null) {
    text = "No mint to look up.";
  } else if (state.status === "idle" || state.status === "loading") {
    text = "Checking DexScreener…";
  } else if (state.status === "error") {
    tone = "text-warn";
    text = `Unavailable: ${state.message}`;
  } else if (state.data.status === "no-pairs") {
    tone = "text-warn";
    text = "No pool on DexScreener. Treat it as untradeable.";
  } else {
    text = foundText(state.data);
    if (state.data.addsCaution) tone = "text-warn";
  }
  const data = state.status === "ready" ? state.data : null;
  const caution = data?.status === "found" ? cautionText(data) : null;
  return (
    <div className="flex flex-col gap-0.5" data-testid="liquidity-row">
      <p className={cn("text-xs", tone)} data-testid="liquidity-row-text">
        <span className="font-medium text-txt">Liquidity: </span>
        {text}
      </p>
      {caution !== null ? (
        <p className="text-xs text-warn" data-testid="liquidity-row-caution">
          {caution}
        </p>
      ) : null}
      {data !== null ? (
        <p
          className={cn("text-xs", data.stale ? "text-warn" : "text-muted")}
          data-testid="liquidity-row-age"
        >
          {data.stale
            ? `May be outdated (${data.source.error ?? "refresh failed"}), from ${ageOf(data.checkedAt)}`
            : `From DexScreener, ${ageOf(data.checkedAt)}`}
        </p>
      ) : null}
    </div>
  );
}
