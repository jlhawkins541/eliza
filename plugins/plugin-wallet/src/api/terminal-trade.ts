/**
 * Real Solana swaps placed from the crypto terminal, in two requests. Review
 * builds the exact Jupiter swap transaction for the signing wallet, simulates
 * it, and holds the unsigned bytes for {@link TERMINAL_TRADE_REVIEW_TTL_MS};
 * execute signs those same bytes through the `WalletBackend` Solana signer and
 * submits them. Nothing is re-quoted in between, so the transaction a person
 * reviewed is the one that is sent.
 *
 * A trade is signed by one of two wallets, chosen per review. The agent
 * wallet signs on the server and needs a trade permission mode that lets a
 * person use the local wallet. A browser wallet such as Phantom signs in the
 * person's browser: review returns the unsigned bytes, the wallet's own popup
 * signs them, and execute accepts the result only when its message is
 * byte-for-byte the reviewed one and the signature verifies for the reviewed
 * address. Both steps refuse requests marked as agent automation, so a
 * terminal trade always rests on a person's tap. A review is single-use, expires with its quote, and cannot be
 * executed when its simulation failed. Each buy is capped by
 * `WALLET_TERMINAL_MAX_BUY_SOL`.
 *
 * A trade goes out one of two ways, chosen per review: through the Solana RPC
 * with a capped priority fee, or with a Jito tip
 * (`WALLET_TERMINAL_JITO_TIP_LAMPORTS`) straight to a Jito block engine
 * (`JITO_BLOCK_ENGINE_URL`, then the `JITO_BLOCK_ENGINE_BACKUP_URLS` regions
 * when it is down) as a bundle-only send, which keeps it out of the public
 * mempool. Either way the RPC confirms the result. Failures are `ElizaError`s whose codes map to
 * HTTP statuses through {@link TERMINAL_TRADE_ERROR_STATUS}.
 */
import crypto from "node:crypto";
import { ElizaError, type IAgentRuntime, isElizaError } from "@elizaos/core";
import type { TradePermissionMode } from "@elizaos/shared";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  fetchJupiterSwapTransaction,
  getSolanaConnection,
  getSolanaTokenDecimals,
  JUPITER_MAX_PRIORITY_FEE_LAMPORTS,
  type JupiterSwapBuild,
  SOL_MINT,
  simulateVersionedTransaction,
} from "../chains/registry.js";
import type {
  WalletTerminalTradeAmount,
  WalletTerminalTradeExecuteResponse,
  WalletTerminalTradeReview,
  WalletTerminalTradeSendRoute,
  WalletTerminalTradeSide,
  WalletTerminalTradeSigner,
  WalletTerminalTradeStatusResponse,
  WalletTerminalTradeWallet,
} from "../contracts.js";
import { canUseLocalTradeExecution } from "../lib/server-wallet-trade.js";
import {
  WALLET_BACKEND_SERVICE_TYPE,
  type WalletBackendService,
} from "../services/wallet-backend-service.js";
import type { SolanaSigner } from "../wallet/backend.js";

export const TERMINAL_TRADE_REVIEW_TTL_MS = 60_000;
export const TERMINAL_TRADE_SLIPPAGE_BPS = [50, 100, 300] as const;
export const TERMINAL_MAX_BUY_SOL_SETTING = "WALLET_TERMINAL_MAX_BUY_SOL";
export const DEFAULT_TERMINAL_MAX_BUY_SOL = 1;
export const TERMINAL_JITO_TIP_SETTING = "WALLET_TERMINAL_JITO_TIP_LAMPORTS";
export const DEFAULT_TERMINAL_JITO_TIP_LAMPORTS = 100_000;
/** Jito's minimum bundle tip. */
export const MIN_TERMINAL_JITO_TIP_LAMPORTS = 1_000;
export const JITO_BLOCK_ENGINE_URL_SETTING = "JITO_BLOCK_ENGINE_URL";
export const DEFAULT_JITO_BLOCK_ENGINE_URL =
  "https://mainnet.block-engine.jito.wtf";
export const JITO_BLOCK_ENGINE_BACKUP_URLS_SETTING =
  "JITO_BLOCK_ENGINE_BACKUP_URLS";
/** Jito's regional mainnet block engines, tried in order when the first is down. */
export const DEFAULT_JITO_BLOCK_ENGINE_BACKUP_URLS: readonly string[] = [
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://amsterdam.mainnet.block-engine.jito.wtf",
  "https://frankfurt.mainnet.block-engine.jito.wtf",
  "https://tokyo.mainnet.block-engine.jito.wtf",
];
const SEND_ROUTES: readonly WalletTerminalTradeSendRoute[] = ["rpc", "jito"];
const SOL_DECIMALS = 9;
const SOLANA_BASE_FEE_LAMPORTS = 5_000;
const AMOUNT_PATTERN = /^\d{1,20}(?:\.\d{1,18})?$/;

