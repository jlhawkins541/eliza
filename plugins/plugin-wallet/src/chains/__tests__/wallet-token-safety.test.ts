/**
 * Exercises WALLET `action=onchain_token_safety` through the real
 * `walletRouterAction` handler and its promoted `WALLET_ONCHAIN_TOKEN_SAFETY`
 * virtual: a real @solana/web3.js Connection against a deterministic loopback
 * node:http JSON-RPC server, plain runtime objects, and a plain callback
 * recorder. Covers dispatch, name routing beside plugin-x402-finance through
 * core's real catalog and action lookup, exact report and invalid-input text,
 * boundary failures, secret hygiene for every URL spelling, the untouched
 * financial gate, the analytics dispatch refactor, and compatibility with
 * core's real planned-reply egress policy.
 */
import {
  type Action,
  type ActionResult,
  buildActionCatalog,
  type Content,
  evaluatePlannedReplyEgress,
  type HandlerCallback,
  type Memory,
  normalizeActionName,
  resolvePlannerActionName,
} from "@elizaos/core";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountInfoResult,
  asAgentRuntime,
  encodeMintAccount,
  encodeTlv,
  epochInfoResult,
  ext,
  type Handlers,
  largestAccountsResult,
  type MintFixtureOptions,
  plainRuntime,
  type SolanaRpcFixture,
  startSolanaRpcFixture,
} from "../../analytics/token-safety/__tests__/solana-rpc-fixture";
import { createTokenSafetyRpc } from "../../analytics/token-safety/rpc";
import { ON_CHAIN_WRITE_SUBACTIONS } from "../../security/wallet-context-safety";
import { requiresWalletFinancialConfirmation } from "../../security/wallet-financial-confirmation";
import { WALLET_ROUTER_SUBACTIONS } from "../../types/wallet-router";
import { evmPlugin } from "../evm";
import { walletRouterAction } from "../wallet-action";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = key(200).toBase58();
const U64_MAX = 2n ** 64n - 1n;

const open: SolanaRpcFixture[] = [];
afterEach(async () => {
  for (const fixture of open.splice(0)) await fixture.close();
});

async function fixture(handlers: Handlers): Promise<SolanaRpcFixture> {
  const started = await startSolanaRpcFixture(handlers);
  open.push(started);
  return started;
}

const asRuntime = asAgentRuntime;

function message(content: Record<string, unknown> = {}): Memory {
  return {
    entityId: "00000000-0000-0000-0000-000000000001",
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "", ...content },
  } as Memory;
}

function recorder() {
  const calls: Content[] = [];
  let settled = false;
  const callback: HandlerCallback = async (content) => {
    calls.push(content);
    await new Promise<void>((resolve) => setImmediate(resolve));
    settled = true;
    return [];
  };
  return { callback, calls, isSettled: () => settled };
}

