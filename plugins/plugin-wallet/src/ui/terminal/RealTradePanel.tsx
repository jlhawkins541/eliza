/**
 * The crypto terminal's Real trade tab: a Solana buy / sell ticket that spends
 * real funds from the agent's wallet through the `/api/wallet/terminal/trade/*`
 * routes. Every trade is reviewed first, where the server builds and simulates
 * the exact transaction, and is sent only when the person taps Confirm inside
 * the review window. The review shows what the architecture notes require
 * before signing: chain, mint, amounts, minimum output, slippage, destination,
 * fee budget, route, simulation, private routing, and the token safety verdict.
 *
 * Turning real trading on changes the agent's trade permission to
 * `manual-local-key`, which lets a person trade from the local wallet but never
 * lets the agent trade on its own. The panel shares nothing with paper trading.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@elizaos/ui";
import { cn } from "@elizaos/ui/utils";
import { AlertTriangle, RefreshCw } from "lucide-react";
import * as React from "react";
import { useEffect, useId, useState } from "react";
import type {
  WalletTerminalTradeAmount,
  WalletTerminalTradeExecuteResponse,
  WalletTerminalTradeReview,
  WalletTerminalTradeSide,
  WalletTerminalTradeStatusResponse,
  WalletTokenSafetyVerdict,
} from "../../contracts.ts";
import {
  type RealTradingHandle,
  type TokenSafetyState,
  useRealTrading,
  useTokenSafety,
} from "./terminal-data.ts";

void React;

const SIDE_ITEMS: Array<{ value: WalletTerminalTradeSide; label: string }> = [
  { value: "buy", label: "Buy with SOL" },
  { value: "sell", label: "Sell for SOL" },
];

const SAFETY_COPY: Record<WalletTokenSafetyVerdict, string> = {
  avoid: "Avoid: GoPlus found a power that can take, lock, or block tokens.",
  caution: "Caution: GoPlus reported risks or left fields unreported.",
  "no-major-flags": "No major flags from GoPlus. That is not proof of safety.",
};

const MODE_COPY: Record<
  WalletTerminalTradeStatusResponse["tradePermissionMode"],
  string
> = {
  "user-sign-only": "sign-only",
  "manual-local-key": "you trade, the agent can't",
  "agent-auto": "the agent may also trade on its own",
  disabled: "trading disabled",
};

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function tokenLabel(amount: WalletTerminalTradeAmount): string {
  return amount.symbol ?? shortAddress(amount.mint);
}

function formatSol(lamports: number): string {
  return `${(lamports / 1_000_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 9,
  })} SOL`;
}

/** Jupiter reports price impact as a fraction; show it in percent. */
function formatImpact(fraction: string | null): string {
  if (fraction === null) return "Not reported";
  const pct = Number(fraction) * 100;
  if (!Number.isFinite(pct)) return "Not reported";
  return Math.abs(pct) < 0.01 ? "under 0.01%" : `${pct.toFixed(2)}%`;
}

function useSecondsLeft(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (expiresAt === null) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
}

function Row({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className="min-w-0 text-right text-xs text-txt [overflow-wrap:anywhere]"
        data-testid={testId}
      >
        {children}
      </dd>
    </div>
  );
}

