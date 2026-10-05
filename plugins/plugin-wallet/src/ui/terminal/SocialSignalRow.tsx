/**
 * The terminal's Social row: one LunarCrush signal for the token being checked
 * or traded, shown beside the GoPlus verdict in the Token safety tab and the
 * Real trade review. Loading, no key, not tracked, unavailable, stale and
 * tracked are each their own visible state; "not tracked" is never drawn as a
 * low score. A low Galaxy Score shows as an added caution and never softens
 * the GoPlus verdict.
 */
import { cn } from "@elizaos/ui/utils";
import * as React from "react";
import type { WalletTerminalSocialSignalResponse } from "../../contracts.ts";
import type { SocialSignalState } from "./terminal-data.ts";

void React;

function ageOf(checkedAt: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(checkedAt)) / 60_000),
  );
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function trackedText(
  data: Extract<WalletTerminalSocialSignalResponse, { status: "tracked" }>,
): string {
  const parts = [
    data.galaxyScore === null
      ? "Galaxy Score not reported"
      : `Galaxy Score ${data.galaxyScore}/100`,
    data.altRank === null
      ? "AltRank not reported"
      : `AltRank #${data.altRank.toLocaleString("en-US")}`,
  ];
  if (data.sentimentPct !== null) {
    parts.push(`${data.sentimentPct}% positive`);
  }
  const matched =
    data.coin.name && data.coin.symbol
      ? ` (LunarCrush matched ${data.coin.name}, ${data.coin.symbol})`
      : "";
  return `${parts.join(" · ")}${matched}`;
}

export function SocialSignalRow({
  state,
  symbol,
}: {
  state: SocialSignalState;
  /** The token's symbol, or null when GoPlus didn't report one. */
  symbol: string | null;
}) {
  let tone = "text-muted";
  let text: string;
  if (symbol === null) {
    text = "No ticker symbol to look up.";
  } else if (state.status === "idle" || state.status === "loading") {
    text = "Checking LunarCrush…";
  } else if (state.status === "error") {
    tone = "text-warn";
    text = `Unavailable: ${state.message}`;
  } else if (state.data.status === "no-key") {
    text = "Add a LunarCrush key (LUNARCRUSH_API_KEY) to see social data.";
  } else if (state.data.status === "not-tracked") {
    text = `Not tracked by LunarCrush. That is not a low score.`;
  } else {
    text = trackedText(state.data);
    if (state.data.addsCaution) tone = "text-warn";
  }
  const data = state.status === "ready" ? state.data : null;
  const stale = data !== null && data.status !== "no-key" && data.stale;
  return (
    <div className="flex flex-col gap-0.5" data-testid="social-signal">
      <p className={cn("text-xs", tone)} data-testid="social-signal-text">
        <span className="font-medium text-txt">Social: </span>
        {text}
      </p>
      {data?.status === "tracked" && data.addsCaution ? (
        <p className="text-xs text-warn" data-testid="social-signal-caution">
          Caution: weak social activity. This adds caution and never clears a
          GoPlus flag.
        </p>
      ) : null}
      {data !== null && data.status !== "no-key" ? (
        <p
          className={cn("text-xs", stale ? "text-warn" : "text-muted")}
          data-testid="social-signal-age"
        >
          {stale
            ? `May be outdated (${data.source.error ?? "refresh failed"}), from ${ageOf(data.checkedAt)}`
            : `From LunarCrush, ${ageOf(data.checkedAt)}`}
        </p>
      ) : null}
    </div>
  );
}