const fullExtensions = [
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
      maximumFee: U64_MAX,
      transferFeeBasisPoints: 1000,
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

const twentyRows = Array.from({ length: 20 }, (_, i) => ({
  address: key(100 + i).toBase58(),
  amount: (BigInt(20 - i) * 1_000_000_000n + BigInt(i)).toString(),
  decimals: 6,
}));

function fullHandlers(overrides: Handlers = {}): Handlers {
  return {
    getAccountInfo: {
      result: accountInfoResult(
        encodeMintAccount({
          supply: 1_000_000_000_000_000n,
          decimals: 6,
          mintAuthority: key(1),
          freezeAuthority: key(2),
          extensions: fullExtensions,
        }),
        TOKEN_2022_PROGRAM_ID.toBase58(),
        312345678,
      ),
    },
    getTokenLargestAccounts: {
      result: largestAccountsResult(twentyRows, 312345679),
    },
    getEpochInfo: { result: epochInfoResult(812) },
    ...overrides,
  };
}

function dataOf(result: ActionResult): Record<string, unknown> {
  const data = result.data;
  if (!data || typeof data !== "object")
    throw new Error("result carried no data");
  return data as Record<string, unknown>;
}

function virtual(name: string): Action {
  const found = (evmPlugin.actions ?? []).find(
    (action) => action.name === name,
  );
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

describe("WALLET onchain_token_safety dispatch", () => {
  it("returns the report through the router, awaiting the callback once with identical text and data", async () => {
    const server = await fixture(fullHandlers());
    const runtime = plainRuntime({ SOLANA_RPC_URL: server.url });
    const rec = recorder();
    const result = await walletRouterAction.handler(
      asRuntime(runtime),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
      rec.callback,
    );
    expect(result).toEqual(expect.objectContaining({ success: true }));
    if (!result) throw new Error("no result");
    expect(dataOf(result)).toEqual(
      expect.objectContaining({
        actionName: "WALLET",
        subaction: "onchain_token_safety",
        outcome: "report",
      }),
    );
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].text).toBe(result.text);
    expect(rec.calls[0].data).toBe(result.data);
    expect(rec.isSettled()).toBe(true);
    expect(runtime.serviceCalls).toEqual([]);
    expect(result.text).not.toContain("Invalid wallet parameters");
  });

  it.each([
    [
      "invalid_input",
      {
        getAccountInfo: {
          result: accountInfoResult(
            Buffer.alloc(0),
            SystemProgram.programId.toBase58(),
            312345678,
          ),
        },
      },
    ],
    [
      "rpc_failure",
      { getAccountInfo: { httpStatus: 429, body: "rate limited" } },
    ],
  ] as const)(
    "awaits the callback once with identical text and data on the %s path",
    async (outcome, handlers) => {
      const server = await fixture(handlers);
      const rec = recorder();
      const result = await walletRouterAction.handler(
        asRuntime(plainRuntime({ SOLANA_RPC_URL: server.url })),
        message(),
        undefined,
        { parameters: { action: "onchain_token_safety", address: MINT } },
        rec.callback,
      );
      if (!result) throw new Error("no result");
      expect(result.success).toBe(false);
      expect(dataOf(result)).toEqual(expect.objectContaining({ outcome }));
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0].text).toBe(result.text);
      expect(rec.calls[0].data).toBe(result.data);
      expect(rec.isSettled()).toBe(true);
    },
  );

  it("renders the complete invalid_input text for a System-owned account", async () => {
    const server = await fixture({
      getAccountInfo: {
        result: accountInfoResult(
          Buffer.alloc(0),
          SystemProgram.programId.toBase58(),
          312345678,
        ),
      },
    });
    const result = await walletRouterAction.handler(
      asRuntime(plainRuntime({ SOLANA_RPC_URL: server.url })),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
    );
    if (!result) throw new Error("no result");
    expect(result.error).toBe("INVALID_ADDRESS");
    expect((result.text ?? "").split("\n")).toEqual([
      "onchain_token_safety:",
      "  status: invalid_input",
      "  error: INVALID_ADDRESS",
      "  kind: not_token_program_account",
      `  input: ${MINT}`,
      `  detail: the account is owned by ${SystemProgram.programId.toBase58()}, not the SPL Token or Token-2022 program, so it is not a token mint. For an owner address, use action=search_address.`,
      "  source: Solana RPC from SOLANA_RPC_URL; account read at slot 312345678",
      '  note: "No token safety check was performed for this input. Nothing about any token is verified."',
    ]);
  });

  it("is reachable through the WALLET_ONCHAIN_TOKEN_SAFETY virtual and the TOKEN_SECURITY legacy name", async () => {
    const tokenSafety = virtual("WALLET_ONCHAIN_TOKEN_SAFETY");
    expect(tokenSafety.similes).toEqual([
      "WALLET",
      "TOKEN_SECURITY",
      "ONCHAIN_TOKEN_SAFETY",
    ]);
    const server = await fixture(fullHandlers());
    const runtime = asRuntime(plainRuntime({ SOLANA_RPC_URL: server.url }));
    const viaVirtual = await tokenSafety.handler(
      runtime,
      message(),
      undefined,
      { parameters: { address: MINT } },
    );
    if (!viaVirtual) throw new Error("no result");
    expect(dataOf(viaVirtual)).toEqual(
      expect.objectContaining({
        subaction: "onchain_token_safety",
        outcome: "report",
      }),
    );
    const viaLegacy = await walletRouterAction.handler(
      runtime,
      message(),
      undefined,
      {
        parameters: { action: "TOKEN_SECURITY", address: MINT },
      },
    );
    if (!viaLegacy) throw new Error("no result");
    expect(dataOf(viaLegacy)).toEqual(
      expect.objectContaining({
        subaction: "onchain_token_safety",
        outcome: "report",
      }),
    );
  });

  // TOKEN_SAFETY and token_safety are the GoPlus subaction's names on this
  // branch (dispatching them would call the GoPlus API), so only the
  // unclaimed x402 action name is driven through the handler here; the
  // catalog and resolver tests below pin that none of them reach this check.
  it.each(["CHECK_TOKEN_SAFETY"])(
    "does not route %s, which belongs to plugin-x402-finance, to the Solana check",
    async (action) => {
      const server = await fixture(fullHandlers());
      const result = await walletRouterAction.handler(
        asRuntime(plainRuntime({ SOLANA_RPC_URL: server.url })),
        message(),
        undefined,
        { parameters: { action, address: MINT } },
      );
      if (!result) throw new Error("no result");
      expect(result.success).toBe(false);
      expect(dataOf(result)).toEqual({ error: "INVALID_PARAMS" });
      expect(result.text).toMatch(/^Invalid wallet parameters: /);
      expect(server.requests).toEqual([]);
    },
  );
});

