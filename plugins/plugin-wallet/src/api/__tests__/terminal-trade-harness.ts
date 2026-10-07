/**
 * Shared harness for tests of the crypto terminal's real-trade routes. Each
 * request goes through the real `handleWalletRoutes`, `terminal-trade.ts`, and
 * Jupiter swap builder. The runtime's Jupiter API answers with real-shaped
 * quote and swap payloads whose swap transaction is a real unsigned v0
 * transaction paid by the test wallet; its Jito block engine records each
 * bundle-only send and answers like Jito's JSON-RPC; its Solana RPC is an
 * in-memory double that records every simulate, send, and confirm; and its
 * wallet backend is a
 * real `LocalEoaBackend` over a key generated per harness, so signatures are
 * real. No network is used and no real key exists here.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { TradePermissionMode } from "@elizaos/shared";
import {
  Keypair,
  type PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { generatePrivateKey } from "viem/accounts";
import { SOL_MINT } from "../../chains/registry";
import { SOLANA_SERVICE_NAME } from "../../chains/solana/constants";
import { DEFAULT_JUPITER_API_BASE_URL } from "../../chains/solana/jupiter-api";
import { WALLET_BACKEND_SERVICE_TYPE } from "../../services/wallet-backend-service";
import { LocalEoaBackend } from "../../wallet/local-eoa-backend";
import { handleWalletRoutes, type WalletRouteContext } from "../wallet-routes";

/** Decimals of the harness token mint. */
export const HARNESS_TOKEN_DECIMALS = 6;
/** Whole tokens one SOL buys in harness quotes. */
export const HARNESS_TOKENS_PER_SOL = 10_000n;
export const HARNESS_PRIORITY_FEE_LAMPORTS = 120_000;
export const HARNESS_LAST_VALID_BLOCK_HEIGHT = 1_000;

export interface HarnessResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface TerminalTradeHarnessOptions {
  mode?: TradePermissionMode;
  /** False gives a real backend that holds only an EVM key. */
  solanaSigner?: boolean;
  settings?: Record<string, string>;
  /** Token mint the RPC knows; a fresh random mint when omitted. */
  tokenMint?: string;
}

