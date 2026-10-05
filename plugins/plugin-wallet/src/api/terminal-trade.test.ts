/**
 * Contract tests for the crypto terminal's real-trade routes through the real
 * `handleWalletRoutes`, Jupiter swap builder, and `LocalEoaBackend` signer.
 * Jupiter and Solana RPC are deterministic in-memory doubles at the network
 * boundary (see `__tests__/terminal-trade-harness.ts`). Covers the permission
 * gate, agent refusal, review details, executing exactly the reviewed bytes
 * with a verifiable signature, single use, expiry, failed simulations, the buy
 * limit, wallet and fee-payer mismatches, input validation, send outcomes,
 * and the Jito route (tip in the swap request, bundle-only send, settings).
 */
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOL_MINT } from "../chains/registry";
import {
  createTerminalTradeHarness,
  HARNESS_PRIORITY_FEE_LAMPORTS,
  type TerminalTradeHarness,
} from "./__tests__/terminal-trade-harness";
import {
  __resetTerminalTradesForTests,
  TERMINAL_TRADE_REVIEW_TTL_MS,
} from "./terminal-trade";

const STATUS = "/api/wallet/terminal/trade/status";
const REVIEW = "/api/wallet/terminal/trade/review";
const EXECUTE = "/api/wallet/terminal/trade/execute";
const START = Date.parse("2026-10-03T21:00:00.000Z");

function buy(h: TerminalTradeHarness, amount = "0.5") {
  return {
    side: "buy",
    mint: h.tokenMint,
    amount,
    slippageBps: 100,
    sendRoute: "rpc",
  };
}

async function reviewId(h: TerminalTradeHarness): Promise<string> {
  const review = await h.request("POST", REVIEW, buy(h));
  expect(review.status).toBe(200);
  return review.body.reviewId as string;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  __resetTerminalTradesForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal trade status", () => {
  it("reports the permission mode, signing wallet, and limits", async () => {
    const h = await createTerminalTradeHarness({ mode: "user-sign-only" });
    const status = await h.request("GET", STATUS);
    expect(status).toEqual({
      status: 200,
      body: {
        tradePermissionMode: "user-sign-only",
        realTradingEnabled: false,
        wallet: { canSign: true, address: h.wallet.publicKey.toBase58() },
        maxBuySol: 1,
        slippageChoicesBps: [50, 100, 300],
        reviewSeconds: 60,
        jito: {
          tipLamports: 100_000,
          blockEngineUrl: "https://mainnet.block-engine.jito.wtf",
        },
      },
    });
  });

  it("explains when the wallet can't sign Solana and refuses to review", async () => {
    const h = await createTerminalTradeHarness({ solanaSigner: false });
    const status = await h.request("GET", STATUS);
    expect(status.body.realTradingEnabled).toBe(true);
    expect(status.body.wallet).toEqual({
      canSign: false,
      address: null,
      reason: "This wallet can't sign Solana transactions here.",
    });
    const review = await h.request("POST", REVIEW, buy(h));
    expect(review.status).toBe(503);
    expect(h.jupiterCalls).toEqual([]);
  });

  it("reports a malformed buy limit instead of guessing one", async () => {
    const h = await createTerminalTradeHarness({
      settings: { WALLET_TERMINAL_MAX_BUY_SOL: "lots" },
    });
    expect(await h.request("GET", STATUS)).toEqual({
      status: 500,
      body: {
        error: "WALLET_TERMINAL_MAX_BUY_SOL must be a positive number of SOL.",
      },
    });
  });
});

