/**
 * Unit tests for the Birdeye search-category registration and
 * `searchBirdeyeTokens` dispatch (symbol vs address mode), against a mocked
 * runtime and mocked `BirdeyeProvider` fetch methods — no live API calls.
 */
import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BirdeyeProvider } from "./birdeye";
import {
  BIRDEYE_SEARCH_CATEGORIES,
  BIRDEYE_TOKEN_SEARCH_CATEGORY,
  registerBirdeyeSearchCategories,
  searchBirdeyeTokens,
} from "./search-category";

type BirdeyeTokenSearchProvider = Pick<
  BirdeyeProvider,
  | "fetchSearchTokenMarketData"
  | "fetchTokenOverview"
  | "fetchTokenMarketData"
  | "fetchTokenSecurityByAddress"
  | "fetchTokenTradeDataSingle"
>;

function createRuntime() {
  const categories = new Map<string, SearchCategoryRegistration>();
  const registerSearchCategory = vi.fn(
    (registration: SearchCategoryRegistration) => {
      categories.set(registration.category, registration);
    },
  );
  const getSearchCategory = vi.fn((category: string) => {
    const registration = categories.get(category);
    if (!registration) throw new Error(`Missing category ${category}`);
    return registration;
  });

  return {
    categories,
    registerSearchCategory,
    runtime: {
      getSearchCategory,
      registerSearchCategory,
      logger: { warn: vi.fn() },
    } as IAgentRuntime,
  };
}