describe("WALLET onchain_token_safety beside plugin-x402-finance", () => {
  // Same name and similes as plugin-x402-finance@1.0.1's registered action.
  const x402CheckTokenSafety: Action = {
    name: "CHECK_TOKEN_SAFETY",
    similes: [
      "RUG_CHECK",
      "HONEYPOT_CHECK",
      "TOKEN_SAFETY",
      "CAN_I_SELL_THIS",
      "CHECK_HONEYPOT",
    ],
    description: "Analyze a Base token for honeypot risk",
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  const walletActions = evmPlugin.actions ?? [];
  const silentLogger = {
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  };

  it("adds no on-chain claim on TOKEN_SAFETY or CHECK_TOKEN_SAFETY in core's catalog", () => {
    const catalog = buildActionCatalog([
      ...walletActions,
      x402CheckTokenSafety,
    ]);
    const claimants = (name: string) =>
      catalog.parents
        .filter((parent) =>
          [
            parent.name,
            ...parent.similes,
            ...parent.children.flatMap((child) => [
              child.name,
              ...child.similes,
            ]),
          ].some((value) => normalizeActionName(value) === name),
        )
        .map((parent) => parent.name);
    // core retrieval drops a simile claimed by more than one catalog parent
    // as ambiguous, so the on-chain check must never add a claim on the x402
    // names.
    const onchain = walletActions.find(
      (action) => action.name === "WALLET_ONCHAIN_TOKEN_SAFETY",
    );
    if (!onchain) throw new Error("WALLET_ONCHAIN_TOKEN_SAFETY not promoted");
    expect(onchain.similes).not.toContain("TOKEN_SAFETY");
    expect(onchain.similes).not.toContain("CHECK_TOKEN_SAFETY");
    expect(claimants("CHECK_TOKEN_SAFETY")).toEqual(["CHECK_TOKEN_SAFETY"]);
    expect(claimants("ONCHAIN_TOKEN_SAFETY")).toEqual(["WALLET"]);
    expect(claimants("TOKEN_SECURITY")).toEqual(["WALLET"]);
  });

  it.each([
    [
      "wallet actions registered first",
      [...walletActions, x402CheckTokenSafety],
    ],
    ["x402 registered first", [x402CheckTokenSafety, ...walletActions]],
  ])(
    "never resolves the x402 names to the on-chain check, and resolves its own names to it, with %s",
    (_label, actions) => {
      const runtime = { actions, logger: silentLogger };
      const resolve = (name: string) =>
        resolvePlannerActionName(runtime, undefined, name);
      expect(resolve("TOKEN_SAFETY")).not.toContain(
        "WALLET_ONCHAIN_TOKEN_SAFETY",
      );
      expect(resolve("CHECK_TOKEN_SAFETY")).toEqual(["CHECK_TOKEN_SAFETY"]);
      expect(resolve("ONCHAIN_TOKEN_SAFETY")).toEqual([
        "WALLET_ONCHAIN_TOKEN_SAFETY",
      ]);
      expect(resolve("TOKEN_SECURITY")).toEqual([
        "WALLET_ONCHAIN_TOKEN_SAFETY",
      ]);
    },
  );
});

describe("WALLET onchain_token_safety report text", () => {
  const k = (n: number) => key(n).toBase58();
  const SUPPLY = 1_000_000_000_000_000n;
  const SPL_TOKEN = "@solana/spl-token 0.4.14";
  const NOTE =
    '  note: "UNKNOWN means the check could not be performed; treat it as unverified, not as passed. flags are derived from verified checks only; no overall safe/unsafe verdict is computed. Describe concentration as share of supply; rows are token accounts, not owners."';
  // Independent expectations: decimal places and 4-place floor percentages
  // derived here with BigInt, not through the module under test.
  const decimal6 = (raw: bigint) =>
    `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "") || "0"}`;
  const percent = (amount: bigint) => {
    const ppm = (amount * 1_000_000n) / SUPPLY;
    return `${ppm / 10_000n}.${(ppm % 10_000n).toString().padStart(4, "0")}`;
  };
  const rowLines = () => {
    let cumulative = 0n;
    return twentyRows.map((row, i) => {
      const amount = BigInt(row.amount);
      cumulative += amount;
      return `      #${i + 1} ${row.address} amount ${decimal6(amount)} (raw ${row.amount}): ${percent(amount)}% of supply, cumulative ${percent(cumulative)}%`;
    });
  };
  const flags = [
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
  ];
  const checkLines = (holderLines: string[]) => [
    `    token_program: verified — Token-2022 (${TOKEN_2022_PROGRAM_ID.toBase58()})`,
    "    supply: verified — 1000000000.0 (raw 1000000000000000, decimals 6)",
    `    mint_authority: verified — PRESENT ${k(1)}: this account can mint new supply`,
    `    freeze_authority: verified — PRESENT ${k(2)}: this account can freeze any token account of this mint`,
    `    transfer_hook: verified — TransferHook PRESENT; hook program ${k(15)} runs on every token movement; hook authority ${k(14)} can replace it`,
    `    transfer_fee: verified — TransferFeeConfig PRESENT; older tier from epoch 0: 250 bps, maximum 5000.0 (raw 5000000000); newer tier from epoch 900: 1000 bps, maximum no cap (u64 max); active fee at epoch 812: older tier at 250 bps, maximum 5000.0 (raw 5000000000); the newer tier takes effect at epoch 900 without any further signature; fee config authority ${k(10)} can schedule a new fee; withdraw-withheld authority ${k(11)} can withdraw withheld fees; withheld on mint 0.0 (raw 0)`,
    `    permanent_delegate: verified — PermanentDelegate PRESENT ${k(13)}: this account can move or burn tokens from any token account of this mint`,
    "    non_transferable: verified — NonTransferable PRESENT: tokens of this mint cannot move between owners",
    `    default_account_state: verified — DefaultAccountState PRESENT: new token accounts start FROZEN (freeze authority ${k(2)} can thaw them)`,
    `    mint_close_authority: verified — MintCloseAuthority PRESENT ${k(12)}: can close the mint account once supply is 0`,
    `    pausable: verified — PausableConfig PRESENT; PAUSED; pause authority ${k(16)}`,
    `    other_extensions: verified — 2 present, listed by name, configuration not assessed: ConfidentialTransferFeeConfig (type 16; not decodable by the installed ${SPL_TOKEN}), Unknown(4242) (type 4242; not decodable by the installed ${SPL_TOKEN})`,
    ...holderLines,
  ];
  const tail = [
    "  extensions: 9 present in account order: TransferFeeConfig (1), MintCloseAuthority (3), DefaultAccountState (6), NonTransferable (9), PermanentDelegate (12), TransferHook (14), ConfidentialTransferFeeConfig (16), PausableConfig (26), Unknown(4242) (4242)",
    `  flags: ${flags.join(", ")}`,
    NOTE,
  ];

  async function render(handlers: Handlers): Promise<ActionResult> {
    const server = await fixture(handlers);
    const result = await walletRouterAction.handler(
      asRuntime(plainRuntime({ SOLANA_RPC_URL: server.url })),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
    );
    if (!result?.text) throw new Error("no text");
    return result;
  }

  it("renders the full report line for line: every check, every extension, every row with its share and cumulative share, and the flags from data", async () => {
    const result = await render(fullHandlers());
    expect(rowLines()[0]).toBe(
      `      #1 ${k(100)} amount 20000.0 (raw 20000000000): 0.0020% of supply, cumulative 0.0020%`,
    );
    expect(rowLines()[1]).toBe(
      `      #2 ${k(101)} amount 19000.000001 (raw 19000000001): 0.0019% of supply, cumulative 0.0039%`,
    );
    const expected = [
      "onchain_token_safety:",
      "  status: report",
      `  mint: ${MINT}`,
      "  source: Solana RPC from SOLANA_RPC_URL; mint account read at slot 312345678",
      "  coverage: 13 of 13 checks fully verified; unknown: none",
      "  checks:",
      ...checkLines([
        "    holder_concentration: verified — getTokenLargestAccounts at slot 312345679 returned 20 token accounts (the RPC returns at most 20). These are token ACCOUNTS, not owners: one owner can control several accounts, and an account can be a pool, exchange or program vault. Shares use the supply read at slot 312345678, rounded down to 4 decimal places. Top 10: 0.0155% of supply; all 20 returned: 0.0210% of supply.",
        ...rowLines(),
      ]),
      ...tail,
    ];
    expect((result.text ?? "").split("\n")).toEqual(expected);
    const report = dataOf(result).report as { flags: string[] };
    expect(report.flags).toEqual(flags);
    expect(result.text).not.toMatch(
      /\b(?:submitted|sent|transferred|swapped|bridged|executed|completed|placed|queued|voted|proposed|confirmed|settled|finalized|filled|transfer|wallet|holdings|holds|contains|balance)\b/i,
    );
    expect(result.values?.tokenSafetyUnknownChecks).toEqual([]);
  });

  it("names the unknown check on the coverage line and keeps the line skeleton when holders are rate-limited", async () => {
    const result = await render(
      fullHandlers({
        getTokenLargestAccounts: { httpStatus: 429, body: "rate limited" },
      }),
    );
    const expected = [
      "onchain_token_safety:",
      "  status: report",
      `  mint: ${MINT}`,
      "  source: Solana RPC from SOLANA_RPC_URL; mint account read at slot 312345678",
      "  coverage: 12 of 13 checks fully verified; unknown: holder_concentration",
      "  checks:",
      ...checkLines([
        "    holder_concentration: UNKNOWN [TOKEN_SAFETY_RPC_RATE_LIMITED] — Solana RPC getTokenLargestAccounts failed: 429 Too Many Requests: rate limited. Unverified, not passed.",
      ]),
      ...tail,
    ];
    expect((result.text ?? "").split("\n")).toEqual(expected);
    expect(result.values?.tokenSafetyUnknownChecks).toEqual([
      "holder_concentration",
    ]);
    expect(result.values?.tokenSafetyChecksFullyVerified).toBe(12);
  });
});

describe("WALLET onchain_token_safety boundary failures", () => {
  async function call(
    parameters: Record<string, unknown>,
    settings: Record<string, string | undefined>,
  ) {
    const result = await walletRouterAction.handler(
      asRuntime(plainRuntime(settings)),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", ...parameters } },
    );
    if (!result) throw new Error("no result");
    return result;
  }

  it.each([
    ["a missing address", {}, "INVALID_PARAMS", "missing_address"],
    ["a symbol", { address: "BONK" }, "INVALID_ADDRESS", "malformed_address"],
    [
      "an EVM address",
      { address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" },
      "INVALID_ADDRESS",
      "malformed_address",
    ],
    [
      "chain base",
      { address: MINT, chain: "base" },
      "INVALID_PARAMS",
      "unsupported_chain",
    ],
    [
      "disagreeing address and mint",
      { address: MINT, mint: key(201).toBase58() },
      "INVALID_PARAMS",
      "ambiguous_address",
    ],
  ])(
    "rejects %s before any RPC request",
    async (_label, parameters, error, kind) => {
      const server = await fixture(fullHandlers());
      const result = await call(parameters, { SOLANA_RPC_URL: server.url });
      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
      expect(dataOf(result)).toEqual(
        expect.objectContaining({
          outcome: "invalid_input",
          invalid: expect.objectContaining({ kind }),
        }),
      );
      expect(server.requests).toEqual([]);
    },
  );

  it("maps a rate-limited mint read to RATE_LIMITED and a JSON-RPC error to PROVIDER_REJECTED", async () => {
    const limited = await fixture({
      getAccountInfo: { httpStatus: 429, body: "busy" },
    });
    const r1 = await call({ address: MINT }, { SOLANA_RPC_URL: limited.url });
    expect(r1.error).toBe("RATE_LIMITED");
    expect(dataOf(r1)).toEqual(
      expect.objectContaining({ outcome: "rpc_failure" }),
    );
    const rejected = await fixture({
      getAccountInfo: { error: { code: -32005, message: "Node is behind" } },
    });
    const r2 = await call({ address: MINT }, { SOLANA_RPC_URL: rejected.url });
    expect(r2.error).toBe("PROVIDER_REJECTED");
    expect(dataOf(r2)).toEqual(
      expect.objectContaining({
        failure: expect.objectContaining({
          rpcErrorCode: -32005,
          method: "getAccountInfo",
        }),
      }),
    );
  });

  it("reports an unclassified sub-read failure as rpc_failure naming that read, never as a degraded check", async () => {
    const server = await fixture(
      fullHandlers({
        getTokenLargestAccounts: {
          result: largestAccountsResult(
            [{ address: "!!", amount: "1", decimals: 6 }],
            312345679,
          ),
        },
      }),
    );
    const result = await call(
      { address: MINT },
      { SOLANA_RPC_URL: server.url },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("PROVIDER_UNAVAILABLE");
    expect(dataOf(result)).toEqual(
      expect.objectContaining({
        outcome: "rpc_failure",
        mint: MINT,
        failure: expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_FAILED",
          method: "getTokenLargestAccounts",
        }),
      }),
    );
    expect(result.text).toContain("  method: getTokenLargestAccounts");
    expect(result.text).toContain(
      '  note: "The getTokenLargestAccounts read failed unexpectedly, so no report was produced. Nothing about this token is verified."',
    );
  });

  it("keeps a multi-line provider body complete in data and on one line in the text", async () => {
    const body = "<html>\n<title>503</title>\n503 Down\n</html>";
    const server = await fixture({
      getAccountInfo: { httpStatus: 503, body },
    });
    const result = await call(
      { address: MINT },
      { SOLANA_RPC_URL: server.url },
    );
    expect(result.error).toBe("PROVIDER_UNAVAILABLE");
    const data = dataOf(result);
    expect(data).toEqual(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_HTTP_ERROR",
          httpStatus: 503,
          detail: expect.stringContaining(body),
        }),
      }),
    );
    const text = result.text ?? "";
    expect(text).toContain(
      "  detail: Solana RPC getAccountInfo failed: 503 Service Unavailable: <html>\\n<title>503</title>\\n503 Down\\n</html>",
    );
    const [first, ...rest] = text.split("\n");
    expect(first).toBe("onchain_token_safety:");
    for (const line of rest) expect(line).toMatch(/^ {2}[a-z_]+: /);
  });

  it("reports PROVIDER_UNAVAILABLE/NOT_CONFIGURED with no request when SOLANA_RPC_URL is unset", async () => {
    const server = await fixture(fullHandlers());
    const result = await call({ address: MINT }, {});
    expect(result.error).toBe("PROVIDER_UNAVAILABLE");
    expect(dataOf(result)).toEqual(
      expect.objectContaining({
        outcome: "rpc_failure",
        failure: expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_NOT_CONFIGURED",
          method: "configuration",
        }),
      }),
    );
    expect(result.text).toContain("SOLANA_RPC_URL is not configured");
    expect(server.requests).toEqual([]);
  });

  it.each(["ws://x?api-key=SECRET_SENTINEL", "not a url"])(
    "reports URL_INVALID for %s without echoing it",
    async (url) => {
      const result = await call({ address: MINT }, { SOLANA_RPC_URL: url });
      expect(result.error).toBe("PROVIDER_UNAVAILABLE");
      expect(dataOf(result)).toEqual(
        expect.objectContaining({
          failure: expect.objectContaining({
            code: "TOKEN_SAFETY_RPC_URL_INVALID",
          }),
        }),
      );
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    },
  );
});