describe("terminal trade permission gate", () => {
  it("refuses review and execute while trading is user-sign-only", async () => {
    const h = await createTerminalTradeHarness({ mode: "user-sign-only" });
    const review = await h.request("POST", REVIEW, buy(h));
    expect(review).toEqual({
      status: 403,
      body: {
        error:
          "Real trading is off. Turn it on in the terminal's Real trade tab first.",
      },
    });
    expect(h.jupiterCalls).toEqual([]);

    h.config.features.tradePermissionMode = "manual-local-key";
    const id = await reviewId(h);
    h.config.features.tradePermissionMode = "user-sign-only";
    const execute = await h.request("POST", EXECUTE, {
      reviewId: id,
      confirm: true,
    });
    expect(execute.status).toBe(403);
    expect(h.sent).toEqual([]);
  });

  it("refuses requests marked as agent automation, even in agent-auto", async () => {
    const h = await createTerminalTradeHarness({ mode: "agent-auto" });
    const agent = { "x-eliza-agent-action": "1" };
    const review = await h.request("POST", REVIEW, buy(h), agent);
    expect(review.status).toBe(403);
    expect(review.body.error).toMatch(/person's tap/);

    const id = await reviewId(h);
    const execute = await h.request(
      "POST",
      EXECUTE,
      { reviewId: id, confirm: true },
      agent,
    );
    expect(execute.status).toBe(403);
    expect(h.sent).toEqual([]);
  });
});

describe("terminal trade review and execute", () => {
  it("shows the trade's details and sends exactly the reviewed transaction once", async () => {
    const h = await createTerminalTradeHarness();
    const review = await h.request("POST", REVIEW, buy(h));
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      expiresAt: new Date(START + TERMINAL_TRADE_REVIEW_TTL_MS).toISOString(),
      chain: "solana",
      side: "buy",
      walletAddress: h.wallet.publicKey.toBase58(),
      input: {
        mint: SOL_MINT,
        symbol: "SOL",
        decimals: 9,
        amount: "0.5",
        rawAmount: "500000000",
      },
      output: {
        mint: h.tokenMint,
        symbol: null,
        decimals: 6,
        amount: "5000",
        rawAmount: "5000000000",
      },
      minimumOutput: "4950",
      slippageBps: 100,
      priceImpactPct: "0.0012",
      route: [
        {
          label: "Raydium",
          inputMint: SOL_MINT,
          outputMint: h.tokenMint,
          percent: 100,
        },
      ],
      fee: {
        route: "rpc",
        baseFeeLamports: 5_000,
        priorityFeeLamports: HARNESS_PRIORITY_FEE_LAMPORTS,
        maxPriorityFeeLamports: 4_000_000,
      },
      sending: { route: "rpc" },
      simulation: {
        success: true,
        err: null,
        logs: ["Program log: Instruction: Route", "Program log: success"],
        unitsConsumed: 61_250,
      },
      canConfirm: true,
    });
    const quoteUrl = new URL(h.jupiterCalls[0] ?? "");
    expect(quoteUrl.searchParams.get("amount")).toBe("500000000");
    expect(quoteUrl.searchParams.get("slippageBps")).toBe("100");
    // Jupiter reads the fee level only when nested under prioritizationFeeLamports.
    expect(h.swapRequests[0]?.prioritizationFeeLamports).toEqual({
      priorityLevelWithMaxLamports: {
        maxLamports: 4_000_000,
        priorityLevel: "veryHigh",
      },
    });
    expect(h.simulated).toHaveLength(1);
    expect(h.sent).toEqual([]);

    const execute = await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(execute.status).toBe(200);
    expect(h.sent).toHaveLength(1);
    // No second quote: the signed bytes are the reviewed transaction's.
    expect(h.jupiterCalls).toHaveLength(2);
    const sent = VersionedTransaction.deserialize(h.sent[0] as Uint8Array);
    const reviewed = h.built[0] as VersionedTransaction;
    expect(Buffer.from(sent.message.serialize())).toEqual(
      Buffer.from(reviewed.message.serialize()),
    );
    const signature = sent.signatures[0] as Uint8Array;
    expect(
      nacl.sign.detached.verify(
        sent.message.serialize(),
        signature,
        h.wallet.publicKey.toBytes(),
      ),
    ).toBe(true);
    expect(execute.body).toEqual({
      status: "confirmed",
      signature: bs58.encode(signature),
      explorerUrl: `https://solscan.io/tx/${bs58.encode(signature)}`,
    });

    const again = await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(again).toEqual({
      status: 409,
      body: { error: "This trade was already sent." },
    });
    expect(h.sent).toHaveLength(1);
  });

  it("reviews a sell from token units to SOL", async () => {
    const h = await createTerminalTradeHarness();
    const review = await h.request("POST", REVIEW, {
      side: "sell",
      mint: h.tokenMint,
      amount: "2500.5",
      slippageBps: 50,
      sendRoute: "jito",
    });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      side: "sell",
      input: { mint: h.tokenMint, decimals: 6, amount: "2500.5" },
      output: { mint: SOL_MINT, symbol: "SOL", amount: "0.25005" },
      minimumOutput: "0.24879975",
      slippageBps: 50,
    });
  });

  it("refuses to confirm after the review window and needs a fresh review", async () => {
    const h = await createTerminalTradeHarness();
    const id = await reviewId(h);
    vi.setSystemTime(START + TERMINAL_TRADE_REVIEW_TTL_MS + 1);
    const execute = await h.request("POST", EXECUTE, {
      reviewId: id,
      confirm: true,
    });
    expect(execute).toEqual({
      status: 409,
      body: {
        error: "This quote expired. Review the trade again for a fresh one.",
      },
    });
    expect(h.sent).toEqual([]);

    vi.setSystemTime(START + 3 * TERMINAL_TRADE_REVIEW_TTL_MS);
    await reviewId(h);
    const forgotten = await h.request("POST", EXECUTE, {
      reviewId: id,
      confirm: true,
    });
    expect(forgotten.status).toBe(404);
  });

  it("keeps a failed simulation reviewable but never sends it", async () => {
    const h = await createTerminalTradeHarness();
    h.simulationErr = { InstructionError: [2, { Custom: 1 }] };
    const review = await h.request("POST", REVIEW, buy(h));
    expect(review.status).toBe(200);
    expect(review.body.canConfirm).toBe(false);
    expect(review.body.simulation).toEqual({
      success: false,
      err: '{"InstructionError":[2,{"Custom":1}]}',
      logs: ["Program log: Error: insufficient funds"],
      unitsConsumed: 61_250,
    });
    const execute = await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(execute).toEqual({
      status: 422,
      body: { error: "The simulation failed, so this trade can't be sent." },
    });
    expect(h.sent).toEqual([]);
  });

  it("caps each buy at the configured SOL limit before quoting", async () => {
    const h = await createTerminalTradeHarness();
    const over = await h.request("POST", REVIEW, buy(h, "1.000000001"));
    expect(over.status).toBe(422);
    expect(over.body.error).toMatch(/over the 1 SOL per-trade limit/);
    expect(h.jupiterCalls).toEqual([]);

    const raised = await createTerminalTradeHarness({
      settings: { WALLET_TERMINAL_MAX_BUY_SOL: "5" },
    });
    expect(
      (await raised.request("POST", REVIEW, buy(raised, "2"))).status,
    ).toBe(200);
  });

  it("refuses a swap Jupiter built for another fee payer", async () => {
    const h = await createTerminalTradeHarness();
    h.swapPayer = (await createTerminalTradeHarness()).wallet.publicKey;
    const review = await h.request("POST", REVIEW, buy(h));
    expect(review).toEqual({
      status: 422,
      body: {
        error:
          "Jupiter built this swap for a different wallet, so it was not used.",
      },
    });
    expect(h.simulated).toEqual([]);
  });

  it("rejects malformed requests without quoting or sending", async () => {
    const h = await createTerminalTradeHarness();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...buy(h), side: "short" }, /side must be/],
      [{ ...buy(h), mint: "not-a-mint" }, /isn't a Solana mint/],
      [{ ...buy(h), mint: SOL_MINT }, /not SOL itself/],
      [{ ...buy(h), amount: "0" }, /greater than zero/],
      [{ ...buy(h), amount: "-1" }, /greater than zero/],
      [{ ...buy(h), amount: "0.0000000001" }, /at most 9 decimal/],
      [{ ...buy(h), slippageBps: 2_000 }, /slippageBps must be one of/],
      [{ ...buy(h), sendRoute: "fast" }, /sendRoute must be "rpc" or "jito"/],
      [{ ...buy(h), sendRoute: undefined }, /sendRoute must be/],
    ];
    for (const [body, error] of cases) {
      const review = await h.request("POST", REVIEW, body);
      expect(review.status).toBe(400);
      expect(review.body.error).toMatch(error);
    }
    const id = await reviewId(h);
    const unconfirmed = await h.request("POST", EXECUTE, { reviewId: id });
    expect(unconfirmed.status).toBe(400);
    const unknown = await h.request("POST", EXECUTE, {
      reviewId: "nope",
      confirm: true,
    });
    expect(unknown.status).toBe(404);
    expect(h.jupiterCalls).toHaveLength(2);
    expect(h.sent).toEqual([]);
  });
});