export const TERMINAL_TRADE_ERROR_STATUS = {
  TERMINAL_TRADE_INVALID_REQUEST: 400,
  TERMINAL_TRADE_NOT_PERMITTED: 403,
  TERMINAL_TRADE_REVIEW_NOT_FOUND: 404,
  TERMINAL_TRADE_REVIEW_CLOSED: 409,
  TERMINAL_TRADE_REFUSED: 422,
  TERMINAL_TRADE_LIMIT_INVALID: 500,
  TERMINAL_TRADE_UPSTREAM_FAILED: 502,
  TERMINAL_TRADE_WALLET_UNAVAILABLE: 503,
  TERMINAL_TRADE_AGENT_UNAVAILABLE: 503,
} as const;

export type TerminalTradeErrorCode = keyof typeof TERMINAL_TRADE_ERROR_STATUS;

/** Who is asking: the configured permission mode and whether an agent sent it. */
export interface TerminalTradeAccess {
  mode: TradePermissionMode;
  fromAgent: boolean;
}

interface PendingTerminalTrade {
  readonly expiresAt: number;
  readonly walletAddress: string;
  readonly unsignedTransaction: Uint8Array;
  readonly lastValidBlockHeight: number | null;
  readonly canConfirm: boolean;
  readonly side: WalletTerminalTradeSide;
  readonly mint: string;
  readonly sending: WalletTerminalTradeReview["sending"];
  readonly signer: WalletTerminalTradeSigner["kind"];
  used: boolean;
}

const pendingTrades = new Map<string, PendingTerminalTrade>();

/** Forget every pending review. Test-only. */
export function __resetTerminalTradesForTests(): void {
  pendingTrades.clear();
}

function tradeError(
  code: TerminalTradeErrorCode,
  message: string,
  extra: { context?: Record<string, unknown>; cause?: unknown } = {},
): ElizaError {
  return new ElizaError(message, {
    code,
    context: extra.context,
    cause: extra.cause,
    severity: code === "TERMINAL_TRADE_UPSTREAM_FAILED" ? "ephemeral" : "fatal",
  });
}