describe("WALLET onchain_token_safety secret hygiene", () => {
  async function run(
    handlers: Handlers,
    options: { closeFirst?: boolean; suffix?: string; secret?: string } = {},
  ) {
    const {
      closeFirst = false,
      suffix = "/?api-key=SECRET_SENTINEL",
      secret = "SECRET_SENTINEL",
    } = options;
    const server = await fixture(handlers);
    const { port } = new URL(server.url);
    const runtime = plainRuntime({ SOLANA_RPC_URL: `${server.url}${suffix}` });
    if (closeFirst) await server.close();
    const rec = recorder();
    const result = await walletRouterAction.handler(
      asRuntime(runtime),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
      rec.callback,
    );
    if (!result) throw new Error("no result");
    const surfaces = [
      result.text ?? "",
      JSON.stringify(result.data),
      JSON.stringify(rec.calls),
      JSON.stringify(runtime.logs),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(secret);
      expect(surface).not.toContain("127.0.0.1");
      expect(surface).not.toContain(`:${port}`);
    }
    return result;
  }

  it("keeps the URL out of a report", async () => {
    expect((await run(fullHandlers())).success).toBe(true);
  });

  it("keeps the URL out of a degraded holder read", async () => {
    const result = await run(
      fullHandlers({
        getTokenLargestAccounts: { httpStatus: 429, body: "rate limited" },
      }),
    );
    expect(result.text).toContain(
      "holder_concentration: UNKNOWN [TOKEN_SAFETY_RPC_RATE_LIMITED]",
    );
  });

  it("keeps the URL out of a closed-server failure", async () => {
    const result = await run(fullHandlers(), { closeFirst: true });
    expect(dataOf(result)).toEqual(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_TRANSPORT_FAILED",
        }),
      }),
    );
  });

  it("keeps the URL out of a stalled mint read", {
    timeout: 20_000,
  }, async () => {
    const result = await run({ getAccountInfo: { stall: true } });
    expect(result.error).toBe("TIMEOUT");
  });

  it("redacts the bare query key when a 429 body echoes only the key", async () => {
    const result = await run(
      fullHandlers({
        getTokenLargestAccounts: {
          httpStatus: 429,
          body: "rate limit for key SECRET_SENTINEL exceeded",
        },
      }),
    );
    expect(result.text).toContain(
      "429 Too Many Requests: rate limit for key <SOLANA_RPC_URL> exceeded",
    );
  });

  it("redacts the bare query key when a JSON-RPC error message echoes only the key", async () => {
    const result = await run({
      getAccountInfo: {
        error: { code: -32052, message: "API key SECRET_SENTINEL is disabled" },
      },
    });
    expect(result.error).toBe("PROVIDER_REJECTED");
    expect(result.text).toContain("API key <SOLANA_RPC_URL> is disabled");
  });

  it("redacts a short credential-named query value when a 429 body echoes only that value", async () => {
    // "0" and "I" are outside base58, so no rendered address can contain it.
    const result = await run(
      fullHandlers({
        getTokenLargestAccounts: {
          httpStatus: 429,
          body: "key x0I7 is over quota",
        },
      }),
      { suffix: "/?api-key=x0I7", secret: "x0I7" },
    );
    expect(result.text).toContain(
      "429 Too Many Requests: key <SOLANA_RPC_URL> is over quota",
    );
  });

  it("redacts a path-embedded token when a JSON-RPC error message echoes it", async () => {
    const result = await run(
      {
        getAccountInfo: {
          error: { code: -32052, message: "endpoint token PATHKEY123 expired" },
        },
      },
      { suffix: "/PATHKEY123/", secret: "PATHKEY123" },
    );
    expect(result.error).toBe("PROVIDER_REJECTED");
    expect(result.text).toContain("endpoint token <SOLANA_RPC_URL> expired");
  });

  it("keeps userinfo credentials out of every surface and redacts them when echoed bare", async () => {
    const server = await fixture(fullHandlers());
    const url = new URL(server.url);
    url.username = "rpcuser01";
    url.password = "hunter2pass";
    const runtime = plainRuntime({ SOLANA_RPC_URL: url.href });
    const rec = recorder();
    // Node's fetch refuses a URL with credentials and names the URL in its
    // message; whichever outcome the runtime produces, neither part may leak.
    const result = await walletRouterAction.handler(
      asRuntime(runtime),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
      rec.callback,
    );
    if (!result) throw new Error("no result");
    for (const surface of [
      result.text ?? "",
      JSON.stringify(result.data),
      JSON.stringify(rec.calls),
      JSON.stringify(runtime.logs),
    ]) {
      expect(surface).not.toContain("rpcuser01");
      expect(surface).not.toContain("hunter2pass");
    }
    const { redact } = createTokenSafetyRpc(runtime);
    expect(
      redact("user rpcuser01 with password hunter2pass is over quota"),
    ).toBe(
      "user <SOLANA_RPC_URL> with password <SOLANA_RPC_URL> is over quota",
    );
  });
});

