/**
 * Orchestrates the read-only inspection, from the mint read through concurrent
 * sub-reads to report assembly. It never signs, never sends, and never touches
 * SolanaService or any key path; the only RPC methods are getAccountInfo (via
 * AndContext), getTokenLargestAccounts, and getEpochInfo when fee tiers differ.
 *
 * A mint-read failure propagates as a typed error. Sub-read failures degrade
 * to visibly unknown checks; coverage and flags are derived from the assembled
 * checks, and flags come only from verified values.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { PublicKey } from "@solana/web3.js";
import { toHuman } from "../../sdk/tokens/decimals.js";
import { buildHolderConcentration } from "./concentration.js";
import {
  applyActiveFee,
  classifyMintAccount,
  decodeExtensions,
} from "./mint.js";
import { degradeRpc, readRpc, type TokenSafetyRpc } from "./rpc.js";
import {
  INVALID_KIND_ERROR,
  TOKEN_SAFETY_CHECK_IDS,
  type TokenSafetyCheckId,
  type TokenSafetyChecks,
  type TokenSafetyFlag,
  type TokenSafetyInvalidInput,
  type TokenSafetyReport,
  type TokenSafetySubCheckId,
} from "./types.js";

export type InspectOutcome =
  | { outcome: "report"; report: TokenSafetyReport }
  | { outcome: "invalid_input"; invalid: TokenSafetyInvalidInput };

/** Reads one mint through `rpc` and assembles the complete token_safety report or a typed invalid-input outcome. */
export async function inspectSolanaTokenSafety(args: {
  runtime: Pick<IAgentRuntime, "logger">;
  rpc: TokenSafetyRpc;
  mint: PublicKey;
}): Promise<InspectOutcome> {
  const { runtime, rpc, mint } = args;
  const m = mint.toBase58();
  const { context, value } = await readRpc("getAccountInfo", m, rpc, () =>
    rpc.connection.getAccountInfoAndContext(mint, "confirmed"),
  );
  if (value === null) {
    return {
      outcome: "invalid_input",
      invalid: {
        kind: "account_not_found",
        error: INVALID_KIND_ERROR.account_not_found,
        input: m,
        detail:
          "no account exists at this address on the cluster served by SOLANA_RPC_URL",
        accountOwner: null,
        accountDataLength: null,
        slot: context.slot,
      },
    };
  }

  const classified = classifyMintAccount(mint, value);
  if (!classified.ok) {
    return {
      outcome: "invalid_input",
      invalid: {
        kind: classified.kind,
        error: INVALID_KIND_ERROR[classified.kind],
        input: m,
        detail: classified.detail,
        accountOwner: classified.accountOwner,
        accountDataLength: classified.accountDataLength,
        slot: context.slot,
      },
    };
  }

  const decoded = decodeExtensions(classified);
  const { connection } = rpc;
  const { mint: mintState, program, programId } = classified;
  const decimals = mintState.decimals;
  const fee = decoded.transferFee;
  const resolveTransferFee = async (): Promise<
    TokenSafetyChecks["transfer_fee"]
  > => {
    if (fee.status === "decoded") return fee.check;
    const epochRead = await degradeRpc(runtime, "getEpochInfo", m, rpc, () =>
      connection.getEpochInfo("confirmed"),
    );
    return applyActiveFee(
      fee.feeNeedsEpoch,
      epochRead.ok
        ? { ok: true, value: BigInt(epochRead.value.epoch) }
        : epochRead,
      decimals,
    );
  };
  const [transferFee, largestRead] = await Promise.all([
    resolveTransferFee(),
    degradeRpc(runtime, "getTokenLargestAccounts", m, rpc, () =>
      connection.getTokenLargestAccounts(mint, "confirmed"),
    ),
  ]);

  const holderConcentration: TokenSafetyChecks["holder_concentration"] =
    largestRead.ok
      ? buildHolderConcentration({
          rows: largestRead.value.value,
          slot: largestRead.value.context.slot,
          supply: mintState.supply,
          supplySlot: context.slot,
          decimals,
        })
      : largestRead.unknown;

  const checks: TokenSafetyChecks = {
    token_program: {
      status: "verified",
      program,
      programId: programId.toBase58(),
    },
    supply: {
      status: "verified",
      raw: mintState.supply.toString(),
      ui: toHuman(mintState.supply, decimals),
      decimals,
    },
    mint_authority: mintState.mintAuthority
      ? {
          status: "verified",
          state: "present",
          address: mintState.mintAuthority.toBase58(),
        }
      : { status: "verified", state: "revoked" },
    freeze_authority: mintState.freezeAuthority
      ? {
          status: "verified",
          state: "present",
          address: mintState.freezeAuthority.toBase58(),
        }
      : { status: "verified", state: "revoked" },
    transfer_hook: decoded.transfer_hook,
    transfer_fee: transferFee,
    permanent_delegate: decoded.permanent_delegate,
    non_transferable: decoded.non_transferable,
    default_account_state: decoded.default_account_state,
    mint_close_authority: decoded.mint_close_authority,
    pausable: decoded.pausable,
    other_extensions: decoded.other_extensions,
    holder_concentration: holderConcentration,
  };

  return {
    outcome: "report",
    report: {
      mint: m,
      source: {
        rpc: "SOLANA_RPC_URL",
        commitment: "confirmed",
        mintSlot: context.slot,
      },
      checks,
      extensionInventory: decoded.inventory,
      coverage: computeCoverage(checks),
      flags: deriveFlags(checks),
    },
  };
}

