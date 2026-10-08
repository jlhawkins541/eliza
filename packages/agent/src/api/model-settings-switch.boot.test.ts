/**
 * Boot-level coverage for a Models-page provider switch. `ModelSettingsService`
 * activates through the API server's operation-manager wiring, and the cold
 * restart runs the real `startEliza` boot (plugin resolution, account-pool
 * export, model projection, runtime settings). The runtime it constructs must
 * name the loaded provider in `ELIZA_BRAIN_PROVIDER`, and the provider
 * plugin's own model getters must return the chosen ids.
 *
 * Also covers the Grok gate at boot: a Grok route without both models pins
 * nothing, withholds the account pool's OpenAI-compatible alias, and reports
 * `PROVIDER_MODELS_REQUIRED` on the runtime.
 *
 * Boot is aborted right after the runtime is constructed, before plugins
 * initialize, so no provider request is made. Only the credential reader, the
 * catalog fetch, and the host's account-pool export are injected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
  getLargeModel as anthropicLargeModel,
  getSmallModel as anthropicSmallModel,
} from "@elizaos/plugin-anthropic/endpoint-config";
import {
  getBaseURL as openaiBaseURL,
  getLargeModel as openaiLargeModel,
  getSmallModel as openaiSmallModel,
} from "@elizaos/plugin-openai/endpoint-config";
import type { ModelProviderId } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { startEliza } from "../runtime/eliza.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import {
  DefaultRuntimeOperationManager,
  FilesystemRuntimeOperationRepository,
  HealthChecker,
  type RuntimeOperation,
  type RuntimeOperationRepository,
} from "../runtime/operations/index.ts";
import type { ProviderCatalogProbe } from "./model-provider-helpers.ts";
import {
  type ModelCatalogFetcher,
  ModelSettingsService,
  type StoredProviderCredential,
} from "./model-settings-service.ts";
import { buildRuntimeOperationManagerOptions } from "./runtime-operation-manager-options.ts";

const XAI_BASE = "https://api.x.ai/v1";

let stateDir: string;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-model-switch-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
  for (const key of [
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_SMALL_MODEL",
    "OPENAI_LARGE_MODEL",
    "ANTHROPIC_SMALL_MODEL",
    "ANTHROPIC_LARGE_MODEL",
    "SMALL_MODEL",
    "LARGE_MODEL",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_ENABLED",
  ]) {
    delete process.env[key];
  }
  // Plugin resolution auto-enables providers from these keys; boot never
  // dispatches a request with them.
  process.env.OPENAI_API_KEY = "sk-fixture-openai-boot-0000";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fixture-boot-0000";
});

afterEach(() => {
  _resetAgentHostBridge();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, envSnapshot);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function directRoute(
  backend: string,
  models: { smallModel?: string; largeModel?: string } = {},
): ElizaConfig {
  return {
    firstRun: false,
    serviceRouting: {
      llmText: { backend, transport: "direct", ...models },
    },
    agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
  } as unknown as ElizaConfig;
}

/** Run the real boot up to runtime construction and return that runtime. */
async function bootRuntime(config: ElizaConfig): Promise<AgentRuntime> {
  const abort = new AbortController();
  let created: AgentRuntime | null = null;
  await startEliza({
    headless: true,
    abortSignal: abort.signal,
    configOverride: config,
    onRuntimeCreated: (runtime) => {
      created = runtime;
      abort.abort();
    },
  }).then(
    () => {
      throw new Error("boot was expected to stop at runtime construction");
    },
    (err: unknown) => {
      if ((err as { name?: unknown } | null)?.name !== "AbortError") throw err;
    },
  );
  if (!created) throw new Error("boot did not construct a runtime");
  return created;
}

function catalogOf(
  models: Partial<Record<string, string[]>>,
): ModelCatalogFetcher {
  return async (provider): Promise<ProviderCatalogProbe> => {
    const ids = models[provider];
    if (!ids) throw new Error(`unexpected catalog fetch for ${provider}`);
    return {
      state: "ok",
      models: ids.map((id) => ({ id, name: id, category: "chat" as const })),
    };
  };
}

function credentialsFor(
  providers: ModelProviderId[],
): (provider: ModelProviderId) => StoredProviderCredential | null {
  return (provider) =>
    providers.includes(provider)
      ? { value: `fixture-${provider}-key-0000`, source: "account-pool" }
      : null;
}

async function waitForTerminal(
  repository: RuntimeOperationRepository,
  id: string,
): Promise<RuntimeOperation> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const op = await repository.get(id);
    if (op && op.status !== "pending" && op.status !== "running") return op;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`operation ${id} did not finish`);
}