describe("WALLET onchain_token_safety endpoint forms that WHATWG accepts but web3.js rejects", () => {
  // Each form passes `new URL()`, but web3.js's own endpoint regexes reject the
  // raw string with a message that embeds it. The Connection must be built from
  // the normalized href, and any constructor rejection must become the typed,
  // static-message URL_INVALID, so the key never reaches any surface.
  async function runForm(form: (hostPort: string) => string) {
    const server = await fixture(fullHandlers());
    const { host } = new URL(server.url);
    const runtime = plainRuntime({ SOLANA_RPC_URL: form(host) });
    const rec = recorder();
    const result = await walletRouterAction.handler(
      asRuntime(runtime),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
      rec.callback,
    );
    if (!result) throw new Error("no result");
    for (const surface of [
      result.text ?? "",
      JSON.stringify(result.data),
      JSON.stringify(result.values),
      JSON.stringify(rec.calls),
      JSON.stringify(runtime.logs),
    ]) {
      expect(surface).not.toContain("SECRET_SENTINEL");
    }
    return result;
  }

  it.each([
    ["single slash", (h: string) => `http:/${h}/?api-key=SECRET_SENTINEL`],
    ["no slashes", (h: string) => `http:${h}/?api-key=SECRET_SENTINEL`],
    ["backslashes", (h: string) => `http:\\\\${h}/?api-key=SECRET_SENTINEL`],
    ["uppercase scheme", (h: string) => `HTTP://${h}/?api-key=SECRET_SENTINEL`],
  ])("normalizes the %s form and reads the mint", async (_name, form) => {
    const result = await runForm(form);
    expect(result.success).toBe(true);
    expect(result.text).toContain("  status: report");
  });

  it("turns an empty-username userinfo key into a typed URL_INVALID", async () => {
    const result = await runForm((h) => `http://:SECRET_SENTINEL@${h}/`);
    expect(result.success).toBe(false);
    expect(result.error).toBe("PROVIDER_UNAVAILABLE");
    expect(dataOf(result)).toEqual(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "TOKEN_SAFETY_RPC_URL_INVALID",
        }),
      }),
    );
  });
});