function SafetyLine({ state }: { state: TokenSafetyState }) {
  if (state.status === "ready") {
    return (
      <p
        className={cn(
          "text-xs",
          state.data.verdict === "avoid"
            ? "text-danger"
            : state.data.verdict === "caution"
              ? "text-warn"
              : "text-muted",
        )}
        data-testid="real-trade-safety"
      >
        {SAFETY_COPY[state.data.verdict]}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted" data-testid="real-trade-safety">
      {state.status === "error"
        ? `Token safety report unavailable: ${state.message}`
        : "Checking token safety…"}
    </p>
  );
}

function ResultView({
  result,
}: {
  result: WalletTerminalTradeExecuteResponse;
}) {
  const copy =
    result.status === "confirmed"
      ? { tone: "text-ok", text: "Trade confirmed on Solana." }
      : result.status === "failed"
        ? {
            tone: "text-danger",
            text: `The trade landed but failed (${result.error}). Network fees were still paid.`,
          }
        : {
            tone: "text-warn",
            text: `The trade was sent but not confirmed yet (${result.detail}). Check it before trying again.`,
          };
  return (
    <div className="flex flex-col gap-1" data-testid="real-trade-result">
      <p role="status" className={cn("text-sm font-medium", copy.tone)}>
        {copy.text}
      </p>
      <a
        href={result.explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="break-all text-xs text-accent underline"
      >
        View {shortAddress(result.signature)} on Solscan
      </a>
    </div>
  );
}

function ReviewDialog({
  review,
  safety,
  sending,
  result,
  error,
  onConfirm,
  onReviewAgain,
  onClose,
}: {
  review: WalletTerminalTradeReview;
  safety: TokenSafetyState | null;
  sending: boolean;
  result: WalletTerminalTradeExecuteResponse | null;
  error: string | null;
  onConfirm: () => void;
  onReviewAgain: () => void;
  onClose: () => void;
}) {
  const secondsLeft = useSecondsLeft(result ? null : review.expiresAt);
  const expired = !result && secondsLeft === 0;
  const output = tokenLabel(review.output);
  const fee = review.fee;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {result ? "Trade sent" : "Review real trade"}
          </DialogTitle>
          <DialogDescription>
            {review.side === "buy" ? "Buy" : "Sell"} on Solana with your wallet.
            {result ? "" : " Nothing moves until you confirm."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <ResultView result={result} />
        ) : (
          <div className="flex flex-col gap-3">
            <dl className="divide-y divide-border/70 rounded-md border border-border/70 px-3">
              <Row label="Chain">Solana mainnet</Row>
              <Row label="Token mint">
                {review.side === "buy" ? review.output.mint : review.input.mint}
              </Row>
              <Row label="You pay" testId="real-trade-pay">
                {review.input.amount} {tokenLabel(review.input)}
              </Row>
              <Row label="You receive (quoted)" testId="real-trade-receive">
                {review.output.amount} {output}
              </Row>
              <Row label="Minimum received" testId="real-trade-minimum">
                {review.minimumOutput} {output}
              </Row>
              <Row label="Slippage">{review.slippageBps / 100}%</Row>
              <Row label="Price impact">
                {formatImpact(review.priceImpactPct)}
              </Row>
              <Row label="Goes to">{review.walletAddress}</Row>
              <Row label="Network fee" testId="real-trade-fee">
                {formatSol(fee.baseFeeLamports)} base +{" "}
                {fee.priorityFeeLamports === null
                  ? `up to ${formatSol(fee.maxPriorityFeeLamports)}`
                  : formatSol(fee.priorityFeeLamports)}{" "}
                priority
              </Row>
              <Row label="Route">
                {review.route.length > 0
                  ? review.route
                      .map(
                        (leg) =>
                          `${leg.label ?? "Unnamed pool"}${leg.percent === null ? "" : ` ${leg.percent}%`}`,
                      )
                      .join(", ")
                  : "Not reported"}
              </Row>
              <Row label="Private / Jito routing">
                {review.privateRouting.detail}
              </Row>
              <Row label="Simulation" testId="real-trade-simulation">
                {review.simulation.success
                  ? `Passed${review.simulation.unitsConsumed === null ? "" : ` · ${review.simulation.unitsConsumed.toLocaleString("en-US")} compute units`}`
                  : `Failed: ${review.simulation.err}`}
              </Row>
            </dl>
            {review.simulation.logs.length > 0 ? (
              <details className="text-xs text-muted">
                <summary>Simulation logs</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                  {review.simulation.logs.join("\n")}
                </pre>
              </details>
            ) : null}
            {safety ? <SafetyLine state={safety} /> : null}
            {!review.canConfirm ? (
              <p role="alert" className="text-xs text-danger">
                The simulation failed, so this trade can't be sent. Adjust the
                amount or slippage and review again.
              </p>
            ) : expired ? (
              <p role="alert" className="text-xs text-warn">
                This quote expired. Review again for a fresh one.
              </p>
            ) : (
              <p className="text-xs text-muted" data-testid="real-trade-expiry">
                Quote held for {secondsLeft}s.
              </p>
            )}
            {error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {result ? null : expired ? (
            <Button
              onClick={onReviewAgain}
              data-testid="real-trade-review-again"
            >
              Review again
            </Button>
          ) : (
            <Button
              onClick={onConfirm}
              disabled={sending || !review.canConfirm}
              data-testid="real-trade-confirm"
            >
              {sending ? "Sending…" : "Confirm trade"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnableRealTrading({ trading }: { trading: RealTradingHandle }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-border/70 p-4"
      data-testid="real-trade-off"
    >
      <h2 className="text-sm font-semibold text-txt">Real trading is off</h2>
      <p className="text-xs text-muted">
        Your trade permission is sign-only, so the terminal can't trade from
        this wallet. Turning it on lets you place trades here, each one
        simulated and sent only after you confirm it. The agent still can't
        trade on its own.
      </p>
      <Button
        className="self-start"
        onClick={() => setConfirming(true)}
        data-testid="real-trade-enable"
      >
        Turn on real trades
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn on real trades?</DialogTitle>
            <DialogDescription>
              This sets the agent's trade permission to "manual local key": you
              can trade from this wallet in the terminal after confirming each
              trade, and the agent can't trade on its own. Use a hot wallet that
              holds only what you're willing to trade.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              disabled={working}
              onClick={() => {
                setWorking(true);
                setError(null);
                void trading.enable().then((outcome) => {
                  setWorking(false);
                  setConfirming(false);
                  if (!outcome.ok) setError(outcome.message);
                });
              }}
              data-testid="real-trade-enable-confirm"
            >
              {working ? "Turning on…" : "Turn on"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TradeTicket({
  trading,
  status,
  initialMint,
}: {
  trading: RealTradingHandle;
  status: WalletTerminalTradeStatusResponse;
  initialMint: string | null;
}) {
  const [side, setSide] = useState<WalletTerminalTradeSide>("buy");
  const [mint, setMint] = useState(initialMint ?? "");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(
    status.slippageChoicesBps.includes(100)
      ? 100
      : (status.slippageChoicesBps[0] ?? 100),
  );
  const [reviewing, setReviewing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [review, setReview] = useState<WalletTerminalTradeReview | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] =
    useState<WalletTerminalTradeExecuteResponse | null>(null);
  const { state: safety, check } = useTokenSafety();
  const [safetyMint, setSafetyMint] = useState<string | null>(null);
  const mintId = useId();
  const amountId = useId();

  const startReview = () => {
    setReviewing(true);
    setFormError(null);
    setSendError(null);
    setResult(null);
    const request = {
      side,
      mint: mint.trim(),
      amount: amount.trim(),
      slippageBps,
    };
    void trading.review(request).then((outcome) => {
      setReviewing(false);
      if (!outcome.ok) {
        setReview(null);
        setFormError(outcome.message);
        return;
      }
      setReview(outcome.value);
      if (request.side === "buy") {
        setSafetyMint(request.mint);
        check(request.mint);
      } else {
        setSafetyMint(null);
      }
    });
  };

  const close = () => {
    if (sending) return;
    setReview(null);
    setResult(null);
    setSendError(null);
  };

  return (
    <>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!reviewing) startReview();
        }}
      >
        <SegmentedControl
          value={side}
          onValueChange={(value) => setSide(value as WalletTerminalTradeSide)}
          items={SIDE_ITEMS}
          aria-label="Trade side"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={mintId} className="text-xs text-muted">
            Solana token mint address
          </label>
          <Input
            id={mintId}
            value={mint}
            onChange={(event) => setMint(event.target.value)}
            placeholder="Paste a mint address"
            autoComplete="off"
            spellCheck={false}
            data-testid="real-trade-mint"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={amountId} className="text-xs text-muted">
            {side === "buy" ? "SOL to spend" : "Tokens to sell"}
          </label>
          <Input
            id={amountId}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            data-testid="real-trade-amount"
          />
          {side === "buy" ? (
            <span className="text-xs text-muted">
              Up to {status.maxBuySol} SOL per buy.
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Slippage</span>
          <SegmentedControl
            value={`${slippageBps}`}
            onValueChange={(value) => setSlippageBps(Number(value))}
            items={status.slippageChoicesBps.map((bps) => ({
              value: `${bps}`,
              label: `${bps / 100}%`,
            }))}
            aria-label="Slippage"
          />
        </div>
        {formError ? (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        ) : null}
        <Button
          type="submit"
          className="self-start"
          disabled={reviewing || mint.trim() === "" || amount.trim() === ""}
          data-testid="real-trade-review"
        >
          {reviewing ? "Building and simulating…" : "Review trade"}
        </Button>
      </form>
      {review ? (
        <ReviewDialog
          review={review}
          safety={safetyMint ? safety : null}
          sending={sending}
          result={result}
          error={sendError}
          onClose={close}
          onReviewAgain={startReview}
          onConfirm={() => {
            setSending(true);
            setSendError(null);
            void trading.execute(review.reviewId).then((outcome) => {
              setSending(false);
              if (outcome.ok) setResult(outcome.value);
              else setSendError(outcome.message);
            });
          }}
        />
      ) : null}
    </>
  );
}

export function RealTradePanel({
  initialMint,
}: {
  initialMint: string | null;
}) {
  const trading = useRealTrading();
  const { state } = trading;

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex items-start gap-2 rounded-md border border-warn/50 bg-warn/10 px-4 py-3"
        data-testid="real-trade-banner"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
        <p className="text-xs text-txt">
          Real trades spend real SOL from your wallet. Each one is simulated
          first and sent only after you confirm it. Paper orders in the other
          tabs never touch this wallet.
        </p>
      </div>
      {state.status === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Checking your wallet…
        </p>
      ) : state.status === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-muted">
            Real trading is unavailable: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={trading.refresh}>
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted" data-testid="real-trade-wallet">
            Wallet{" "}
            {state.data.wallet.address
              ? shortAddress(state.data.wallet.address)
              : "not set up"}{" "}
            · Trade permission: {MODE_COPY[state.data.tradePermissionMode]}
          </p>
          {!state.data.wallet.canSign ? (
            <p role="alert" className="text-sm text-warn">
              This wallet can't place trades: {state.data.wallet.reason}
            </p>
          ) : !state.data.realTradingEnabled ? (
            <EnableRealTrading trading={trading} />
          ) : (
            <TradeTicket
              trading={trading}
              status={state.data}
              initialMint={initialMint}
            />
          )}
        </>
      )}
    </div>
  );
}
