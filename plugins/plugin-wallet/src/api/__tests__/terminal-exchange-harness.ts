/**
 * Shared harness for tests of the crypto terminal's Kraken and OKX order
 * routes. Each request goes through the real `handleWalletRoutes`,
 * `terminal-exchange.ts` and the signed venue clients; the runtime's fetch
 * answers as Kraken's and OKX's REST APIs do, after recomputing each request's
 * signature from test-only secrets and refusing a wrong one. The doubles keep
 * balances, validate-only checks, placed orders and cancels in memory and
 * record every call. No network is used and no real key exists here.
 */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type { TradePermissionMode } from "@elizaos/shared";
import {
  KRAKEN_API_URL,
  krakenSignature,
  okxSignature,
} from "../exchange-venues";
import { handleWalletRoutes, type WalletRouteContext } from "../wallet-routes";

/** Test-only credentials; the Kraken secret is base64 as Kraken issues it. */
export const HARNESS_EXCHANGE_SETTINGS = {
  KRAKEN_API_KEY: "kraken-test-key",
  KRAKEN_API_SECRET: Buffer.from("kraken-test-secret").toString("base64"),
  OKX_API_KEY: "okx-test-key",
  OKX_API_SECRET: "okx-test-secret",
  OKX_API_PASSPHRASE: "okx-test-passphrase",
} as const;

const OKX_URL = "https://www.okx.com";

export interface HarnessOrder {
  venue: "kraken" | "okx";
  orderId: string;
  clientOrderId: string;
  market: string;
  side: string;
  quantity: string;
  price: string;
  state: "open" | "canceled" | "filled";
  filled: string;
}

export interface HarnessExchangeCall {
  venue: "kraken" | "okx";
  method: string;
  path: string;
  params: Record<string, string>;
}

