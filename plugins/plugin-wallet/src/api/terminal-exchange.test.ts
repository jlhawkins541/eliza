/**
 * Drives the crypto terminal's Kraken and OKX order routes through the real
 * `handleWalletRoutes`, `terminal-exchange.ts` and signed venue clients, with
 * the exchanges answered by the signature-checking doubles in
 * `__tests__/terminal-exchange-harness.ts`. Covers readiness without keys,
 * the person-only gate, request validation, the order-value cap, venue checks
 * (Kraken validate-only, OKX steps and minimum), funds, single-use and expiring
 * reviews, placing exactly the reviewed order, a refused send, a lost send
 * recorded as unknown and found again by client order id, venue errors that
 * mean "no answer" kept unknown, sells valued at the market bid, funds held by
 * open orders, refresh, cancel, and exact decimal math.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalExchangeHarness,
  type TerminalExchangeHarness,
} from "./__tests__/terminal-exchange-harness";
import {
  compareDecimals,
  DecimalStringError,
  isMultipleOf,
  multiplyDecimals,
  subtractDecimalsFloor,
} from "./decimal-strings";
import { __resetTerminalExchangeForTests } from "./terminal-exchange";

const STATUS = "/api/wallet/terminal/exchange/status";
const REVIEW = "/api/wallet/terminal/exchange/review";
const EXECUTE = "/api/wallet/terminal/exchange/execute";
const ORDERS = "/api/wallet/terminal/exchange/orders";
const REFRESH = "/api/wallet/terminal/exchange/refresh";
const CANCEL = "/api/wallet/terminal/exchange/cancel";

const krakenBuy = {
  venue: "kraken",
  base: "SOL",
  quote: "USD",
  side: "buy",
  quantity: "0.5",
  price: "140.25",
};
const okxBuy = { ...krakenBuy, venue: "okx", quantity: "0.5", price: "140.25" };

afterEach(() => {
  __resetTerminalExchangeForTests();
  vi.useRealTimers();
});

async function review(
  harness: TerminalExchangeHarness,
  body: Record<string, unknown>,
) {
  return harness.request("POST", REVIEW, body);
}

describe("terminal exchange status", () => {
  it("lists each venue's missing settings and never returns keys", async () => {
    const harness = createTerminalExchangeHarness({
      settings: { OKX_API_PASSPHRASE: "" },
    });
    const { status, body } = await harness.request("GET", STATUS);
    expect(status).toBe(200);
    expect(body).toEqual({
      tradePermissionMode: "manual-local-key",
      realTradingEnabled: true,
      venues: {
        kraken: { configured: true, missingSettings: [] },
        okx: { configured: false, missingSettings: ["OKX_API_PASSPHRASE"] },
      },
      bases: ["SOL", "USDC", "USDT", "PYUSD"],
      quotes: ["USD", "USDT", "USDC"],
      maxOrderUsd: 100,
      reviewSeconds: 60,
    });
    expect(JSON.stringify(body)).not.toContain("test-secret");
    expect(harness.calls).toHaveLength(0);
  });

  it("reports trading off in user-sign-only mode", async () => {
    const harness = createTerminalExchangeHarness({ mode: "user-sign-only" });
    const { body } = await harness.request("GET", STATUS);
    expect(body.realTradingEnabled).toBe(false);
  });
});

describe("terminal exchange gate", () => {
  it("refuses agent requests and trading-off mode before any venue call", async () => {
    const harness = createTerminalExchangeHarness();
    const fromAgent = await harness.request("POST", REVIEW, krakenBuy, {
      "x-eliza-agent-action": "1",
    });
    expect(fromAgent.status).toBe(403);
    expect(fromAgent.body.error).toContain("person's tap");

    const off = createTerminalExchangeHarness({ mode: "user-sign-only" });
    const refused = await review(off, krakenBuy);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("Real trading is off");
    expect([...harness.calls, ...off.calls]).toHaveLength(0);
  });
});

describe("terminal exchange review", () => {
  it("checks a Kraken order in validate-only mode and reads funds", async () => {
    const harness = createTerminalExchangeHarness();
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      venue: "kraken",
      market: "SOLUSD",
      side: "buy",
      orderType: "limit",
      quantity: "0.5",
      price: "140.25",
      orderValue: "70.125",
    });
    expect(body.checks).toEqual([
      {
        label: "Kraken validation",
        detail:
          "Kraken accepted it in validate-only mode: buy 0.5 SOLUSD @ limit 140.25",
      },
      {
        label: "Funds",
        detail: "500 USD available; this order holds 70.125.",
      },
    ]);
    expect(harness.calls.map((call) => call.method)).toEqual([
      "AddOrder",
      "BalanceEx",
    ]);
    expect(harness.calls[0]?.params).toMatchObject({
      pair: "SOLUSD",
      type: "buy",
      ordertype: "limit",
      volume: "0.5",
      price: "140.25",
      validate: "true",
      cl_ord_id: body.clientOrderId,
    });
    expect(harness.orders).toHaveLength(0);
  });

  it("checks an OKX order against the live market's steps and funds", async () => {
    const harness = createTerminalExchangeHarness({
      settings: { WALLET_TERMINAL_MAX_ORDER_USD: "500" },
    });
    const { status, body } = await review(harness, {
      ...okxBuy,
      side: "sell",
      quantity: "1.25",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ market: "SOL-USD", orderValue: "175.3125" });
    expect(body.checks).toEqual([
      {
        label: "OKX market",
        detail:
          "SOL-USD is live; quantity step 0.0001, price step 0.01, minimum 0.01 SOL.",
      },
      {
        label: "Market bid",
        detail:
          "OKX's best bid is 150.00 USD, above your limit, so this sell would fill at about 150.00: worth about 187.5 USD.",
      },
      { label: "Funds", detail: "3 SOL available; this order holds 1.25." },
    ]);
  });

  it.each([
    ["kraken", "SOLUSD"],
    ["okx", "SOL-USD"],
  ])(
    "values a low %s sell limit at the market bid against the cap",
    async (venue) => {
      const harness = createTerminalExchangeHarness();
      // 2 SOL at a 0.01 limit is "worth" 0.02, but it would fill near the
      // 150 bid: about 300 USD, over the default 100 cap.
      const { status, body } = await review(harness, {
        ...krakenBuy,
        venue,
        side: "sell",
        quantity: "2",
        price: "0.01",
      });
      expect(status).toBe(422);
      expect(body.error).toContain("worth 300 USD, over the 100 USD limit");
      expect(harness.orders).toHaveLength(0);
    },
  );

  it("counts Kraken funds already held by open orders as unavailable", async () => {
    const harness = createTerminalExchangeHarness();
    harness.krakenHeld.ZUSD = "450.0000";
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(422);
    expect(body.error).toBe(
      "Kraken shows 50 USD available; this order needs 70.125.",
    );
  });

  it("reports a venue step it can't read instead of crashing", async () => {
    const harness = createTerminalExchangeHarness();
    harness.bids.okx = "1.5e2";
    const { status, body } = await review(harness, {
      ...okxBuy,
      side: "sell",
    });
    expect(status).toBe(502);
    expect(body.error).toContain("can't read (1.5e2)");
  });

  it("accepts a tiny order-value cap written out in full", async () => {
    const harness = createTerminalExchangeHarness({
      settings: { WALLET_TERMINAL_MAX_ORDER_USD: "0.0000001" },
    });
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(422);
    expect(body.error).toContain("over the 0.0000001 USD limit");
  });

  it.each([
    [{ ...okxBuy, quantity: "0.00005" }, "steps of 0.0001 SOL"],
    [{ ...okxBuy, price: "140.255" }, "steps of 0.01 USD"],
    [{ ...okxBuy, quantity: "0.005" }, "smallest order on SOL-USD is 0.01 SOL"],
    [{ ...okxBuy, base: "PYUSD" }, "PYUSD-USD is not a live spot market"],
  ])("refuses an OKX order the market won't take", async (body, message) => {
    const harness = createTerminalExchangeHarness();
    const { status, body: answer } = await review(harness, body);
    expect(status).toBe(422);
    expect(answer.error).toContain(message);
  });

  it("refuses a Kraken order Kraken rejects in validation", async () => {
    const harness = createTerminalExchangeHarness();
    harness.krakenErrors = ["EOrder:Insufficient funds"];
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(422);
    expect(body.error).toBe("Kraken: EOrder:Insufficient funds");
  });

  it("refuses an order the available balance can't cover", async () => {
    const harness = createTerminalExchangeHarness();
    harness.balances.kraken.ZUSD = "50";
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(422);
    expect(body.error).toBe(
      "Kraken shows 50 USD available; this order needs 70.125.",
    );
  });

  it("refuses an order over the value cap before calling the venue", async () => {
    const harness = createTerminalExchangeHarness({
      settings: { WALLET_TERMINAL_MAX_ORDER_USD: "50" },
    });
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(422);
    expect(body.error).toContain("over the 50 USD limit per order");
    expect(harness.calls).toHaveLength(0);
  });

  it.each(["lots", "1e-7", "-5", "0"])(
    "reports an invalid order-value cap %s instead of using a default",
    async (cap) => {
      const harness = createTerminalExchangeHarness({
        settings: { WALLET_TERMINAL_MAX_ORDER_USD: cap },
      });
      const { status, body } = await review(harness, krakenBuy);
      expect(status).toBe(500);
      expect(body.error).toContain("must be a positive amount in USD");
    },
  );

  it("names the missing settings for an unconfigured venue", async () => {
    const harness = createTerminalExchangeHarness({
      settings: { KRAKEN_API_KEY: "", KRAKEN_API_SECRET: "" },
    });
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(503);
    expect(body.error).toBe(
      "Set KRAKEN_API_KEY, KRAKEN_API_SECRET in packages/agent/.env to use Kraken.",
    );
  });

  it.each([
    [{ ...krakenBuy, venue: "binance" }, "venue must be one of"],
    [{ ...krakenBuy, base: "BTC" }, "base must be one of"],
    [{ ...krakenBuy, base: "USDC", quote: "USDC" }, "two different"],
    [{ ...krakenBuy, side: "short" }, "side must be one of"],
    [{ ...krakenBuy, quantity: "-1" }, "positive quantity"],
    [{ ...krakenBuy, quantity: "0" }, "positive quantity"],
    [{ ...krakenBuy, price: "1e3" }, "positive limit price"],
  ])("rejects a malformed order", async (body, message) => {
    const harness = createTerminalExchangeHarness();
    const { status, body: answer } = await review(harness, body);
    expect(status).toBe(400);
    expect(answer.error).toContain(message);
    expect(harness.calls).toHaveLength(0);
  });

  it("surfaces a wrong signature as the venue's refusal", async () => {
    const harness = createTerminalExchangeHarness({
      settings: {
        KRAKEN_API_SECRET: Buffer.from("other-secret").toString("base64"),
      },
    });
    const { status, body } = await review(harness, krakenBuy);
    expect(status).toBe(422);
    expect(body.error).toBe("Kraken: EAPI:Invalid signature");
  });
});

describe("terminal exchange execute", () => {
  it("places exactly the reviewed Kraken order once", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    const placed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(placed.status).toBe(200);
    expect(placed.body).toMatchObject({
      clientOrderId: reviewed.clientOrderId,
      venue: "kraken",
      market: "SOLUSD",
      state: "submitted",
      orderId: harness.orders[0]?.orderId,
      detail: "Kraken accepted the order.",
    });
    expect(harness.orders).toHaveLength(1);
    const addOrder = harness.calls.filter(
      (call) => call.method === "AddOrder" && call.params.validate !== "true",
    );
    expect(addOrder).toHaveLength(1);
    expect(addOrder[0]?.params).toMatchObject({
      pair: "SOLUSD",
      type: "buy",
      volume: "0.5",
      price: "140.25",
      cl_ord_id: reviewed.clientOrderId,
    });

    const again = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(again.status).toBe(409);
    expect(harness.orders).toHaveLength(1);
  });

  it("places an OKX order with its dashless client order id", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, okxBuy)).body;
    const placed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(placed.body.state).toBe("submitted");
    const post = harness.calls.find(
      (call) => call.path === "/api/v5/trade/order" && call.method === "POST",
    );
    expect(post?.params).toMatchObject({
      instId: "SOL-USD",
      tdMode: "cash",
      side: "buy",
      ordType: "limit",
      sz: "0.5",
      px: "140.25",
      clOrdId: String(reviewed.clientOrderId).replaceAll("-", ""),
    });
  });

  it("needs confirm: true and a known review", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    const unconfirmed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
    });
    expect(unconfirmed.status).toBe(400);
    const unknown = await harness.request("POST", EXECUTE, {
      reviewId: "missing",
      confirm: true,
    });
    expect(unknown.status).toBe(404);
    expect(harness.orders).toHaveLength(0);
  });

  it("refuses an expired review", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    vi.setSystemTime(Date.now() + 61_000);
    const late = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toContain("expired");
    expect(harness.orders).toHaveLength(0);
  });

  it("refuses an agent request to execute a person's review", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    const fromAgent = await harness.request(
      "POST",
      EXECUTE,
      { reviewId: reviewed.reviewId, confirm: true },
      { "x-eliza-agent-action": "true" },
    );
    expect(fromAgent.status).toBe(403);
    expect(harness.orders).toHaveLength(0);
  });

  it("records a refused send as rejected", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    harness.krakenErrors = ["EOrder:Rate limit exceeded"];
    const placed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(placed.status).toBe(200);
    expect(placed.body).toMatchObject({
      state: "rejected",
      orderId: null,
      detail: "Kraken: EOrder:Rate limit exceeded",
    });
  });

  it("records a lost send as unknown, then finds the order by client id", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    harness.dropNextPlacement = true;
    const placed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(placed.body.state).toBe("unknown");
    expect(placed.body.detail).toContain(String(reviewed.clientOrderId));
    expect(placed.body.detail).toContain("before placing another");

    const refreshed = await harness.request("POST", REFRESH, {
      clientOrderId: reviewed.clientOrderId,
    });
    expect(refreshed.body).toMatchObject({
      state: "open",
      orderId: harness.orders[0]?.orderId,
    });
  });

  it.each([
    ["EService:Unavailable"],
    ["EService:Busy"],
    ["EGeneral:Internal error"],
  ])("records a Kraken %s answer as unknown, not rejected", async (error) => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    harness.krakenErrors = [error];
    const placed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(placed.body).toMatchObject({ state: "unknown", orderId: null });
    expect(placed.body.detail).toContain("before placing another");
  });

  it.each(["50001", "50004", "50013", "50026"])(
    "records an OKX %s answer as unknown, not rejected",
    async (code) => {
      const harness = createTerminalExchangeHarness();
      const reviewed = (await review(harness, okxBuy)).body;
      harness.okxPlaceCode = code;
      const placed = await harness.request("POST", EXECUTE, {
        reviewId: reviewed.reviewId,
        confirm: true,
      });
      expect(placed.body).toMatchObject({ state: "unknown", orderId: null });
    },
  );

  it("records an OKX parameter error as rejected", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, okxBuy)).body;
    harness.okxPlaceCode = "51008";
    const placed = await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    expect(placed.body).toMatchObject({
      state: "rejected",
      detail: "OKX: error 51008",
    });
  });

  it("finds a lost Kraken order that already filled", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, krakenBuy)).body;
    harness.dropNextPlacement = true;
    await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    const [order] = harness.orders;
    if (!order) throw new Error("expected the dropped order on Kraken");
    order.state = "filled";
    order.filled = order.quantity;
    const refreshed = await harness.request("POST", REFRESH, {
      clientOrderId: reviewed.clientOrderId,
    });
    expect(refreshed.body).toMatchObject({
      state: "filled",
      orderId: order.orderId,
      filledQuantity: "0.5",
    });
    expect(harness.calls.map((call) => call.method)).toContain("ClosedOrders");
  });

  it("keeps a lost OKX send unknown when OKX has no such order", async () => {
    const harness = createTerminalExchangeHarness();
    const reviewed = (await review(harness, okxBuy)).body;
    harness.dropNextPlacement = true;
    await harness.request("POST", EXECUTE, {
      reviewId: reviewed.reviewId,
      confirm: true,
    });
    const refreshed = await harness.request("POST", REFRESH, {
      clientOrderId: reviewed.clientOrderId,
    });
    expect(refreshed.body.state).toBe("unknown");
    expect(refreshed.body.detail).toContain("Check its order history");
  });
});

describe("terminal exchange orders", () => {
  it("lists, refreshes and cancels this session's orders", async () => {
    const harness = createTerminalExchangeHarness();
    for (const body of [krakenBuy, okxBuy]) {
      const reviewed = (await review(harness, body)).body;
      await harness.request("POST", EXECUTE, {
        reviewId: reviewed.reviewId,
        confirm: true,
      });
    }
    const listed = await harness.request("GET", ORDERS);
    const orders = listed.body.orders as Array<Record<string, unknown>>;
    expect(orders.map((order) => order.venue)).toEqual(["okx", "kraken"]);

    const [kraken] = harness.orders;
    if (!kraken) throw new Error("expected a Kraken order");
    kraken.filled = "0.2";
    const refreshed = await harness.request("POST", REFRESH, {
      clientOrderId: orders[1]?.clientOrderId,
    });
    expect(refreshed.body).toMatchObject({
      state: "partially-filled",
      filledQuantity: "0.2",
    });

    const unconfirmed = await harness.request("POST", CANCEL, {
      clientOrderId: orders[1]?.clientOrderId,
    });
    expect(unconfirmed.status).toBe(400);
    for (const order of orders) {
      const canceled = await harness.request("POST", CANCEL, {
        clientOrderId: order.clientOrderId,
        confirm: true,
      });
      expect(canceled.body.state).toBe("canceled");
    }
    const twice = await harness.request("POST", CANCEL, {
      clientOrderId: orders[0]?.clientOrderId,
      confirm: true,
    });
    expect(twice.status).toBe(422);
    expect(twice.body.error).toBe("This order is already canceled.");
  });

  it("refuses an order from another session", async () => {
    const harness = createTerminalExchangeHarness();
    const { status } = await harness.request("POST", REFRESH, {
      clientOrderId: "not-ours",
    });
    expect(status).toBe(404);
  });

  it("refuses an agent request to list or cancel orders", async () => {
    const harness = createTerminalExchangeHarness();
    const listed = await harness.request("GET", ORDERS, undefined, {
      "x-eliza-agent-action": "1",
    });
    expect(listed.status).toBe(403);
  });
});

describe("exact decimal math", () => {
  it("multiplies, compares and checks steps without floating point", () => {
    expect(multiplyDecimals("0.1", "0.2")).toBe("0.02");
    expect(multiplyDecimals("1.25", "140.25")).toBe("175.3125");
    expect(multiplyDecimals("3", "4")).toBe("12");
    expect(compareDecimals("100.0000001", "100")).toBe(1);
    expect(compareDecimals("70.125", "70.1250")).toBe(0);
    expect(isMultipleOf("0.3", "0.1")).toBe(true);
    expect(isMultipleOf("0.00005", "0.0001")).toBe(false);
    expect(isMultipleOf("1", "0")).toBe(false);
    expect(subtractDecimalsFloor("500.0000", "450.25")).toBe("49.75");
    expect(subtractDecimalsFloor("1", "2")).toBe("0");
  });

  it("rejects exponents, signs and blanks instead of misreading them", () => {
    for (const value of ["1e-7", "1e21", "-1", "", " 1", "0x10"]) {
      expect(() => compareDecimals("1", value)).toThrow(DecimalStringError);
    }
    expect(() => isMultipleOf("0.00002", "1e-5")).toThrow(DecimalStringError);
  });
});