export function isTerminalTradeError(
  error: unknown,
): error is ElizaError & { code: TerminalTradeErrorCode } {
  return (
    isElizaError(error) &&
    Object.hasOwn(TERMINAL_TRADE_ERROR_STATUS, error.code)
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRuntime(runtime: IAgentRuntime | null): IAgentRuntime {
  if (!runtime) {
    throw tradeError(
      "TERMINAL_TRADE_AGENT_UNAVAILABLE",
      "The agent isn't running yet, so the terminal can't reach your wallet.",
    );
  }
  return runtime;
}

function browserWalletAllowed(mode: TradePermissionMode): boolean {
  return mode !== "disabled";
}

function assertPermitted(
  access: TerminalTradeAccess,
  signer: WalletTerminalTradeSigner["kind"],
): void {
  if (access.fromAgent) {
    throw tradeError(
      "TERMINAL_TRADE_NOT_PERMITTED",
      "Terminal trades need a person's tap; agent requests are refused.",
    );
  }
  if (signer === "browser-wallet") {
    if (!browserWalletAllowed(access.mode)) {
      throw tradeError(
        "TERMINAL_TRADE_NOT_PERMITTED",
        "Trading is disabled for this agent, including browser wallet trades.",
        { context: { mode: access.mode } },
      );
    }
    return;
  }
  if (!canUseLocalTradeExecution(access.mode, false)) {
    throw tradeError(
      "TERMINAL_TRADE_NOT_PERMITTED",
      "Real trading is off. Turn it on in the terminal's Real trade tab first.",
      { context: { mode: access.mode } },
    );
  }
}

function walletService(runtime: IAgentRuntime): WalletBackendService {
  const service = runtime.getService<WalletBackendService>(
    WALLET_BACKEND_SERVICE_TYPE,
  );
  if (!service) {
    throw tradeError(
      "TERMINAL_TRADE_WALLET_UNAVAILABLE",
      "The wallet plugin isn't running, so there is no wallet to sign with.",
    );
  }
  return service;
}

function resolveSigner(runtime: IAgentRuntime): SolanaSigner {
  const service = walletService(runtime);
  let backend: ReturnType<WalletBackendService["getWalletBackend"]>;
  try {
    backend = service.getWalletBackend();
  } catch (cause) {
    // error-policy:J2 the backend load failure becomes a typed wallet error.
    throw tradeError(
      "TERMINAL_TRADE_WALLET_UNAVAILABLE",
      `No wallet is set up for signing: ${messageOf(cause)}`,
      { cause },
    );
  }
  if (!backend.canSign("solana")) {
    throw tradeError(
      "TERMINAL_TRADE_WALLET_UNAVAILABLE",
      "This wallet can't sign Solana transactions here.",
      { context: { backend: backend.kind } },
    );
  }
  try {
    return backend.getSolanaSigner();
  } catch (cause) {
    // error-policy:J2 a backend that can't hand out its signer is unavailable.
    throw tradeError(
      "TERMINAL_TRADE_WALLET_UNAVAILABLE",
      `The wallet's Solana signer is unavailable: ${messageOf(cause)}`,
      { cause, context: { backend: backend.kind } },
    );
  }
}

function describeWallet(runtime: IAgentRuntime): WalletTerminalTradeWallet {
  try {
    return {
      canSign: true,
      address: resolveSigner(runtime).publicKey.toBase58(),
    };
  } catch (error) {
    // error-policy:J4 a wallet that can't sign is shown as its own state.
    if (
      !isTerminalTradeError(error) ||
      error.code !== "TERMINAL_TRADE_WALLET_UNAVAILABLE"
    ) {
      throw error;
    }
    const known = runtime
      .getService<WalletBackendService>(WALLET_BACKEND_SERVICE_TYPE)
      ?.getWalletBackendOrNull()
      ?.getAddresses().solana;
    return {
      canSign: false,
      address: known ? known.toBase58() : null,
      reason: error.message,
    };
  }
}

/** Parse a decimal string into base units, or null when it has too many decimals. */
function toBaseUnits(amount: string, decimals: number): bigint | null {
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

function fromBaseUnits(raw: string, decimals: number): string {
  const digits = BigInt(raw)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function resolveMaxBuySol(runtime: IAgentRuntime): number {
  const raw = runtime.getSetting(TERMINAL_MAX_BUY_SOL_SETTING);
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_TERMINAL_MAX_BUY_SOL;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw tradeError(
      "TERMINAL_TRADE_LIMIT_INVALID",
      `${TERMINAL_MAX_BUY_SOL_SETTING} must be a positive number of SOL.`,
      { context: { value: String(raw) } },
    );
  }
  return value;
}

/**
 * The Jito tip in lamports: Jito's minimum at least, and no more than the
 * priority-fee cap an RPC send may pay, so a typo can't spend a large tip.
 */
function resolveJitoTipLamports(runtime: IAgentRuntime): number {
  const raw = runtime.getSetting(TERMINAL_JITO_TIP_SETTING);
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_TERMINAL_JITO_TIP_LAMPORTS;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TERMINAL_JITO_TIP_LAMPORTS ||
    value > JUPITER_MAX_PRIORITY_FEE_LAMPORTS
  ) {
    throw tradeError(
      "TERMINAL_TRADE_LIMIT_INVALID",
      `${TERMINAL_JITO_TIP_SETTING} must be a whole number of lamports from ${MIN_TERMINAL_JITO_TIP_LAMPORTS} to ${JUPITER_MAX_PRIORITY_FEE_LAMPORTS}.`,
      { context: { value: String(raw) } },
    );
  }
  return value;
}

function parseBlockEngineUrl(raw: string, setting: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL | null;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 an unparseable address is reported below, not replaced.
    url = null;
  }
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw tradeError(
      "TERMINAL_TRADE_LIMIT_INVALID",
      `${setting} must be an https block engine address, such as ${DEFAULT_JITO_BLOCK_ENGINE_URL}.`,
      { context: { value: raw } },
    );
  }
  return value;
}

function resolveJitoBlockEngineUrl(
  runtime: Pick<IAgentRuntime, "getSetting">,
): string {
  const raw = runtime.getSetting(JITO_BLOCK_ENGINE_URL_SETTING);
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_JITO_BLOCK_ENGINE_URL;
  }
  return parseBlockEngineUrl(String(raw), JITO_BLOCK_ENGINE_URL_SETTING);
}

/**
 * Block engines to try, in order, when the first one is unreachable or busy.
 * Unset means Jito's regional engines; `none` turns backups off; otherwise a
 * comma-separated list of https addresses. The first engine is never repeated.
 */
