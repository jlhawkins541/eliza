/**
 * Classifies an untrusted account as a mint and decodes its Token-2022 TLV
 * extensions with bounds checks. It does not use spl-token
 * `getExtensionTypes` or `getExtensionData`: the first throws RangeError on
 * Token-2022 padding, and the second silently returns short slices.
 *
 * The walk mirrors Token-2022 `get_tlv_data_info`: it stops at a zero type or
 * a sub-header tail, and reports a truncated or duplicated entry as malformed
 * instead of a partial list. Every risk extension is decoded only when its
 * stored length equals the installed layout length.
 */
import {
  ACCOUNT_SIZE,
  AccountType,
  DefaultAccountStateLayout,
  ExtensionType,
  getEpochFee,
  getTypeLen,
  type Mint,
  MintCloseAuthorityLayout,
  MintLayout,
  MULTISIG_SIZE,
  PausableConfigLayout,
  PermanentDelegateLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TokenInvalidAccountSizeError,
  TokenInvalidMintError,
  type TransferFee,
  TransferFeeConfigLayout,
  TransferHookLayout,
  unpackMint,
} from "@solana/spl-token";
import { type AccountInfo, PublicKey } from "@solana/web3.js";
import { toHuman } from "../../sdk/tokens/decimals.js";
import type {
  Absent,
  ExtAddr,
  FeeTier,
  OtherExtension,
  RpcUnknown,
  TokenSafetyChecks,
  TokenSafetyInvalidKind,
  TokenSafetyReport,
} from "./types.js";

const MINT_BYTES = 82;
const U64_MAX = 2n ** 64n - 1n;

export type ClassifiedMint =
  | {
      ok: true;
      program: "spl-token" | "token-2022";
      programId: PublicKey;
      mint: Mint;
      tlv: Buffer;
    }
  | {
      ok: false;
      kind: Exclude<
        TokenSafetyInvalidKind,
        | "missing_address"
        | "ambiguous_address"
        | "unsupported_chain"
        | "malformed_address"
        | "account_not_found"
      >;
      detail: string;
      accountOwner: string;
      accountDataLength: number;
    };

/** Decides whether an untrusted account is an initialized SPL Token or Token-2022 mint. */
export function classifyMintAccount(
  address: PublicKey,
  info: AccountInfo<Buffer>,
): ClassifiedMint {
  const owner = info.owner.toBase58();
  const len = info.data.length;
  const reject = (
    kind: Extract<ClassifiedMint, { ok: false }>["kind"],
    detail: string,
  ): ClassifiedMint => ({
    ok: false,
    kind,
    detail,
    accountOwner: owner,
    accountDataLength: len,
  });

  let program: "spl-token" | "token-2022";
  let programId: PublicKey;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) {
    program = "spl-token";
    programId = TOKEN_PROGRAM_ID;
  } else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    program = "token-2022";
    programId = TOKEN_2022_PROGRAM_ID;
  } else {
    return reject(
      "not_token_program_account",
      `the account is owned by ${owner}, not the SPL Token or Token-2022 program, so it is not a token mint. For an owner address, use action=search_address.`,
    );
  }

  const tokenAccountDetail = `the account is a ${program} token account (${len} bytes), not a mint. Pass the mint address of the token instead.`;
  const multisigDetail = `the account is a ${program} multisig account (${len} bytes), not a mint.`;
  const malformedDetail = (why: string) =>
    `the ${program} account data (${len} bytes) is not a valid mint: ${why}.`;
  if (len === ACCOUNT_SIZE)
    return reject("token_account_not_mint", tokenAccountDetail);
  if (len === MULTISIG_SIZE) return reject("multisig_account", multisigDetail);
  if (len !== MINT_BYTES) {
    if (program === "spl-token" || len < ACCOUNT_SIZE) {
      return reject(
        "malformed_mint_data",
        malformedDetail(`a mint is ${MINT_BYTES} bytes`),
      );
    }
    const accountType = info.data[ACCOUNT_SIZE];
    if (accountType === AccountType.Account) {
      return reject("token_account_not_mint", tokenAccountDetail);
    }
    if (accountType !== AccountType.Mint) {
      return reject(
        "malformed_mint_data",
        malformedDetail(
          `account type byte at offset ${ACCOUNT_SIZE} is ${accountType}, not Mint (${AccountType.Mint})`,
        ),
      );
    }
  }

  const raw = MintLayout.decode(info.data.subarray(0, MINT_BYTES));
  const mintTag: number = raw.mintAuthorityOption;
  const freezeTag: number = raw.freezeAuthorityOption;
  if (
    (mintTag !== 0 && mintTag !== 1) ||
    (freezeTag !== 0 && freezeTag !== 1)
  ) {
    return reject(
      "malformed_mint_data",
      malformedDetail(
        `authority option tags are ${mintTag} (mint) and ${freezeTag} (freeze); each must be 0 or 1`,
      ),
    );
  }

  let mint: Mint;
  try {
    mint = unpackMint(address, info, programId);
  } catch (error) {
    // error-policy:J3 spl-token's account-shape errors mean these untrusted bytes are not a mint; only those four classes are translated, anything else is rethrown.
    if (
      error instanceof TokenInvalidAccountSizeError ||
      error instanceof TokenInvalidMintError ||
      error instanceof TokenInvalidAccountOwnerError ||
      error instanceof TokenAccountNotFoundError
    ) {
      return reject(
        "malformed_mint_data",
        malformedDetail(`spl-token rejected it with ${error.name}`),
      );
    }
    throw error;
  }
  if (!mint.isInitialized) {
    return reject(
      "uninitialized_mint",
      `the ${program} mint account exists but is not initialized, so it has no supply, decimals or authorities.`,
    );
  }
  return { ok: true, program, programId, mint, tlv: mint.tlvData };
}