describe("Birdeye search categories", () => {
  it("registers one token intel search category", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerBirdeyeSearchCategories(runtime);
    registerBirdeyeSearchCategories(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("birdeye_tokens")).toMatchObject({
      category: "birdeye_tokens",
      serviceType: "birdeye",
      source: "plugin:wallet:birdeye",
    });
    expect(
      BIRDEYE_SEARCH_CATEGORIES.map((category) => category.category),
    ).toEqual(["birdeye_tokens"]);
    expect(
      BIRDEYE_TOKEN_SEARCH_CATEGORY.filters?.some(
        (filter) => filter.name === "query" && filter.required,
      ),
    ).toBe(false);
  });

  it("can register disabled categories when Birdeye routing is unavailable", () => {
    const { categories, runtime } = createRuntime();

    registerBirdeyeSearchCategories(runtime, {
      enabled: false,
      disabledReason: "missing key",
    });

    expect(categories.get("birdeye_tokens")).toMatchObject({
      enabled: false,
      disabledReason: "missing key",
    });
  });

  it("searches token intel by symbol", async () => {
    const provider = {
      fetchSearchTokenMarketData: vi.fn(async () => ({
        data: {
          items: [
            {
              type: "token",
              result: [
                {
                  symbol: "SOL",
                  address: "So11111111111111111111111111111111111111112",
                  network: "solana",
                  price: 172.23,
                  price_change_24h_percent: 1.5,
                  volume_24h_usd: 1000000,
                  market_cap: 75000000000,
                  fdv: 90000000000,
                },
                {
                  symbol: "SOLDOG",
                  address: "ignored",
                },
              ],
            },
          ],
        },
      })),
    };

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      {
        query: "$SOL",
        filters: { mode: "symbol", chain: "all" },
        limit: 3,
      },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(provider.fetchSearchTokenMarketData).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "SOL",
        chain: "all",
        target: "token",
        limit: 3,
      }),
    );
    expect(result).toMatchObject({
      mode: "symbol",
      resultCount: 1,
    });
    expect(result.mode).toBe("symbol");
    if (result.mode !== "symbol") {
      throw new Error("Expected symbol search result");
    }
    expect(result.results[0].tokens).toHaveLength(1);
    expect(result.text).toContain("birdeye_token_search:");
    expect(result.text).toContain("mode: symbol");
  });

  it("searches token intel by address", async () => {
    const address = "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9";
    const provider = {
      fetchTokenOverview: vi.fn(async () => ({
        data: {
          name: "Aave",
          symbol: "AAVE",
          decimals: 18,
          price: 100,
          liquidity: 2000000,
        },
      })),
      fetchTokenMarketData: vi.fn(async () => ({
        data: {
          price: 101,
          liquidity: 2100000,
          marketcap: 1500000000,
        },
      })),
      fetchTokenSecurityByAddress: vi.fn(),
      fetchTokenTradeDataSingle: vi.fn(async () => ({
        data: {
          holder: 100000,
          price_change_24h_percent: -2.25,
        },
      })),
    };

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      {
        query: `lookup ${address}`,
        filters: {
          mode: "address",
          chain: "base",
          includeSecurity: false,
        },
      },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(provider.fetchTokenOverview).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
    expect(provider.fetchTokenMarketData).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
    expect(provider.fetchTokenSecurityByAddress).not.toHaveBeenCalled();
    expect(provider.fetchTokenTradeDataSingle).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
    expect(result).toMatchObject({
      mode: "address",
      resultCount: 1,
    });
    expect(result.mode).toBe("address");
    if (result.mode !== "address") {
      throw new Error("Expected address search result");
    }
    expect(result.results[0].chain).toBe("base");
    expect(result.text).toContain("mode: address");
    expect(result.text).toContain("Aave");
    expect(result.text).toContain('"not_requested"');
  });

  const SOLANA_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  function solanaProvider(security: unknown) {
    return {
      fetchSearchTokenMarketData: vi.fn(),
      fetchTokenOverview: vi.fn(async () => ({
        data: { name: "Bonk", symbol: "Bonk", decimals: 5 },
      })),
      fetchTokenMarketData: vi.fn(async () => ({ data: {} })),
      fetchTokenSecurityByAddress: vi.fn(async () => security),
      fetchTokenTradeDataSingle: vi.fn(async () => ({ data: {} })),
    };
  }

  function securityLine(text: string): string {
    const lines = text.split("\n");
    const header = lines.findIndex((line) => line.includes("security[1]{"));
    expect(header).toBeGreaterThanOrEqual(0);
    return lines[header + 1];
  }

  it("auto-detects a Solana mint and renders its security checks", async () => {
    const provider = solanaProvider({
      success: true,
      data: {
        freezeable: true,
        freezeAuthority: "FrzAuth1111111111111111111111111111111111111",
        mutableMetadata: false,
        top10HolderPercent: 0.4521,
        creatorPercentage: 0.05,
        ownerPercentage: 0,
        isToken2022: true,
        transferFeeEnable: true,
        nonTransferable: false,
        fakeToken: null,
        jupStrictList: false,
      },
    });

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      { query: SOLANA_MINT, mode: "auto" },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(result.mode).toBe("address");
    expect(provider.fetchSearchTokenMarketData).not.toHaveBeenCalled();
    expect(provider.fetchTokenSecurityByAddress).toHaveBeenCalledWith(
      { address: SOLANA_MINT },
      { headers: { "x-chain": "solana" } },
    );
    expect(securityLine(result.text)).toBe(
      `    - ${[
        `"${SOLANA_MINT}"`,
        '"ok"',
        "true",
        '"FrzAuth1111111111111111111111111111111111111"',
        '"unknown"',
        "false",
        '"45.21%"',
        '"5.00%"',
        '"0.00%"',
        "true",
        "true",
        "false",
        '"unknown"',
        "false",
        '"unknown"',
      ].join(",")}`,
    );
    expect(result.text).toContain("securityNote:");
  });

  it("reports a revoked freeze authority as none", async () => {
    const provider = solanaProvider({
      success: true,
      data: { freezeable: false, freezeAuthority: null },
    });

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      { query: SOLANA_MINT },
      provider as BirdeyeTokenSearchProvider,
    );

    const line = securityLine(result.text);
    expect(line).toContain('"ok",false,"none"');
    expect(line).toContain('"unknown"');
  });

  it("marks an empty security response as no_data with every check unknown", async () => {
    const provider = solanaProvider({ success: false, data: {} });

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      { query: SOLANA_MINT },
      provider as BirdeyeTokenSearchProvider,
    );

    const values = securityLine(result.text)
      .replace(/^\s+- /, "")
      .split(",");
    expect(values[1]).toBe('"no_data"');
    expect(values.slice(2).every((value) => value === '"unknown"')).toBe(true);
  });

  it("propagates a security endpoint failure instead of rendering a pass", async () => {
    const provider = solanaProvider(undefined);
    provider.fetchTokenSecurityByAddress.mockRejectedValueOnce(
      new Error("Birdeye 429"),
    );

    await expect(
      searchBirdeyeTokens(
        {} as IAgentRuntime,
        { query: SOLANA_MINT },
        provider as BirdeyeTokenSearchProvider,
      ),
    ).rejects.toThrow("Birdeye 429");
  });
});
