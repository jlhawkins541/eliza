/**
 * Integration tests for the token_safety inspection: a real @solana/web3.js
 * Connection against a deterministic loopback node:http JSON-RPC server, with
 * byte-exact mint accounts. Covers SPL and Token-2022 decoding, fee-tier
 * epoch selection, holder concentration arithmetic and validation, sub-read
 * degradation, typed mint-read failures, and the read-only method set. The
 * failure classifier is also driven directly with deterministic thrown errors
 * to pin which TypeErrors count as transport failures.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  accountInfoResult,
  asAgentRuntime,
  encodeMintAccount,
  epochInfoResult,
  ext,
  type Handlers,
  largestAccountsResult,
  type MintFixtureOptions,
  plainRuntime,
  type RecordedRequest,
  type Reply,
  type SolanaRpcFixture,
  startSolanaRpcFixture,
} from "./__tests__/solana-rpc-fixture";
import { formatTokenSafetyReport } from "./format";
import { type InspectOutcome, inspectSolanaTokenSafety } from "./inspect";
import { createTokenSafetyRpc, degradeRpc, readRpc } from "./rpc";
import type { TokenSafetyReport } from "./types";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = key(200);
const U64_MAX = 2n ** 64n - 1n;
const MINT_SLOT = 5000;
const HOLDER_SLOT = 5001;

const open: SolanaRpcFixture[] = [];
const allRequests: RecordedRequest[] = [];

afterEach(async () => {
  for (const fixture of open.splice(0)) {
    allRequests.push(...fixture.requests);
    await fixture.close();
  }
});

afterAll(() => {
  const allowed = new Set([
    "getAccountInfo",
    "getTokenLargestAccounts",
    "getEpochInfo",
  ]);
  expect(allRequests.length).toBeGreaterThan(0);
  for (const request of allRequests) expect(allowed).toContain(request.method);
});

function mintAccount(owner: PublicKey, opts: MintFixtureOptions) {
  return {
    result: accountInfoResult(
      encodeMintAccount(opts),
      owner.toBase58(),
      MINT_SLOT,
    ),
  };
}

function oneRow(amount: string, decimals: number) {
  return {
    result: largestAccountsResult(
      [{ address: key(90).toBase58(), amount, decimals }],
      HOLDER_SLOT,
    ),
  };
}

async function inspect(handlers: Handlers, timeoutMs?: number) {
  const fixture = await startSolanaRpcFixture(handlers);
  open.push(fixture);
  const runtime = plainRuntime({ SOLANA_RPC_URL: fixture.url });
  const rpc = createTokenSafetyRpc(runtime, timeoutMs);
  const result = await inspectSolanaTokenSafety({
    runtime: asAgentRuntime(runtime),
    rpc,
    mint: MINT,
  });
  return { fixture, runtime, result };
}

function report(result: InspectOutcome): TokenSafetyReport {
  if (result.outcome !== "report")
    throw new Error(`expected report, got ${JSON.stringify(result)}`);
  return result.report;
}

function methods(fixture: SolanaRpcFixture): string[] {
  return fixture.requests.map((r) => r.method);
}

const fullTokenExtensions = (older: bigint, newer: bigint) => [
  ext.transferFeeConfig({
    transferFeeConfigAuthority: key(10),
    withdrawWithheldAuthority: key(11),
    withheldAmount: 42n,
    olderTransferFee: {
      epoch: 0n,
      maximumFee: older,
      transferFeeBasisPoints: 50,
    },
    newerTransferFee: {
      epoch: 20n,
      maximumFee: newer,
      transferFeeBasisPoints: 300,
    },
  }),
  ext.mintCloseAuthority(key(12)),
  ext.defaultAccountState(2),
  ext.nonTransferable(),
  ext.permanentDelegate(key(13)),
  ext.transferHook(key(14), key(15)),
  ext.opaque(16, 10),
  ext.pausable(key(16), true),
  ext.opaque(4242, 5),
];

describe("inspectSolanaTokenSafety — SPL Token", () => {
  it("reports supply 2^64-1 exactly, revoked authorities and no extensions with full coverage", async () => {
    const { result } = await inspect({
      getAccountInfo: mintAccount(TOKEN_PROGRAM_ID, {
        supply: U64_MAX,
        decimals: 9,
      }),
      getTokenLargestAccounts: oneRow(U64_MAX.toString(), 9),
    });
    const r = report(result);
    expect(r.checks.supply).toEqual({
      status: "verified",
      raw: "18446744073709551615",
      ui: "18446744073.709551615",
      decimals: 9,
      nativeMint: false,
    });
    expect(r.checks.mint_authority).toEqual({
      status: "verified",
      state: "revoked",
    });
    expect(r.checks.freeze_authority).toEqual({
      status: "verified",
      state: "revoked",
    });
    for (const id of [
      "transfer_hook",
      "transfer_fee",
      "permanent_delegate",
      "non_transferable",
      "default_account_state",
      "mint_close_authority",
      "pausable",
    ] as const) {
      expect(r.checks[id]).toEqual({
        status: "verified",
        present: false,
        basis: "spl_token_program_has_no_extensions",
      });
    }
    expect(r.coverage).toEqual({
      checksTotal: 13,
      checksFullyVerified: 13,
      unknown: [],
    });
    expect(r.flags).toEqual([]);
  });
});

describe("inspectSolanaTokenSafety — Token-2022 extensions", () => {
  it.each([
    [15, "older", 50],
    [25, "newer", 300],
  ] as const)(
    "decodes every risk extension and selects the fee tier at epoch %i",
    async (epoch, tier, bps) => {
      const { result, fixture } = await inspect({
        getAccountInfo: mintAccount(TOKEN_2022_PROGRAM_ID, {
          supply: 1_000_000_000n,
          decimals: 6,
          mintAuthority: key(1),
          freezeAuthority: key(2),
          extensions: fullTokenExtensions(1_000_000n, U64_MAX),
        }),
        getTokenLargestAccounts: oneRow("500000000", 6),
        getEpochInfo: { result: epochInfoResult(epoch) },
      });
      const r = report(result);
      expect(methods(fixture).sort()).toEqual([
        "getAccountInfo",
        "getEpochInfo",
        "getTokenLargestAccounts",
      ]);
      expect(r.checks.transfer_hook).toEqual({
        status: "verified",
        present: true,
        hookProgram: { state: "set", address: key(15).toBase58() },
        authority: { state: "set", address: key(14).toBase58() },
      });
      expect(r.checks.permanent_delegate).toEqual({
        status: "verified",
        present: true,
        delegate: { state: "set", address: key(13).toBase58() },
      });
      expect(r.checks.mint_close_authority).toEqual({
        status: "verified",
        present: true,
        closeAuthority: { state: "set", address: key(12).toBase58() },
      });
      expect(r.checks.pausable).toEqual({
        status: "verified",
        present: true,
        authority: { state: "set", address: key(16).toBase58() },
        paused: true,
      });
      expect(r.checks.default_account_state).toEqual({
        status: "verified",
        present: true,
        state: "frozen",
        frozenByDefault: true,
      });
      expect(r.checks.non_transferable).toEqual({
        status: "verified",
        present: true,
      });
      const fee = r.checks.transfer_fee;
      if (fee.status !== "verified" || fee.present !== true)
        throw new Error("fee not verified");
      expect(fee.older).toEqual({
        epoch: "0",
        basisPoints: 50,
        maximumFeeRaw: "1000000",
        maximumFeeUi: "1.0",
        maximumIsU64Max: false,
      });
      expect(fee.newer.maximumIsU64Max).toBe(true);
      expect(fee.transferFeeConfigAuthority).toEqual({
        state: "set",
        address: key(10).toBase58(),
      });
      expect(fee.withdrawWithheldAuthority).toEqual({
        state: "set",
        address: key(11).toBase58(),
      });
      expect(fee.withheldAmountRaw).toBe("42");
      expect(fee.active).toEqual(
        expect.objectContaining({
          status: "verified",
          basis: "epoch",
          currentEpoch: String(epoch),
          tier,
          basisPoints: bps,
        }),
      );
      expect(r.checks.other_extensions).toEqual({
        status: "verified",
        basis: "tlv_scanned",
        entries: [
          {
            type: 16,
            name: "ConfidentialTransferFeeConfig",
            scope: "unknown_type",
            decodableByInstalledSplToken: false,
          },
          {
            type: 4242,
            name: "Unknown(4242)",
            scope: "unknown_type",
            decodableByInstalledSplToken: false,
          },
        ],
      });
      expect(r.flags).toEqual([
        "mint_authority_present",
        "freeze_authority_present",
        "transfer_hook_program_set",
        "transfer_hook_authority_set",
        "transfer_fee_nonzero_active",
        "transfer_fee_nonzero_scheduled",
        "transfer_fee_authority_set",
        "permanent_delegate_set",
        "non_transferable",
        "default_account_state_frozen",
        "mint_close_authority_set",
        "pausable_authority_set",
        "paused",
        "unassessed_extensions_present",
      ]);
      expect(r.coverage).toEqual({
        checksTotal: 13,
        checksFullyVerified: 13,
        unknown: [],
      });
      const text = formatTokenSafetyReport(r);
      if (tier === "newer") {
        expect(text).toContain(
          "active fee at epoch 25: newer tier at 300 bps, maximum no cap (u64 max)",
        );
      } else {
        expect(text).toContain(
          "active fee at epoch 15: older tier at 50 bps, maximum 1.0 (raw 1000000)",
        );
      }
    },
  );

  it("flags a decodable mint-scoped extension as unassessed because its configuration is never read", async () => {
    const { result } = await inspect({
      getAccountInfo: mintAccount(TOKEN_2022_PROGRAM_ID, {
        supply: 10n,
        decimals: 0,
        extensions: [ext.opaque(10, 52)],
      }),
      getTokenLargestAccounts: oneRow("10", 0),
    });
    const r = report(result);
    expect(r.checks.other_extensions).toEqual({
      status: "verified",
      basis: "tlv_scanned",
      entries: [
        {
          type: 10,
          name: "InterestBearingConfig",
          scope: "mint",
          decodableByInstalledSplToken: true,
        },
      ],
    });
    expect(r.flags).toEqual(["unassessed_extensions_present"]);
    expect(formatTokenSafetyReport(r)).toContain(
      "other_extensions: verified — 1 present, listed by name, configuration not assessed: InterestBearingConfig (type 10)",
    );
  });

  it("reads no epoch when both fee tiers are identical", async () => {
    const { result, fixture } = await inspect({
      getAccountInfo: mintAccount(TOKEN_2022_PROGRAM_ID, {
        supply: 10n,
        decimals: 0,
        extensions: [
          ext.transferFeeConfig({
            transferFeeConfigAuthority: PublicKey.default,
            withdrawWithheldAuthority: PublicKey.default,
            withheldAmount: 0n,
            olderTransferFee: {
              epoch: 0n,
              maximumFee: 0n,
              transferFeeBasisPoints: 0,
            },
            newerTransferFee: {
              epoch: 9n,
              maximumFee: 0n,
              transferFeeBasisPoints: 0,
            },
          }),
        ],
      }),
      getTokenLargestAccounts: oneRow("10", 0),
    });
    const fee = report(result).checks.transfer_fee;
    if (fee.status !== "verified" || fee.present !== true)
      throw new Error("fee not verified");
    expect(fee.active).toEqual(
      expect.objectContaining({
        status: "verified",
        basis: "tiers_identical",
        currentEpoch: null,
      }),
    );
    expect(methods(fixture)).not.toContain("getEpochInfo");
  });

  it("keeps both tiers verified and reports the active fee unknown when getEpochInfo is rejected", async () => {
    const { result } = await inspect({
      getAccountInfo: mintAccount(TOKEN_2022_PROGRAM_ID, {
        supply: 1_000_000_000n,
        decimals: 6,
        extensions: fullTokenExtensions(1_000_000n, U64_MAX),
      }),
      getTokenLargestAccounts: oneRow("1", 6),
      getEpochInfo: { error: { code: -32005, message: "Node is behind" } },
    });
    const r = report(result);
    const fee = r.checks.transfer_fee;
    if (fee.status !== "verified" || fee.present !== true)
      throw new Error("fee not verified");
    expect(fee.older.basisPoints).toBe(50);
    expect(fee.newer.basisPoints).toBe(300);
    expect(fee.active).toEqual(
      expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_RPC_REJECTED",
        method: "getEpochInfo",
        rpcErrorCode: -32005,
      }),
    );
    expect(r.coverage.unknown).toEqual(["transfer_fee.active_fee"]);
    expect(r.coverage.checksFullyVerified).toBe(12);
    expect(r.flags).not.toContain("transfer_fee_nonzero_active");
    expect(r.flags).toContain("transfer_fee_nonzero_scheduled");
  });

  it("decodes a padded 357-byte mint with exactly its four risk extensions present", async () => {
    const bytes = encodeMintAccount({
      supply: 1n,
      decimals: 0,
      extensions: [
        ext.transferFeeConfig({
          transferFeeConfigAuthority: key(10),
          withdrawWithheldAuthority: key(11),
          withheldAmount: 0n,
          olderTransferFee: {
            epoch: 0n,
            maximumFee: 5n,
            transferFeeBasisPoints: 10,
          },
          newerTransferFee: {
            epoch: 0n,
            maximumFee: 5n,
            transferFeeBasisPoints: 10,
          },
        }),
        ext.transferHook(key(14), key(15)),
        ext.defaultAccountState(1),
        ext.nonTransferable(),
      ],
    });
    expect(bytes.length).toBe(357);
    const { result } = await inspect({
      getAccountInfo: {
        result: accountInfoResult(
          bytes,
          TOKEN_2022_PROGRAM_ID.toBase58(),
          MINT_SLOT,
        ),
      },
      getTokenLargestAccounts: oneRow("1", 0),
    });
    const r = report(result);
    const present = (
      [
        "transfer_hook",
        "transfer_fee",
        "permanent_delegate",
        "non_transferable",
        "default_account_state",
        "mint_close_authority",
        "pausable",
      ] as const
    ).filter((id) => {
      const check = r.checks[id];
      return check.status === "verified" && check.present === true;
    });
    expect(present).toEqual([
      "transfer_hook",
      "transfer_fee",
      "non_transferable",
      "default_account_state",
    ]);
    expect(r.coverage.unknown).toEqual([]);
  });
});

describe("inspectSolanaTokenSafety — holder concentration", () => {
  it("keeps all 20 rows in RPC order with exact BigInt shares", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      address: key(100 + i).toBase58(),
      amount:
        i === 0
          ? (2n ** 63n).toString()
          : (BigInt(20 - i) * 10n ** 15n + BigInt(i)).toString(),
      decimals: 9,
    }));
    const { result } = await inspect({
      getAccountInfo: mintAccount(TOKEN_PROGRAM_ID, {
        supply: U64_MAX,
        decimals: 9,
      }),
      getTokenLargestAccounts: {
        result: largestAccountsResult(rows, HOLDER_SLOT),
      },
    });
    const holders = report(result).checks.holder_concentration;
    if (holders.status !== "verified") throw new Error("holders not verified");
    expect(holders.rowsReturned).toBe(20);
    expect(holders.rows.map((row) => row.tokenAccount)).toEqual(
      rows.map((row) => row.address),
    );
    expect(holders.rows.map((row) => row.amountRaw)).toEqual(
      rows.map((row) => row.amount),
    );
    expect(holders.rows[0].shareOfSupply).toEqual({
      status: "verified",
      percent: "50.0000",
    });
    const pct = (amount: bigint) => {
      const ppm = (amount * 1_000_000n) / U64_MAX;
      return `${ppm / 10000n}.${(ppm % 10000n).toString().padStart(4, "0")}`;
    };
    const sum = (n: number) =>
      rows.slice(0, n).reduce((acc, row) => acc + BigInt(row.amount), 0n);
    expect(holders.top10ShareOfSupply).toEqual({
      status: "verified",
      percent: pct(sum(10)),
    });
    expect(holders.allReturnedShareOfSupply).toEqual({
      status: "verified",
      percent: pct(sum(20)),
    });
    expect(holders.slot).toBe(HOLDER_SLOT);
    expect(holders.supplySlot).toBe(MINT_SLOT);
  });

  const token2022 = mintAccount(TOKEN_2022_PROGRAM_ID, {
    supply: 1000n,
    decimals: 2,
    mintAuthority: key(1),
    extensions: [ext.transferHook(key(14), key(15))],
  });

  it.each([
    [
      "-32010",
      {
        error: {
          code: -32010,
          message: "excluded from account secondary indexes",
        },
      },
      "TOKEN_SAFETY_RPC_REJECTED",
      -32010,
      null,
    ],
    [
      "HTTP 429",
      { httpStatus: 429, body: '{"error":"slow down"}' },
      "TOKEN_SAFETY_RPC_RATE_LIMITED",
      null,
      429,
    ],
    [
      "malformed result",
      { result: { context: { slot: 1 }, value: {} } },
      "TOKEN_SAFETY_RPC_MALFORMED_RESPONSE",
      null,
      null,
    ],
  ] as const)(
    "degrades %s to an unknown check and keeps the mint checks verified",
    async (_label, reply, code, rpcErrorCode, httpStatus) => {
      const started = Date.now();
      const { result, fixture, runtime } = await inspect({
        getAccountInfo: token2022,
        getTokenLargestAccounts: reply,
      });
      const r = report(result);
      expect(r.checks.holder_concentration).toEqual(
        expect.objectContaining({
          status: "unknown",
          code,
          method: "getTokenLargestAccounts",
          rpcErrorCode,
          httpStatus,
        }),
      );
      expect(r.checks.mint_authority.status).toBe("verified");
      expect(r.checks.transfer_hook).toEqual(
        expect.objectContaining({ status: "verified", present: true }),
      );
      expect(r.coverage.unknown).toEqual(["holder_concentration"]);
      expect(
        methods(fixture).filter((m) => m === "getTokenLargestAccounts"),
      ).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(runtime.logs).toEqual([
        expect.objectContaining({ level: "warn" }),
      ]);
    },
  );

  it("degrades a stalled getTokenLargestAccounts to TIMEOUT", async () => {
    const { result } = await inspect(
      { getAccountInfo: token2022, getTokenLargestAccounts: { stall: true } },
      50,
    );
    const r = report(result);
    expect(r.checks.holder_concentration).toEqual(
      expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_RPC_TIMEOUT",
        method: "getTokenLargestAccounts",
        rpcErrorCode: null,
        httpStatus: null,
      }),
    );
    expect(r.checks.supply.status).toBe("verified");
    expect(r.checks.mint_authority).toEqual({
      status: "verified",
      state: "present",
      address: key(1).toBase58(),
    });
    expect(r.checks.transfer_hook).toEqual({
      status: "verified",
      present: true,
      hookProgram: { state: "set", address: key(15).toBase58() },
      authority: { state: "set", address: key(14).toBase58() },
    });
    expect(r.coverage.unknown).toEqual(["holder_concentration"]);
  });

  it.each([
    [
      "mismatched decimals",
      [{ address: key(90).toBase58(), amount: "1", decimals: 3 }],
    ],
    [
      "a non-integer amount",
      [{ address: key(90).toBase58(), amount: "1.5", decimals: 2 }],
    ],
    [
      "duplicate accounts",
      [
        { address: key(90).toBase58(), amount: "2", decimals: 2 },
        { address: key(90).toBase58(), amount: "1", decimals: 2 },
      ],
    ],
    ["no rows with non-zero supply", []],
  ])(
    "reports %s as HOLDER_ROWS_INCONSISTENT with no rows",
    async (_label, rows) => {
      const { result } = await inspect({
        getAccountInfo: token2022,
        getTokenLargestAccounts: {
          result: largestAccountsResult(rows, HOLDER_SLOT),
        },
      });
      const holders = report(result).checks.holder_concentration;
      expect(holders).toEqual(
        expect.objectContaining({
          status: "unknown",
          code: "TOKEN_SAFETY_HOLDER_ROWS_INCONSISTENT",
          slot: HOLDER_SLOT,
          supplySlot: MINT_SLOT,
        }),
      );
      expect("rows" in holders).toBe(false);
    },
  );

  it("reports an amount above supply read at a different slot as supply changing between the two reads", async () => {
    const { result } = await inspect({
      getAccountInfo: token2022,
      getTokenLargestAccounts: oneRow("1001", 2),
    });
    const holders = report(result).checks.holder_concentration;
    expect(holders).toEqual(
      expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_HOLDER_EXCEEDS_SUPPLY",
      }),
    );
    if (holders.status !== "unknown") return;
    expect(holders.reason).toContain("between the two reads");
  });

  it.each([
    [
      "a different slot",
      HOLDER_SLOT,
      "the 2 returned token accounts together show 1100 raw at slot 5001, above the supply of 1000 raw read at slot 5000; supply changed between the two reads (mint or burn), so shares are unverified",
    ],
    [
      "the same slot",
      MINT_SLOT,
      "the 2 returned token accounts together show 1100 raw at slot 5000, above the supply of 1000 raw read at the same slot; the RPC response is inconsistent, so shares are unverified",
    ],
  ])(
    "reports rows that each fit under supply but sum above it at %s as HOLDER_EXCEEDS_SUPPLY, never a share above 100%%",
    async (_label, holderSlot, reason) => {
      const { result } = await inspect({
        getAccountInfo: token2022,
        getTokenLargestAccounts: {
          result: largestAccountsResult(
            [
              { address: key(90).toBase58(), amount: "600", decimals: 2 },
              { address: key(91).toBase58(), amount: "500", decimals: 2 },
            ],
            holderSlot,
          ),
        },
      });
      const r = report(result);
      expect(r.checks.holder_concentration).toEqual({
        status: "unknown",
        code: "TOKEN_SAFETY_HOLDER_EXCEEDS_SUPPLY",
        reason,
        method: "getTokenLargestAccounts",
        slot: holderSlot,
        supplySlot: MINT_SLOT,
      });
      expect(r.coverage.unknown).toEqual(["holder_concentration"]);
      const text = formatTokenSafetyReport(r);
      expect(text).not.toContain("110.0000");
      expect(text).toContain(
        "holder_concentration: UNKNOWN [TOKEN_SAFETY_HOLDER_EXCEEDS_SUPPLY]",
      );
    },
  );

  it("reports every share as ZERO_SUPPLY unknown when the supply is 0", async () => {
    const { result } = await inspect({
      getAccountInfo: mintAccount(TOKEN_PROGRAM_ID, {
        supply: 0n,
        decimals: 2,
      }),
      getTokenLargestAccounts: oneRow("0", 2),
    });
    const r = report(result);
    const holders = r.checks.holder_concentration;
    if (holders.status !== "verified") throw new Error("holders not verified");
    expect(holders.rows[0].shareOfSupply).toEqual(
      expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_ZERO_SUPPLY",
      }),
    );
    expect(holders.rows[0].cumulativeShareOfSupply.status).toBe("unknown");
    expect(holders.top10ShareOfSupply.status).toBe("unknown");
    expect(holders.allReturnedShareOfSupply.status).toBe("unknown");
    expect(r.coverage.unknown).toEqual([
      "holder_concentration.share_of_supply",
    ]);
    const text = formatTokenSafetyReport(r);
    expect(text).not.toContain("0.0000%");
    expect(text).toContain(
      "share of supply UNKNOWN [TOKEN_SAFETY_ZERO_SUPPLY] (supply is 0)",
    );
  });
});

describe("inspectSolanaTokenSafety — invalid accounts", () => {
  it("reports a missing account with the read slot and no further reads", async () => {
    const { result, fixture } = await inspect({
      getAccountInfo: { result: { context: { slot: 77 }, value: null } },
    });
    expect(result).toEqual({
      outcome: "invalid_input",
      invalid: expect.objectContaining({
        kind: "account_not_found",
        error: "INVALID_ADDRESS",
        slot: 77,
      }),
    });
    expect(methods(fixture)).toEqual(["getAccountInfo"]);
  });

  it.each([
    [
      "a System-owned account",
      SystemProgram.programId,
      encodeMintAccount({ supply: 1n }),
      "not_token_program_account",
    ],
    [
      "a token account",
      TOKEN_PROGRAM_ID,
      Buffer.alloc(165),
      "token_account_not_mint",
    ],
    [
      "an uninitialized mint",
      TOKEN_PROGRAM_ID,
      Buffer.alloc(82),
      "uninitialized_mint",
    ],
  ])(
    "reports %s as invalid input with no sub-reads",
    async (_label, owner, data, kind) => {
      const { result, fixture } = await inspect({
        getAccountInfo: {
          result: accountInfoResult(data, owner.toBase58(), MINT_SLOT),
        },
        getTokenLargestAccounts: oneRow("1", 0),
      });
      expect(result).toEqual({
        outcome: "invalid_input",
        invalid: expect.objectContaining({
          kind,
          accountOwner: owner.toBase58(),
          accountDataLength: data.length,
          slot: MINT_SLOT,
        }),
      });
      expect(methods(fixture)).toEqual(["getAccountInfo"]);
    },
  );
});

describe("inspectSolanaTokenSafety — mint-read failures", () => {
  async function rejectWith(
    handlers: Handlers,
    timeoutMs?: number,
    closeFirst = false,
  ) {
    const fixture = await startSolanaRpcFixture(handlers);
    open.push(fixture);
    const runtime = plainRuntime({ SOLANA_RPC_URL: fixture.url });
    const rpc = createTokenSafetyRpc(runtime, timeoutMs);
    if (closeFirst) await fixture.close();
    return inspectSolanaTokenSafety({
      runtime: asAgentRuntime(runtime),
      rpc,
      mint: MINT,
    });
  }

  it("rejects with TRANSPORT_FAILED when the server is closed", async () => {
    await expect(rejectWith({}, undefined, true)).rejects.toEqual(
      expect.objectContaining({
        code: "TOKEN_SAFETY_RPC_TRANSPORT_FAILED",
        cause: expect.anything(),
        severity: "ephemeral",
      }),
    );
  });

  it.each([
    {
      label: "a stall",
      reply: { stall: true },
      timeoutMs: 50,
      code: "TOKEN_SAFETY_RPC_TIMEOUT",
      context: {},
    },
    {
      label: "HTTP 429",
      reply: { httpStatus: 429, body: "busy" },
      timeoutMs: undefined,
      code: "TOKEN_SAFETY_RPC_RATE_LIMITED",
      context: { httpStatus: 429 },
    },
    {
      label: "JSON-RPC -32005",
      reply: { error: { code: -32005, message: "Node is behind" } },
      timeoutMs: undefined,
      code: "TOKEN_SAFETY_RPC_REJECTED",
      context: { rpcErrorCode: -32005 },
    },
    {
      label: "HTTP 503",
      reply: { httpStatus: 503, body: "down" },
      timeoutMs: undefined,
      code: "TOKEN_SAFETY_RPC_HTTP_ERROR",
      context: { httpStatus: 503 },
    },
    {
      label: 'a non-base58 owner "!!"',
      reply: {
        result: {
          context: { slot: 1 },
          value: {
            data: ["", "base64"],
            owner: "!!",
            lamports: 1,
            executable: false,
            rentEpoch: 0,
            space: 0,
          },
        },
      },
      timeoutMs: undefined,
      code: "TOKEN_SAFETY_RPC_FAILED",
      context: {},
    },
  ] satisfies Array<{
    label: string;
    reply: Reply;
    timeoutMs: number | undefined;
    code: string;
    context: Record<string, unknown>;
  }>)(
    "rejects $label with $code",
    async ({ reply, timeoutMs, code, context }) => {
      await expect(
        rejectWith({ getAccountInfo: reply }, timeoutMs),
      ).rejects.toEqual(
        expect.objectContaining({
          code,
          cause: expect.anything(),
          severity: "ephemeral",
          context: expect.objectContaining({
            method: "getAccountInfo",
            mint: MINT.toBase58(),
            ...context,
          }),
        }),
      );
    },
  );
});

describe("readRpc / degradeRpc failure classification", () => {
  const socketError = (code: string) =>
    Object.assign(new Error(`socket failure ${code}`), { code });
  const rpc = () =>
    createTokenSafetyRpc(
      plainRuntime({ SOLANA_RPC_URL: "http://127.0.0.1:9/" }),
    );

  it.each([
    [
      "Node's fetch failed",
      new TypeError("fetch failed", { cause: socketError("ECONNREFUSED") }),
    ],
    [
      "an undici socket termination",
      new TypeError("terminated", { cause: socketError("UND_ERR_SOCKET") }),
    ],
    ["a Bun connection error", socketError("ConnectionRefused")],
  ])("degrades %s as TRANSPORT_FAILED", async (_label, thrown) => {
    const runtime = plainRuntime({});
    const read = await degradeRpc(
      asAgentRuntime(runtime),
      "getTokenLargestAccounts",
      MINT.toBase58(),
      rpc(),
      () => Promise.reject(thrown),
    );
    expect(read).toEqual({
      ok: false,
      unknown: expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_RPC_TRANSPORT_FAILED",
        method: "getTokenLargestAccounts",
      }),
    });
    expect(runtime.logs).toEqual([expect.objectContaining({ level: "warn" })]);
  });

  it.each([
    [
      "a property read on undefined",
      new TypeError("Cannot read properties of undefined (reading 'value')"),
    ],
    [
      "a Node API misuse code",
      Object.assign(
        new TypeError('The "url" argument must be of type string'),
        { code: "ERR_INVALID_ARG_TYPE" },
      ),
    ],
    [
      "a TypeError caused by a non-socket error",
      new TypeError("x is not a function", { cause: new Error("inner") }),
    ],
  ])(
    "classifies %s as TOKEN_SAFETY_RPC_FAILED and never degrades it",
    async (_label, thrown) => {
      const runtime = plainRuntime({});
      const degraded = degradeRpc(
        asAgentRuntime(runtime),
        "getEpochInfo",
        MINT.toBase58(),
        rpc(),
        () => Promise.reject(thrown),
      );
      await expect(degraded).rejects.toEqual(
        expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_FAILED",
          cause: thrown,
          context: expect.objectContaining({ method: "getEpochInfo" }),
        }),
      );
      await expect(
        readRpc("getAccountInfo", MINT.toBase58(), rpc(), () =>
          Promise.reject(thrown),
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_FAILED",
          severity: "ephemeral",
          context: expect.objectContaining({ method: "getAccountInfo" }),
        }),
      );
      expect(runtime.logs).toEqual([]);
    },
  );
});

describe("installed spl-token version in the report text", () => {
  function readJsonObject(file: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`${file} is not a JSON object`);
    return Object.fromEntries(Object.entries(parsed));
  }

  it("names the @solana/spl-token version that is installed and pinned", async () => {
    const requireFromHere = createRequire(import.meta.url);
    const splRoot = path.resolve(
      path.dirname(requireFromHere.resolve("@solana/spl-token")),
      "../..",
    );
    const installed = readJsonObject(
      path.join(splRoot, "package.json"),
    ).version;
    const dependencies = readJsonObject(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../package.json",
      ),
    ).dependencies;
    if (typeof installed !== "string")
      throw new Error("installed @solana/spl-token has no version");
    if (typeof dependencies !== "object" || dependencies === null)
      throw new Error("plugin-wallet package.json has no dependencies");
    expect(dependencies).toEqual(
      expect.objectContaining({ "@solana/spl-token": installed }),
    );
    const { result } = await inspect({
      getAccountInfo: mintAccount(TOKEN_2022_PROGRAM_ID, {
        supply: 10n,
        decimals: 0,
        extensions: [ext.opaque(16, 10)],
      }),
      getTokenLargestAccounts: oneRow("10", 0),
    });
    expect(formatTokenSafetyReport(report(result))).toContain(
      `ConfidentialTransferFeeConfig (type 16; not decodable by the installed @solana/spl-token ${installed})`,
    );
  });
});

describe("inspectSolanaTokenSafety — native wrapped-SOL mints", () => {
  // Wrapping SOL deposits lamports and mints nothing, so a native mint's
  // supply field stays 0 while its token accounts hold large balances.
  it.each([
    ["SPL Token", TOKEN_PROGRAM_ID, NATIVE_MINT],
    ["Token-2022", TOKEN_2022_PROGRAM_ID, NATIVE_MINT_2022],
  ])(
    "reports every %s native-mint share as untracked, never as rows exceeding supply",
    async (_name, program, nativeMint) => {
      const fixture = await startSolanaRpcFixture({
        getAccountInfo: mintAccount(program, { supply: 0n, decimals: 9 }),
        getTokenLargestAccounts: {
          result: largestAccountsResult(
            [
              {
                address: key(91).toBase58(),
                amount: "7000000000",
                decimals: 9,
              },
              {
                address: key(92).toBase58(),
                amount: "3000000000",
                decimals: 9,
              },
            ],
            HOLDER_SLOT,
          ),
        },
      });
      open.push(fixture);
      const runtime = plainRuntime({ SOLANA_RPC_URL: fixture.url });
      const result = await inspectSolanaTokenSafety({
        runtime: asAgentRuntime(runtime),
        rpc: createTokenSafetyRpc(runtime),
        mint: nativeMint,
      });
      const r = report(result);
      const holders = r.checks.holder_concentration;
      if (holders.status !== "verified")
        throw new Error(
          `expected verified rows, got ${JSON.stringify(holders)}`,
        );
      expect(holders.rows).toHaveLength(2);
      const untracked = expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_NATIVE_MINT_SUPPLY_UNTRACKED",
      });
      for (const row of holders.rows) {
        expect(row.shareOfSupply).toEqual(untracked);
        expect(row.cumulativeShareOfSupply).toEqual(untracked);
      }
      expect(holders.top10ShareOfSupply).toEqual(untracked);
      expect(holders.allReturnedShareOfSupply).toEqual(untracked);
      expect(r.checks.supply).toEqual(
        expect.objectContaining({ nativeMint: true }),
      );
      expect(JSON.stringify(r)).not.toContain("HOLDER_EXCEEDS_SUPPLY");
      expect(formatTokenSafetyReport(r)).not.toMatch(/\d% of supply/);
    },
  );
});
