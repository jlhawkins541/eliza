/**
 * JSON-safe DTOs for the WALLET token_safety report. Every u64 is a decimal
 * string. Every field is required, and `null` appears only where the field
 * does not apply. A check that could not run is a typed `unknown` status with
 * its code and complete reason, never a pass, zero or omission.
 */
import type { FailureCode } from "../../actions/failure-codes.js";

export const TOKEN_SAFETY_CHECK_IDS = [
  "token_program",
  "supply",
  "mint_authority",
  "freeze_authority",
  "transfer_hook",
  "transfer_fee",
  "permanent_delegate",
  "non_transferable",
  "default_account_state",
  "mint_close_authority",
  "pausable",
  "other_extensions",
  "holder_concentration",
] as const;
export type TokenSafetyCheckId = (typeof TOKEN_SAFETY_CHECK_IDS)[number];
export type TokenSafetySubCheckId =
  | "transfer_fee.active_fee"
  | "holder_concentration.share_of_supply";

export type TokenSafetyThrownCode =
  | "TOKEN_SAFETY_RPC_NOT_CONFIGURED"
  | "TOKEN_SAFETY_RPC_URL_INVALID"
  | "TOKEN_SAFETY_RPC_TIMEOUT"
  | "TOKEN_SAFETY_RPC_RATE_LIMITED"
  | "TOKEN_SAFETY_RPC_HTTP_ERROR"
  | "TOKEN_SAFETY_RPC_REJECTED"
  | "TOKEN_SAFETY_RPC_TRANSPORT_FAILED"
  | "TOKEN_SAFETY_RPC_MALFORMED_RESPONSE"
  | "TOKEN_SAFETY_RPC_FAILED";
export type TokenSafetyDegradableCode = Extract<
  TokenSafetyThrownCode,
  | "TOKEN_SAFETY_RPC_TIMEOUT"
  | "TOKEN_SAFETY_RPC_RATE_LIMITED"
  | "TOKEN_SAFETY_RPC_HTTP_ERROR"
  | "TOKEN_SAFETY_RPC_REJECTED"
  | "TOKEN_SAFETY_RPC_TRANSPORT_FAILED"
  | "TOKEN_SAFETY_RPC_MALFORMED_RESPONSE"
>;
export type TokenSafetyUnknownCode =
  | TokenSafetyDegradableCode
  | "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED"
  | "TOKEN_SAFETY_EXTENSION_LENGTH_MISMATCH"
  | "TOKEN_SAFETY_UNRECOGNIZED_ENUM_VALUE"
  | "TOKEN_SAFETY_HOLDER_ROWS_INCONSISTENT"
  | "TOKEN_SAFETY_HOLDER_EXCEEDS_SUPPLY"
  | "TOKEN_SAFETY_ZERO_SUPPLY";

export type Unknown<C extends TokenSafetyUnknownCode = TokenSafetyUnknownCode> =
  { status: "unknown"; code: C; reason: string };
export type RpcUnknown = Unknown<TokenSafetyDegradableCode> & {
  method: "getTokenLargestAccounts" | "getEpochInfo";
  rpcErrorCode: number | null;
  httpStatus: number | null;
};
/** An extension-stored address; `PublicKey.default` decodes to `unset`. */
export type ExtAddr = { state: "set"; address: string } | { state: "unset" };
/** A mint COption authority; `None` decodes to `revoked`. */
export type Authority =
  | { state: "present"; address: string }
  | { state: "revoked" };
/** Share of supply as a 4-place percent string ("51.2300" or "<0.0001"). */
export type Share =
  | { status: "verified"; percent: string }
  | Unknown<"TOKEN_SAFETY_ZERO_SUPPLY">;
export type Absent = {
  status: "verified";
  present: false;
  basis: "spl_token_program_has_no_extensions" | "tlv_scanned";
};
export type ExtCheck<C> =
  | Absent
  | ({ status: "verified"; present: true } & C)
  | ({ present: true } & Unknown<
      | "TOKEN_SAFETY_EXTENSION_LENGTH_MISMATCH"
      | "TOKEN_SAFETY_UNRECOGNIZED_ENUM_VALUE"
    >)
  | ({ present: "unknown" } & Unknown<"TOKEN_SAFETY_EXTENSION_DATA_MALFORMED">);
