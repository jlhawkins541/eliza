/**
 * Behavior of the Models-page use-case against the real config mutators,
 * shared DTO schemas, operation manager, classifier, and filesystem operation
 * repository. Only the external edges are injected: credential storage, the
 * plugin-presence probe, the provider catalog fetch, and the restart closure
 * behind the cold strategy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import {
  type ModelProviderId,
  ModelSettingsStatusSchema,
  ProviderModelCatalogSchema,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { resolvePreferredProviderId } from "../runtime/model-resolution.ts";
import { defaultClassifier } from "../runtime/operations/classifier.ts";
import { createColdStrategy } from "../runtime/operations/cold-strategy.ts";
import { HealthChecker } from "../runtime/operations/health.ts";
import { DefaultRuntimeOperationManager } from "../runtime/operations/manager.ts";
import { FilesystemRuntimeOperationRepository } from "../runtime/operations/repository.ts";
import { createRuntimeOperationStrategies } from "../runtime/operations/strategy-table.ts";
import type {
  RuntimeOperation,
  RuntimeOperationRepository,
} from "../runtime/operations/types.ts";
import type { ProviderCatalogProbe } from "./model-provider-helpers.ts";
import {
  type AccountPoolSelector,
  isProviderPluginInstalled,
  type ModelCatalogFetcher,
  ModelSettingsService,
  type ModelSettingsServiceDeps,
  readProviderCredential,
  type StoredProviderCredential,
  selectPooledCredential,
} from "./model-settings-service.ts";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_SMALL_MODEL",
  "ANTHROPIC_LARGE_MODEL",
  "OLLAMA_API_ENDPOINT",
  "OLLAMA_API_URL",
  "OLLAMA_BASE_URL",
  "OLLAMA_SMALL_MODEL",
  "OLLAMA_LARGE_MODEL",
  "XAI_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
] as const;

const OPENAI_KEY = "sk-fixture-openai-0000-wxyz";
const XAI_KEY = "xai-fixture-grok-1111-abcd";

let stateDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-model-settings-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function credentials(
  values: Partial<Record<ModelProviderId, string>>,
): ModelSettingsServiceDeps["readCredential"] {
  return (provider): StoredProviderCredential | null => {
    const value = values[provider];
    if (!value) return null;
    return {
      value,
      source: provider === "elizacloud" ? "cloud-account" : "account-pool",
    };
  };
}

function catalog(
  byProvider: Partial<Record<string, ProviderCatalogProbe>>,
): ModelCatalogFetcher & {
  calls: Array<{ provider: string; baseUrl: string }>;
} {
  const calls: Array<{ provider: string; baseUrl: string }> = [];
  const fetcher = (async (provider, request) => {
    calls.push({ provider, baseUrl: request.baseUrl });
    const probe = byProvider[provider];
    if (!probe) throw new Error(`unexpected catalog fetch for ${provider}`);
    return probe;
  }) as ModelCatalogFetcher & {
    calls: Array<{ provider: string; baseUrl: string }>;
  };
  fetcher.calls = calls;
  return fetcher;
}

const GROK_CATALOG: ProviderCatalogProbe = {
  state: "ok",
  models: [
    { id: "grok-4", name: "Grok 4", category: "chat" },
    { id: "grok-4-fast", name: "Grok 4 Fast", category: "chat" },
    { id: "grok-2-image", name: "Grok Image", category: "image" },
  ],
};

function buildOperations(currentConfig: () => ElizaConfig) {
  const repository = new FilesystemRuntimeOperationRepository(stateDir);
  const restartRuntime = vi.fn(
    async () => ({ agentId: "restarted" }) as AgentRuntime,
  );
  const manager = new DefaultRuntimeOperationManager({
    repository,
    runtime: () => ({ agentId: "current" }) as AgentRuntime,
    classifyContext: () => ({
      currentProvider: resolvePreferredProviderId(currentConfig()),
    }),
    classifier: defaultClassifier,
    healthChecker: new HealthChecker(),
    strategies: createRuntimeOperationStrategies({
      cold: createColdStrategy({ restartRuntime }),
      hot: { tier: "hot", apply: async (ctx) => ctx.runtime },
    }),
  });
  return { manager, repository, restartRuntime };
}

async function waitForTerminal(
  repository: RuntimeOperationRepository,
  id: string,
): Promise<RuntimeOperation> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const op = await repository.get(id);
    if (op && op.status !== "pending" && op.status !== "running") return op;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation ${id} did not finish`);
}

function directConfig(
  backend: string,
  models: { smallModel?: string; largeModel?: string } = {},
): ElizaConfig {
  return {
    serviceRouting: {
      llmText: { backend, transport: "direct", ...models },
    },
  } as ElizaConfig;
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ElizaError);
  expect((error as ElizaError).code).toBe(code);
}

describe("ModelSettingsService.getStatus", () => {
  it("returns a complete DTO that reveals only the last four key characters", async () => {
    process.env.OLLAMA_API_URL = "http://192.168.1.50:11434/api";
    const config = directConfig("openai", { largeModel: "gpt-5.6-sol" });
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({ openai: OPENAI_KEY }),
      isPluginInstalled: (name) => name !== "@elizaos/plugin-anthropic",
      isCloudProvisioned: () => false,
    });

    const status = await service.getStatus({ config, runtime: null });

    expect(ModelSettingsStatusSchema.parse(status)).toEqual(status);
    expect(JSON.stringify(status)).not.toContain(OPENAI_KEY);
    expect(status.active).toMatchObject({
      provider: "openai",
      providerLabel: "OpenAI",
      smallModel: null,
      smallModelSource: "provider-default",
      largeModel: "gpt-5.6-sol",
      largeModelSource: "user",
      health: { state: "unchecked", checkedAt: null, detail: null },
    });
    const byId = new Map(status.providers.map((entry) => [entry.id, entry]));
    expect(byId.get("openai")?.credential).toMatchObject({
      state: "stored",
      last4: "wxyz",
      source: "account-pool",
    });
    expect(byId.get("anthropic")).toMatchObject({
      pluginInstalled: false,
      credential: { state: "missing" },
    });
    expect(byId.get("grok")?.requiresModelSelection).toBe(true);
    expect(byId.get("local")?.activatable).toBe(false);
    expect(byId.get("ollama")?.endpoint).toEqual({
      url: "http://192.168.1.50:11434",
      isDefault: false,
      transport: "http-private",
      // OLLAMA_API_URL wins over the owner-editable OLLAMA_BASE_URL.
      overriddenBy: "OLLAMA_API_URL",
    });
    expect(status.operation).toBeNull();
    expect(status.managedByCloud).toBe(false);
  });

  it("reports an unconfigured route as an explicit unknown, not a default", async () => {
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({}),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => true,
    });
    const status = await service.getStatus({ config: {}, runtime: null });
    expect(status.active).toMatchObject({
      provider: "other",
      providerLabel: null,
      smallModel: null,
      largeModel: null,
      smallModelSource: "unknown",
      largeModelSource: "unknown",
    });
    expect(status.managedByCloud).toBe(true);
  });
});

describe("active model sources", () => {
  function statusFor(config: ElizaConfig) {
    return new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({}),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
    }).getStatus({ config, runtime: null });
  }

  it("attributes each tier to its own source", async () => {
    process.env.ANTHROPIC_SMALL_MODEL = "claude-haiku-4-5";
    const { active } = await statusFor(
      directConfig("anthropic", { largeModel: "claude-opus-4-8" }),
    );
    expect(active).toMatchObject({
      smallModel: "claude-haiku-4-5",
      smallModelSource: "environment",
      largeModel: "claude-opus-4-8",
      largeModelSource: "user",
    });
  });

  it("marks an Eliza Cloud tier that falls back to the default as provider-default", async () => {
    const { active } = await statusFor({
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          smallModel: "cloud-small-pick",
        },
      },
    } as ElizaConfig);
    expect(active.provider).toBe("elizacloud");
    expect(active.smallModelSource).toBe("user");
    expect(active.smallModel).toBe("cloud-small-pick");
    expect(active.largeModelSource).toBe("provider-default");
    expect(active.largeModel).not.toBeNull();
  });

  it("never attributes the shared OpenAI-compatible env to an unpicked Grok tier", async () => {
    process.env.OPENAI_SMALL_MODEL = "gpt-5.6-luna";
    const { active } = await statusFor(
      directConfig("grok", { largeModel: "grok-4" }),
    );
    expect(active).toMatchObject({
      smallModel: null,
      smallModelSource: "unknown",
      largeModel: "grok-4",
      largeModelSource: "user",
    });
  });
});

describe("provider plugin presence", () => {
  it("probes the plugin the provider catalog routes each provider through", async () => {
    const probed: string[] = [];
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({}),
      // Only the OpenAI-compatible plugin is present: Grok, which is served
      // by it, is available; Anthropic and Ollama are not.
      isPluginInstalled: (name) => {
        probed.push(name);
        return name === "@elizaos/plugin-openai";
      },
      isCloudProvisioned: () => false,
    });
    const status = await service.getStatus({ config: {}, runtime: null });
    const installed = Object.fromEntries(
      status.providers.map((entry) => [entry.id, entry.pluginInstalled]),
    );
    expect(installed).toMatchObject({
      openai: true,
      grok: true,
      anthropic: false,
      ollama: false,
    });
    expect(probed).toContain("@elizaos/plugin-local-inference");
    expect(probed).toContain("@elizaos/plugin-elizacloud");
  });

  it("counts a plugin installed into the state dir through its install record", () => {
    const pluginName = "@elizaos/plugin-model-settings-fixture";
    const installPath = path.join(stateDir, "plugins", "installed", "fixture");
    expect(isProviderPluginInstalled(pluginName, {})).toBe(false);
    const config = {
      plugins: { installs: { [pluginName]: { installPath } } },
    } as unknown as ElizaConfig;
    expect(isProviderPluginInstalled(pluginName, config)).toBe(false);
    fs.mkdirSync(installPath, { recursive: true });
    expect(isProviderPluginInstalled(pluginName, config)).toBe(true);
  });
});

describe("ModelSettingsService.listModels", () => {
  it("lists the configured LAN Ollama host and keeps only chat models", async () => {
    process.env.OLLAMA_BASE_URL = "http://192.168.1.50:11434";
    const fetcher = catalog({
      ollama: {
        state: "ok",
        models: [
          { id: "llama3.2:3b", name: "llama3.2:3b", category: "chat" },
          {
            id: "nomic-embed-text",
            name: "nomic-embed-text",
            category: "embedding",
          },
        ],
      },
    });
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({}),
      fetchCatalog: fetcher,
      now: () => new Date("2026-10-06T00:00:00.000Z"),
    });

    const result = await service.listModels("ollama", {
      config: {},
      runtime: null,
    });

    expect(fetcher.calls).toEqual([
      { provider: "ollama", baseUrl: "http://192.168.1.50:11434" },
    ]);
    expect(ProviderModelCatalogSchema.parse(result)).toEqual({
      provider: "ollama",
      state: "ok",
      models: [{ id: "llama3.2:3b", label: "llama3.2:3b" }],
      fetchedAt: "2026-10-06T00:00:00.000Z",
    });
  });

  it("keeps an unreachable endpoint distinct from an empty catalog", async () => {
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({}),
      fetchCatalog: catalog({
        ollama: { state: "unreachable", detail: "connect ECONNREFUSED" },
      }),
    });
    const result = await service.listModels("ollama", {
      config: {},
      runtime: null,
    });
    expect(result).toMatchObject({
      state: "unreachable",
      detail: "connect ECONNREFUSED",
    });
  });

  it("does not call a keyed catalog without a credential", async () => {
    const fetcher = catalog({});
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({}),
      fetchCatalog: fetcher,
    });
    const result = await service.listModels("grok", {
      config: {},
      runtime: null,
    });
    expect(result).toEqual({ provider: "grok", state: "missing-credential" });
    expect(fetcher.calls).toEqual([]);
  });

  it("queries xAI at its own API base, never OpenAI's", async () => {
    const fetcher = catalog({ grok: GROK_CATALOG });
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({ grok: XAI_KEY }),
      fetchCatalog: fetcher,
    });
    await service.listModels("grok", { config: {}, runtime: null });
    expect(fetcher.calls).toEqual([
      { provider: "grok", baseUrl: "https://api.x.ai/v1" },
    ]);
  });
});

describe("ModelSettingsService.activate", () => {
  it("rejects Grok without both model tiers", async () => {
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {
        throw new Error("must not save");
      },
      readCredential: credentials({ grok: XAI_KEY }),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
    });
    await expectCode(
      service.activate(
        { provider: "grok", smallModel: "grok-4-fast" },
        { config: {}, runtime: null },
      ),
      "MODEL_REQUIRED",
    );
  });

  it("refuses a provider whose plugin is not installed", async () => {
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({ anthropic: "sk-ant-fixture" }),
      isPluginInstalled: () => false,
      isCloudProvisioned: () => false,
    });
    await expectCode(
      service.activate(
        { provider: "anthropic" },
        { config: {}, runtime: null },
      ),
      "PROVIDER_PLUGIN_MISSING",
    );
  });

  it("refuses a keyed provider with no credential and a cloud-managed agent", async () => {
    const base = {
      operations: null,
      saveConfig: () => {},
      isPluginInstalled: () => true,
    };
    await expectCode(
      new ModelSettingsService({
        ...base,
        readCredential: credentials({}),
        isCloudProvisioned: () => false,
      }).activate({ provider: "openai" }, { config: {}, runtime: null }),
      "CREDENTIAL_REQUIRED",
    );
    await expectCode(
      new ModelSettingsService({
        ...base,
        readCredential: credentials({ openai: OPENAI_KEY }),
        isCloudProvisioned: () => true,
      }).activate({ provider: "openai" }, { config: {}, runtime: null }),
      "MODEL_SETTINGS_MANAGED_BY_CLOUD",
    );
  });

  it("refuses model ids the live catalog does not offer, or cannot confirm", async () => {
    const base = {
      operations: null,
      saveConfig: () => {},
      readCredential: credentials({ grok: XAI_KEY }),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
    };
    await expectCode(
      new ModelSettingsService({
        ...base,
        fetchCatalog: catalog({ grok: GROK_CATALOG }),
      }).activate(
        { provider: "grok", smallModel: "gpt-5.6-luna", largeModel: "grok-4" },
        { config: {}, runtime: null },
      ),
      "MODEL_NOT_IN_CATALOG",
    );
    await expectCode(
      new ModelSettingsService({
        ...base,
        fetchCatalog: catalog({
          grok: { state: "auth-failed", detail: "HTTP 401" },
        }),
      }).activate(
        { provider: "grok", smallModel: "grok-4-fast", largeModel: "grok-4" },
        { config: {}, runtime: null },
      ),
      "MODEL_CATALOG_UNAVAILABLE",
    );
  });

  it("switches to Grok through a restart and projects the picks onto the OpenAI-compatible keys", async () => {
    const state = {
      config: directConfig("anthropic"),
      runtime: null,
    };
    const { manager, repository, restartRuntime } = buildOperations(
      () => state.config,
    );
    const saved: string[] = [];
    const service = new ModelSettingsService({
      operations: manager,
      saveConfig: (config) => saved.push(JSON.stringify(config)),
      readCredential: credentials({ grok: XAI_KEY }),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
      fetchCatalog: catalog({ grok: GROK_CATALOG }),
    });

    const outcome = await service.activate(
      { provider: "grok", smallModel: "grok-4-fast", largeModel: "grok-4" },
      state,
    );

    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    const op = await waitForTerminal(repository, outcome.operationId);
    expect(op.status).toBe("succeeded");
    expect(op.tier).toBe("cold");
    expect(restartRuntime).toHaveBeenCalledWith("provider switch to grok");
    expect(state.config.serviceRouting?.llmText).toMatchObject({
      backend: "grok",
      transport: "direct",
      smallModel: "grok-4-fast",
      largeModel: "grok-4",
    });
    expect(process.env.OPENAI_SMALL_MODEL).toBe("grok-4-fast");
    expect(process.env.OPENAI_LARGE_MODEL).toBe("grok-4");
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toContain(XAI_KEY);

    const status = await service.getStatus(state);
    expect(status.operation).toEqual({
      id: outcome.operationId,
      provider: "grok",
      state: "succeeded",
      error: null,
    });
  });

  it("restarts for a same-provider model change and reports a busy manager", async () => {
    const state = { config: directConfig("openai"), runtime: null };
    const { manager, repository } = buildOperations(() => state.config);
    const service = new ModelSettingsService({
      operations: manager,
      saveConfig: () => {},
      readCredential: credentials({ openai: OPENAI_KEY }),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
      fetchCatalog: catalog({
        openai: {
          state: "ok",
          models: [
            { id: "gpt-5.6-sol", name: "gpt-5.6-sol", category: "chat" },
          ],
        },
      }),
    });

    const first = await service.activate(
      { provider: "openai", largeModel: "gpt-5.6-sol" },
      state,
    );
    if (first.kind !== "accepted") throw new Error("expected accepted");
    await expectCode(
      service.activate({ provider: "openai" }, state),
      "OPERATION_IN_PROGRESS",
    );
    const op = await waitForTerminal(repository, first.operationId);
    expect(op.tier).toBe("cold");
    expect(op.status).toBe("succeeded");
  });

  it("retracts the previous provider's picks from the saved config so the next boot gets defaults", async () => {
    const state = {
      config: {
        ...directConfig("grok", {
          smallModel: "grok-4-fast",
          largeModel: "grok-4",
        }),
        env: {
          OPENAI_SMALL_MODEL: "grok-4-fast",
          OPENAI_LARGE_MODEL: "grok-4",
        },
      } as ElizaConfig,
      runtime: null,
    };
    process.env.OPENAI_SMALL_MODEL = "grok-4-fast";
    process.env.OPENAI_LARGE_MODEL = "grok-4";
    const saved: ElizaConfig[] = [];
    const service = new ModelSettingsService({
      operations: null,
      saveConfig: (config) => saved.push(structuredClone(config)),
      readCredential: credentials({ openai: OPENAI_KEY }),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
    });

    const outcome = await service.activate({ provider: "openai" }, state);

    expect(outcome).toEqual({ kind: "persisted", provider: "openai" });
    expect(state.config.serviceRouting?.llmText).toEqual({
      backend: "openai",
      transport: "direct",
    });
    const savedEnv = saved[0]?.env as Record<string, unknown> | undefined;
    expect(savedEnv?.OPENAI_SMALL_MODEL).toBeUndefined();
    expect(savedEnv?.OPENAI_LARGE_MODEL).toBeUndefined();
    // Headless: the loaded Grok route keeps serving until the next boot, so
    // the live process env still names xAI models, never a mix with OpenAI.
    expect(process.env.OPENAI_SMALL_MODEL).toBe("grok-4-fast");
    expect(process.env.OPENAI_LARGE_MODEL).toBe("grok-4");
  });

  it("retracts the previous provider's picks from the live env before the restart", async () => {
    const state = {
      config: directConfig("grok", {
        smallModel: "grok-4-fast",
        largeModel: "grok-4",
      }),
      runtime: null,
    };
    process.env.OPENAI_SMALL_MODEL = "grok-4-fast";
    process.env.OPENAI_LARGE_MODEL = "grok-4";
    const { manager, repository } = buildOperations(() => state.config);
    const service = new ModelSettingsService({
      operations: manager,
      saveConfig: () => {},
      readCredential: credentials({ openai: OPENAI_KEY }),
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
    });

    const outcome = await service.activate({ provider: "openai" }, state);
    if (outcome.kind !== "accepted") throw new Error("expected accepted");
    await waitForTerminal(repository, outcome.operationId);

    expect(process.env.OPENAI_SMALL_MODEL).not.toBe("grok-4-fast");
    expect(process.env.OPENAI_LARGE_MODEL).not.toBe("grok-4");
  });
});

describe("readProviderCredential", () => {
  it("does not attribute another provider's OpenAI-compatible alias to OpenAI", () => {
    const env = {
      OPENAI_API_KEY: XAI_KEY,
      OPENAI_BASE_URL: "https://api.x.ai/v1",
    } as NodeJS.ProcessEnv;
    // An isolated state dir has no account-pool records.
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
    try {
      expect(
        readProviderCredential("openai", {
          config: {},
          env,
          activeProvider: "grok",
          pool: null,
        }),
      ).toBeNull();
      expect(
        readProviderCredential("openai", {
          config: {},
          env: { OPENAI_API_KEY: OPENAI_KEY } as NodeJS.ProcessEnv,
          activeProvider: "anthropic",
          pool: null,
        }),
      ).toEqual({ value: OPENAI_KEY, source: "launch-env" });
    } finally {
      if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousStateDir;
    }
  });
});

describe("selectPooledCredential", () => {
  const record = (id: string, access: string, updatedAt: number) => ({
    id,
    updatedAt,
    credentials: { access },
  });
  const records = [
    record("acct-old", "sk-old-key-1111", 1),
    record("acct-new", "sk-new-key-2222", 2),
  ];

  function pool(
    linked: Array<{ id: string; enabled?: boolean }>,
    activeAccountId?: string | null,
  ): AccountPoolSelector & { strategies: unknown[] } {
    const strategies: unknown[] = [];
    return {
      strategies,
      list: () => linked,
      ...(activeAccountId !== undefined
        ? {
            selectionState: (_provider: string, strategy?: unknown) => {
              strategies.push(strategy);
              return { activeAccountId, reason: "priority" };
            },
          }
        : {}),
    };
  }

  it("reports the account the pool would export, not the newest one", () => {
    const selector = pool([{ id: "acct-old" }, { id: "acct-new" }], "acct-old");
    expect(
      selectPooledCredential("openai-api", records, selector, "round-robin"),
    ).toBe("sk-old-key-1111");
    expect(selector.strategies).toEqual(["round-robin"]);
  });

  it("reports nothing when the pool would export no account (all disabled)", () => {
    expect(
      selectPooledCredential(
        "openai-api",
        records,
        pool(
          [
            { id: "acct-old", enabled: false },
            { id: "acct-new", enabled: false },
          ],
          null,
        ),
        "priority",
      ),
    ).toBeNull();
  });

  it("skips disabled and unlinked accounts on a host without a selection dry run", () => {
    expect(
      selectPooledCredential(
        "openai-api",
        records,
        pool([{ id: "acct-old" }, { id: "acct-new", enabled: false }]),
        "priority",
      ),
    ).toBe("sk-old-key-1111");
    expect(
      selectPooledCredential("openai-api", records, pool([]), "priority"),
    ).toBeNull();
  });
});

describe("readProviderCredential without stored accounts", () => {
  it("falls back to launch env only where the pool would", () => {
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
    const emptyPool: AccountPoolSelector = {
      list: () => [],
      selectionState: () => ({ activeAccountId: null, reason: null }),
    };
    try {
      for (const pool of [null, emptyPool]) {
        expect(
          readProviderCredential("grok", {
            config: {},
            env: { XAI_API_KEY: XAI_KEY } as NodeJS.ProcessEnv,
            activeProvider: "grok",
            pool,
          }),
        ).toEqual({ value: XAI_KEY, source: "launch-env" });
        expect(
          readProviderCredential("anthropic", {
            config: {},
            env: {} as NodeJS.ProcessEnv,
            activeProvider: "openai",
            pool,
          }),
        ).toBeNull();
      }
    } finally {
      if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousStateDir;
    }
  });
});