export type TlvEntry = {
  type: number;
  name: string;
  offset: number;
  length: number;
  data: Buffer;
};
export type TlvWalk =
  | { status: "parsed"; entries: TlvEntry[] }
  | { status: "malformed"; offset: number; reason: string };

/**
 * Walks Token-2022 mint TLV data with bounds checks; never returns a partial
 * list as complete. A malformed reason is model-facing: no clause of it (split
 * on commas, semicolons, "and" or "but") may be a bare "<number> <word>" pair,
 * which core reply egress reads as an ungrounded holding claim.
 */
export function walkMintTlv(tlv: Buffer): TlvWalk {
  const entries: TlvEntry[] = [];
  const seen = new Set<number>();
  const len = tlv.length;
  let offset = 0;
  while (offset < len) {
    if (len - offset < 2) break;
    const type = tlv.readUInt16LE(offset);
    if (type === 0) break;
    if (len - offset < 4) {
      return {
        status: "malformed",
        offset,
        reason: `the type header at TLV offset ${offset} has no length field`,
      };
    }
    const length = tlv.readUInt16LE(offset + 2);
    const available = len - offset - 4;
    if (length > available) {
      return {
        status: "malformed",
        offset,
        reason: `the entry header at TLV offset ${offset} declares a value length of ${length} while only ${available} bytes follow the header`,
      };
    }
    if (seen.has(type)) {
      return {
        status: "malformed",
        offset,
        reason: `duplicate extension type ${type} at TLV offset ${offset}`,
      };
    }
    seen.add(type);
    entries.push({
      type,
      name: extensionName(type),
      offset,
      length,
      data: tlv.subarray(offset + 4, offset + 4 + length),
    });
    offset += 4 + length;
  }
  return { status: "parsed", entries };
}

const LOCAL_EXTENSION_NAMES: Readonly<Record<number, string>> = {
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  24: "ConfidentialMintBurn",
};

/** Names an extension type from the installed spl-token enum, a local map, or `Unknown(n)`. */
export function extensionName(type: number): string {
  const fromEnum: string | undefined = ExtensionType[type];
  if (typeof fromEnum === "string") return fromEnum;
  return LOCAL_EXTENSION_NAMES[type] ?? `Unknown(${type})`;
}

