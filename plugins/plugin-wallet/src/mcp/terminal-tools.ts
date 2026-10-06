/**
 * Read-only MCP tool catalog for the crypto terminal: markets, price history,
 * GoPlus token safety, DexScreener liquidity, LunarCrush social signal, and
 * the real-trade status, each answered by the running agent's own
 * `/api/wallet/terminal/*` routes.
 *
 * Consumers are `server.ts` (the MCP transport glue) and its tests. Every tool
 * is a GET against a route a person could already open in the terminal, so an
 * MCP client such as Claude Desktop can research a token but can never review,
 * sign, or send a trade: no tool reaches `trade/review` or `trade/execute`.
 * Arguments are validated here before any request; an invalid argument, an
 * unreachable agent, or a non-200 answer is a typed {@link TerminalMcpError}
 * rather than an empty result.
 */

import {
  createSelfApiRequestHeaders,
  resolveServerOnlyPort,
} from "@elizaos/shared";

/** One JSON-schema property of a tool argument. */
interface ToolProperty {
  type: "string" | "number";
  description: string;
  enum?: readonly (string | number)[];
}

export interface TerminalMcpTool {
  name: string;
  description: string;
  properties: Record<string, ToolProperty>;
  required: readonly string[];
}

const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const COINGECKO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SYMBOL_PATTERN = /^\$?[A-Za-z0-9]{1,20}$/;
const CHART_DAYS = [1, 7, 30, 90, 365] as const;
const REQUEST_TIMEOUT_MS = 30_000;

const MINT_PROPERTY: ToolProperty = {
  type: "string",
  description: "Base58 Solana token mint address.",
};

export const TERMINAL_MCP_TOOLS: readonly TerminalMcpTool[] = [
  {
    name: "terminal_markets",
    description:
      "List the top crypto assets by market cap with USD price, 24h change and volume, from CoinGecko via the elizaOS terminal. Read-only.",
    properties: {},
    required: [],
  },
  {
    name: "terminal_chart",
    description:
      "Read one asset's USD price history from CoinGecko via the elizaOS terminal. Read-only.",
    properties: {
      id: {
        type: "string",
        description: "CoinGecko asset id, such as bitcoin or solana.",
      },
      days: {
        type: "number",
        description: "How many days of history.",
        enum: CHART_DAYS,
      },
    },
    required: ["id"],
  },
  {
    name: "token_safety",
    description:
      "Run the GoPlus rug-risk check on a Solana mint: authorities, Token-2022 extensions, holder concentration and an avoid/caution/no-major-flags verdict. A third-party report is a signal, not proof. Read-only.",
    properties: { mint: MINT_PROPERTY },
    required: ["mint"],
  },
  {
    name: "token_pairs",
    description:
      "Read a Solana mint's DexScreener pools: price, liquidity, 24h volume and pool age. Thin liquidity or a pool under a day old adds caution and never clears a GoPlus flag. Read-only.",
    properties: { mint: MINT_PROPERTY },
    required: ["mint"],
  },
  {
    name: "social_signal",
    description:
      "Read LunarCrush's Galaxy Score, AltRank and sentiment for a ticker. Needs LUNARCRUSH_API_KEY on the agent; without it the answer says so. A low score adds caution and never clears a GoPlus flag. Read-only.",
    properties: {
      symbol: {
        type: "string",
        description: "Ticker symbol, such as SOL or BONK.",
      },
    },
    required: ["symbol"],
  },
  {
    name: "trade_status",
    description:
      "Read whether the terminal can place real trades: the trade permission mode, the signing wallet's public address, the per-trade buy cap and the Jito tip. Returns no keys. Trades themselves are only placed by a person in the terminal. Read-only.",
    properties: {},
    required: [],
  },
];

export type TerminalMcpErrorKind = "invalid-argument" | "unreachable" | "http";

/** A tool call that was refused before sending, or that the agent failed. */
export class TerminalMcpError extends Error {
  constructor(
    readonly kind: TerminalMcpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TerminalMcpError";
  }
}

export type TerminalMcpFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** Where the agent is and how to authenticate to it. */
export interface TerminalMcpTarget {
  /** Agent API origin, such as `http://127.0.0.1:31337`. */
  baseUrl: string;
  headers: Record<string, string>;
  fetch: TerminalMcpFetch;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TerminalMcpError("invalid-argument", `${name} is required`);
  }
  return value.trim();
}

function matching(value: string, pattern: RegExp, message: string): string {
  if (!pattern.test(value)) {
    throw new TerminalMcpError("invalid-argument", message);
  }
  return value;
}