describe("Models-page switch through a real boot", () => {
  it("switches OpenAI → Anthropic → OpenAI and boots the chosen provider and models", async () => {
    const state: { config: ElizaConfig; runtime: AgentRuntime | null } = {
      config: directRoute("openai"),
      runtime: null,
    };
    state.runtime = await bootRuntime(state.config);
    expect(state.runtime.getSetting("ELIZA_BRAIN_PROVIDER")).toBe("openai");

    const restartRuntime = vi.fn(async () => {
      state.runtime = await bootRuntime(state.config);
      return true;
    });
    const repository = new FilesystemRuntimeOperationRepository(stateDir);
    const service = new ModelSettingsService({
      operations: new DefaultRuntimeOperationManager(
        buildRuntimeOperationManagerOptions(state, restartRuntime, {
          repository,
          healthChecker: new HealthChecker(),
        }),
      ),
      saveConfig: () => {},
      readCredential: credentialsFor(["openai", "anthropic"]),
      isCloudProvisioned: () => false,
      fetchCatalog: catalogOf({
        anthropic: ["claude-haiku-4-5", "claude-opus-4-8"],
        openai: ["gpt-5.6-luna", "gpt-5.6-sol"],
      }),
    });

    const toAnthropic = await service.activate(
      {
        provider: "anthropic",
        smallModel: "claude-haiku-4-5",
        largeModel: "claude-opus-4-8",
      },
      state,
    );
    if (toAnthropic.kind !== "accepted") throw new Error("expected accepted");
    const anthropicOp = await waitForTerminal(
      repository,
      toAnthropic.operationId,
    );
    expect(anthropicOp).toMatchObject({ status: "succeeded", tier: "cold" });
    expect(state.runtime.getSetting("ELIZA_BRAIN_PROVIDER")).toBe("anthropic");
    expect(state.runtime.getSetting("MODEL_PROVIDER")).toBe("anthropic");
    expect(anthropicSmallModel(state.runtime)).toBe("claude-haiku-4-5");
    expect(anthropicLargeModel(state.runtime)).toBe("claude-opus-4-8");

    const toOpenAi = await service.activate(
      {
        provider: "openai",
        smallModel: "gpt-5.6-luna",
        largeModel: "gpt-5.6-sol",
      },
      state,
    );
    if (toOpenAi.kind !== "accepted") throw new Error("expected accepted");
    expect(
      (await waitForTerminal(repository, toOpenAi.operationId)).status,
    ).toBe("succeeded");
    expect(state.runtime.getSetting("ELIZA_BRAIN_PROVIDER")).toBe("openai");
    expect(openaiSmallModel(state.runtime)).toBe("gpt-5.6-luna");
    expect(openaiLargeModel(state.runtime)).toBe("gpt-5.6-sol");
    expect(restartRuntime).toHaveBeenCalledTimes(2);
  }, 240_000);
});

describe("Grok boot gate", () => {
  /** Host account pool that exports the xAI alias the way app-core does. */
  function installAccountPool(): { activeBackends: unknown[] } {
    const activeBackends: unknown[] = [];
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      applyAccountPoolApiCredentials: async (options) => {
        activeBackends.push(options?.activeBackend);
        process.env.XAI_API_KEY = "xai-fixture-boot-0000";
        if (options?.activeBackend === "grok") {
          process.env.OPENAI_API_KEY = "xai-fixture-boot-0000";
          process.env.OPENAI_BASE_URL = XAI_BASE;
        }
      },
    });
    return { activeBackends };
  }

  it("pins nothing and reports PROVIDER_MODELS_REQUIRED for a Grok route without both models", async () => {
    const pool = installAccountPool();

    const runtime = await bootRuntime(
      directRoute("grok", { smallModel: "grok-4-fast" }),
    );

    expect(pool.activeBackends).toEqual([undefined]);
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(runtime.getSetting("ELIZA_BRAIN_PROVIDER")).toBeNull();
    expect(runtime.getSetting("MODEL_PROVIDER")).toBeNull();
    expect(openaiBaseURL(runtime)).not.toBe(XAI_BASE);
    expect(runtime.getSetting("OPENAI_SMALL_MODEL")).not.toBe("grok-4-fast");
    expect(runtime.getRecentReportedErrors()).toContainEqual(
      expect.objectContaining({
        scope: "eliza.directProviderModels",
        code: "PROVIDER_MODELS_REQUIRED",
        context: expect.objectContaining({
          provider: "grok",
          missingTiers: ["largeModel"],
        }),
      }),
    );
  }, 120_000);

  it("pins the OpenAI-compatible plugin at xAI with the chosen Grok models", async () => {
    const pool = installAccountPool();

    const runtime = await bootRuntime(
      directRoute("grok", { smallModel: "grok-4-fast", largeModel: "grok-4" }),
    );

    expect(pool.activeBackends).toEqual(["grok"]);
    expect(runtime.getSetting("ELIZA_BRAIN_PROVIDER")).toBe("openai");
    expect(openaiBaseURL(runtime)).toBe(XAI_BASE);
    expect(openaiSmallModel(runtime)).toBe("grok-4-fast");
    expect(openaiLargeModel(runtime)).toBe("grok-4");
  }, 120_000);
});