export interface TerminalTradeHarness {
  readonly wallet: Keypair;
  readonly tokenMint: string;
  readonly config: { features: { tradePermissionMode: TradePermissionMode } };
  readonly runtime: IAgentRuntime;
  /** Every Jupiter URL requested, in order. */
  readonly jupiterCalls: string[];
  /** Parsed bodies of each Jupiter `/swap` request. */
  readonly swapRequests: Record<string, unknown>[];
  /** Each Jito send: the full URL and the signed transaction bytes. */
  readonly jitoSends: Array<{ url: string; bytes: Uint8Array }>;
  /** A JSON-RPC error message the block engine answers with, when set. */
  jitoError: string | null;
  /** Hosts whose block engine is down: an HTTP status, or no answer at all. */
  readonly jitoDown: Map<string, number | "unreachable">;
  /** The host of every block engine a send reached, in order. */
  readonly jitoAttempts: string[];
  /** Transactions passed to `simulateTransaction`. */
  readonly simulated: VersionedTransaction[];
  /** Raw bytes passed to `sendRawTransaction`. */
  readonly sent: Uint8Array[];
  /** Unsigned swap transactions Jupiter handed out, in order. */
  readonly built: VersionedTransaction[];
  simulationErr: unknown;
  confirmationErr: unknown;
  confirmThrows: Error | null;
  sendThrows: Error | null;
  /** Fee payer Jupiter builds for; defaults to the wallet. */
  swapPayer: PublicKey | null;
  request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<HarnessResponse>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// One placeholder instruction stands in for Jupiter's route; the payer is the
// only signer, as in a real swap transaction.
function unsignedSwap(payer: PublicKey): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
        data: Buffer.from("swap"),
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Output in base units for an input in base units at the harness rate. */
function quoteOut(inputMint: string, inAmount: bigint): bigint {
  const tokenUnit = 10n ** BigInt(HARNESS_TOKEN_DECIMALS);
  return inputMint === SOL_MINT
    ? (inAmount * HARNESS_TOKENS_PER_SOL * tokenUnit) / 1_000_000_000n
    : (inAmount * 1_000_000_000n) / (HARNESS_TOKENS_PER_SOL * tokenUnit);
}

export async function createTerminalTradeHarness(
  options: TerminalTradeHarnessOptions = {},
): Promise<TerminalTradeHarness> {
  const wallet = Keypair.generate();
  const tokenMint =
    options.tokenMint ?? Keypair.generate().publicKey.toBase58();
  const backend = await LocalEoaBackend.create({
    getSetting: (key: string) =>
      options.solanaSigner === false
        ? key === "EVM_PRIVATE_KEY"
          ? generatePrivateKey()
          : null
        : key === "SOLANA_PRIVATE_KEY"
          ? bs58.encode(wallet.secretKey)
          : null,
  } as unknown as IAgentRuntime);

  const harness = {
    wallet,
    tokenMint,
    config: {
      features: { tradePermissionMode: options.mode ?? "manual-local-key" },
    },
    jupiterCalls: [] as string[],
    swapRequests: [] as Record<string, unknown>[],
    jitoSends: [] as Array<{ url: string; bytes: Uint8Array }>,
    jitoError: null as string | null,
    jitoDown: new Map<string, number | "unreachable">(),
    jitoAttempts: [] as string[],
    simulated: [] as VersionedTransaction[],
    sent: [] as Uint8Array[],
    built: [] as VersionedTransaction[],
    simulationErr: null as unknown,
    confirmationErr: null as unknown,
    confirmThrows: null as Error | null,
    sendThrows: null as Error | null,
    swapPayer: null as PublicKey | null,
  };

  const connection = {
    getParsedAccountInfo: async (key: PublicKey) => ({
      context: { slot: 1 },
      value:
        key.toBase58() === tokenMint
          ? {
              data: {
                parsed: { info: { decimals: HARNESS_TOKEN_DECIMALS } },
              },
            }
          : null,
    }),
    simulateTransaction: async (transaction: VersionedTransaction) => {
      harness.simulated.push(transaction);
      return {
        context: { slot: 1 },
        value: {
          err: harness.simulationErr,
          logs: harness.simulationErr
            ? ["Program log: Error: insufficient funds"]
            : ["Program log: Instruction: Route", "Program log: success"],
          unitsConsumed: 61_250,
          accounts: null,
          returnData: null,
        },
      };
    },
    sendRawTransaction: async (bytes: Uint8Array) => {
      if (harness.sendThrows) throw harness.sendThrows;
      harness.sent.push(bytes);
      const signature = VersionedTransaction.deserialize(bytes).signatures[0];
      return bs58.encode(signature ?? new Uint8Array(64));
    },
    confirmTransaction: async () => {
      if (harness.confirmThrows) throw harness.confirmThrows;
      return { context: { slot: 2 }, value: { err: harness.confirmationErr } };
    },
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 2_000,
    }),
  };

  const networkFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const block = new URL(url);
    if (
      block.hostname.endsWith("block-engine.jito.wtf") ||
      block.hostname.endsWith(".block-engine.test")
    ) {
      harness.jitoAttempts.push(block.host);
      const down = harness.jitoDown.get(block.host);
      if (down === "unreachable") throw new TypeError("fetch failed");
      if (down !== undefined) {
        return new Response("busy", { status: down });
      }
      const call = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [string, { encoding: string }];
      };
      if (
        block.pathname !== "/api/v1/transactions" ||
        call.method !== "sendTransaction" ||
        call.params[1].encoding !== "base64"
      ) {
        throw new Error(`unexpected Jito request: ${url}`);
      }
      const bytes = new Uint8Array(Buffer.from(call.params[0], "base64"));
      if (harness.jitoError) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32602, message: harness.jitoError },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      harness.jitoSends.push({ url, bytes });
      const signature = VersionedTransaction.deserialize(bytes).signatures[0];
      return json({
        jsonrpc: "2.0",
        id: call.id,
        result: bs58.encode(signature ?? new Uint8Array(64)),
      });
    }
    harness.jupiterCalls.push(url);
    if (url.startsWith(`${DEFAULT_JUPITER_API_BASE_URL}/quote?`)) {
      const query = new URL(url).searchParams;
      const inputMint = query.get("inputMint") ?? "";
      const outputMint = query.get("outputMint") ?? "";
      const inAmount = BigInt(query.get("amount") ?? "0");
      const slippageBps = Number(query.get("slippageBps"));
      const outAmount = quoteOut(inputMint, inAmount);
      return json({
        inputMint,
        inAmount: inAmount.toString(),
        outputMint,
        outAmount: outAmount.toString(),
        otherAmountThreshold: (
          (outAmount * BigInt(10_000 - slippageBps)) /
          10_000n
        ).toString(),
        swapMode: "ExactIn",
        slippageBps,
        priceImpactPct: "0.0012",
        routePlan: [
          {
            swapInfo: { label: "Raydium", inputMint, outputMint },
            percent: 100,
          },
        ],
      });
    }
    if (url === `${DEFAULT_JUPITER_API_BASE_URL}/swap`) {
      harness.swapRequests.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      const transaction = unsignedSwap(harness.swapPayer ?? wallet.publicKey);
      harness.built.push(transaction);
      return json({
        swapTransaction: Buffer.from(transaction.serialize()).toString(
          "base64",
        ),
        lastValidBlockHeight: HARNESS_LAST_VALID_BLOCK_HEIGHT,
        prioritizationFeeLamports: HARNESS_PRIORITY_FEE_LAMPORTS,
      });
    }
    throw new Error(`unexpected Jupiter request: ${url}`);
  };

  const walletService = {
    getWalletBackend: () => backend,
    getWalletBackendOrNull: () => backend,
  };
  const settings = options.settings ?? {};
  const quiet = () => undefined;
  const runtime = {
    agentId: "terminal-trade-test",
    character: { name: "Terminal Trade Test", settings: {} },
    fetch: networkFetch,
    getSetting: (key: string) => settings[key] ?? null,
    getService: (name: string) =>
      name === SOLANA_SERVICE_NAME
        ? { getConnection: () => connection }
        : name === WALLET_BACKEND_SERVICE_TYPE
          ? walletService
          : null,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  } as unknown as IAgentRuntime;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<HarnessResponse> {
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
    if (!handled) return { status: 404, body: { error: "not handled" } };
    return { status: res.statusCode, body: res.body };
  }

  return Object.assign(harness, { runtime, request });
}