export type FeeTier = {
  epoch: string;
  basisPoints: number;
  maximumFeeRaw: string;
  maximumFeeUi: string;
  maximumIsU64Max: boolean;
};
export type ActiveFee =
  | {
      status: "verified";
      basis: "tiers_identical";
      currentEpoch: null;
      tier: "older";
      basisPoints: number;
      maximumFeeRaw: string;
      maximumFeeUi: string;
      maximumIsU64Max: boolean;
    }
  | {
      status: "verified";
      basis: "epoch";
      currentEpoch: string;
      tier: "older" | "newer";
      basisPoints: number;
      maximumFeeRaw: string;
      maximumFeeUi: string;
      maximumIsU64Max: boolean;
    }
  | RpcUnknown;
export type OtherExtension = {
  type: number;
  name: string;
  scope: "mint" | "account_extension_in_mint_data" | "unknown_type";
  decodableByInstalledSplToken: boolean;
};
export type HolderRow = {
  rank: number;
  tokenAccount: string;
  amountRaw: string;
  amountUi: string;
  shareOfSupply: Share;
  cumulativeShareOfSupply: Share;
};

export type TokenSafetyChecks = {
  token_program: {
    status: "verified";
    program: "spl-token" | "token-2022";
    programId: string;
  };
  supply: { status: "verified"; raw: string; ui: string; decimals: number };
  mint_authority: { status: "verified" } & Authority;
  freeze_authority: { status: "verified" } & Authority;
  transfer_hook: ExtCheck<{ hookProgram: ExtAddr; authority: ExtAddr }>;
  transfer_fee: ExtCheck<{
    older: FeeTier;
    newer: FeeTier;
    active: ActiveFee;
    transferFeeConfigAuthority: ExtAddr;
    withdrawWithheldAuthority: ExtAddr;
    withheldAmountRaw: string;
    withheldAmountUi: string;
  }>;
  permanent_delegate: ExtCheck<{ delegate: ExtAddr }>;
  non_transferable: ExtCheck<Record<never, never>>;
  default_account_state: ExtCheck<{
    state: "initialized" | "frozen";
    frozenByDefault: boolean;
  }>;
  mint_close_authority: ExtCheck<{ closeAuthority: ExtAddr }>;
  pausable: ExtCheck<{ authority: ExtAddr; paused: boolean }>;
  other_extensions:
    | {
        status: "verified";
        basis: "spl_token_program_has_no_extensions" | "tlv_scanned";
        entries: OtherExtension[];
      }
    | Unknown<"TOKEN_SAFETY_EXTENSION_DATA_MALFORMED">;
  holder_concentration:
    | {
        status: "verified";
        method: "getTokenLargestAccounts";
        slot: number;
        supplySlot: number;
        rpcMaxRows: 20;
        rowsReturned: number;
        label: "token_accounts_not_owners";
        rows: HolderRow[];
        top10ShareOfSupply: Share;
        allReturnedShareOfSupply: Share;
      }
    | RpcUnknown
    | (Unknown<
        | "TOKEN_SAFETY_HOLDER_ROWS_INCONSISTENT"
        | "TOKEN_SAFETY_HOLDER_EXCEEDS_SUPPLY"
      > & {
        method: "getTokenLargestAccounts";
        slot: number;
        supplySlot: number;
      });
};

/**
 * Risk flags derived from verified checks only. `unassessed_extensions_present`
 * is raised for any entry in `other_extensions`: those extensions are listed
 * by name, but their configuration is never decoded or assessed.
 */
export type TokenSafetyFlag =
  | "mint_authority_present"
  | "freeze_authority_present"
  | "transfer_hook_program_set"
  | "transfer_hook_authority_set"
  | "transfer_fee_nonzero_active"
  | "transfer_fee_nonzero_scheduled"
  | "transfer_fee_authority_set"
  | "permanent_delegate_set"
  | "non_transferable"
  | "default_account_state_frozen"
  | "mint_close_authority_set"
  | "pausable_authority_set"
  | "paused"
  | "unassessed_extensions_present";