describe("WALLET onchain_token_safety stays outside the financial gate", () => {
  it("never requires confirmation and is not an on-chain write or router subaction", () => {
    expect(
      requiresWalletFinancialConfirmation({
        subaction: "onchain_token_safety",
      } as Parameters<typeof requiresWalletFinancialConfirmation>[0]),
    ).toBe(false);
    expect(ON_CHAIN_WRITE_SUBACTIONS.has("onchain_token_safety")).toBe(false);
    expect(
      (WALLET_ROUTER_SUBACTIONS as readonly string[]).includes(
        "onchain_token_safety",
      ),
    ).toBe(false);
  });
});

describe("analytics dispatch after the handler-record refactor", () => {
  it.each(["token_info", "search_address"])(
    "routes %s to its own handler",
    async (action) => {
      const result = await walletRouterAction.handler(
        asRuntime(plainRuntime({})),
        message(),
        undefined,
        { parameters: { action, address: MINT } },
      );
      if (!result) throw new Error("no result");
      expect(dataOf(result)).toEqual(
        expect.objectContaining({
          subaction: action,
          error: "SERVICE_UNAVAILABLE",
        }),
      );
      expect(result.error).toBe("SERVICE_UNAVAILABLE");
      expect(result.text).not.toContain("Invalid wallet parameters");
    },
  );
});

describe("egress compatibility", () => {
  it("lets replies grounded in the report pass core's planned-reply egress policy", async () => {
    const server = await fixture(
      fullHandlers({
        getTokenLargestAccounts: { httpStatus: 429, body: "rate limited" },
      }),
    );
    const degraded = await walletRouterAction.handler(
      asRuntime(plainRuntime({ SOLANA_RPC_URL: server.url })),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
    );
    const fullServer = await fixture(fullHandlers());
    const full = await walletRouterAction.handler(
      asRuntime(plainRuntime({ SOLANA_RPC_URL: fullServer.url })),
      message(),
      undefined,
      { parameters: { action: "onchain_token_safety", address: MINT } },
    );
    if (!full?.text || !degraded?.text) throw new Error("no text");
    for (const [tokenSafetyResult, reply] of [
      [full, full.text],
      [degraded, degraded.text],
      [
        full,
        "The largest token account has 51.23% of supply; mint authority is present and the TransferHook program is set.",
      ],
      [
        degraded,
        "Holder concentration could not be checked (rate limited), so it is unverified.",
      ],
    ] as const) {
      expect(
        evaluatePlannedReplyEgress({
          reply,
          request: "check whether this token mint is safe",
          actionResults: [tokenSafetyResult],
          actions: [],
        }),
      ).toEqual({ verdict: "allow" });
    }
    // Control: the same policy does reject an ungrounded holding paraphrase,
    // so the allow verdicts above are not vacuous.
    expect(
      evaluatePlannedReplyEgress({
        reply: "The top account holds 512300000 BONK.",
        request: "check whether this token mint is safe",
        actionResults: [full],
        actions: [],
      }),
    ).toEqual({ verdict: "reject", kind: "financial_holding" });
  });
});

