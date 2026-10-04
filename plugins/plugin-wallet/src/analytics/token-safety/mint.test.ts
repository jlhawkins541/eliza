/**
 * Deterministic unit tests for the token_safety mint classifier, the
 * bounds-checked Token-2022 TLV walk/decoder and the epoch-based fee-tier
 * resolution, using byte-exact accounts built from the installed spl-token
 * layouts. No network, no mocks.
 */
import {
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type AccountInfo, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  encodeMintAccount,
  encodeTlv,
  ext,
  type MintFixtureOptions,
} from "./__tests__/solana-rpc-fixture";
import {
  applyActiveFee,
  type ClassifiedMint,
  classifyMintAccount,
  decodeExtensions,
  extensionName,
  walkMintTlv,
} from "./mint";
import type { RpcUnknown } from "./types";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = key(200);

function info(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: 1, executable: false, rentEpoch: 0 };
}

function classified2022(
  opts: MintFixtureOptions,
): Extract<ClassifiedMint, { ok: true }> {
  const result = classifyMintAccount(
    MINT,
    info(
      TOKEN_2022_PROGRAM_ID,
      encodeMintAccount({ supply: 1000n, decimals: 6, ...opts }),
    ),
  );
  if (!result.ok) throw new Error(`expected a mint, got ${result.kind}`);
  return result;
}

describe("walkMintTlv", () => {
  it("parses entries in order across Token-2022 padding where spl-token getExtensionTypes throws", () => {
    const tlv = Buffer.concat([
      encodeTlv([
        ext.transferHook(key(1), key(2)),
        ext.opaque(16, 10),
        ext.pausable(key(3), false),
      ]),
      Buffer.alloc(2),
    ]);
    expect(() => getExtensionTypes(tlv)).toThrow(RangeError);
    const walk = walkMintTlv(tlv);
    expect(walk.status).toBe("parsed");
    if (walk.status !== "parsed") return;
    expect(walk.entries.map((e) => [e.type, e.name])).toEqual([
      [14, "TransferHook"],
      [16, "ConfidentialTransferFeeConfig"],
      [26, "PausableConfig"],
    ]);
  });

  it("stops at a zero type header even when non-zero bytes follow", () => {
    const tlv = Buffer.concat([
      encodeTlv([ext.nonTransferable()]),
      Buffer.from([0, 0, 9, 9, 9, 9]),
    ]);
    const walk = walkMintTlv(tlv);
    expect(walk).toEqual({
      status: "parsed",
      entries: [expect.objectContaining({ type: 9, length: 0 })],
    });
  });

  it("reports a 3-byte tail, an overrunning length and a duplicate type as malformed, never as entries", () => {
    const tail = walkMintTlv(
      Buffer.concat([
        encodeTlv([ext.nonTransferable()]),
        Buffer.from([5, 0, 1]),
      ]),
    );
    expect(tail).toEqual({
      status: "malformed",
      offset: 4,
      reason: "the type header at TLV offset 4 has no length field",
    });

    const overrun = Buffer.alloc(14);
    overrun.writeUInt16LE(14, 0);
    overrun.writeUInt16LE(64, 2);
    expect(walkMintTlv(overrun)).toEqual({
      status: "malformed",
      offset: 0,
      reason:
        "the entry header at TLV offset 0 declares a value length of 64 while only 10 bytes follow the header",
    });

    const duplicate = encodeTlv([ext.nonTransferable(), ext.nonTransferable()]);
    expect(walkMintTlv(duplicate)).toEqual({
      status: "malformed",
      offset: 4,
      reason: "duplicate extension type 9 at TLV offset 4",
    });
  });
});

describe("extensionName", () => {
  it("names local-map types and renders types the installed enum lacks as Unknown(n)", () => {
    expect(extensionName(16)).toBe("ConfidentialTransferFeeConfig");
    expect(extensionName(17)).toBe("ConfidentialTransferFeeAmount");
    expect(extensionName(24)).toBe("ConfidentialMintBurn");
    expect(extensionName(28)).toBe("Unknown(28)");
    expect(extensionName(300)).toBe("Unknown(300)");
  });

  it("scopes an account-level type found in mint data", () => {
    const decoded = decodeExtensions(
      classified2022({ extensions: [ext.opaque(2, 8)] }),
    );
    expect(decoded.other_extensions).toEqual({
      status: "verified",
      basis: "tlv_scanned",
      entries: [
        {
          type: 2,
          name: "TransferFeeAmount",
          scope: "account_extension_in_mint_data",
          decodableByInstalledSplToken: true,
        },
      ],
    });
  });
});