function resolveJitoBackupUrls(
  runtime: Pick<IAgentRuntime, "getSetting">,
  primary: string,
): string[] {
  const raw = runtime.getSetting(JITO_BLOCK_ENGINE_BACKUP_URLS_SETTING);
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text.toLowerCase() === "none") return [];
  const urls =
    text === ""
      ? [...DEFAULT_JITO_BLOCK_ENGINE_BACKUP_URLS]
      : text
          .split(",")
          .map((entry) =>
            parseBlockEngineUrl(entry, JITO_BLOCK_ENGINE_BACKUP_URLS_SETTING),
          );
  return [...new Set(urls)].filter((url) => url !== primary);
}

/** The reviewed block engine and its backups; throws on a setting it can't use. */
export function resolveJitoRoute(runtime: Pick<IAgentRuntime, "getSetting">): {
  blockEngineUrl: string;
  backupBlockEngineUrls: string[];
} {
  const blockEngineUrl = resolveJitoBlockEngineUrl(runtime);
  return {
    blockEngineUrl,
    backupBlockEngineUrls: resolveJitoBackupUrls(runtime, blockEngineUrl),
  };
}

/** Real-trading readiness for the terminal's Real trade tab. */
export function describeTerminalTrading(
  runtime: IAgentRuntime | null,
  mode: TradePermissionMode,
): WalletTerminalTradeStatusResponse {
  const agentRuntime = requireRuntime(runtime);
  return {
    tradePermissionMode: mode,
    realTradingEnabled: canUseLocalTradeExecution(mode, false),
    browserWalletEnabled: browserWalletAllowed(mode),
    wallet: describeWallet(agentRuntime),
    maxBuySol: resolveMaxBuySol(agentRuntime),
    slippageChoicesBps: [...TERMINAL_TRADE_SLIPPAGE_BPS],
    reviewSeconds: TERMINAL_TRADE_REVIEW_TTL_MS / 1000,
    jito: {
      tipLamports: resolveJitoTipLamports(agentRuntime),
      ...resolveJitoRoute(agentRuntime),
    },
  };
}

type ParsedReviewRequest = {
  mint: string;
  amount: string;
  slippageBps: number;
  sendRoute: WalletTerminalTradeSendRoute;
  signer: WalletTerminalTradeSigner;
} & ({ side: "buy"; lamports: bigint } | { side: "sell"; lamports: null });

function invalid(message: string): ElizaError {
  return tradeError("TERMINAL_TRADE_INVALID_REQUEST", message);
}

function parseMint(value: unknown): string {
  if (typeof value !== "string") throw invalid("Enter a token mint address.");
  const mint = value.trim();
  let key: PublicKey;
  try {
    key = new PublicKey(mint);
  } catch {
    // error-policy:J3 an undecodable mint is an invalid request.
    throw invalid("That isn't a Solana mint address.");
  }
  if (key.toBase58() !== mint) {
    throw invalid("That isn't a Solana mint address.");
  }
  if (mint === SOL_MINT) {
    throw invalid("Pick the token to trade against SOL, not SOL itself.");
  }
  return mint;
}

function parseSigner(value: unknown): WalletTerminalTradeSigner {
  if (typeof value !== "object" || value === null) {
    throw invalid(
      'signer must be { kind: "agent-wallet" } or { kind: "browser-wallet", address }.',
    );
  }
  const { kind, address } = value as { kind?: unknown; address?: unknown };
  if (kind === "agent-wallet") return { kind };
  if (kind !== "browser-wallet") {
    throw invalid('signer.kind must be "agent-wallet" or "browser-wallet".');
  }
  if (typeof address !== "string") {
    throw invalid("Connect a browser wallet before reviewing a trade.");
  }
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    // error-policy:J3 an undecodable wallet address is an invalid request.
    throw invalid("The browser wallet address isn't a Solana address.");
  }
  if (key.toBase58() !== address) {
    throw invalid("The browser wallet address isn't a Solana address.");
  }
  return { kind, address };
}