describe("egress compatibility of every rendered variant", () => {
  const MINT_SLOT = 312345678;
  const mintRead = (
    owner: PublicKey,
    opts: MintFixtureOptions,
    slot = MINT_SLOT,
  ): Handlers[string] => ({
    result: accountInfoResult(encodeMintAccount(opts), owner.toBase58(), slot),
  });
  const rawRead = (owner: PublicKey, data: Buffer): Handlers[string] => ({
    result: accountInfoResult(data, owner.toBase58(), MINT_SLOT),
  });
  const rows = (
    amounts: ReadonlyArray<string>,
    decimals: number,
    slot = MINT_SLOT + 1,
  ): Handlers[string] => ({
    result: largestAccountsResult(
      amounts.map((amount, i) => ({
        address: key(100 + i).toBase58(),
        amount,
        decimals,
      })),
      slot,
    ),
  });
  const token2022 = (extensions: MintFixtureOptions["extensions"]) =>
    mintRead(TOKEN_2022_PROGRAM_ID, {
      supply: 1000n,
      decimals: 2,
      mintAuthority: key(1),
      extensions,
    });
  const malformedTlv = (rawTlv: Buffer): Handlers => ({
    getAccountInfo: mintRead(TOKEN_2022_PROGRAM_ID, {
      supply: 1000n,
      decimals: 2,
      rawTlv,
    }),
    getTokenLargestAccounts: rows(["10"], 2),
  });
  const overrun = Buffer.alloc(14);
  overrun.writeUInt16LE(14, 0);
  overrun.writeUInt16LE(64, 2);
  const sameFee = {
    epoch: 0n,
    maximumFee: 0n,
    transferFeeBasisPoints: 0,
  };

  type Variant = {
    label: string;
    handlers?: Handlers;
    settings?: Record<string, string>;
    parameters?: Record<string, unknown>;
    closeFirst?: boolean;
    shows: string;
  };
  const variants: Variant[] = [
    {
      label: "the full Token-2022 report",
      handlers: fullHandlers(),
      shows: "active fee at epoch 812: older tier at 250 bps",
    },
    {
      label: "holders rate-limited",
      handlers: fullHandlers({
        getTokenLargestAccounts: { httpStatus: 429, body: "rate limited" },
      }),
      shows: "holder_concentration: UNKNOWN [TOKEN_SAFETY_RPC_RATE_LIMITED]",
    },
    {
      label: "holders rate-limited with a multi-line HTML body",
      handlers: fullHandlers({
        getTokenLargestAccounts: {
          httpStatus: 429,
          body: "<html>\n<title>429</title>\n429 Too\n</html>",
        },
      }),
      shows:
        "429 Too Many Requests: <html>\\n<title>429</title>\\n429 Too\\n</html>",
    },
    {
      label: "an SPL Token mint",
      handlers: {
        getAccountInfo: mintRead(TOKEN_PROGRAM_ID, {
          supply: 5000n,
          decimals: 3,
          freezeAuthority: key(2),
        }),
        getTokenLargestAccounts: rows(["4000", "1000"], 3),
      },
      shows: "extensions: none (SPL Token program)",
    },
    {
      label: "zero supply",
      handlers: {
        getAccountInfo: mintRead(TOKEN_PROGRAM_ID, { supply: 0n, decimals: 2 }),
        getTokenLargestAccounts: rows(["0"], 2),
      },
      shows: "share of supply UNKNOWN [TOKEN_SAFETY_ZERO_SUPPLY] (supply is 0)",
    },
    {
      label: "identical fee tiers",
      handlers: {
        getAccountInfo: token2022([
          ext.transferFeeConfig({
            transferFeeConfigAuthority: PublicKey.default,
            withdrawWithheldAuthority: PublicKey.default,
            withheldAmount: 0n,
            olderTransferFee: sameFee,
            newerTransferFee: { ...sameFee, epoch: 9n },
          }),
        ]),
        getTokenLargestAccounts: rows(["10"], 2),
      },
      shows: "both tiers are identical",
    },
    {
      label: "an unknown active fee",
      handlers: fullHandlers({
        getEpochInfo: { error: { code: -32005, message: "Node is behind" } },
      }),
      shows: "active fee UNKNOWN [TOKEN_SAFETY_RPC_REJECTED]",
    },
    {
      label: "an extension length mismatch",
      handlers: {
        getAccountInfo: token2022([ext.opaque(14, 10)]),
        getTokenLargestAccounts: rows(["10"], 2),
      },
      shows: "UNKNOWN [TOKEN_SAFETY_EXTENSION_LENGTH_MISMATCH]",
    },
    {
      label: "an unrecognized DefaultAccountState value",
      handlers: {
        getAccountInfo: token2022([ext.defaultAccountState(7)]),
        getTokenLargestAccounts: rows(["10"], 2),
      },
      shows: "UNKNOWN [TOKEN_SAFETY_UNRECOGNIZED_ENUM_VALUE]",
    },
    {
      label: "malformed TLV: an overrunning entry length",
      handlers: malformedTlv(overrun),
      shows:
        "transfer_hook: UNKNOWN [TOKEN_SAFETY_EXTENSION_DATA_MALFORMED] — the entry header at TLV offset 0 declares a value length of 64 while only 10 bytes follow the header; whether TransferHook is present is unverified. Unverified, not passed.",
    },
    {
      label: "malformed TLV: a type header with no length field",
      handlers: malformedTlv(
        Buffer.concat([
          encodeTlv([ext.nonTransferable()]),
          Buffer.from([5, 0, 1]),
        ]),
      ),
      shows:
        "extensions: UNKNOWN [TOKEN_SAFETY_EXTENSION_DATA_MALFORMED] — the type header at TLV offset 4 has no length field; the extension list is unverified.",
    },
    {
      label: "malformed TLV: a duplicate extension type",
      handlers: malformedTlv(
        encodeTlv([ext.nonTransferable(), ext.nonTransferable()]),
      ),
      shows:
        "other_extensions: UNKNOWN [TOKEN_SAFETY_EXTENSION_DATA_MALFORMED] — duplicate extension type 9 at TLV offset 4; which other extensions are present is unverified.",
    },
    {
      label: "inconsistent holder rows",
      handlers: {
        getAccountInfo: token2022([]),
        getTokenLargestAccounts: rows(["10"], 3),
      },
      shows: "UNKNOWN [TOKEN_SAFETY_HOLDER_ROWS_INCONSISTENT]",
    },
    {
      label: "a holder above supply at the same slot",
      handlers: {
        getAccountInfo: token2022([]),
        getTokenLargestAccounts: rows(["1001"], 2, MINT_SLOT),
      },
      shows: "the RPC response is inconsistent",
    },
    {
      label: "a holder above supply between the two reads",
      handlers: {
        getAccountInfo: token2022([]),
        getTokenLargestAccounts: rows(["1001"], 2),
      },
      shows: "supply changed between the two reads",
    },
    {
      label: "holder rows summing above supply",
      handlers: {
        getAccountInfo: token2022([]),
        getTokenLargestAccounts: rows(["600", "500"], 2),
      },
      shows:
        "the 2 returned token accounts together show 1100 raw at slot 312345679",
    },
    {
      label: "invalid input: missing_address",
      parameters: {},
      shows: "kind: missing_address",
    },
    {
      label: "invalid input: ambiguous_address",
      parameters: { address: MINT, mint: key(201).toBase58() },
      shows: "kind: ambiguous_address",
    },
    {
      label: "invalid input: unsupported_chain",
      parameters: { address: MINT, chain: "base" },
      shows: "kind: unsupported_chain",
    },
    {
      label: "invalid input: malformed_address (symbol)",
      parameters: { address: "BONK" },
      shows: "kind: malformed_address",
    },
    {
      label: "invalid input: malformed_address (EVM)",
      parameters: { address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" },
      shows: "kind: malformed_address",
    },
    {
      label: "invalid input: account_not_found",
      handlers: {
        getAccountInfo: { result: { context: { slot: 77 }, value: null } },
      },
      shows: "kind: account_not_found",
    },
    {
      label: "invalid input: not_token_program_account",
      handlers: {
        getAccountInfo: mintRead(SystemProgram.programId, { supply: 1n }),
      },
      shows: "kind: not_token_program_account",
    },
    {
      label: "invalid input: token_account_not_mint",
      handlers: {
        getAccountInfo: rawRead(TOKEN_PROGRAM_ID, Buffer.alloc(165)),
      },
      shows: "kind: token_account_not_mint",
    },
    {
      label: "invalid input: multisig_account",
      handlers: {
        getAccountInfo: rawRead(TOKEN_2022_PROGRAM_ID, Buffer.alloc(355)),
      },
      shows: "kind: multisig_account",
    },
    {
      label: "invalid input: uninitialized_mint",
      handlers: { getAccountInfo: rawRead(TOKEN_PROGRAM_ID, Buffer.alloc(82)) },
      shows: "kind: uninitialized_mint",
    },
    {
      label: "invalid input: malformed_mint_data (option tags)",
      handlers: {
        getAccountInfo: mintRead(TOKEN_PROGRAM_ID, {
          supply: 1n,
          optionTagOverride: { mint: 2 },
        }),
      },
      shows: "kind: malformed_mint_data",
    },
    {
      label: "invalid input: malformed_mint_data (account type byte)",
      handlers: {
        getAccountInfo: rawRead(
          TOKEN_2022_PROGRAM_ID,
          (() => {
            const b = Buffer.alloc(200);
            b[165] = 7;
            return b;
          })(),
        ),
      },
      shows: "kind: malformed_mint_data",
    },
    {
      label: "rpc_failure: SOLANA_RPC_URL unset",
      settings: {},
      shows: "code: TOKEN_SAFETY_RPC_NOT_CONFIGURED",
    },
    {
      label: "rpc_failure: SOLANA_RPC_URL invalid",
      settings: { SOLANA_RPC_URL: "not a url" },
      shows: "code: TOKEN_SAFETY_RPC_URL_INVALID",
    },
    {
      label: "rpc_failure: mint read rate-limited",
      handlers: { getAccountInfo: { httpStatus: 429, body: "busy" } },
      shows: "code: TOKEN_SAFETY_RPC_RATE_LIMITED",
    },
    {
      label: "rpc_failure: mint read HTTP 503 with a multi-line body",
      handlers: {
        getAccountInfo: {
          httpStatus: 503,
          body: "<html>\n<title>503</title>\n503 Down\n</html>",
        },
      },
      shows: "code: TOKEN_SAFETY_RPC_HTTP_ERROR",
    },
    {
      label: "rpc_failure: mint read JSON-RPC error",
      handlers: {
        getAccountInfo: { error: { code: -32005, message: "Node is behind" } },
      },
      shows: "code: TOKEN_SAFETY_RPC_REJECTED",
    },
    {
      label: "rpc_failure: server closed",
      handlers: fullHandlers(),
      closeFirst: true,
      shows: "code: TOKEN_SAFETY_RPC_TRANSPORT_FAILED",
    },
    {
      label: "rpc_failure: unclassified sub-read failure",
      handlers: fullHandlers({
        getTokenLargestAccounts: {
          result: largestAccountsResult(
            [{ address: "!!", amount: "1", decimals: 6 }],
            MINT_SLOT + 1,
          ),
        },
      }),
      shows: "code: TOKEN_SAFETY_RPC_FAILED",
    },
  ];

  it.each(variants)("allows the rendered text for $label", async (variant) => {
    const server = await fixture(variant.handlers ?? {});
    const settings = variant.settings ?? { SOLANA_RPC_URL: server.url };
    if (variant.closeFirst) await server.close();
    const result = await walletRouterAction.handler(
      asRuntime(plainRuntime(settings)),
      message(),
      undefined,
      {
        parameters: {
          action: "onchain_token_safety",
          ...(variant.parameters ?? { address: MINT }),
        },
      },
    );
    if (!result?.text) throw new Error("no text");
    expect(result.text).toContain(variant.shows);
    expect(
      evaluatePlannedReplyEgress({
        reply: result.text,
        request: "check whether this token mint is safe",
        actionResults: [result],
        actions: [],
      }),
    ).toEqual({ verdict: "allow" });
  });

  it.each([
    {
      label: "the pre-fix malformed-TLV wording",
      reply:
        "transfer_hook: UNKNOWN [TOKEN_SAFETY_EXTENSION_DATA_MALFORMED] — entry at TLV offset 140 declares 64 bytes but 10 remain; whether TransferHook is present is unverified. Unverified, not passed.",
    },
    {
      label: "an unescaped multi-line provider body",
      reply:
        "holder_concentration: UNKNOWN [TOKEN_SAFETY_RPC_RATE_LIMITED] — Solana RPC getTokenLargestAccounts failed: 429 Too Many Requests: <html>\n<title>429</title>\n429 Too\n</html>. Unverified, not passed.",
    },
  ])("is not vacuous: $label is rejected as a holding claim", ({ reply }) => {
    expect(
      evaluatePlannedReplyEgress({
        reply,
        request: "check whether this token mint is safe",
        actionResults: [],
        actions: [],
      }),
    ).toEqual({ verdict: "reject", kind: "financial_holding" });
  });
});
