/**
 * End-to-end check of the terminal MCP server as an MCP client sees it: spawns
 * the real `run-terminal-mcp.ts` entry over stdio with the real
 * `@modelcontextprotocol/sdk` client, pointed at a local HTTP server that
 * mounts the real DexScreener pairs route (its upstream served from the sample
 * payload). Covers the advertised read-only tool list and annotations, a tool
 * call answered by the route, and an invalid argument returned as an MCP error
 * result. Skipped only when the optional SDK is not installed.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __resetWalletTerminalPairsRouteForTests,
  __setWalletTerminalPairsFetchForTests,
  handleWalletTerminalPairsRoute,
} from "../routes/wallet-terminal-pairs-route";

const sdkInstalled = (() => {
  try {
    createRequire(import.meta.url).resolve("@modelcontextprotocol/sdk/client");
    return true;
  } catch {
    // error-policy:J3 an unresolvable optional package means "not installed".
    return false;
  }
})();

const sample = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../routes/__fixtures__/dexscreener-token-pairs.sample.json",
    ),
    "utf8",
  ),
) as { mint: string; dexscreener: unknown[] };

const TOKEN = "mcp-e2e-token";
let server: http.Server;
let origin = "";

beforeAll(async () => {
  __setWalletTerminalPairsFetchForTests(
    async () =>
      new Response(JSON.stringify(sample.dexscreener), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    void handleWalletTerminalPairsRoute(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  __resetWalletTerminalPairsRouteForTests();
  await new Promise<void>((done) => server.close(() => done()));
});

describe.skipIf(!sdkInstalled)("terminal MCP server over stdio", () => {
  it("lists read-only tools and answers a call through the agent route", async () => {
    const clientSpec = "@modelcontextprotocol/sdk/client/index.js";
    const stdioSpec = "@modelcontextprotocol/sdk/client/stdio.js";
    const { Client } = (await import(clientSpec)) as {
      Client: new (info: {
        name: string;
        version: string;
      }) => {
        connect(transport: unknown): Promise<void>;
        listTools(): Promise<{
          tools: Array<{
            name: string;
            annotations?: Record<string, boolean>;
            inputSchema: { properties?: Record<string, unknown> };
          }>;
        }>;
        callTool(request: {
          name: string;
          arguments: Record<string, unknown>;
        }): Promise<{
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        }>;
        close(): Promise<void>;
      };
    };
    const { StdioClientTransport } = (await import(stdioSpec)) as {
      StdioClientTransport: new (options: {
        command: string;
        args: string[];
        env: Record<string, string>;
        stderr: "pipe";
      }) => unknown;
    };
    const client = new Client({ name: "terminal-mcp-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath.endsWith("bun") ? process.execPath : "bun",
        args: [resolve(import.meta.dirname, "run-terminal-mcp.ts")],
        env: {
          PATH: process.env.PATH ?? "",
          ELIZA_TERMINAL_MCP_URL: origin,
          ELIZA_API_TOKEN: TOKEN,
        },
        stderr: "pipe",
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "terminal_markets",
        "terminal_chart",
        "token_safety",
        "token_pairs",
        "social_signal",
        "trade_status",
      ]);
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
        });
      }
      expect(
        tools.find((tool) => tool.name === "token_pairs")?.inputSchema
          .properties,
      ).toHaveProperty("mint");

      const answered = await client.callTool({
        name: "token_pairs",
        arguments: { mint: sample.mint },
      });
      expect(answered.isError).toBeFalsy();
      expect(JSON.parse(answered.content[0]?.text ?? "")).toMatchObject({
        status: "found",
        pairCount: 2,
      });

      const refused = await client.callTool({
        name: "token_pairs",
        arguments: { mint: "not-a-mint" },
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain(
        "mint must be a base58 Solana mint address",
      );
    } finally {
      await client.close();
    }
  }, 60_000);
});