/** Validate a tool call's arguments and return the route path it reads. */
export function terminalMcpToolPath(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "terminal_markets":
      return "/api/wallet/terminal/markets";
    case "terminal_chart": {
      const id = matching(
        stringArg(args, "id").toLowerCase(),
        COINGECKO_ID_PATTERN,
        "id must be a CoinGecko asset id, such as bitcoin",
      );
      const rawDays = args.days ?? 7;
      if (
        typeof rawDays !== "number" ||
        !(CHART_DAYS as readonly number[]).includes(rawDays)
      ) {
        throw new TerminalMcpError(
          "invalid-argument",
          `days must be one of ${CHART_DAYS.join(", ")}`,
        );
      }
      return `/api/wallet/terminal/chart?${new URLSearchParams({
        id,
        days: String(rawDays),
      })}`;
    }
    case "token_safety":
    case "token_pairs": {
      const mint = matching(
        stringArg(args, "mint"),
        SOLANA_MINT_PATTERN,
        "mint must be a base58 Solana mint address",
      );
      const route = name === "token_safety" ? "token-safety" : "pairs";
      return `/api/wallet/terminal/${route}?${new URLSearchParams({ mint })}`;
    }
    case "social_signal": {
      const symbol = matching(
        stringArg(args, "symbol"),
        SYMBOL_PATTERN,
        "symbol must be a ticker of 1 to 20 letters or digits",
      ).replace(/^\$/, "");
      return `/api/wallet/terminal/social?${new URLSearchParams({ symbol })}`;
    }
    case "trade_status":
      return "/api/wallet/terminal/trade/status";
    default:
      throw new TerminalMcpError("invalid-argument", `Unknown tool: ${name}`);
  }
}

/**
 * Run one tool against the agent and return its JSON answer unchanged. Every
 * request is a GET; nothing here can change terminal or wallet state.
 */
export async function dispatchTerminalMcpTool(
  target: TerminalMcpTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const path = terminalMcpToolPath(name, args);
  const url = new URL(path, target.baseUrl).toString();
  let response: Response;
  try {
    response = await target.fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...target.headers },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // error-policy:J2 context-adding rethrow: a typed error for the MCP client.
    throw new TerminalMcpError(
      "unreachable",
      `The elizaOS agent at ${target.baseUrl} could not be reached (${
        error instanceof Error ? error.message : "request failed"
      }). Start it with bun run start.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing: an unreadable body is an error.
    throw new TerminalMcpError(
      "http",
      `The agent answered HTTP ${response.status} with a body that is not JSON (${
        error instanceof Error ? error.message : "parse failed"
      })`,
    );
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new TerminalMcpError(
      "http",
      response.status === 401 || response.status === 403
        ? `The agent refused the request (${detail}). Set ELIZA_API_TOKEN to the agent's API token.`
        : `The agent answered ${detail}`,
    );
  }
  return body;
}

/** Setting that points the MCP server at an agent other than the local one. */
export const TERMINAL_MCP_URL_SETTING = "ELIZA_TERMINAL_MCP_URL";

/**
 * Where the MCP server sends requests: `ELIZA_TERMINAL_MCP_URL` when set
 * (an http or https origin only), otherwise the local agent's API port, with
 * the agent's own API token as a bearer header.
 */
export function resolveTerminalMcpTarget(
  env: Record<string, string | undefined>,
  fetcher: TerminalMcpFetch,
): TerminalMcpTarget {
  const configured = env[TERMINAL_MCP_URL_SETTING]?.trim();
  let baseUrl = `http://127.0.0.1:${resolveServerOnlyPort(env)}`;
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch (error) {
      // error-policy:J3 untrusted-input sanitizing: an unparseable URL is an error.
      throw new TerminalMcpError(
        "invalid-argument",
        `${TERMINAL_MCP_URL_SETTING} is not a URL (${
          error instanceof Error ? error.message : "parse failed"
        })`,
      );
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new TerminalMcpError(
        "invalid-argument",
        `${TERMINAL_MCP_URL_SETTING} must be an http or https origin with no path, credentials or query`,
      );
    }
    // The agent's API token rides in every request, so plain http is only
    // allowed to this machine.
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
      parsed.hostname,
    );
    if (parsed.protocol === "http:" && !loopback) {
      throw new TerminalMcpError(
        "invalid-argument",
        `${TERMINAL_MCP_URL_SETTING} must use https for any host other than this machine, because the agent's API token is sent with each request`,
      );
    }
    baseUrl = parsed.origin;
  }
  return { baseUrl, headers: createSelfApiRequestHeaders(env), fetch: fetcher };
}
