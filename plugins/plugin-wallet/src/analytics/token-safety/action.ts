/**
 * The action boundary for WALLET `action=onchain_token_safety`. It parses
 * parameters, runs the key-free inspection, translates typed RPC and
 * configuration failures into structured WALLET results, and awaits the
 * callback once with the same text and data it returns.
 *
 * Only an ElizaError carrying a TokenSafetyThrownCode is translated; anything
 * else is a bug and propagates to core's ACTION_HANDLER_FAILED path. It never
 * reaches WalletBackend, SolanaService key paths or the confirmation gate.
 */
import {
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  isElizaError,
} from "@elizaos/core";
import { PublicKey } from "@solana/web3.js";
import {
  formatTokenSafetyInvalid,
  formatTokenSafetyReport,
  formatTokenSafetyRpcFailure,
} from "./format.js";
import { type InspectOutcome, inspectSolanaTokenSafety } from "./inspect.js";
import { createTokenSafetyRpc } from "./rpc.js";
import {
  INVALID_KIND_ERROR,
  isTokenSafetyThrownCode,
  THROWN_CODE_FAILURE,
  type TokenSafetyActionData,
  type TokenSafetyInvalidInput,
  type TokenSafetyInvalidKind,
} from "./types.js";

type RpcFailureData = Extract<
  TokenSafetyActionData,
  { outcome: "rpc_failure" }
>;
type FailureMethod = RpcFailureData["failure"]["method"];

function invalid(
  kind: TokenSafetyInvalidKind,
  input: string | null,
  detail: string,
): { ok: false; invalid: TokenSafetyInvalidInput } {
  return {
    ok: false,
    invalid: {
      kind,
      error: INVALID_KIND_ERROR[kind],
      input,
      detail,
      accountOwner: null,
      accountDataLength: null,
      slot: null,
    },
  };
}

/** Validates the untrusted mint parameter without any RPC call. */
export function parseTokenSafetyParams(
  raw: Record<string, unknown>,
):
  | { ok: true; address: string }
  | { ok: false; invalid: TokenSafetyInvalidInput } {
  const candidates = [raw.address, raw.mint, raw.tokenAddress]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const distinct = [...new Set(candidates)];
  if (distinct.length === 0) {
    return invalid(
      "missing_address",
      null,
      "onchain_token_safety needs the Solana mint address in the address parameter.",
    );
  }
  if (distinct.length > 1) {
    return invalid(
      "ambiguous_address",
      null,
      `address, mint and tokenAddress name different values (${distinct.join(", ")}); pass exactly one mint address.`,
    );
  }
  const address = distinct[0];
  if (
    typeof raw.chain === "string" &&
    raw.chain.trim() !== "" &&
    raw.chain.trim().toLowerCase() !== "solana"
  ) {
    return invalid(
      "unsupported_chain",
      address,
      `onchain_token_safety reads Solana mints only; chain "${raw.chain.trim()}" is not supported.`,
    );
  }
  if (/^0x/i.test(address)) {
    return invalid(
      "malformed_address",
      address,
      "onchain_token_safety reads Solana mint addresses only; 0x… is an EVM address.",
    );
  }
  try {
    new PublicKey(address);
  } catch {
    // error-policy:J3 Untrusted mint text becomes an explicit malformed_address result, never a default key.
    return invalid(
      "malformed_address",
      address,
      "not a base58 Solana address; if this is a symbol such as BONK, resolve the mint with action=token_info first.",
    );
  }
  return { ok: true, address };
}

function failureMethod(value: unknown): FailureMethod | null {
  return value === "getAccountInfo" ||
    value === "configuration" ||
    value === "getTokenLargestAccounts" ||
    value === "getEpochInfo"
    ? value
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

async function respond(
  data: TokenSafetyActionData,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  if (data.outcome === "report") {
    const text = formatTokenSafetyReport(data.report);
    await callback?.({ text, actions: ["WALLET"], data });
    return {
      success: true,
      text,
      data,
      values: {
        tokenSafetyOutcome: "report",
        tokenSafetyUnknownChecks: data.report.coverage.unknown,
        tokenSafetyChecksFullyVerified:
          data.report.coverage.checksFullyVerified,
      },
    };
  }
  const text =
    data.outcome === "invalid_input"
      ? formatTokenSafetyInvalid(data.invalid)
      : formatTokenSafetyRpcFailure(data);
  await callback?.({ text, actions: ["WALLET"], data });
  return {
    success: false,
    text,
    data,
    values: { tokenSafetyOutcome: data.outcome, tokenSafetyError: data.error },
    error: data.error,
  };
}

/** Handles WALLET `action=onchain_token_safety` for one Solana mint address. */
export async function tokenSafetyHandler(
  runtime: IAgentRuntime,
  raw: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const base = {
    actionName: "WALLET",
    subaction: "onchain_token_safety",
  } as const;
  const parsed = parseTokenSafetyParams(raw);
  if (!parsed.ok) {
    return respond(
      {
        ...base,
        outcome: "invalid_input",
        error: parsed.invalid.error,
        invalid: parsed.invalid,
      },
      callback,
    );
  }
  const mint = new PublicKey(parsed.address);

  let outcome: InspectOutcome;
  try {
    const rpc = createTokenSafetyRpc(runtime);
    outcome = await inspectSolanaTokenSafety({ runtime, rpc, mint });
  } catch (error) {
    // error-policy:J1 Action boundary: typed token-safety RPC/configuration failures become the structured WALLET onchain_token_safety failure the planner reads.
    if (!(isElizaError(error) && isTokenSafetyThrownCode(error.code))) {
      throw error;
    }
    const method = failureMethod(error.context?.method);
    if (method === null) throw error;
    return respond(
      {
        ...base,
        outcome: "rpc_failure",
        error: THROWN_CODE_FAILURE[error.code],
        mint: parsed.address,
        failure: {
          code: error.code,
          method,
          detail: error.message,
          rpcErrorCode: numberOrNull(error.context?.rpcErrorCode),
          httpStatus: numberOrNull(error.context?.httpStatus),
        },
      },
      callback,
    );
  }

  if (outcome.outcome === "invalid_input") {
    return respond(
      {
        ...base,
        outcome: "invalid_input",
        error: outcome.invalid.error,
        invalid: outcome.invalid,
      },
      callback,
    );
  }
  return respond(
    { ...base, outcome: "report", report: outcome.report },
    callback,
  );
}