function parseReviewRequest(
  body: Record<string, unknown>,
): ParsedReviewRequest {
  const side = body.side;
  if (side !== "buy" && side !== "sell") {
    throw invalid('side must be "buy" or "sell".');
  }
  const mint = parseMint(body.mint);
  const amount = typeof body.amount === "string" ? body.amount.trim() : "";
  if (!AMOUNT_PATTERN.test(amount) || !/[1-9]/.test(amount)) {
    throw invalid("Enter an amount greater than zero.");
  }
  const slippageBps = body.slippageBps;
  if (
    typeof slippageBps !== "number" ||
    !(TERMINAL_TRADE_SLIPPAGE_BPS as readonly number[]).includes(slippageBps)
  ) {
    throw invalid(
      `slippageBps must be one of ${TERMINAL_TRADE_SLIPPAGE_BPS.join(", ")}.`,
    );
  }
  const sendRoute = body.sendRoute;
  if (
    typeof sendRoute !== "string" ||
    !(SEND_ROUTES as readonly string[]).includes(sendRoute)
  ) {
    throw invalid('sendRoute must be "rpc" or "jito".');
  }
  const route = sendRoute as WalletTerminalTradeSendRoute;
  const signer = parseSigner(body.signer);
  if (side === "sell") {
    return {
      side,
      mint,
      amount,
      slippageBps,
      sendRoute: route,
      signer,
      lamports: null,
    };
  }
  const lamports = toBaseUnits(amount, SOL_DECIMALS);
  if (lamports === null) {
    throw invalid("SOL amounts have at most 9 decimal places.");
  }
  return {
    side,
    mint,
    amount,
    slippageBps,
    sendRoute: route,
    signer,
    lamports,
  };
}

function assertWithinBuyLimit(
  request: ParsedReviewRequest,
  maxBuySol: number,
  rawLamports: bigint,
): void {
  const limit = BigInt(Math.round(maxBuySol * 10 ** SOL_DECIMALS));
  if (request.side === "buy" && rawLamports > limit) {
    throw tradeError(
      "TERMINAL_TRADE_REFUSED",
      `This buy is over the ${maxBuySol} SOL per-trade limit. Raise ${TERMINAL_MAX_BUY_SOL_SETTING} to allow larger buys.`,
      { context: { maxBuySol, amount: request.amount } },
    );
  }
}

function amountOf(
  mint: string,
  decimals: number,
  rawAmount: string,
): WalletTerminalTradeAmount {
  return {
    mint,
    symbol: mint === SOL_MINT ? "SOL" : null,
    decimals,
    amount: fromBaseUnits(rawAmount, decimals),
    rawAmount,
  };
}

async function buildSwap(
  runtime: IAgentRuntime,
  request: ParsedReviewRequest,
  walletPublicKey: PublicKey,
  jitoTipLamports: number | null,
): Promise<{ build: JupiterSwapBuild; outputDecimals: number }> {
  const connection = getSolanaConnection(runtime);
  try {
    const build = await fetchJupiterSwapTransaction(
      {
        subaction: "swap",
        chain: "solana",
        fromToken: request.side === "buy" ? SOL_MINT : request.mint,
        toToken: request.side === "buy" ? request.mint : SOL_MINT,
        amount: request.amount,
        slippageBps: request.slippageBps,
        mode: "execute",
        dryRun: false,
      },
      runtime,
      connection,
      walletPublicKey,
      jitoTipLamports === null ? {} : { jitoTipLamports },
    );
    const outputDecimals =
      build.outputMint === SOL_MINT
        ? SOL_DECIMALS
        : await getSolanaTokenDecimals(connection, build.outputMint);
    return { build, outputDecimals };
  } catch (cause) {
    // error-policy:J2 quote, swap-build, and mint lookups fail as one typed error.
    throw tradeError(
      "TERMINAL_TRADE_UPSTREAM_FAILED",
      `Couldn't get a Jupiter quote for this trade: ${messageOf(cause)}`,
      { cause, context: { side: request.side, mint: request.mint } },
    );
  }
}

/**
 * Build, check, and simulate a trade, and hold its unsigned transaction for
 * {@link executeTerminalTrade}. Nothing is signed or sent here.
 */