const ACCOUNT_SCOPED_TYPES = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);
const UNKNOWN_SCOPED_TYPES = new Set([16, 24]);

const RISK = {
  transfer_fee: ExtensionType.TransferFeeConfig,
  mint_close_authority: ExtensionType.MintCloseAuthority,
  default_account_state: ExtensionType.DefaultAccountState,
  non_transferable: ExtensionType.NonTransferable,
  permanent_delegate: ExtensionType.PermanentDelegate,
  transfer_hook: ExtensionType.TransferHook,
  pausable: ExtensionType.PausableConfig,
} as const;
type RiskCheckId = keyof typeof RISK;
const RISK_TYPES: ReadonlySet<number> = new Set(Object.values(RISK));

type VerifiedTransferFee = Extract<
  TokenSafetyChecks["transfer_fee"],
  { status: "verified"; present: true }
>;

/**
 * A decoded TransferFeeConfig whose two tiers differ, so the active fee
 * depends on the current epoch. It carries no `active` field: only
 * `applyActiveFee` turns it into a report check, so a pending state can never
 * reach a report disguised as an RPC failure.
 */
export type TransferFeeAwaitingEpoch = {
  config: Omit<VerifiedTransferFee, "active">;
  older: TransferFee;
  newer: TransferFee;
};

export type DecodedExtensions = Pick<
  TokenSafetyChecks,
  | "transfer_hook"
  | "permanent_delegate"
  | "non_transferable"
  | "default_account_state"
  | "mint_close_authority"
  | "pausable"
  | "other_extensions"
> & {
  inventory: TokenSafetyReport["extensionInventory"];
  transferFee:
    | { status: "decoded"; check: TokenSafetyChecks["transfer_fee"] }
    | { status: "needs_epoch"; feeNeedsEpoch: TransferFeeAwaitingEpoch };
};

function extAddr(key: PublicKey): ExtAddr {
  return key.equals(PublicKey.default)
    ? { state: "unset" }
    : { state: "set", address: key.toBase58() };
}

function feeTier(fee: TransferFee, decimals: number): FeeTier {
  return {
    epoch: fee.epoch.toString(),
    basisPoints: fee.transferFeeBasisPoints,
    maximumFeeRaw: fee.maximumFee.toString(),
    maximumFeeUi: toHuman(fee.maximumFee, decimals),
    maximumIsU64Max: fee.maximumFee === U64_MAX,
  };
}

function absent(basis: Absent["basis"]): Absent {
  return { status: "verified", present: false, basis };
}