describe("classifyMintAccount", () => {
  const cases: Array<{
    label: string;
    owner: PublicKey;
    data: Buffer;
    kind: string;
  }> = [
    {
      label: "System owner",
      owner: SystemProgram.programId,
      data: encodeMintAccount({ supply: 1n }),
      kind: "not_token_program_account",
    },
    {
      label: "SPL 165 bytes",
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(165),
      kind: "token_account_not_mint",
    },
    {
      label: "Token-2022 with byte 165 = Account",
      owner: TOKEN_2022_PROGRAM_ID,
      data: (() => {
        const b = Buffer.alloc(200);
        b[165] = 2;
        return b;
      })(),
      kind: "token_account_not_mint",
    },
    {
      label: "355 bytes",
      owner: TOKEN_2022_PROGRAM_ID,
      data: Buffer.alloc(355),
      kind: "multisig_account",
    },
    {
      label: "SPL 200 bytes",
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(200),
      kind: "malformed_mint_data",
    },
    {
      label: "Token-2022 120 bytes",
      owner: TOKEN_2022_PROGRAM_ID,
      data: Buffer.alloc(120),
      kind: "malformed_mint_data",
    },
    {
      label: "mintAuthorityOption 2",
      owner: TOKEN_PROGRAM_ID,
      data: encodeMintAccount({ supply: 1n, optionTagOverride: { mint: 2 } }),
      kind: "malformed_mint_data",
    },
    {
      label: "all-zero 82 bytes",
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(82),
      kind: "uninitialized_mint",
    },
  ];
  it.each(cases)("$label → $kind", ({ owner, data, kind }) => {
    const result = classifyMintAccount(MINT, info(owner, data));
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        kind,
        accountOwner: owner.toBase58(),
        accountDataLength: data.length,
      }),
    );
  });

  it("names the foreign owner in the detail", () => {
    const result = classifyMintAccount(
      MINT,
      info(SystemProgram.programId, encodeMintAccount()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("11111111111111111111111111111111");
  });
});

