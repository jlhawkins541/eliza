/**
 * Drives the terminal MCP tools over real TCP against a local HTTP server that
 * mounts the real DexScreener pairs, GoPlus token safety and LunarCrush social
 * routes (their upstreams served from sample payloads through injected
 * fetches) behind a bearer-token check. Covers argument validation before any
 * request, the agent's answer passed through unchanged, a missing or wrong
 * token, an unreachable agent, the MCP error result shape, target resolution
 * from the environment, and that no tool can reach a trade review or execute.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __resetWalletTerminalPairsRouteForTests,
  __setWalletTerminalPairsFetchForTests,
  handleWalletTerminalPairsRoute,
} from "../routes/wallet-terminal-pairs-route";
import {
  __resetWalletTerminalSocialRouteForTests,
  handleWalletTerminalSocialRoute,
} from "../routes/wallet-terminal-social-route";
import {
  __resetWalletTerminalTokenSafetyRouteForTests,
  __setWalletTerminalTokenSafetyFetchForTests,
  handleWalletTerminalTokenSafetyRoute,
} from "../routes/wallet-terminal-token-safety-route";
import { runTerminalMcpTool } from "./server";
import {
  dispatchTerminalMcpTool,
  resolveTerminalMcpTarget,
  TERMINAL_MCP_TOOLS,
  TerminalMcpError,
  type TerminalMcpTarget,
  terminalMcpToolPath,
} from "./terminal-tools";

const fixtures = resolve(import.meta.dirname, "../routes/__fixtures__");
const pairsSample = JSON.parse(
  readFileSync(
    resolve(fixtures, "dexscreener-token-pairs.sample.json"),
    "utf8",
  ),
) as { mint: string; dexscreener: unknown[] };
const goplusSample = JSON.parse(
  readFileSync(
    resolve(fixtures, "goplus-solana-token-security.recorded.json"),
    "utf8",
  ),
) as { mint: string; goplus: unknown };

const TOKEN = "test-agent-api-token";
const MINT = pairsSample.mint;
let server: http.Server;
let baseUrl = "";
const served: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    served.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    void (async () => {
      const handled =
        (await handleWalletTerminalPairsRoute(req, res)) ||
        (await handleWalletTerminalTokenSafetyRoute(req, res)) ||
        (await handleWalletTerminalSocialRoute(req, res, {
          getSetting: () => null,
        }));
      if (!handled) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
      }
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

afterEach(() => {
  served.length = 0;
  __resetWalletTerminalPairsRouteForTests();
  __resetWalletTerminalTokenSafetyRouteForTests();
  __resetWalletTerminalSocialRouteForTests();
});

function target(token: string | null = TOKEN): TerminalMcpTarget {
  return {
    baseUrl,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    fetch: (input, init) => fetch(input, init),
  };
}

describe("terminal MCP tool catalog", () => {
  it("offers only read-only tools, none reaching a trade review or execute", () => {
    const paths = TERMINAL_MCP_TOOLS.map((tool) =>
      terminalMcpToolPath(tool.name, {
        id: "bitcoin",
        mint: MINT,
        symbol: "BONK",
      }),
    );
    expect(TERMINAL_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "terminal_markets",
      "terminal_chart",
      "token_safety",
      "token_pairs",
      "social_signal",
      "trade_status",
    ]);
    for (const path of paths) {
      expect(path).toMatch(/^\/api\/wallet\/terminal\//);
      expect(path).not.toMatch(/trade\/(review|execute)/);
    }
  });

  it("refuses bad arguments before any request", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["token_pairs", {}],
      ["token_pairs", { mint: "not-a-mint" }],
      ["token_safety", { mint: "0OIl" }],
      ["social_signal", { symbol: "BO NK" }],
      ["terminal_chart", { id: "bitcoin", days: 3 }],
      ["terminal_chart", { id: "../etc" }],
      ["trade_execute", {}],
    ];
    for (const [name, args] of bad) {
      expect(() => terminalMcpToolPath(name, args)).toThrow(TerminalMcpError);
    }
  });

  it("normalizes a $ticker and a chart's default range", () => {
    expect(terminalMcpToolPath("social_signal", { symbol: "$bonk" })).toBe(
      "/api/wallet/terminal/social?symbol=bonk",
    );
    expect(terminalMcpToolPath("terminal_chart", { id: "Solana" })).toBe(
      "/api/wallet/terminal/chart?id=solana&days=7",
    );
  });
});

describe("terminal MCP tools over the agent's routes", () => {
  it("returns the pairs route's answer unchanged", async () => {
    __setWalletTerminalPairsFetchForTests(async () =>
      json(pairsSample.dexscreener),
    );
    const answer = (await dispatchTerminalMcpTool(target(), "token_pairs", {
      mint: MINT,
    })) as { status: string; pairCount: number; totalLiquidityUsd: number };
    expect(answer).toMatchObject({
      status: "found",
      pairCount: 2,
      totalLiquidityUsd: 5_022_000,
    });
    expect(served).toEqual([`/api/wallet/terminal/pairs?mint=${MINT}`]);
  });

  it("returns the token safety verdict", async () => {
    __setWalletTerminalTokenSafetyFetchForTests(async () =>
      json(goplusSample.goplus),
    );
    const answer = (await dispatchTerminalMcpTool(target(), "token_safety", {
      mint: goplusSample.mint,
    })) as { verdict: string; checks: unknown[] };
    expect(answer.verdict).toBe("caution");
    expect(answer.checks.length).toBeGreaterThan(0);
  });

  it("passes the agent's no-key answer through for the social signal", async () => {
    const answer = await dispatchTerminalMcpTool(target(), "social_signal", {
      symbol: "BONK",
    });
    expect(answer).toEqual({ status: "no-key", symbol: "BONK" });
  });

  it("explains a missing or wrong API token", async () => {
    for (const token of [null, "wrong-token"]) {
      await expect(
        dispatchTerminalMcpTool(target(token), "token_pairs", { mint: MINT }),
      ).rejects.toThrow(/Set ELIZA_API_TOKEN/);
    }
  });

  it("reports the agent's own error text", async () => {
    __setWalletTerminalPairsFetchForTests(async () => json({}, 500));
    await expect(
      dispatchTerminalMcpTool(target(), "token_pairs", { mint: MINT }),
    ).rejects.toThrow("The agent answered DexScreener returned HTTP 500");
  });

  it("says the agent is unreachable and how to start it", async () => {
    const closed = http.createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    const error = await dispatchTerminalMcpTool(
      { ...target(), baseUrl: `http://127.0.0.1:${port}` },
      "terminal_markets",
      {},
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalMcpError);
    expect((error as TerminalMcpError).kind).toBe("unreachable");
    expect((error as Error).message).toContain("bun run start");
  });

  it("shapes success and failure as MCP results", async () => {
    __setWalletTerminalPairsFetchForTests(async () => json([]));
    const ok = await runTerminalMcpTool(target(), "token_pairs", {
      mint: MINT,
    });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]?.text ?? "")).toMatchObject({
      status: "no-pairs",
    });

    const failed = await runTerminalMcpTool(target(), "token_pairs", {
      mint: "nope",
    });
    expect(failed).toEqual({
      isError: true,
      content: [
        { type: "text", text: "mint must be a base58 Solana mint address" },
      ],
    });
    expect(served).toHaveLength(1);
  });
});

describe("resolveTerminalMcpTarget", () => {
  const fetcher = (input: string, init: RequestInit) => fetch(input, init);

  it("defaults to the local agent port with its API token", () => {
    const resolved = resolveTerminalMcpTarget(
      { ELIZA_API_TOKEN: "abc", ELIZA_PORT: "4123" },
      fetcher,
    );
    expect(resolved.baseUrl).toBe("http://127.0.0.1:4123");
    expect(resolved.headers).toEqual({ Authorization: "Bearer abc" });
  });

  it("sends no auth header when the agent has no token", () => {
    expect(resolveTerminalMcpTarget({}, fetcher).headers).toEqual({});
  });

  it("accepts an origin and refuses anything else", () => {
    expect(
      resolveTerminalMcpTarget(
        { ELIZA_TERMINAL_MCP_URL: "https://agent.example:8443/" },
        fetcher,
      ).baseUrl,
    ).toBe("https://agent.example:8443");
    for (const value of [
      "not a url",
      "ftp://agent.example",
      "https://user:pass@agent.example",
      "https://agent.example/api",
      "https://agent.example/?x=1",
    ]) {
      expect(() =>
        resolveTerminalMcpTarget({ ELIZA_TERMINAL_MCP_URL: value }, fetcher),
      ).toThrow(TerminalMcpError);
    }
  });
});
