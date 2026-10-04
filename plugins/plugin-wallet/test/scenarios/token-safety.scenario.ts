/**
 * Keyless per-plugin e2e for WALLET `action=token_safety`.
 *
 * The seed starts the deterministic loopback Solana JSON-RPC fixture and
 * points SOLANA_RPC_URL at it, so the real WALLET handler reads a byte-exact
 * Token-2022 mint and its largest token accounts through a real web3.js
 * Connection — no live network, no API keys, no signer. The turn proves the
 * report reaches the planner and that a share-of-supply reply is delivered
 * without tripping core's reply-grounding egress check.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  accountInfoResult,
  encodeMintAccount,
  ext,
  largestAccountsResult,
  type SolanaRpcFixture,
  startSolanaRpcFixture,
} from "../../src/analytics/token-safety/__tests__/solana-rpc-fixture";

const WALLET = "WALLET";
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = key(200).toBase58();
const REPLY =
  "The largest token account has 51.23% of supply; mint authority is present and the TransferHook program is set.";

type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioModelFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let rpcFixture: SolanaRpcFixture | undefined;
let restoreEnv: (() => void) | undefined;

export default scenario({
  lane: "pr-deterministic",
  id: "wallet.token-safety",
  title:
    "Wallet: on-chain Solana mint safety via WALLET against a loopback RPC",
  domain: "wallet",
  tags: ["smoke", "wallet", "analytics", "solana"],
  description:
    "Checks a Token-2022 mint through the WALLET action (action=token_safety) against a deterministic loopback Solana JSON-RPC server — keyless, no signer, no live network.",

  requires: {
    plugins: ["@elizaos/plugin-wallet"],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "token-safety-rpc-fixture",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        rpcFixture = await startSolanaRpcFixture({
          getAccountInfo: {
            result: accountInfoResult(
              encodeMintAccount({
                supply: 1_000_000_000_000_000n,
                decimals: 6,
                mintAuthority: key(1),
                extensions: [ext.transferHook(key(14), key(15))],
              }),
              TOKEN_2022_PROGRAM_ID.toBase58(),
              312345678,
            ),
          },
          getTokenLargestAccounts: {
            result: largestAccountsResult(
              [
                {
                  address: key(100).toBase58(),
                  amount: "512300000000000",
                  decimals: 6,
                },
                {
                  address: key(101).toBase58(),
                  amount: "87700000000000",
                  decimals: 6,
                },
              ],
              312345679,
            ),
          },
        });
        const previous = process.env.SOLANA_RPC_URL;
        restoreEnv = () => {
          if (previous === undefined) delete process.env.SOLANA_RPC_URL;
          else process.env.SOLANA_RPC_URL = previous;
          restoreEnv = undefined;
        };
        process.env.SOLANA_RPC_URL = rpcFixture.url;
        runtime.setSetting?.("SOLANA_RPC_URL", rpcFixture.url);

        runtime.scenarioModelFixtures?.register(
          {
            name: "token-safety-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes(MINT),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["wallet"],
              intents: ["wallet"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [WALLET],
            },
            times: 1,
          },
          {
            name: "token-safety-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes(MINT),
              toolName: WALLET,
            },
            response: {
              text: "",
              thought: "Read the mint on-chain with WALLET token_safety.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-token-safety",
                  name: WALLET,
                  type: "function",
                  arguments: { action: "token_safety", address: MINT },
                },
              ],
            },
            times: 1,
          },
          {
            name: "token-safety-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "The token_safety report is complete.",
              messageToUser: REPLY,
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "close-token-safety-rpc-fixture",
      apply: async () => {
        restoreEnv?.();
        await rpcFixture?.close();
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Wallet" },
  ],

  turns: [
    {
      kind: "message",
      name: "check-mint",
      // Avoids the words that wake the EVM get-balance provider (token,
      // balance, wallet, erc20), which would add an unrelated model call.
      text: `Is the mint ${MINT} safe? Read its authorities, extensions and largest accounts on Solana.`,
      // Carry the wallet discriminator on the inbound message so WALLET's
      // structural validate() recognizes the analytics subaction.
      content: { action: "token_safety", address: MINT },
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === WALLET);
        if (!call) {
          return `Expected ${WALLET} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${WALLET} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
        if (
          typeof turn.responseText !== "string" ||
          !turn.responseText.includes("51.23% of supply")
        ) {
          return `expected the share-of-supply reply to be delivered, saw: ${turn.responseText}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: WALLET,
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "token-safety-report-effect",
      predicate: (ctx) => {
        const served = rpcFixture?.requests.map((r) => r.method) ?? [];
        for (const method of ["getAccountInfo", "getTokenLargestAccounts"]) {
          if (!served.includes(method)) {
            return `loopback RPC never served ${method}; served: ${served.join(", ") || "(none)"}`;
          }
        }
        const call = ctx.actionsCalled.find(
          (a) => a.actionName === WALLET && a.result?.success === true,
        );
        const data =
          call?.result?.data && typeof call.result.data === "object"
            ? (call.result.data as Record<string, unknown>)
            : null;
        if (!data) return "successful WALLET call carried no result.data";
        if (data.subaction !== "token_safety") {
          return `expected result.data.subaction "token_safety", saw ${String(data.subaction)}`;
        }
        if (data.outcome !== "report") {
          return `expected result.data.outcome "report", saw ${String(data.outcome)}`;
        }
      },
    },
  ],
});
