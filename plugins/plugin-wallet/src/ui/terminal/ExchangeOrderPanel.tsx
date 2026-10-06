/**
 * The Real trade tab's exchange section: a Kraken or OKX spot limit order
 * ticket that uses the agent's exchange API keys through the
 * `/api/wallet/terminal/exchange/*` routes. Every order is reviewed first,
 * where the venue checks it without placing it and the available balance is
 * read, and is placed only when the person taps Confirm inside the review
 * window. Orders placed this session are listed with their last known state,
 * a Refresh, and a Cancel that asks first.
 *
 * It is shown only once real trading is on, and a venue without its keys says
 * which settings it needs instead of offering a ticket. An `unknown` order is
 * shown as unknown with its client order id, never as placed or failed.
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
import { RefreshCw } from "lucide-react";
import * as React from "react";
import { useEffect, useId, useState } from "react";
import type {
  WalletExchangeBase,
  WalletExchangeOrder,
  WalletExchangeOrderState,
  WalletExchangeQuote,
  WalletExchangeVenue,
  WalletTerminalExchangeReview,
  WalletTerminalExchangeStatusResponse,
  WalletTerminalTradeSide,
} from "../../contracts.ts";
import {
  type ExchangeTradingHandle,
  useExchangeTrading,
} from "./terminal-data.ts";

void React;

const VENUE_NAME: Record<WalletExchangeVenue, string> = {
  kraken: "Kraken",
  okx: "OKX",
};

const VENUE_ITEMS: Array<{ value: WalletExchangeVenue; label: string }> = [
  { value: "kraken", label: "Kraken" },
  { value: "okx", label: "OKX" },
];

const SIDE_ITEMS: Array<{ value: WalletTerminalTradeSide; label: string }> = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
];

const STATE_COPY: Record<WalletExchangeOrderState, string> = {
  submitted: "Placed",
  open: "Open",
  "partially-filled": "Partly filled",
  filled: "Filled",
  canceled: "Canceled",
  rejected: "Rejected",
  unknown: "Unknown",
};

const STATE_TONE: Record<WalletExchangeOrderState, string> = {
  submitted: "text-txt",
  open: "text-txt",
  "partially-filled": "text-txt",
  filled: "text-ok",
  canceled: "text-muted",
  rejected: "text-danger",
  unknown: "text-warn",
};

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

function ExchangeReviewDialog({
  review,
  placed,
  sending,
  error,
  onConfirm,
  onReviewAgain,
  onClose,
}: {
  review: WalletTerminalExchangeReview;
  placed: WalletExchangeOrder | null;
  sending: boolean;
  error: string | null;
  onConfirm: () => void;
  onReviewAgain: () => void;
  onClose: () => void;
}) {
  const secondsLeft = useSecondsLeft(placed ? null : review.expiresAt);
  const expired = !placed && secondsLeft === 0;
  const venue = VENUE_NAME[review.venue];
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {placed ? `Order on ${venue}` : `Review ${venue} order`}
          </DialogTitle>
          <DialogDescription>
            A real limit order with your {venue} account.
            {placed ? "" : " Nothing is placed until you confirm."}
          </DialogDescription>
        </DialogHeader>
        {placed ? (
          <div className="flex flex-col gap-2" data-testid="exchange-result">
            <p className={cn("text-sm font-medium", STATE_TONE[placed.state])}>
              {STATE_COPY[placed.state]}
              {placed.orderId ? ` · order ${placed.orderId}` : ""}
            </p>
            <p className="text-xs text-txt">{placed.detail}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <dl className="divide-y divide-border/70 rounded-md border border-border/70 px-3">
              <Row label="Exchange">{venue}</Row>
              <Row label="Market">{review.market}</Row>
              <Row label="Order" testId="exchange-review-order">
                {review.side === "buy" ? "Buy" : "Sell"} {review.quantity}{" "}
                {review.base} at {review.price} {review.quote} (limit)
              </Row>
              <Row label="Order value" testId="exchange-review-value">
                {review.orderValue} {review.quote}
              </Row>
              {review.checks.map((check) => (
                <Row key={check.label} label={check.label}>
                  {check.detail}
                </Row>
              ))}
              <Row label="Client order id">{review.clientOrderId}</Row>
            </dl>
            <p className="text-xs text-muted">
              A limit order can rest on the book until it fills or you cancel
              it. Fees are charged by {venue}.
            </p>
            {expired ? (
              <p role="alert" className="text-xs text-warn">
                This review expired. Review again for a fresh check.
              </p>
            ) : (
              <p className="text-xs text-muted" data-testid="exchange-expiry">
                Review held for {secondsLeft}s.
              </p>
            )}
            {error ? (
              <p
                role="alert"
                className="text-xs text-danger"
                data-testid="exchange-send-error"
              >
                {error} Check this session's orders below before reviewing
                again.
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {placed ? "Done" : "Cancel"}
          </Button>
          {placed ? null : expired || error ? (
            <Button onClick={onReviewAgain} data-testid="exchange-review-again">
              Review again
            </Button>
          ) : (
            <Button
              onClick={onConfirm}
              disabled={sending}
              data-testid="exchange-confirm"
            >
              {sending ? "Placing…" : "Confirm order"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExchangeTicket({
  exchange,
  status,
}: {
  exchange: ExchangeTradingHandle;
  status: WalletTerminalExchangeStatusResponse;
}) {
  const [venue, setVenue] = useState<WalletExchangeVenue>("kraken");
  const [side, setSide] = useState<WalletTerminalTradeSide>("buy");
  const [base, setBase] = useState<WalletExchangeBase>("SOL");
  const [quote, setQuote] = useState<WalletExchangeQuote>("USD");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [review, setReview] = useState<WalletTerminalExchangeReview | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<WalletExchangeOrder | null>(null);
  const quantityId = useId();
  const priceId = useId();
  const venueStatus = status.venues[venue];

  const startReview = () => {
    setReviewing(true);
    setFormError(null);
    setSendError(null);
    setPlaced(null);
    void exchange
      .review({
        venue,
        base,
        quote,
        side,
        quantity: quantity.trim(),
        price: price.trim(),
      })
      .then((outcome) => {
        setReviewing(false);
        if (!outcome.ok) {
          setReview(null);
          setFormError(outcome.message);
          return;
        }
        setReview(outcome.value);
      });
  };

  const close = () => {
    if (sending) return;
    setReview(null);
    setPlaced(null);
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
          value={venue}
          onValueChange={(value) => setVenue(value as WalletExchangeVenue)}
          items={VENUE_ITEMS}
          aria-label="Exchange"
        />
        {!venueStatus.configured ? (
          <p className="text-xs text-warn" data-testid="exchange-missing">
            Set {venueStatus.missingSettings.join(", ")} in packages/agent/.env
            to trade on {VENUE_NAME[venue]}.
          </p>
        ) : null}
        <SegmentedControl
          value={side}
          onValueChange={(value) => setSide(value as WalletTerminalTradeSide)}
          items={SIDE_ITEMS}
          aria-label="Order side"
        />
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Asset</span>
            <SegmentedControl
              value={base}
              onValueChange={(value) => setBase(value as WalletExchangeBase)}
              items={status.bases.map((value) => ({ value, label: value }))}
              aria-label="Asset"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Priced in</span>
            <SegmentedControl
              value={quote}
              onValueChange={(value) => setQuote(value as WalletExchangeQuote)}
              items={status.quotes.map((value) => ({ value, label: value }))}
              aria-label="Priced in"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={quantityId} className="text-xs text-muted">
            {base} to {side}
          </label>
          <Input
            id={quantityId}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            data-testid="exchange-quantity"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={priceId} className="text-xs text-muted">
            Limit price in {quote}
          </label>
          <Input
            id={priceId}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            data-testid="exchange-price"
          />
          <span className="text-xs text-muted">
            Up to {status.maxOrderUsd} USD per order.
          </span>
        </div>
        {formError ? (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        ) : null}
        <Button
          type="submit"
          className="self-start"
          disabled={
            reviewing ||
            !venueStatus.configured ||
            quantity.trim() === "" ||
            price.trim() === ""
          }
          data-testid="exchange-review"
        >
          {reviewing ? `Checking with ${VENUE_NAME[venue]}…` : "Review order"}
        </Button>
      </form>
      {review ? (
        <ExchangeReviewDialog
          review={review}
          placed={placed}
          sending={sending}
          error={sendError}
          onClose={close}
          onReviewAgain={startReview}
          onConfirm={() => {
            setSending(true);
            setSendError(null);
            void exchange.execute(review.reviewId).then((outcome) => {
              setSending(false);
              if (outcome.ok) setPlaced(outcome.value);
              else setSendError(outcome.message);
            });
          }}
        />
      ) : null}
    </>
  );
}

function OrderList({ exchange }: { exchange: ExchangeTradingHandle }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<WalletExchangeOrder | null>(
    null,
  );
  if (exchange.ordersError !== null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid="exchange-orders-error"
        >
          Couldn't load this session's exchange orders: {exchange.ordersError}
        </p>
        <Button variant="outline" size="sm" onClick={exchange.refresh}>
          <RefreshCw className="size-3.5" /> Try again
        </Button>
      </div>
    );
  }
  if (exchange.orders.length === 0) {
    return (
      <p className="text-xs text-muted" data-testid="exchange-orders-empty">
        No exchange orders placed from this terminal session.
      </p>
    );
  }
  const run = (clientOrderId: string, action: typeof exchange.refreshOrder) => {
    setBusy(clientOrderId);
    setError(null);
    void action(clientOrderId).then((outcome) => {
      setBusy(null);
      if (!outcome.ok) setError(outcome.message);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <ul
        className="divide-y divide-border/70 rounded-md border border-border/70"
        data-testid="exchange-orders"
      >
        {exchange.orders.map((order) => {
          const closed = ["filled", "canceled", "rejected"].includes(
            order.state,
          );
          return (
            <li
              key={order.clientOrderId}
              className="flex flex-col gap-1 px-3 py-2.5"
              data-testid={`exchange-order-${order.clientOrderId}`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm text-txt">
                  {VENUE_NAME[order.venue]} · {order.side} {order.quantity}{" "}
                  {order.market} at {order.price}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs font-medium",
                    STATE_TONE[order.state],
                  )}
                >
                  {STATE_COPY[order.state]}
                  {order.filledQuantity && Number(order.filledQuantity) > 0
                    ? ` · ${order.filledQuantity} filled`
                    : ""}
                </span>
              </div>
              <span className="text-xs text-muted">{order.detail}</span>
              <div className="flex gap-2">
                {order.state === "rejected" ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === order.clientOrderId}
                    onClick={() =>
                      run(order.clientOrderId, exchange.refreshOrder)
                    }
                  >
                    <RefreshCw className="size-3.5" /> Refresh
                  </Button>
                )}
                {closed || order.orderId === null ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === order.clientOrderId}
                    onClick={() => setCancelling(order)}
                    data-testid="exchange-order-cancel"
                  >
                    Cancel order
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Dialog
        open={cancelling !== null}
        onOpenChange={(open) => (open ? undefined : setCancelling(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this order?</DialogTitle>
            <DialogDescription>
              {cancelling
                ? `${VENUE_NAME[cancelling.venue]} will cancel ${cancelling.side} ${cancelling.quantity} ${cancelling.market} at ${cancelling.price}. Any part already filled stays filled.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(null)}>
              Keep it
            </Button>
            <Button
              onClick={() => {
                if (cancelling) {
                  run(cancelling.clientOrderId, exchange.cancelOrder);
                }
                setCancelling(null);
              }}
              data-testid="exchange-cancel-confirm"
            >
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The exchange section of the Real trade tab; render only with trading on. */
export function ExchangeOrderPanel() {
  const exchange = useExchangeTrading();
  const { state } = exchange;
  return (
    <section
      aria-labelledby="exchange-orders-title"
      className="flex flex-col gap-3 border-t border-border/70 pt-4"
      data-testid="exchange-panel"
    >
      <h2 id="exchange-orders-title" className="text-sm font-semibold">
        Exchange limit order
      </h2>
      <p className="text-xs text-muted">
        Places a spot limit order with your Kraken or OKX API keys. The exchange
        checks it first and it is placed only after you confirm.
      </p>
      {state.status === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Checking exchange keys…
        </p>
      ) : state.status === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-muted">
            Exchange orders are unavailable: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={exchange.refresh}>
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        </div>
      ) : (
        <>
          <ExchangeTicket exchange={exchange} status={state.data} />
          <OrderList exchange={exchange} />
        </>
      )}
    </section>
  );
}