export interface TerminalExchangeHarness {
  readonly config: { features: { tradePermissionMode: TradePermissionMode } };
  readonly calls: HarnessExchangeCall[];
  readonly orders: HarnessOrder[];
  /** Available balances by venue and currency. */
  readonly balances: Record<"kraken" | "okx", Record<string, string>>;
  /** Kraken validate/place errors, as Kraken's `error` list would carry them. */
  krakenErrors: string[];
  /** Amounts open orders hold on Kraken, by currency key. */
  krakenHeld: Record<string, string>;
  /** When set, the next OKX order placement answers with this error code. */
  okxPlaceCode: string | null;
  /** Best bid each venue reports for every market. */
  bids: Record<"kraken" | "okx", string>;
  /** When set, the next order placement throws before any answer arrives. */
  dropNextPlacement: boolean;
  request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createTerminalExchangeHarness(
  options: {
    mode?: TradePermissionMode;
    settings?: Record<string, string>;
    /** A config object to share, so another harness's mode changes apply here. */
    config?: { features: { tradePermissionMode: TradePermissionMode } };
  } = {},
): TerminalExchangeHarness {
  const settings: Record<string, string> = {
    ...HARNESS_EXCHANGE_SETTINGS,
    ...options.settings,
  };
  const harness: TerminalExchangeHarness = {
    config: options.config ?? {
      features: { tradePermissionMode: options.mode ?? "manual-local-key" },
    },
    calls: [],
    orders: [],
    balances: {
      kraken: { ZUSD: "500.0000", SOL: "3.0000000000" },
      okx: { USD: "500", SOL: "3" },
    },
    krakenErrors: [],
    krakenHeld: {},
    okxPlaceCode: null,
    bids: { kraken: "150.00", okx: "150.00" },
    dropNextPlacement: false,
    request,
  };

  function kraken(path: string, init: RequestInit): Response {
    const headers = init.headers as Record<string, string>;
    const body = String(init.body ?? "");
    const params = Object.fromEntries(new URLSearchParams(body));
    const expected = krakenSignature(
      path,
      params.nonce ?? "",
      body,
      HARNESS_EXCHANGE_SETTINGS.KRAKEN_API_SECRET,
    );
    if (
      headers["API-Key"] !== HARNESS_EXCHANGE_SETTINGS.KRAKEN_API_KEY ||
      headers["API-Sign"] !== expected
    ) {
      return json({ error: ["EAPI:Invalid signature"] });
    }
    const method = path.replace("/0/private/", "");
    harness.calls.push({ venue: "kraken", method, path, params });
    if (method === "BalanceEx") {
      return json({
        error: [],
        result: Object.fromEntries(
          Object.entries(harness.balances.kraken).map(([key, balance]) => [
            key,
            { balance, hold_trade: harness.krakenHeld[key] ?? "0.0000" },
          ]),
        ),
      });
    }
    if (method === "AddOrder") {
      if (harness.krakenErrors.length > 0) {
        return json({ error: harness.krakenErrors });
      }
      if (params.pair !== "SOLUSD" && params.pair !== "SOLUSDC") {
        return json({ error: ["EQuery:Unknown asset pair"] });
      }
      const descr = {
        order: `${params.type} ${params.volume} ${params.pair} @ limit ${params.price}`,
      };
      if (params.validate === "true") {
        return json({ error: [], result: { descr } });
      }
      if (harness.dropNextPlacement) {
        harness.dropNextPlacement = false;
        harness.orders.push(orderFrom("kraken", params.pair ?? "", params));
        throw new Error("socket hang up");
      }
      const order = orderFrom("kraken", params.pair ?? "", params);
      harness.orders.push(order);
      return json({ error: [], result: { descr, txid: [order.orderId] } });
    }
    if (method === "OpenOrders") {
      const open = harness.orders.filter(
        (order) =>
          order.venue === "kraken" &&
          order.state === "open" &&
          order.clientOrderId === params.cl_ord_id,
      );
      return json({
        error: [],
        result: {
          open: Object.fromEntries(
            open.map((order) => [order.orderId, { status: "open" }]),
          ),
        },
      });
    }
    if (method === "ClosedOrders") {
      const closed = harness.orders.filter(
        (order) =>
          order.venue === "kraken" &&
          order.state !== "open" &&
          order.clientOrderId === params.cl_ord_id,
      );
      return json({
        error: [],
        result: {
          closed: Object.fromEntries(
            closed.map((order) => [order.orderId, { status: order.state }]),
          ),
        },
      });
    }
    if (method === "QueryOrders") {
      const order = harness.orders.find((o) => o.orderId === params.txid);
      return json({
        error: [],
        result: order
          ? {
              [order.orderId]: {
                status: order.state === "filled" ? "closed" : order.state,
                vol: order.quantity,
                vol_exec: order.filled,
              },
            }
          : {},
      });
    }
    if (method === "CancelOrder") {
      const order = harness.orders.find((o) => o.orderId === params.txid);
      if (!order) return json({ error: ["EOrder:Unknown order"] });
      order.state = "canceled";
      return json({ error: [], result: { count: 1 } });
    }
    return json({ error: [`EGeneral:Unknown method ${method}`] });
  }

  function okx(url: URL, init: RequestInit): Response {
    const headers = init.headers as Record<string, string>;
    const method = String(init.method ?? "GET");
    const body = typeof init.body === "string" ? init.body : "";
    const requestPath = `${url.pathname}${url.search}`;
    const params: Record<string, string> = {
      ...Object.fromEntries(url.searchParams),
      ...(body ? (JSON.parse(body) as Record<string, string>) : {}),
    };
    if (
      url.pathname !== "/api/v5/public/instruments" &&
      url.pathname !== "/api/v5/market/ticker"
    ) {
      const expected = okxSignature(
        headers["OK-ACCESS-TIMESTAMP"] ?? "",
        method,
        requestPath,
        body,
        HARNESS_EXCHANGE_SETTINGS.OKX_API_SECRET,
      );
      if (
        headers["OK-ACCESS-KEY"] !== HARNESS_EXCHANGE_SETTINGS.OKX_API_KEY ||
        headers["OK-ACCESS-PASSPHRASE"] !==
          HARNESS_EXCHANGE_SETTINGS.OKX_API_PASSPHRASE ||
        headers["OK-ACCESS-SIGN"] !== expected
      ) {
        return json({ code: "50113", msg: "Invalid Sign", data: [] }, 401);
      }
    }
    harness.calls.push({
      venue: "okx",
      method,
      path: url.pathname,
      params,
    });
    if (url.pathname === "/api/v5/market/ticker") {
      return json({
        code: "0",
        msg: "",
        data: [{ instId: params.instId, bidPx: harness.bids.okx }],
      });
    }
    if (url.pathname === "/api/v5/public/instruments") {
      const live = params.instId === "SOL-USD" || params.instId === "SOL-USDC";
      return json({
        code: "0",
        msg: "",
        data: live
          ? [
              {
                instId: params.instId,
                state: "live",
                lotSz: "0.0001",
                tickSz: "0.01",
                minSz: "0.01",
              },
            ]
          : [],
      });
    }
    if (url.pathname === "/api/v5/account/balance") {
      const ccy = params.ccy ?? "";
      return json({
        code: "0",
        msg: "",
        data: [
          {
            details:
              ccy in harness.balances.okx
                ? [{ ccy, availBal: harness.balances.okx[ccy] }]
                : [],
          },
        ],
      });
    }
    if (url.pathname === "/api/v5/trade/order" && method === "POST") {
      if (harness.dropNextPlacement) {
        harness.dropNextPlacement = false;
        throw new Error("socket hang up");
      }
      if (harness.okxPlaceCode !== null) {
        const code = harness.okxPlaceCode;
        harness.okxPlaceCode = null;
        return json({
          code: "1",
          msg: "",
          data: [{ sCode: code, sMsg: `error ${code}` }],
        });
      }
      const order = orderFrom("okx", params.instId ?? "", {
        type: params.side ?? "",
        volume: params.sz ?? "",
        price: params.px ?? "",
        cl_ord_id: params.clOrdId ?? "",
      });
      harness.orders.push(order);
      return json({
        code: "0",
        msg: "",
        data: [
          {
            ordId: order.orderId,
            clOrdId: params.clOrdId,
            sCode: "0",
            sMsg: "",
          },
        ],
      });
    }
    if (url.pathname === "/api/v5/trade/order" && method === "GET") {
      const order = harness.orders.find(
        (o) =>
          o.venue === "okx" &&
          (o.orderId === params.ordId || o.clientOrderId === params.clOrdId),
      );
      return json({
        code: "0",
        msg: "",
        data: order
          ? [
              {
                ordId: order.orderId,
                state: order.state === "open" ? "live" : order.state,
                accFillSz: order.filled,
              },
            ]
          : [],
      });
    }
    if (url.pathname === "/api/v5/trade/cancel-order") {
      const order = harness.orders.find((o) => o.orderId === params.ordId);
      if (!order) {
        return json({
          code: "1",
          msg: "",
          data: [{ sCode: "51400", sMsg: "Order does not exist" }],
        });
      }
      order.state = "canceled";
      return json({
        code: "0",
        msg: "",
        data: [{ ordId: order.orderId, sCode: "0", sMsg: "" }],
      });
    }
    return json({ code: "50000", msg: "unknown path", data: [] }, 404);
  }

  function orderFrom(
    venue: "kraken" | "okx",
    market: string,
    params: Record<string, string>,
  ): HarnessOrder {
    return {
      venue,
      orderId:
        venue === "kraken"
          ? `O${crypto.randomBytes(4).toString("hex").toUpperCase()}`
          : String(crypto.randomInt(1e9, 2e9)),
      clientOrderId: params.cl_ord_id ?? "",
      market,
      side: params.type ?? "",
      quantity: params.volume ?? "",
      price: params.price ?? "",
      state: "open",
      filled: "0",
    };
  }

  const networkFetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === KRAKEN_API_URL && url.pathname === "/0/public/Ticker") {
      harness.calls.push({
        venue: "kraken",
        method: "Ticker",
        path: url.pathname,
        params: Object.fromEntries(url.searchParams),
      });
      return json({
        error: [],
        result: {
          [url.searchParams.get("pair") ?? ""]: {
            b: [harness.bids.kraken, "1", "1.000"],
          },
        },
      });
    }
    if (url.origin === KRAKEN_API_URL) return kraken(url.pathname, init);
    if (url.origin === OKX_URL) return okx(url, init);
    throw new Error(`unexpected request: ${url.href}`);
  };

  const quiet = () => undefined;
  const runtime = {
    agentId: "terminal-exchange-test",
    fetch: networkFetch,
    getSetting: (key: string) => settings[key] ?? null,
    getService: () => null,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  } as unknown as IAgentRuntime;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const res: { statusCode: number; body: Record<string, unknown> } = {
      statusCode: 0,
      body: {},
    };
    const ctx = {
      req: { headers },
      res,
      method,
      pathname: path,
      config: harness.config,
      saveConfig: () => undefined,
      ensureWalletKeysInEnvAndConfig: () => true,
      resolveWalletExportRejection: () => null,
      deps: {},
      runtime,
      readJsonBody: async () => body ?? {},
      json(target: typeof res, data: Record<string, unknown>, status = 200) {
        target.statusCode = status;
        target.body = data;
      },
      error(target: typeof res, message: string, status = 400) {
        target.statusCode = status;
        target.body = { error: message };
      },
    } as unknown as WalletRouteContext;
    const handled = await handleWalletRoutes(ctx);
    if (!handled) throw new Error(`route not handled: ${method} ${path}`);
    return { status: res.statusCode, body: res.body };
  }

  return harness;
}