export type TokenSafetyReport = {
  mint: string;
  source: { rpc: "SOLANA_RPC_URL"; commitment: "confirmed"; mintSlot: number };
  checks: TokenSafetyChecks;
  extensionInventory:
    | {
        status: "verified";
        entries: Array<{ type: number; name: string; length: number }>;
      }
    | Unknown<"TOKEN_SAFETY_EXTENSION_DATA_MALFORMED">;
  coverage: {
    checksTotal: 13;
    checksFullyVerified: number;
    unknown: Array<TokenSafetyCheckId | TokenSafetySubCheckId>;
  };
  flags: TokenSafetyFlag[];
};

export type TokenSafetyInvalidKind =
  | "missing_address"
  | "ambiguous_address"
  | "unsupported_chain"
  | "malformed_address"
  | "account_not_found"
  | "not_token_program_account"
  | "token_account_not_mint"
  | "multisig_account"
  | "uninitialized_mint"
  | "malformed_mint_data";
export type TokenSafetyInvalidInput = {
  kind: TokenSafetyInvalidKind;
  error: "INVALID_PARAMS" | "INVALID_ADDRESS";
  input: string | null;
  detail: string;
  accountOwner: string | null;
  accountDataLength: number | null;
  slot: number | null;
};
export const INVALID_KIND_ERROR: Record<
  TokenSafetyInvalidKind,
  "INVALID_PARAMS" | "INVALID_ADDRESS"
> = {
  missing_address: "INVALID_PARAMS",
  ambiguous_address: "INVALID_PARAMS",
  unsupported_chain: "INVALID_PARAMS",
  malformed_address: "INVALID_ADDRESS",
  account_not_found: "INVALID_ADDRESS",
  not_token_program_account: "INVALID_ADDRESS",
  token_account_not_mint: "INVALID_ADDRESS",
  multisig_account: "INVALID_ADDRESS",
  uninitialized_mint: "INVALID_ADDRESS",
  malformed_mint_data: "INVALID_ADDRESS",
};
export const THROWN_CODE_FAILURE: Record<
  TokenSafetyThrownCode,
  Extract<
    FailureCode,
    "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_REJECTED" | "PROVIDER_UNAVAILABLE"
  >
> = {
  TOKEN_SAFETY_RPC_NOT_CONFIGURED: "PROVIDER_UNAVAILABLE",
  TOKEN_SAFETY_RPC_URL_INVALID: "PROVIDER_UNAVAILABLE",
  TOKEN_SAFETY_RPC_TIMEOUT: "TIMEOUT",
  TOKEN_SAFETY_RPC_RATE_LIMITED: "RATE_LIMITED",
  TOKEN_SAFETY_RPC_HTTP_ERROR: "PROVIDER_UNAVAILABLE",
  TOKEN_SAFETY_RPC_REJECTED: "PROVIDER_REJECTED",
  TOKEN_SAFETY_RPC_TRANSPORT_FAILED: "PROVIDER_UNAVAILABLE",
  TOKEN_SAFETY_RPC_MALFORMED_RESPONSE: "PROVIDER_UNAVAILABLE",
  TOKEN_SAFETY_RPC_FAILED: "PROVIDER_UNAVAILABLE",
};

/** True when `code` is one of the typed token_safety RPC/configuration codes. */
export function isTokenSafetyThrownCode(
  code: string,
): code is TokenSafetyThrownCode {
  return Object.hasOwn(THROWN_CODE_FAILURE, code);
}

type Base = { actionName: "WALLET"; subaction: "token_safety" };
export type TokenSafetyActionData =
  | (Base & { outcome: "report"; report: TokenSafetyReport })
  | (Base & {
      outcome: "invalid_input";
      error: "INVALID_PARAMS" | "INVALID_ADDRESS";
      invalid: TokenSafetyInvalidInput;
    })
  | (Base & {
      outcome: "rpc_failure";
      error:
        | "TIMEOUT"
        | "RATE_LIMITED"
        | "PROVIDER_REJECTED"
        | "PROVIDER_UNAVAILABLE";
      mint: string | null;
      failure: {
        code: TokenSafetyThrownCode;
        // A sub-read only lands here with the unclassified RPC_FAILED code,
        // which is never degraded to an unknown check.
        method:
          | "getAccountInfo"
          | "configuration"
          | "getTokenLargestAccounts"
          | "getEpochInfo";
        detail: string;
        rpcErrorCode: number | null;
        httpStatus: number | null;
      };
    });