describe("terminal trade send outcomes", () => {
  it("reports a trade that landed and reverted as failed, with its signature", async () => {
    const h = await createTerminalTradeHarness();
    h.confirmationErr = { InstructionError: [3, "Custom"] };
    const execute = await h.request("POST", EXECUTE, {
      reviewId: await reviewId(h),
      confirm: true,
    });
    expect(execute.status).toBe(200);
    expect(execute.body).toMatchObject({
      status: "failed",
      error: '{"InstructionError":[3,"Custom"]}',
    });
    expect(execute.body.signature).toEqual(expect.any(String));
  });

  it("reports a sent trade it could not confirm as unconfirmed", async () => {
    const h = await createTerminalTradeHarness();
    h.confirmThrows = new Error("block height exceeded");
    const execute = await h.request("POST", EXECUTE, {
      reviewId: await reviewId(h),
      confirm: true,
    });
    expect(execute.body).toMatchObject({
      status: "unconfirmed",
      detail: "block height exceeded",
    });
    expect(h.sent).toHaveLength(1);
  });

  it("names the signature when the RPC refuses the send", async () => {
    const h = await createTerminalTradeHarness();
    h.sendThrows = new Error("Transaction simulation failed");
    const execute = await h.request("POST", EXECUTE, {
      reviewId: await reviewId(h),
      confirm: true,
    });
    expect(execute.status).toBe(502);
    expect(execute.body.error).toMatch(
      /^Solana RPC did not accept the trade \(Transaction simulation failed\)\. If you're unsure whether it went through, look up [1-9A-HJ-NP-Za-km-z]{64,88} before trying again\.$/,
    );
  });
});

