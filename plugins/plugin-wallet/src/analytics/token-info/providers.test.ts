/**
 * Deterministic unit tests for how the Birdeye `token_info` provider maps the
 * planner's `kind` and `chain` params onto a Birdeye search request. Guards the
 * regression where a Solana mint was forced into symbol mode and skipped the
 * security lookup. Uses a stub Birdeye client; no live API calls.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BirdeyeProvider } from "../birdeye/birdeye";
import { searchBirdeyeTokens } from "../birdeye/search-category";
import { birdeyeChainFilter, birdeyeSearchMode } from "./providers";

type BirdeyeTokenSearchProvider = Pick<
  BirdeyeProvider,
  | "fetchSearchTokenMarketData"
  | "fetchTokenOverview"
  | "fetchTokenMarketData"
  | "fetchTokenSecurityByAddress"
  | "fetchTokenTradeDataSingle"
>;

function stubProvider() {
  return {
    fetchSearchTokenMarketData: vi.fn(async () => ({ data: { items: [] } })),
    fetchTokenOverview: vi.fn(async () => ({ data: {} })),
    fetchTokenMarketData: vi.fn(async () => ({ data: {} })),
    fetchTokenSecurityByAddress: vi.fn(async () => ({
      success: true,
      data: {},
    })),
    fetchTokenTradeDataSingle: vi.fn(async () => ({ data: {} })),
  };
}

describe("Birdeye token_info request mapping", () => {
  it("routes an un-hinted Solana mint to the address lookup with security", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const provider = stubProvider();

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      { query: mint, mode: birdeyeSearchMode(undefined) },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(result.mode).toBe("address");
    expect(provider.fetchSearchTokenMarketData).not.toHaveBeenCalled();
    expect(provider.fetchTokenSecurityByAddress).toHaveBeenCalledWith(
      { address: mint },
      { headers: { "x-chain": "solana" } },
    );
  });

  it("keeps an un-hinted ticker in symbol mode", async () => {
    const provider = stubProvider();

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      { query: "$BONK", mode: birdeyeSearchMode(undefined) },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(result.mode).toBe("symbol");
    expect(provider.fetchTokenSecurityByAddress).not.toHaveBeenCalled();
  });

  it("honors explicit kind hints", () => {
    expect(birdeyeSearchMode("token-address")).toBe("address");
    expect(birdeyeSearchMode("token-symbol")).toBe("symbol");
    expect(birdeyeSearchMode("wallet-address")).toBe("auto");
  });

  it("sends an explicit EVM chain to the address lookup", async () => {
    const address = "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9";
    const provider = stubProvider();
    const chain = birdeyeChainFilter("Base");

    await searchBirdeyeTokens(
      {} as IAgentRuntime,
      { query: address, filters: chain ? { chain } : undefined },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(provider.fetchTokenSecurityByAddress).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
  });

  it("resolves chain aliases and ignores values that name no chain", () => {
    expect(birdeyeChainFilter("sol")).toBe("solana");
    expect(birdeyeChainFilter(" Ethereum ")).toBe("ethereum");
    expect(birdeyeChainFilter("matic")).toBe("polygon");
    expect(birdeyeChainFilter("birdeye")).toBeUndefined();
    expect(birdeyeChainFilter("evm")).toBeUndefined();
    expect(birdeyeChainFilter("")).toBeUndefined();
    expect(birdeyeChainFilter(undefined)).toBeUndefined();
  });
});
