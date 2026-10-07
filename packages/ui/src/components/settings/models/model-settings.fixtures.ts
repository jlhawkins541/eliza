/**
 * Deterministic model-settings DTO fixtures for the Models workspace stories
 * and tests. Every fixture satisfies the shared wire schemas, so a contract
 * change that breaks them fails the schema check in the workspace test.
 */

import type {
  ModelProviderStatusDto,
  ModelSettingsStatusDto,
  ProviderModelCatalogDto,
} from "@elizaos/shared";

const UNCHECKED = {
  state: "unchecked",
  checkedAt: null,
  detail: null,
} as const;

export function providerFixtures(
  overrides: Partial<
    Record<ModelProviderStatusDto["id"], Partial<ModelProviderStatusDto>>
  > = {},
): ModelProviderStatusDto[] {
  const base: ModelProviderStatusDto[] = [
    {
      id: "openai",
      label: "OpenAI",
      pluginInstalled: true,
      credential: {
        state: "stored",
        last4: "wxyz",
        source: "account-pool",
        lastVerifiedAt: null,
        health: UNCHECKED,
      },
      endpoint: {
        url: "https://api.openai.com/v1",
        isDefault: true,
        transport: "https",
        overriddenBy: null,
      },
      supportsEndpoint: true,
      activatable: true,
      requiresModelSelection: false,
    },
    {
      id: "anthropic",
      label: "Anthropic",
      pluginInstalled: true,
      credential: { state: "missing" },
      endpoint: null,
      supportsEndpoint: false,
      activatable: true,
      requiresModelSelection: false,
    },
    {
      id: "grok",
      label: "xAI Grok",
      pluginInstalled: true,
      credential: {
        state: "stored",
        last4: "abcd",
        source: "account-pool",
        lastVerifiedAt: null,
        health: UNCHECKED,
      },
      endpoint: null,
      supportsEndpoint: false,
      activatable: true,
      requiresModelSelection: true,
    },
    {
      id: "ollama",
      label: "Ollama",
      pluginInstalled: true,
      credential: { state: "not-required" },
      endpoint: {
        url: "http://192.168.1.50:11434",
        isDefault: false,
        transport: "http-private",
        overriddenBy: null,
      },
      supportsEndpoint: true,
      activatable: true,
      requiresModelSelection: false,
    },
    {
      id: "elizacloud",
      label: "Eliza Cloud",
      pluginInstalled: true,
      credential: { state: "missing" },
      endpoint: null,
      supportsEndpoint: false,
      activatable: true,
      requiresModelSelection: false,
    },
    {
      id: "local",
      label: "On-device",
      pluginInstalled: true,
      credential: { state: "not-required" },
      endpoint: null,
      supportsEndpoint: false,
      activatable: false,
      requiresModelSelection: false,
    },
  ];
  return base.map((provider) => ({
    ...provider,
    ...(overrides[provider.id] ?? {}),
  }));
}

export function statusFixture(
  overrides: Partial<ModelSettingsStatusDto> = {},
): ModelSettingsStatusDto {
  return {
    active: {
      provider: "openai",
      providerLabel: "OpenAI",
      runtimeProviderName: "openai",
      smallModel: "gpt-5.6-luna",
      largeModel: "gpt-5.6-sol",
      smallModelSource: "environment",
      largeModelSource: "environment",
      endpoint: {
        url: "https://api.openai.com/v1",
        isDefault: true,
        transport: "https",
        overriddenBy: null,
      },
      health: UNCHECKED,
    },
    providers: providerFixtures(),
    operation: null,
    managedByCloud: false,
    ...overrides,
  };
}

/** No provider configured yet: the designed-empty state. */
export function unconfiguredStatusFixture(): ModelSettingsStatusDto {
  return statusFixture({
    active: {
      provider: "other",
      providerLabel: null,
      runtimeProviderName: null,
      smallModel: null,
      largeModel: null,
      smallModelSource: "unknown",
      largeModelSource: "unknown",
      endpoint: null,
      health: UNCHECKED,
    },
  });
}

export const OPENAI_CATALOG_FIXTURE: ProviderModelCatalogDto = {
  provider: "openai",
  state: "ok",
  models: [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
  fetchedAt: "2026-10-06T00:00:00.000Z",
};

export const GROK_CATALOG_FIXTURE: ProviderModelCatalogDto = {
  provider: "grok",
  state: "ok",
  models: [
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
  ],
  fetchedAt: "2026-10-06T00:00:00.000Z",
};

export const OLLAMA_UNREACHABLE_FIXTURE: ProviderModelCatalogDto = {
  provider: "ollama",
  state: "unreachable",
  detail: "connect ECONNREFUSED 192.168.1.50:11434",
  fetchedAt: "2026-10-06T00:00:00.000Z",
};