describe("decodeExtensions", () => {
  it("decodes PublicKey.default addresses as unset", () => {
    const zero = PublicKey.default;
    const decoded = decodeExtensions(
      classified2022({
        extensions: [
          ext.transferFeeConfig({
            transferFeeConfigAuthority: zero,
            withdrawWithheldAuthority: zero,
            withheldAmount: 0n,
            olderTransferFee: {
              epoch: 0n,
              maximumFee: 0n,
              transferFeeBasisPoints: 0,
            },
            newerTransferFee: {
              epoch: 0n,
              maximumFee: 0n,
              transferFeeBasisPoints: 0,
            },
          }),
          ext.mintCloseAuthority(zero),
          ext.permanentDelegate(zero),
          ext.transferHook(key(4), zero),
          ext.pausable(zero, false),
        ],
      }),
    );
    expect(decoded.transfer_hook).toEqual({
      status: "verified",
      present: true,
      hookProgram: { state: "unset" },
      authority: { state: "set", address: key(4).toBase58() },
    });
    expect(decoded.permanent_delegate).toEqual({
      status: "verified",
      present: true,
      delegate: { state: "unset" },
    });
    expect(decoded.mint_close_authority).toEqual({
      status: "verified",
      present: true,
      closeAuthority: { state: "unset" },
    });
    expect(decoded.pausable).toEqual({
      status: "verified",
      present: true,
      authority: { state: "unset" },
      paused: false,
    });
    expect(decoded.transferFee).toEqual({
      status: "decoded",
      check: expect.objectContaining({
        status: "verified",
        present: true,
        transferFeeConfigAuthority: { state: "unset" },
        withdrawWithheldAuthority: { state: "unset" },
        active: expect.objectContaining({ basis: "tiers_identical" }),
      }),
    });
  });

  describe("differing fee tiers", () => {
    const tiers = () =>
      decodeExtensions(
        classified2022({
          extensions: [
            ext.transferFeeConfig({
              transferFeeConfigAuthority: key(10),
              withdrawWithheldAuthority: key(11),
              withheldAmount: 0n,
              olderTransferFee: {
                epoch: 0n,
                maximumFee: 5_000_000_000n,
                transferFeeBasisPoints: 250,
              },
              newerTransferFee: {
                epoch: 900n,
                maximumFee: 2n ** 64n - 1n,
                transferFeeBasisPoints: 1000,
              },
            }),
          ],
        }),
      ).transferFee;

    function pending() {
      const fee = tiers();
      if (fee.status !== "needs_epoch") throw new Error("expected needs_epoch");
      return fee.feeNeedsEpoch;
    }

    it("leaves the active fee out of the decoded config until the epoch is applied", () => {
      const fee = tiers();
      expect(fee.status).toBe("needs_epoch");
      expect("active" in pending().config).toBe(false);
      expect(JSON.stringify(pending().config)).not.toContain(
        "TOKEN_SAFETY_RPC",
      );
    });

    it.each([
      { epoch: 899n, tier: "older", basisPoints: 250 },
      { epoch: 900n, tier: "newer", basisPoints: 1000 },
    ])(
      "selects the $tier tier at epoch $epoch",
      ({ epoch, tier, basisPoints }) => {
        expect(
          applyActiveFee(pending(), { ok: true, value: epoch }, 6),
        ).toEqual(
          expect.objectContaining({
            status: "verified",
            present: true,
            active: expect.objectContaining({
              status: "verified",
              basis: "epoch",
              currentEpoch: epoch.toString(),
              tier,
              basisPoints,
            }),
          }),
        );
      },
    );

    it("carries the epoch read's own typed unknown as the active fee", () => {
      const unknown: RpcUnknown = {
        status: "unknown",
        code: "TOKEN_SAFETY_RPC_RATE_LIMITED",
        reason: "Solana RPC getEpochInfo failed: 429 Too Many Requests: busy",
        method: "getEpochInfo",
        rpcErrorCode: null,
        httpStatus: 429,
      };
      const fee = applyActiveFee(pending(), { ok: false, unknown }, 6);
      expect(fee).toEqual(
        expect.objectContaining({ status: "verified", active: unknown }),
      );
    });
  });

  it("reports a TransferHook entry with the wrong length as LENGTH_MISMATCH", () => {
    const decoded = decodeExtensions(
      classified2022({ extensions: [ext.opaque(14, 10)] }),
    );
    expect(decoded.transfer_hook).toEqual({
      status: "unknown",
      present: true,
      code: "TOKEN_SAFETY_EXTENSION_LENGTH_MISMATCH",
      reason:
        "TransferHook data is 10 bytes, expected 64; its configuration is unverified",
    });
  });

  it.each([0, 7])(
    "reports DefaultAccountState value %i as UNRECOGNIZED_ENUM_VALUE",
    (state) => {
      const decoded = decodeExtensions(
        classified2022({ extensions: [ext.defaultAccountState(state)] }),
      );
      expect(decoded.default_account_state).toEqual(
        expect.objectContaining({
          status: "unknown",
          present: true,
          code: "TOKEN_SAFETY_UNRECOGNIZED_ENUM_VALUE",
        }),
      );
    },
  );

  it("makes all eight extension checks unknown when the walk is malformed", () => {
    const rawTlv = Buffer.alloc(14);
    rawTlv.writeUInt16LE(14, 0);
    rawTlv.writeUInt16LE(64, 2);
    const decoded = decodeExtensions(classified2022({ rawTlv }));
    if (decoded.transferFee.status !== "decoded")
      throw new Error("expected a decoded fee check");
    for (const check of [
      decoded.transfer_hook,
      decoded.transferFee.check,
      decoded.permanent_delegate,
      decoded.non_transferable,
      decoded.default_account_state,
      decoded.mint_close_authority,
      decoded.pausable,
    ]) {
      expect(check).toEqual(
        expect.objectContaining({
          status: "unknown",
          present: "unknown",
          code: "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED",
        }),
      );
    }
    expect(decoded.other_extensions).toEqual(
      expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED",
      }),
    );
    expect(decoded.inventory).toEqual(
      expect.objectContaining({
        status: "unknown",
        code: "TOKEN_SAFETY_EXTENSION_DATA_MALFORMED",
      }),
    );
  });
});