/** Decodes the seven risk extensions and lists every other extension by name. */
export function decodeExtensions(
  classified: Extract<ClassifiedMint, { ok: true }>,
): DecodedExtensions {
  if (classified.program === "spl-token") {
    const basis = "spl_token_program_has_no_extensions" as const;
    return {
      transfer_hook: absent(basis),
      transferFee: { status: "decoded", check: absent(basis) },
      permanent_delegate: absent(basis),
      non_transferable: absent(basis),
      default_account_state: absent(basis),
      mint_close_authority: absent(basis),
      pausable: absent(basis),
      other_extensions: { status: "verified", basis, entries: [] },
      inventory: { status: "verified", entries: [] },
    };
  }

  const walk = walkMintTlv(classified.tlv);
  if (walk.status === "malformed") {
    const malformed = (name: string) => ({
      status: "unknown" as const,
      present: "unknown" as const,
      code: "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED" as const,
      reason: `${walk.reason}; whether ${name} is present is unverified`,
    });
    return {
      transfer_hook: malformed("TransferHook"),
      transferFee: { status: "decoded", check: malformed("TransferFeeConfig") },
      permanent_delegate: malformed("PermanentDelegate"),
      non_transferable: malformed("NonTransferable"),
      default_account_state: malformed("DefaultAccountState"),
      mint_close_authority: malformed("MintCloseAuthority"),
      pausable: malformed("PausableConfig"),
      other_extensions: {
        status: "unknown",
        code: "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED",
        reason: `${walk.reason}; which other extensions are present is unverified`,
      },
      inventory: {
        status: "unknown",
        code: "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED",
        reason: `${walk.reason}; the extension list is unverified`,
      },
    };
  }

  const decimals = classified.mint.decimals;
  const byType = new Map(walk.entries.map((entry) => [entry.type, entry]));
  const lengthMismatch = (id: RiskCheckId): TlvEntry | null => {
    const entry = byType.get(RISK[id]);
    if (!entry) return null;
    return entry.length === getTypeLen(RISK[id]) ? null : entry;
  };
  const mismatch = (entry: TlvEntry) => ({
    status: "unknown" as const,
    present: true as const,
    code: "TOKEN_SAFETY_EXTENSION_LENGTH_MISMATCH" as const,
    reason: `${entry.name} data is ${entry.length} bytes, expected ${getTypeLen(entry.type)}; its configuration is unverified`,
  });
  const scanned = absent("tlv_scanned");

  const decodeRisk = <T>(
    id: RiskCheckId,
    decode: (data: Buffer) => T,
  ): T | Absent | ReturnType<typeof mismatch> => {
    const entry = byType.get(RISK[id]);
    if (!entry) return scanned;
    const bad = lengthMismatch(id);
    if (bad) return mismatch(bad);
    return decode(entry.data);
  };

  const feeEntry = byType.get(RISK.transfer_fee);
  const feeMismatch = lengthMismatch("transfer_fee");
  let transferFee: DecodedExtensions["transferFee"];
  if (!feeEntry) {
    transferFee = { status: "decoded", check: scanned };
  } else if (feeMismatch) {
    transferFee = { status: "decoded", check: mismatch(feeMismatch) };
  } else {
    const cfg = TransferFeeConfigLayout.decode(feeEntry.data);
    const older = feeTier(cfg.olderTransferFee, decimals);
    const config: TransferFeeAwaitingEpoch["config"] = {
      status: "verified",
      present: true,
      older,
      newer: feeTier(cfg.newerTransferFee, decimals),
      transferFeeConfigAuthority: extAddr(cfg.transferFeeConfigAuthority),
      withdrawWithheldAuthority: extAddr(cfg.withdrawWithheldAuthority),
      withheldAmountRaw: cfg.withheldAmount.toString(),
      withheldAmountUi: toHuman(cfg.withheldAmount, decimals),
    };
    const identical =
      cfg.olderTransferFee.transferFeeBasisPoints ===
        cfg.newerTransferFee.transferFeeBasisPoints &&
      cfg.olderTransferFee.maximumFee === cfg.newerTransferFee.maximumFee;
    transferFee = identical
      ? {
          status: "decoded",
          check: {
            ...config,
            active: {
              status: "verified",
              basis: "tiers_identical",
              currentEpoch: null,
              tier: "older",
              basisPoints: older.basisPoints,
              maximumFeeRaw: older.maximumFeeRaw,
              maximumFeeUi: older.maximumFeeUi,
              maximumIsU64Max: older.maximumIsU64Max,
            },
          },
        }
      : {
          status: "needs_epoch",
          feeNeedsEpoch: {
            config,
            older: cfg.olderTransferFee,
            newer: cfg.newerTransferFee,
          },
        };
  }

  const transfer_hook: TokenSafetyChecks["transfer_hook"] = decodeRisk(
    "transfer_hook",
    (data): TokenSafetyChecks["transfer_hook"] => {
      const hook = TransferHookLayout.decode(data);
      return {
        status: "verified",
        present: true,
        hookProgram: extAddr(hook.programId),
        authority: extAddr(hook.authority),
      };
    },
  );

  const permanent_delegate: TokenSafetyChecks["permanent_delegate"] =
    decodeRisk(
      "permanent_delegate",
      (data): TokenSafetyChecks["permanent_delegate"] => ({
        status: "verified",
        present: true,
        delegate: extAddr(PermanentDelegateLayout.decode(data).delegate),
      }),
    );

  const non_transferable: TokenSafetyChecks["non_transferable"] = decodeRisk(
    "non_transferable",
    (): TokenSafetyChecks["non_transferable"] => ({
      status: "verified",
      present: true,
    }),
  );

  const default_account_state: TokenSafetyChecks["default_account_state"] =
    decodeRisk(
      "default_account_state",
      (data): TokenSafetyChecks["default_account_state"] => {
        const state: number = DefaultAccountStateLayout.decode(data).state;
        if (state === 1) {
          return {
            status: "verified",
            present: true,
            state: "initialized",
            frozenByDefault: false,
          };
        }
        if (state === 2) {
          return {
            status: "verified",
            present: true,
            state: "frozen",
            frozenByDefault: true,
          };
        }
        return {
          status: "unknown",
          present: true,
          code: "TOKEN_SAFETY_UNRECOGNIZED_ENUM_VALUE",
          reason: `DefaultAccountState stores state value ${state}, which is neither Initialized (1) nor Frozen (2); the default state of new token accounts is unverified`,
        };
      },
    );

  const mint_close_authority: TokenSafetyChecks["mint_close_authority"] =
    decodeRisk(
      "mint_close_authority",
      (data): TokenSafetyChecks["mint_close_authority"] => ({
        status: "verified",
        present: true,
        closeAuthority: extAddr(
          MintCloseAuthorityLayout.decode(data).closeAuthority,
        ),
      }),
    );

  const pausable: TokenSafetyChecks["pausable"] = decodeRisk(
    "pausable",
    (data): TokenSafetyChecks["pausable"] => {
      const cfg = PausableConfigLayout.decode(data);
      return {
        status: "verified",
        present: true,
        authority: extAddr(cfg.authority),
        paused: cfg.paused,
      };
    },
  );

  const others: OtherExtension[] = walk.entries
    .filter((entry) => !RISK_TYPES.has(entry.type))
    .map((entry) => {
      const decodable = typeof ExtensionType[entry.type] === "string";
      const scope: OtherExtension["scope"] = ACCOUNT_SCOPED_TYPES.has(
        entry.type,
      )
        ? "account_extension_in_mint_data"
        : entry.name.startsWith("Unknown(") ||
            UNKNOWN_SCOPED_TYPES.has(entry.type)
          ? "unknown_type"
          : "mint";
      return {
        type: entry.type,
        name: entry.name,
        scope,
        decodableByInstalledSplToken: decodable,
      };
    });

  return {
    transfer_hook,
    transferFee,
    permanent_delegate,
    non_transferable,
    default_account_state,
    mint_close_authority,
    pausable,
    other_extensions: {
      status: "verified",
      basis: "tlv_scanned",
      entries: others,
    },
    inventory: {
      status: "verified",
      entries: walk.entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        length: entry.length,
      })),
    },
  };
}