/** Lists every unknown check and sub-check; a check counts as fully verified only when neither applies. */
export function computeCoverage(
  checks: TokenSafetyChecks,
): TokenSafetyReport["coverage"] {
  const unknown: Array<TokenSafetyCheckId | TokenSafetySubCheckId> = [];
  const involved = new Set<TokenSafetyCheckId>();
  for (const id of TOKEN_SAFETY_CHECK_IDS) {
    const check = checks[id];
    if (check.status === "unknown") {
      unknown.push(id);
      involved.add(id);
      continue;
    }
    if (
      id === "transfer_fee" &&
      checks.transfer_fee.status === "verified" &&
      checks.transfer_fee.present === true &&
      checks.transfer_fee.active.status === "unknown"
    ) {
      unknown.push("transfer_fee.active_fee");
      involved.add(id);
    }
    if (
      id === "holder_concentration" &&
      checks.holder_concentration.status === "verified" &&
      (checks.holder_concentration.top10ShareOfSupply.status === "unknown" ||
        checks.holder_concentration.rows.some(
          (row) => row.shareOfSupply.status === "unknown",
        ))
    ) {
      unknown.push("holder_concentration.share_of_supply");
      involved.add(id);
    }
  }
  return {
    checksTotal: 13,
    checksFullyVerified: TOKEN_SAFETY_CHECK_IDS.length - involved.size,
    unknown,
  };
}

/** Derives risk flags from verified checks only; there is no verdict or score. */
export function deriveFlags(checks: TokenSafetyChecks): TokenSafetyFlag[] {
  const flags: TokenSafetyFlag[] = [];
  if (checks.mint_authority.state === "present") {
    flags.push("mint_authority_present");
  }
  if (checks.freeze_authority.state === "present") {
    flags.push("freeze_authority_present");
  }
  const hook = checks.transfer_hook;
  if (hook.status === "verified" && hook.present === true) {
    if (hook.hookProgram.state === "set")
      flags.push("transfer_hook_program_set");
    if (hook.authority.state === "set")
      flags.push("transfer_hook_authority_set");
  }
  const fee = checks.transfer_fee;
  if (fee.status === "verified" && fee.present === true) {
    const nonzero = (bps: number, raw: string) => bps > 0 && raw !== "0";
    if (
      fee.active.status === "verified" &&
      nonzero(fee.active.basisPoints, fee.active.maximumFeeRaw)
    ) {
      flags.push("transfer_fee_nonzero_active");
    }
    if (
      nonzero(fee.older.basisPoints, fee.older.maximumFeeRaw) ||
      nonzero(fee.newer.basisPoints, fee.newer.maximumFeeRaw)
    ) {
      flags.push("transfer_fee_nonzero_scheduled");
    }
    if (fee.transferFeeConfigAuthority.state === "set") {
      flags.push("transfer_fee_authority_set");
    }
  }
  const delegate = checks.permanent_delegate;
  if (
    delegate.status === "verified" &&
    delegate.present === true &&
    delegate.delegate.state === "set"
  ) {
    flags.push("permanent_delegate_set");
  }
  const nonTransferable = checks.non_transferable;
  if (
    nonTransferable.status === "verified" &&
    nonTransferable.present === true
  ) {
    flags.push("non_transferable");
  }
  const das = checks.default_account_state;
  if (
    das.status === "verified" &&
    das.present === true &&
    das.frozenByDefault
  ) {
    flags.push("default_account_state_frozen");
  }
  const close = checks.mint_close_authority;
  if (
    close.status === "verified" &&
    close.present === true &&
    close.closeAuthority.state === "set"
  ) {
    flags.push("mint_close_authority_set");
  }
  const pausable = checks.pausable;
  if (pausable.status === "verified" && pausable.present === true) {
    if (pausable.authority.state === "set")
      flags.push("pausable_authority_set");
    if (pausable.paused) flags.push("paused");
  }
  // Every listed extension is named but its configuration is not decoded, so
  // any entry at all (even a decodable mint-scoped one such as
  // InterestBearingConfig) means part of the mint is unassessed.
  const others = checks.other_extensions;
  if (others.status === "verified" && others.entries.length > 0) {
    flags.push("unassessed_extensions_present");
  }
  return flags;
}