export async function reviewTerminalTrade(
  runtime: IAgentRuntime | null,
  access: TerminalTradeAccess,
  body: Record<string, unknown>,
): Promise<WalletTerminalTradeReview> {
  if (access.fromAgent) assertPermitted(access, "agent-wallet");
  const agentRuntime = requireRuntime(runtime);
  const request = parseReviewRequest(body);
  assertPermitted(access, request.signer.kind);
  const maxBuySol = resolveMaxBuySol(agentRuntime);
  if (request.side === "buy") {
    assertWithinBuyLimit(request, maxBuySol, request.lamports);
  }
  const jito =
    request.sendRoute === "jito"
      ? {
          tipLamports: resolveJitoTipLamports(agentRuntime),
          ...resolveJitoRoute(agentRuntime),
        }
      : null;
  const signerKey =
    request.signer.kind === "browser-wallet"
      ? new PublicKey(request.signer.address)
      : resolveSigner(agentRuntime).publicKey;
  const walletAddress = signerKey.toBase58();
  const { build, outputDecimals } = await buildSwap(
    agentRuntime,
    request,
    signerKey,
    jito?.tipLamports ?? null,
  );

  const feePayer = build.transaction.message.staticAccountKeys[0];
  if (!feePayer?.equals(signerKey)) {
    throw tradeError(
      "TERMINAL_TRADE_REFUSED",
      "Jupiter built this swap for a different wallet, so it was not used.",
      { context: { feePayer: feePayer?.toBase58() ?? null, walletAddress } },
    );
  }
  if (BigInt(build.inAmountRaw) <= 0n) {
    throw invalid("That amount is smaller than the token's smallest unit.");
  }
  assertWithinBuyLimit(request, maxBuySol, BigInt(build.inAmountRaw));
  if (build.outAmountRaw === null || build.minOutAmountRaw === null) {
    throw tradeError(
      "TERMINAL_TRADE_UPSTREAM_FAILED",
      "Jupiter's quote left out the output or minimum output amount.",
      { context: { side: request.side, mint: request.mint } },
    );
  }

  let simulation: Awaited<ReturnType<typeof simulateVersionedTransaction>>;
  try {
    simulation = await simulateVersionedTransaction(
      getSolanaConnection(agentRuntime),
      build.transaction,
    );
  } catch (cause) {
    // error-policy:J2 an RPC that can't simulate leaves nothing to review.
    throw tradeError(
      "TERMINAL_TRADE_UPSTREAM_FAILED",
      `Solana RPC couldn't simulate this trade: ${messageOf(cause)}`,
      { cause },
    );
  }

  const fee: WalletTerminalTradeReview["fee"] = jito
    ? {
        route: "jito",
        baseFeeLamports: SOLANA_BASE_FEE_LAMPORTS,
        jitoTipLamports: jito.tipLamports,
      }
    : {
        route: "rpc",
        baseFeeLamports: SOLANA_BASE_FEE_LAMPORTS,
        priorityFeeLamports: build.priorityFeeLamports,
        maxPriorityFeeLamports: JUPITER_MAX_PRIORITY_FEE_LAMPORTS,
      };
  const sending: WalletTerminalTradeReview["sending"] = jito
    ? {
        route: "jito",
        blockEngineUrl: jito.blockEngineUrl,
        backupBlockEngineUrls: jito.backupBlockEngineUrls,
        detail:
          "Sent only to Jito's block engine as a bundle, not to the public mempool. It lands only with its tip.",
      }
    : {
        route: "rpc",
        detail: "Sent through your Solana RPC with a capped priority fee.",
      };

  const now = Date.now();
  prunePendingTrades(now);
  const reviewId = crypto.randomUUID();
  const expiresAt = now + TERMINAL_TRADE_REVIEW_TTL_MS;
  const unsignedTransaction = build.transaction.serialize();
  pendingTrades.set(reviewId, {
    expiresAt,
    walletAddress,
    unsignedTransaction,
    lastValidBlockHeight: build.lastValidBlockHeight,
    canConfirm: simulation.success,
    side: request.side,
    mint: request.mint,
    sending,
    signer: request.signer.kind,
    used: false,
  });

  return {
    reviewId,
    expiresAt: new Date(expiresAt).toISOString(),
    chain: "solana",
    side: request.side,
    walletAddress,
    input: amountOf(build.inputMint, build.inputDecimals, build.inAmountRaw),
    output: amountOf(build.outputMint, outputDecimals, build.outAmountRaw),
    minimumOutput: fromBaseUnits(build.minOutAmountRaw, outputDecimals),
    slippageBps: build.effectiveSlippageBps ?? request.slippageBps,
    priceImpactPct:
      typeof build.quoteSummary.priceImpactPct === "string"
        ? build.quoteSummary.priceImpactPct
        : null,
    route: build.route.map((leg) => ({ ...leg })),
    fee,
    sending: { ...sending },
    simulation: { ...simulation, logs: [...simulation.logs] },
    canConfirm: simulation.success,
    signing:
      request.signer.kind === "browser-wallet"
        ? {
            kind: "browser-wallet",
            unsignedTransaction:
              Buffer.from(unsignedTransaction).toString("base64"),
          }
        : { kind: "agent-wallet" },
  };
}

/** Drop reviews that ended more than one review window ago. */
function prunePendingTrades(now: number): void {
  for (const [id, trade] of pendingTrades) {
    if (now > trade.expiresAt + TERMINAL_TRADE_REVIEW_TTL_MS) {
      pendingTrades.delete(id);
    }
  }
}

interface JitoSendReply {
  result?: unknown;
  error?: { message?: unknown };
}

/** A block engine that never answered, or answered busy, before taking the send. */
class JitoEngineUnavailableError extends Error {}