/**
 * Builds the transfer_fee check for differing tiers from the current epoch
 * read: the tier in force at that epoch, or the read's typed RpcUnknown.
 */
export function applyActiveFee(
  pending: TransferFeeAwaitingEpoch,
  epoch: { ok: true; value: bigint } | { ok: false; unknown: RpcUnknown },
  decimals: number,
): TokenSafetyChecks["transfer_fee"] {
  const { config } = pending;
  if (!epoch.ok) return { ...config, active: epoch.unknown };
  const selected = getEpochFee(
    {
      transferFeeConfigAuthority: PublicKey.default,
      withdrawWithheldAuthority: PublicKey.default,
      withheldAmount: 0n,
      olderTransferFee: pending.older,
      newerTransferFee: pending.newer,
    },
    epoch.value,
  );
  const tier: "older" | "newer" =
    epoch.value >= pending.newer.epoch ? "newer" : "older";
  const chosen = feeTier(selected, decimals);
  return {
    ...config,
    active: {
      status: "verified",
      basis: "epoch",
      currentEpoch: epoch.value.toString(),
      tier,
      basisPoints: chosen.basisPoints,
      maximumFeeRaw: chosen.maximumFeeRaw,
      maximumFeeUi: chosen.maximumFeeUi,
      maximumIsU64Max: chosen.maximumIsU64Max,
    },
  };
}
