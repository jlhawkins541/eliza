/**
 * Tests the Crypto Queen setup check over real HTTP: a local server stands in
 * for Ollama's `/api/tags` and a Solana JSON-RPC endpoint, and real `fetch`
 * calls it. The wallet key is generated per test, the character file is the
 * shipped one, and no outside network is used.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCryptoQueenSetup,
  parseEnvFile,
  type SetupCheck,
  type SetupEnv,
} from "./setup-check";

const here = path.dirname(fileURLToPath(import.meta.url));
const characterPath = path.join(here, "../../characters/crypto-queen.json");

interface FakeServices {
  models: string[];
  health: string;
  lamports: number;
  rpcCalls: string[];
  lunarStatus: number;
  lunarAuth: string[];
}

let server: Server;
let baseUrl: string;
let services: FakeServices;

beforeEach(async () => {
  services = {
    models: ["llama3.1:latest", "nomic-embed-text:latest"],
    health: "ok",
    lamports: 250_000_000,
    rpcCalls: [],
    lunarStatus: 200,
    lunarAuth: [],
  };
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/tags") {
      res.end(
        JSON.stringify({ models: services.models.map((name) => ({ name })) }),
      );
      return;
    }
    if (req.url === "/lunarcrush/public/coins/btc/v1") {
      services.lunarAuth.push(String(req.headers.authorization));
      res.statusCode = services.lunarStatus;
      res.end(
        JSON.stringify({ data: { id: 1, symbol: "BTC", galaxy_score: 71 } }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const call = JSON.parse(raw) as { id: number; method: string };
        services.rpcCalls.push(call.method);
        const result =
          call.method === "getHealth"
            ? services.health
            : { context: { slot: 1 }, value: services.lamports };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const deps = {
  // LunarCrush calls go to the local server's /lunarcrush path instead.
  fetch: (input: string, init?: RequestInit) =>
    fetch(
      input.replace("https://lunarcrush.com/api4", `${baseUrl}/lunarcrush`),
      init,
    ),
  readFile: (filePath: string) => {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      // error-policy:J3 an unreadable path is the null the check expects.
      return null;
    }
  },
};

function fullEnv(wallet: Keypair): Record<string, string> {
  return {
    ELIZA_CHARACTER_PATH: characterPath,
    OLLAMA_BASE_URL: baseUrl,
    OLLAMA_SMALL_MODEL: "llama3.1",
    OLLAMA_LARGE_MODEL: "llama3.1",
    OLLAMA_EMBEDDING_MODEL: "nomic-embed-text",
    SOLANA_RPC_URL: `${baseUrl}/rpc`,
    SOLANA_PRIVATE_KEY: bs58.encode(wallet.secretKey),
    LUNARCRUSH_API_KEY: "test-lunarcrush-key",
  };
}

function find(checks: SetupCheck[], name: string): SetupCheck {
  const check = checks.find((entry) => entry.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check;
}

describe("checkCryptoQueenSetup", () => {
  it("passes every plugin when Ollama, Solana and the character are set up", async () => {
    const wallet = Keypair.generate();
    const env = {
      ...fullEnv(wallet),
      WALLET_TERMINAL_JITO_TIP_LAMPORTS: "100000",
    };
    const checks = await checkCryptoQueenSetup(env, deps);

    expect(checks.filter((check) => check.status !== "pass")).toEqual([]);
    expect(find(checks, "Character file").detail).toContain("Crypto Queen");
    expect(find(checks, "OLLAMA_EMBEDDING_MODEL").detail).toBe(
      "nomic-embed-text is pulled.",
    );
    const walletCheck = find(checks, "Solana wallet key");
    expect(walletCheck.detail).toContain(wallet.publicKey.toBase58());
    expect(walletCheck.detail).toContain("0.25 SOL");
    expect(services.rpcCalls).toEqual(["getHealth", "getBalance"]);
    expect(find(checks, "Jito tip").detail).toBe(
      "Trades sent through Jito tip 0.0001 SOL.",
    );
    expect(find(checks, "LunarCrush social signal").detail).toBe(
      "LunarCrush accepted the key (BTC Galaxy Score 71).",
    );
    expect(services.lunarAuth).toEqual(["Bearer test-lunarcrush-key"]);
    expect(find(checks, "Database").area).toBe("@elizaos/plugin-sql");
    for (const check of checks) {
      expect(check.detail).not.toContain(env.SOLANA_PRIVATE_KEY);
    }
  });

  it("fails each missing setting with the step that fixes it", async () => {
    const checks = await checkCryptoQueenSetup({}, deps);

    expect(find(checks, "Character file").status).toBe("fail");
    expect(find(checks, "Model settings").detail).toContain(
      "OLLAMA_SMALL_MODEL, OLLAMA_LARGE_MODEL, OLLAMA_EMBEDDING_MODEL",
    );
    expect(find(checks, "Ollama server").status).toBe("fail");
    expect(find(checks, "Solana RPC").detail).toContain(
      "Real trade won't work",
    );
    expect(find(checks, "Solana wallet key").status).toBe("warn");
    expect(services.rpcCalls).toEqual([]);
    expect(find(checks, "LunarCrush social signal").status).toBe("warn");
    expect(services.lunarAuth).toEqual([]);
  });

  it("names a model that is not pulled", async () => {
    services.models = ["llama3.1:latest"];
    const checks = await checkCryptoQueenSetup(
      fullEnv(Keypair.generate()),
      deps,
    );

    expect(find(checks, "OLLAMA_EMBEDDING_MODEL")).toMatchObject({
      status: "fail",
      detail:
        "nomic-embed-text is not pulled. Run `ollama pull nomic-embed-text`.",
    });
  });

  it("fails when Ollama or the RPC is down, without reading the balance", async () => {
    const env: SetupEnv = {
      ...fullEnv(Keypair.generate()),
      OLLAMA_BASE_URL: "http://127.0.0.1:1",
    };
    services.health = "behind";
    const checks = await checkCryptoQueenSetup(env, deps);

    expect(find(checks, "Ollama server").detail).toContain(
      "Ollama is not answering at http://127.0.0.1:1",
    );
    expect(find(checks, "Solana RPC").status).toBe("fail");
    expect(find(checks, "Solana wallet key")).toMatchObject({
      status: "pass",
    });
    expect(services.rpcCalls).toEqual(["getHealth"]);
  });

  it("rejects a malformed key, buy cap and Jito tip without echoing the key", async () => {
    const env: SetupEnv = {
      ...fullEnv(Keypair.generate()),
      SOLANA_PRIVATE_KEY: "not-a-key",
      WALLET_TERMINAL_MAX_BUY_SOL: "0",
      WALLET_TERMINAL_JITO_TIP_LAMPORTS: "500",
    };
    const checks = await checkCryptoQueenSetup(env, deps);

    const walletCheck = find(checks, "Solana wallet key");
    expect(walletCheck.status).toBe("fail");
    expect(walletCheck.detail).not.toContain("not-a-key");
    expect(find(checks, "Real trade buy cap").status).toBe("fail");
    expect(find(checks, "Jito tip").status).toBe("fail");
  });

  it("warns when a cloud model key could answer instead of Ollama", async () => {
    const checks = await checkCryptoQueenSetup(
      { ...fullEnv(Keypair.generate()), OPENAI_API_KEY: "set" },
      deps,
    );

    expect(find(checks, "Other model providers")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("OPENAI_API_KEY"),
    });
  });
});

describe("checkCryptoQueenSetup LunarCrush key", () => {
  it("fails a rejected key without printing it", async () => {
    services.lunarStatus = 401;
    const env = fullEnv(Keypair.generate());
    const check = find(
      await checkCryptoQueenSetup(env, deps),
      "LunarCrush social signal",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("The LunarCrush key was rejected");
    expect(check.detail).not.toContain("test-lunarcrush-key");
  });
});

describe("parseEnvFile", () => {
  it("reads dotenv lines, comments and quotes", () => {
    expect(
      parseEnvFile(
        '# comment\nOLLAMA_BASE_URL=http://localhost:11434\nexport SOLANA_RPC_URL="https://rpc.example"\n\nBAD LINE\nEMPTY=\n',
      ),
    ).toEqual({
      OLLAMA_BASE_URL: "http://localhost:11434",
      SOLANA_RPC_URL: "https://rpc.example",
      EMPTY: "",
    });
  });
});