/**
 * Hand a signed transaction to one Jito block engine with `bundleOnly=true`,
 * so Jito wraps it in a bundle and never forwards it to RPC nodes. Jito
 * always skips preflight; the review's simulation is the preflight here.
 */
async function sendToJitoEngine(
  runtime: IAgentRuntime,
  blockEngineUrl: string,
  signed: VersionedTransaction,
): Promise<void> {
  const fetchFn = runtime.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(
      `${blockEngineUrl}/api/v1/transactions?bundleOnly=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "sendTransaction",
          params: [
            Buffer.from(signed.serialize()).toString("base64"),
            { encoding: "base64" },
          ],
        }),
      },
    );
  } catch (cause) {
    // error-policy:J2 no answer at all lets the caller try the next region.
    throw new JitoEngineUnavailableError(messageOf(cause), { cause });
  }
  const text = await response.text();
  let reply: JitoSendReply;
  try {
    reply = JSON.parse(text) as JitoSendReply;
  } catch {
    // error-policy:J3 a non-JSON reply is reported with its HTTP status.
    reply = {};
  }
  if (response.ok && !reply.error && typeof reply.result === "string") return;
  const message =
    typeof reply.error?.message === "string"
      ? reply.error.message
      : `HTTP ${response.status}`;
  if (response.status === 429 || response.status >= 500) {
    throw new JitoEngineUnavailableError(message);
  }
  throw new Error(message);
}

/**
 * Send through the reviewed block engine, then each backup region in turn,
 * moving on only when an engine was unreachable or answered 429/5xx. Every
 * attempt carries the same signed bytes, so the trade has one signature and
 * can land at most once however many regions see it. A refusal (bad tip,
 * invalid transaction) stops at once, since another region would refuse too.
 */
async function sendThroughJito(
  runtime: IAgentRuntime,
  route: { blockEngineUrl: string; backupBlockEngineUrls: string[] },
  signed: VersionedTransaction,
): Promise<void> {
  const failures: string[] = [];
  for (const url of [route.blockEngineUrl, ...route.backupBlockEngineUrls]) {
    try {
      await sendToJitoEngine(runtime, url, signed);
      if (failures.length > 0) {
        runtime.logger.warn(
          { blockEngineUrl: url, failures },
          "[WalletTerminalTrade] Jito send used a backup region",
        );
      }
      return;
    } catch (error) {
      // error-policy:J2 only an unreachable or busy engine moves to the next region.
      if (!(error instanceof JitoEngineUnavailableError)) throw error;
      failures.push(`${new URL(url).host}: ${error.message}`);
    }
  }
  throw new Error(
    `every block engine was unavailable (${failures.join("; ")})`,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Accept a browser wallet's signed transaction only if it is the reviewed
 * message, unchanged, carrying a valid signature from the reviewed wallet.
 */
function acceptBrowserSignature(
  pending: PendingTerminalTrade,
  value: unknown,
): VersionedTransaction {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("signedTransaction is required for a browser wallet trade.");
  }
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(
      new Uint8Array(Buffer.from(value, "base64")),
    );
  } catch {
    // error-policy:J3 bytes that aren't a transaction are an invalid request.
    throw invalid("signedTransaction isn't a Solana transaction.");
  }
  const reviewed = VersionedTransaction.deserialize(
    pending.unsignedTransaction,
  );
  const message = signed.message.serialize();
  if (!bytesEqual(message, reviewed.message.serialize())) {
    throw tradeError(
      "TERMINAL_TRADE_REFUSED",
      "The wallet changed the transaction while signing, so it was not sent. Review the trade again.",
      { context: { walletAddress: pending.walletAddress } },
    );
  }
  const signature = signed.signatures[0];
  if (
    !signature ||
    !nacl.sign.detached.verify(
      message,
      signature,
      new PublicKey(pending.walletAddress).toBytes(),
    )
  ) {
    throw tradeError(
      "TERMINAL_TRADE_REFUSED",
      "The wallet's signature doesn't match the reviewed wallet, so the trade was not sent.",
      { context: { walletAddress: pending.walletAddress } },
    );
  }
  return signed;
}

function explorerUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

/**
 * Sign and send the exact transaction a review holds, once. Refuses an
 * unknown, used, or expired review, a failed simulation, and a wallet that
 * changed since the review. A browser wallet review takes the wallet's signed
 * transaction instead of signing here.
 */
export async function executeTerminalTrade(
  runtime: IAgentRuntime | null,
  access: TerminalTradeAccess,
  body: Record<string, unknown>,
): Promise<WalletTerminalTradeExecuteResponse> {
  if (access.fromAgent) assertPermitted(access, "agent-wallet");
  const agentRuntime = requireRuntime(runtime);
  if (typeof body.reviewId !== "string" || body.reviewId.length === 0) {
    throw invalid("reviewId is required.");
  }
  if (body.confirm !== true) {
    throw invalid("Send confirm: true to place this trade.");
  }

  const now = Date.now();
  const pending = pendingTrades.get(body.reviewId);
  if (!pending) {
    throw tradeError(
      "TERMINAL_TRADE_REVIEW_NOT_FOUND",
      "This review wasn't found. Review the trade again.",
    );
  }
  if (pending.used) {
    throw tradeError(
      "TERMINAL_TRADE_REVIEW_CLOSED",
      "This trade was already sent.",
    );
  }
  if (now > pending.expiresAt) {
    throw tradeError(
      "TERMINAL_TRADE_REVIEW_CLOSED",
      "This quote expired. Review the trade again for a fresh one.",
    );
  }
  if (!pending.canConfirm) {
    throw tradeError(
      "TERMINAL_TRADE_REFUSED",
      "The simulation failed, so this trade can't be sent.",
    );
  }
  assertPermitted(access, pending.signer);

  let signed: VersionedTransaction;
  if (pending.signer === "browser-wallet") {
    signed = acceptBrowserSignature(pending, body.signedTransaction);
    // Claimed before any await so a second tap can't send it twice.
    pending.used = true;
  } else {
    if (body.signedTransaction !== undefined) {
      throw invalid(
        "This trade is signed by the agent wallet; don't send a signed transaction.",
      );
    }
    // Claimed before any await so a second tap can't send it twice.
    pending.used = true;
    const signer = resolveSigner(agentRuntime);
    if (signer.publicKey.toBase58() !== pending.walletAddress) {
      throw tradeError(
        "TERMINAL_TRADE_REVIEW_CLOSED",
        "The wallet changed since this review. Review the trade again.",
      );
    }
    const result = await signer.signTransaction(
      VersionedTransaction.deserialize(pending.unsignedTransaction),
    );
    if (!(result instanceof VersionedTransaction)) {
      throw tradeError(
        "TERMINAL_TRADE_WALLET_UNAVAILABLE",
        "The wallet returned a different kind of transaction than it was given.",
      );
    }
    signed = result;
  }
  const signatureBytes = signed.signatures[0];
  if (!signatureBytes) {
    throw tradeError(
      "TERMINAL_TRADE_WALLET_UNAVAILABLE",
      "The wallet did not sign the trade.",
    );
  }
  const signature = bs58.encode(signatureBytes);
  const context = {
    signature,
    side: pending.side,
    mint: pending.mint,
    walletAddress: pending.walletAddress,
  };

  const connection = getSolanaConnection(agentRuntime);
  const route = pending.sending;
  try {
    if (route.route === "jito") {
      await sendThroughJito(agentRuntime, route, signed);
    } else {
      await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: "confirmed",
      });
    }
  } catch (cause) {
    // error-policy:J2 a refused send keeps the signature for the person to check.
    const sender = route.route === "jito" ? "Jito" : "Solana RPC";
    throw tradeError(
      "TERMINAL_TRADE_UPSTREAM_FAILED",
      `${sender} did not accept the trade (${messageOf(cause)}). If you're unsure whether it went through, look up ${signature} before trying again.`,
      { cause, context: { ...context, route: route.route } },
    );
  }

  try {
    const lastValidBlockHeight =
      pending.lastValidBlockHeight ??
      (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: signed.message.recentBlockhash,
        lastValidBlockHeight,
      },
      "confirmed",
    );
    const err = confirmation.value.err;
    if (err) {
      const error = typeof err === "string" ? err : JSON.stringify(err);
      agentRuntime.logger.warn(
        { ...context, error },
        "[WalletTerminalTrade] trade landed and failed",
      );
      return {
        status: "failed",
        signature,
        explorerUrl: explorerUrl(signature),
        error,
      };
    }
  } catch (cause) {
    // error-policy:J4 a sent trade whose outcome wasn't seen is its own state.
    agentRuntime.logger.warn(
      { ...context, error: messageOf(cause) },
      "[WalletTerminalTrade] trade sent but not confirmed",
    );
    return {
      status: "unconfirmed",
      signature,
      explorerUrl: explorerUrl(signature),
      detail: messageOf(cause),
    };
  }

  agentRuntime.logger.info(
    { ...context, route: route.route },
    "[WalletTerminalTrade] trade confirmed",
  );
  return {
    status: "confirmed",
    signature,
    explorerUrl: explorerUrl(signature),
  };
}