describe("terminal trade Jito route", () => {
  function jitoBuy(h: TerminalTradeHarness) {
    return { ...buy(h), sendRoute: "jito" };
  }

  it("asks Jupiter for a Jito tip and sends the reviewed bytes only to the block engine", async () => {
    const h = await createTerminalTradeHarness();
    const review = await h.request("POST", REVIEW, jitoBuy(h));
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      fee: { route: "jito", baseFeeLamports: 5_000, jitoTipLamports: 100_000 },
      sending: {
        route: "jito",
        blockEngineUrl: "https://mainnet.block-engine.jito.wtf",
      },
      canConfirm: true,
    });
    expect(h.swapRequests[0]?.prioritizationFeeLamports).toEqual({
      jitoTipLamports: 100_000,
    });
    expect(h.simulated).toHaveLength(1);
    expect(h.jitoSends).toEqual([]);

    const execute = await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(execute.status).toBe(200);
    expect(execute.body.status).toBe("confirmed");
    expect(h.sent).toEqual([]);
    expect(h.jitoSends).toHaveLength(1);
    const jito = h.jitoSends[0] as { url: string; bytes: Uint8Array };
    expect(jito.url).toBe(
      "https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true",
    );
    const sent = VersionedTransaction.deserialize(jito.bytes);
    expect(Buffer.from(sent.message.serialize())).toEqual(
      Buffer.from((h.built[0] as VersionedTransaction).message.serialize()),
    );
    const signature = sent.signatures[0] as Uint8Array;
    expect(
      nacl.sign.detached.verify(
        sent.message.serialize(),
        signature,
        h.wallet.publicKey.toBytes(),
      ),
    ).toBe(true);
    expect(execute.body.signature).toBe(bs58.encode(signature));
  });

  it("uses the configured tip and block engine", async () => {
    const h = await createTerminalTradeHarness({
      settings: {
        WALLET_TERMINAL_JITO_TIP_LAMPORTS: "250000",
        JITO_BLOCK_ENGINE_URL: "https://ny.block-engine.test/",
      },
    });
    const status = await h.request("GET", STATUS);
    expect(status.body.jito).toEqual({
      tipLamports: 250_000,
      blockEngineUrl: "https://ny.block-engine.test",
    });
    const review = await h.request("POST", REVIEW, jitoBuy(h));
    expect(h.swapRequests[0]?.prioritizationFeeLamports).toEqual({
      jitoTipLamports: 250_000,
    });
    await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(h.jitoSends.map((send) => send.url)).toEqual([
      "https://ny.block-engine.test/api/v1/transactions?bundleOnly=true",
    ]);
  });

  it("reports a tip or block engine setting it can't use instead of guessing", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ WALLET_TERMINAL_JITO_TIP_LAMPORTS: "999" }, /from 1000 to 4000000/],
      [{ WALLET_TERMINAL_JITO_TIP_LAMPORTS: "4000001" }, /from 1000/],
      [{ WALLET_TERMINAL_JITO_TIP_LAMPORTS: "0.5" }, /whole number/],
      [{ JITO_BLOCK_ENGINE_URL: "http://ny.block-engine.test" }, /https/],
      [{ JITO_BLOCK_ENGINE_URL: "block engine" }, /https/],
    ];
    for (const [settings, error] of cases) {
      const h = await createTerminalTradeHarness({ settings });
      const status = await h.request("GET", STATUS);
      expect(status.status).toBe(500);
      expect(status.body.error).toMatch(error);
      const review = await h.request("POST", REVIEW, jitoBuy(h));
      expect(review.status).toBe(500);
      expect(h.jupiterCalls).toEqual([]);
    }
  });

  it("names the signature when the block engine refuses the send", async () => {
    const h = await createTerminalTradeHarness();
    h.jitoError = "bundle tip too low";
    const review = await h.request("POST", REVIEW, jitoBuy(h));
    const execute = await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(execute.status).toBe(502);
    expect(execute.body.error).toMatch(
      /^Jito did not accept the trade \(bundle tip too low\)\. If you're unsure whether it went through, look up [1-9A-HJ-NP-Za-km-z]{64,88} before trying again\.$/,
    );
    expect(h.sent).toEqual([]);
    const again = await h.request("POST", EXECUTE, {
      reviewId: review.body.reviewId,
      confirm: true,
    });
    expect(again.status).toBe(409);
  });
});
