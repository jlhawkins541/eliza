/**
 * Owner-facing model settings use-case shared by `/api/model-settings` and the
 * SETTINGS `update_ai_provider` agent action: which provider and models Eliza
 * is using, each switchable provider's credential/endpoint/plugin status, the
 * live model catalogs, and activation of a provider with optional model tiers.
 *
 * Activation never accepts a credential. Keys stay owned by the encrypted
 * account pool (or the launch environment); this module reads them only to
 * report the last four characters and to authenticate catalog requests.
 * Activation writes the provider route and the chosen model tiers into
 * `serviceRouting.llmText` and runs through the runtime operation manager,
 * which restarts the runtime so the boot-time model env projection
 * (`applyDirectProviderModelEnv`) reaches the provider plugins. Without an
 * operation manager (a headless runtime with no API host) the same config
 * mutation is persisted for the next boot.
 *
 * Failures are typed `ElizaError`s whose codes the route layer maps to HTTP
 * statuses; nothing here fabricates a healthy-looking default.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { listAccounts } from "@elizaos/auth/account-storage";
import type { DirectAccountProvider } from "@elizaos/auth/types";
import { ElizaError, logger } from "@elizaos/core";
import {
  type ActivatableModelProviderId,
  classifyModelEndpointTransport,
  DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  DEFAULT_OPENAI_ENDPOINT,
  type EndpointStatus,
  getFirstRunProviderOption,
  isCloudProvisionedContainer,
  MODEL_PROVIDER_IDS,
  type ModelProviderId,
  type ModelProviderStatusDto,
  type ModelSettingsOperationDto,
  type ModelSettingsStatusDto,
  normalizeFirstRunProviderId,
  OLLAMA_ENDPOINT_SETTING_KEYS,
  type PostActivateModelRequest,
  type ProviderHealth,
  type ProviderModelCatalogDto,
  type ProviderModelOption,
  providerRequiresModelSelection,
  type ResolvedModelEndpoint,
  resolveDevCloudEnvAuthority,
  resolveOllamaEndpoint,
  resolveOpenAiEndpoint,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { isMobilePlatform } from "@elizaos/shared/runtime-env";
import type { ElizaConfig } from "../config/config.ts";
import type {
  ProviderSwitchIntent,
  RuntimeOperation,
  RuntimeOperationManager,
} from "../runtime/operations/index.ts";
import {
  STATIC_ELIZA_PLUGIN_LOADERS,
  STATIC_ELIZA_PLUGINS,
} from "../runtime/plugin-types.ts";
import {
  applyDirectProviderModelEnv,
  type DirectProviderModelEnv,
  resolveDirectProviderModelEnv,
} from "../runtime/provider-model-defaults.ts";
import {
  type CachedModel,
  fetchOllamaModels,
  type ProviderCatalogProbe,
  probeAnthropicCatalog,
  probeOpenAiCompatibleCatalog,
} from "./model-provider-helpers.ts";
import type { ModelSettingsState } from "./model-settings-host.ts";
import {
  applyFirstRunConnectionConfig,
  createProviderSwitchConnection,
} from "./provider-switch-config.ts";

export type { ModelSettingsState } from "./model-settings-host.ts";

/** A credential value read from its owning store. Never leaves this module. */
export interface StoredProviderCredential {
  value: string;
  source: "account-pool" | "launch-env" | "cloud-account";
}

/** Providers whose key the account pool owns. */
type KeyedProviderId = "openai" | "anthropic" | "grok";

const KEYED_PROVIDER_ACCOUNT: Readonly<
  Record<KeyedProviderId, DirectAccountProvider>
> = {
  openai: "openai-api",
  anthropic: "anthropic-api",
  grok: "xai-api",
};

const XAI_API_BASE = "https://api.x.ai/v1";

/** Plugin package each Models-page provider is served by. */
const PROVIDER_PLUGIN: Readonly<Record<ModelProviderId, string>> = {
  openai: "@elizaos/plugin-openai",
  anthropic: "@elizaos/plugin-anthropic",
  // xAI is OpenAI-compatible; the account pool exports its key as an
  // OpenAI-compatible credential while Grok is the active backend.
  grok: "@elizaos/plugin-openai",
  ollama: "@elizaos/plugin-zerollama",
  elizacloud: "@elizaos/plugin-elizacloud",
  local: "@elizaos/plugin-local-inference",
};

const PROVIDER_LABEL: Readonly<Record<ModelProviderId, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  grok: "xAI Grok",
  ollama: "Ollama",
  elizacloud: "Eliza Cloud",
  local: "On-device",
};

const ACTIVATABLE: ReadonlySet<ModelProviderId> = new Set([
  "openai",
  "anthropic",
  "grok",
  "ollama",
  "elizacloud",
]);

/** HTTP status the route layer answers for each activation failure code. */
export const MODEL_SETTINGS_ERROR_STATUS: Readonly<Record<string, number>> = {
  MODEL_REQUIRED: 400,
  MODEL_NOT_IN_CATALOG: 400,
  MODEL_SELECTION_UNSUPPORTED: 400,
  MODEL_SETTINGS_MANAGED_BY_CLOUD: 409,
  DEV_CLOUD_AUTHORITY_ACTIVE: 409,
  PROVIDER_PLUGIN_MISSING: 409,
  CREDENTIAL_REQUIRED: 409,
  MODEL_CATALOG_UNAVAILABLE: 409,
  OPERATION_IN_PROGRESS: 409,
};

function modelSettingsError(
  code: keyof typeof MODEL_SETTINGS_ERROR_STATUS,
  message: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(message, { code, context, severity: "ephemeral" });
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function lastFour(value: string): string {
  return value.trim().slice(-4);
}

function uncheckedHealth(): ProviderHealth {
  return { state: "unchecked", checkedAt: null, detail: null };
}

/**
 * Production credential reader. The account pool is the authority for direct
 * keys; launch env is consulted only when it is not another provider's
 * OpenAI/Anthropic-compatible alias (the account pool exports the active xAI
 * key as `OPENAI_API_KEY` with an x.ai base URL, and Cloud inference reuses the
 * `*_BASE_URL` pair for its proxy).
 */
export function readProviderCredential(
  provider: ModelProviderId,
  context: {
    config: ElizaConfig;
    env: NodeJS.ProcessEnv;
    activeProvider: ModelProviderId | "other";
  },
): StoredProviderCredential | null {
  const { config, env, activeProvider } = context;
  if (provider === "elizacloud") {
    const cloud = config.cloud as { apiKey?: unknown } | undefined;
    const value = trimmed(cloud?.apiKey) ?? trimmed(env.ELIZAOS_CLOUD_API_KEY);
    return value ? { value, source: "cloud-account" } : null;
  }
  if (provider !== "openai" && provider !== "anthropic" && provider !== "grok")
    return null;

  const records = listAccounts(KEYED_PROVIDER_ACCOUNT[provider])
    .filter((record) => trimmed(record.credentials.access) !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const pooled = records[0];
  if (pooled) {
    return { value: pooled.credentials.access.trim(), source: "account-pool" };
  }

  let launchValue: string | null = null;
  if (provider === "grok") {
    launchValue = trimmed(env.XAI_API_KEY);
  } else if (provider === "openai") {
    const ownsAlias =
      activeProvider === "openai" ||
      resolveOpenAiEndpoint((key) => env[key]).isDefault;
    launchValue = ownsAlias ? trimmed(env.OPENAI_API_KEY) : null;
  } else {
    const ownsAlias =
      activeProvider === "anthropic" || !trimmed(env.ANTHROPIC_BASE_URL);
    launchValue = ownsAlias ? trimmed(env.ANTHROPIC_API_KEY) : null;
  }
  return launchValue ? { value: launchValue, source: "launch-env" } : null;
}

/**
 * Whether a provider plugin package can be loaded in this process: a mobile
 * bundle can load only statically registered plugins; elsewhere the package
 * must be present in a `node_modules` directory on this module's resolution
 * path. Uses package directories rather than export maps, which differ
 * between ESM-only and dual packages.
 */
export function isProviderPluginInstalled(pluginName: string): boolean {
  if (
    STATIC_ELIZA_PLUGINS[pluginName] ||
    STATIC_ELIZA_PLUGIN_LOADERS[pluginName]
  )
    return true;
  if (isMobilePlatform()) return false;
  const searchPaths =
    createRequire(import.meta.url).resolve.paths(pluginName) ?? [];
  return searchPaths.some((dir) =>
    existsSync(path.join(dir, ...pluginName.split("/"), "package.json")),
  );
}

export type ModelCatalogFetcher = (
  provider: "openai" | "anthropic" | "grok" | "ollama",
  request: { apiKey: string | null; baseUrl: string },
) => Promise<ProviderCatalogProbe>;

/** Production catalog fetcher over the provider REST catalogs. */
export const fetchProviderModelCatalog: ModelCatalogFetcher = async (
  provider,
  { apiKey, baseUrl },
) => {
  switch (provider) {
    case "anthropic":
      return probeAnthropicCatalog(apiKey ?? "");
    case "ollama":
      return fetchOllamaModels(baseUrl);
    case "openai":
    case "grok":
      return probeOpenAiCompatibleCatalog(provider, apiKey ?? "", baseUrl);
  }
};

export interface ModelSettingsServiceDeps {
  /** Null on a headless runtime: activation is persisted for the next boot. */
  operations: RuntimeOperationManager | null;
  saveConfig: (config: ElizaConfig) => void;
  env?: NodeJS.ProcessEnv;
  readCredential?: typeof readProviderCredential;
  isPluginInstalled?: (pluginName: string) => boolean;
  fetchCatalog?: ModelCatalogFetcher;
  isCloudProvisioned?: () => boolean;
  now?: () => Date;
}

export type ModelActivationOutcome =
  | {
      kind: "accepted" | "deduped";
      provider: ActivatableModelProviderId;
      operationId: string;
    }
  | { kind: "persisted"; provider: ActivatableModelProviderId };

/** Map a llmText route onto a Models-page provider id. */
export function resolveActiveModelProvider(
  config: ElizaConfig,
): ModelProviderId | "other" {
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeFirstRunProviderId(llmText?.backend);
  if (llmText?.transport === "cloud-proxy" && backend === "elizacloud") {
    return "elizacloud";
  }
  if (llmText?.transport === "direct" && backend) {
    return (MODEL_PROVIDER_IDS as readonly string[]).includes(backend)
      ? (backend as ModelProviderId)
      : "other";
  }
  if (llmText?.transport === "remote") return "other";
  const cloud = config.cloud as
    | { inferenceMode?: unknown; services?: { inference?: unknown } }
    | undefined;
  if (
    cloud?.inferenceMode === "local" ||
    cloud?.services?.inference === false
  ) {
    return "local";
  }
  return "other";
}

function endpointStatus(
  resolved: ResolvedModelEndpoint,
  overriddenBy: string | null,
): EndpointStatus {
  return {
    url: resolved.url,
    isDefault: resolved.isDefault,
    transport: classifyModelEndpointTransport(resolved.url) ?? "invalid",
    overriddenBy,
  };
}

/** The owner-editable Ollama setting is `OLLAMA_BASE_URL`; the others win over it. */
function ollamaEndpoint(env: NodeJS.ProcessEnv): EndpointStatus {
  const resolved = resolveOllamaEndpoint((key) => env[key]);
  const editable = OLLAMA_ENDPOINT_SETTING_KEYS[2];
  const overriddenBy =
    resolved.source !== null && resolved.source !== editable
      ? resolved.source
      : null;
  return endpointStatus(resolved, overriddenBy);
}

/**
 * OpenAI's endpoint. While another provider is active, `OPENAI_BASE_URL` in
 * the process env may be that provider's compatibility alias, so only the
 * owner's persisted config value is attributed to OpenAI.
 */
function openAiEndpoint(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv,
  activeProvider: ModelProviderId | "other",
): EndpointStatus {
  if (activeProvider === "openai") {
    return endpointStatus(
      resolveOpenAiEndpoint((key) => env[key]),
      null,
    );
  }
  const persisted = config.env as Record<string, unknown> | undefined;
  return endpointStatus(
    resolveOpenAiEndpoint((key) => {
      const value = persisted?.[key];
      return typeof value === "string" ? value : undefined;
    }),
    null,
  );
}

function operationState(
  op: RuntimeOperation,
): ModelSettingsOperationDto["state"] {
  switch (op.status) {
    case "pending":
      return "pending";
    case "running":
      return "applying";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "rolled-back":
      return "failed";
  }
}

function toCatalogOptions(models: CachedModel[]): ProviderModelOption[] {
  return models
    .filter((model) => model.category === "chat")
    .map((model) => ({ id: model.id, label: model.name }));
}

/**
 * Remove model ids a previous direct selection projected into env, so the
 * next provider's defaults can be stamped instead of inheriting them. Only
 * values equal to the previous projection are removed; operator values stay.
 */
function retractProjectedModelEnv(
  config: ElizaConfig,
  previous: DirectProviderModelEnv,
  env: NodeJS.ProcessEnv,
): void {
  const configEnv = config.env as Record<string, unknown> | undefined;
  const vars = configEnv?.vars as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(previous.assignments)) {
    if (env[key] === value) delete env[key];
    if (configEnv?.[key] === value) delete configEnv[key];
    if (vars?.[key] === value) delete vars[key];
  }
}

/**
 * Pure config mutation for an activation: route text to `provider`, record the
 * chosen model tiers on `serviceRouting.llmText`, and project them into
 * `env`. Shared by the operation `prepare` step and the headless path.
 */
export async function applyModelSelectionToConfig(
  config: ElizaConfig,
  selection: {
    provider: ActivatableModelProviderId;
    smallModel: string | null;
    largeModel: string | null;
  },
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const previous = resolveDirectProviderModelEnv(config);
  if (previous) retractProjectedModelEnv(config, previous, env);

  const connection = createProviderSwitchConnection({
    provider: selection.provider,
  });
  if (!connection) {
    throw new ElizaError(
      `[model-settings] No connection for provider ${selection.provider}`,
      {
        code: "MODEL_SETTINGS_PROVIDER_UNRESOLVED",
        context: { provider: selection.provider },
      },
    );
  }
  await applyFirstRunConnectionConfig(config, connection);
  if (selection.provider === "elizacloud") return;

  const llmText = config.serviceRouting?.llmText;
  if (!llmText) {
    throw new ElizaError(
      "[model-settings] Provider activation did not produce a text route",
      {
        code: "MODEL_SETTINGS_ROUTE_MISSING",
        context: { provider: selection.provider },
      },
    );
  }
  if (selection.smallModel) llmText.smallModel = selection.smallModel;
  else delete llmText.smallModel;
  if (selection.largeModel) llmText.largeModel = selection.largeModel;
  else delete llmText.largeModel;
  applyDirectProviderModelEnv(config, env);
}

export class ModelSettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly readCredential: typeof readProviderCredential;
  private readonly isPluginInstalled: (pluginName: string) => boolean;
  private readonly fetchCatalog: ModelCatalogFetcher;
  private readonly isCloudProvisioned: () => boolean;
  private readonly now: () => Date;

  constructor(private readonly deps: ModelSettingsServiceDeps) {
    this.env = deps.env ?? process.env;
    this.readCredential = deps.readCredential ?? readProviderCredential;
    this.isPluginInstalled =
      deps.isPluginInstalled ?? isProviderPluginInstalled;
    this.fetchCatalog = deps.fetchCatalog ?? fetchProviderModelCatalog;
    this.isCloudProvisioned =
      deps.isCloudProvisioned ?? isCloudProvisionedContainer;
    this.now = deps.now ?? (() => new Date());
  }

  private credential(
    provider: ModelProviderId,
    state: ModelSettingsState,
  ): StoredProviderCredential | null {
    return this.readCredential(provider, {
      config: state.config,
      env: this.env,
      activeProvider: resolveActiveModelProvider(state.config),
    });
  }

  private providerStatus(
    provider: ModelProviderId,
    state: ModelSettingsState,
  ): ModelProviderStatusDto {
    const activeProvider = resolveActiveModelProvider(state.config);
    const keyed =
      provider === "openai" ||
      provider === "anthropic" ||
      provider === "grok" ||
      provider === "elizacloud";
    const stored = keyed ? this.credential(provider, state) : null;
    const credential: ModelProviderStatusDto["credential"] = !keyed
      ? { state: "not-required" }
      : stored
        ? {
            state: "stored",
            last4: lastFour(stored.value),
            source: stored.source,
            lastVerifiedAt: null,
            health: uncheckedHealth(),
          }
        : { state: "missing" };
    const endpoint =
      provider === "ollama"
        ? ollamaEndpoint(this.env)
        : provider === "openai"
          ? openAiEndpoint(state.config, this.env, activeProvider)
          : null;
    return {
      id: provider,
      label: PROVIDER_LABEL[provider],
      pluginInstalled: this.isPluginInstalled(PROVIDER_PLUGIN[provider]),
      credential,
      endpoint,
      supportsEndpoint: provider === "ollama" || provider === "openai",
      activatable: ACTIVATABLE.has(provider),
      requiresModelSelection:
        ACTIVATABLE.has(provider) &&
        providerRequiresModelSelection(provider as ActivatableModelProviderId),
    };
  }

  private activeModels(
    provider: ModelProviderId | "other",
    state: ModelSettingsState,
  ): Pick<
    ModelSettingsStatusDto["active"],
    "smallModel" | "largeModel" | "modelSource"
  > {
    if (provider === "elizacloud") {
      const llmText = state.config.serviceRouting?.llmText;
      const models = state.config.models as
        | { small?: unknown; large?: unknown }
        | undefined;
      const userSmall = trimmed(llmText?.smallModel) ?? trimmed(models?.small);
      const userLarge = trimmed(llmText?.largeModel) ?? trimmed(models?.large);
      if (userSmall || userLarge) {
        return {
          smallModel: userSmall ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
          largeModel: userLarge ?? DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
          modelSource: "user",
        };
      }
      const envSmall = trimmed(this.env.ELIZAOS_CLOUD_SMALL_MODEL);
      const envLarge = trimmed(this.env.ELIZAOS_CLOUD_LARGE_MODEL);
      if (envSmall || envLarge) {
        return {
          smallModel: envSmall ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
          largeModel: envLarge ?? DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
          modelSource: "environment",
        };
      }
      return {
        smallModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
        largeModel: DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
        modelSource: "provider-default",
      };
    }
    const direct = resolveDirectProviderModelEnv(state.config);
    if (!direct) {
      return { smallModel: null, largeModel: null, modelSource: "unknown" };
    }
    const smallModel =
      direct.assignments[direct.smallKey] ?? trimmed(this.env[direct.smallKey]);
    const largeModel =
      direct.assignments[direct.largeKey] ?? trimmed(this.env[direct.largeKey]);
    const modelSource = Object.keys(direct.assignments).length
      ? "user"
      : smallModel || largeModel
        ? "environment"
        : "provider-default";
    return { smallModel, largeModel, modelSource };
  }

  private async latestOperation(): Promise<ModelSettingsOperationDto | null> {
    if (!this.deps.operations) return null;
    const operations = await this.deps.operations.list({
      includeTerminal: true,
    });
    const latest = operations.find((op) => op.kind === "provider-switch");
    if (latest?.intent.kind !== "provider-switch") return null;
    return {
      id: latest.id,
      provider: latest.intent.provider,
      state: operationState(latest),
      error: latest.error?.message ?? null,
    };
  }

  async getStatus(state: ModelSettingsState): Promise<ModelSettingsStatusDto> {
    const provider = resolveActiveModelProvider(state.config);
    const providers = MODEL_PROVIDER_IDS.map((id) =>
      this.providerStatus(id, state),
    );
    const activeStatus =
      provider === "other"
        ? null
        : providers.find((entry) => entry.id === provider);
    const llmText = resolveServiceRoutingInConfig(
      state.config as Record<string, unknown>,
    )?.llmText;
    const runtimeProviderName = state.runtime
      ? trimmed(state.runtime.getSetting("ELIZA_BRAIN_PROVIDER"))
      : null;
    return {
      active: {
        provider,
        providerLabel:
          provider === "other"
            ? (getFirstRunProviderOption(llmText?.backend)?.name ??
              trimmed(llmText?.backend) ??
              "Not configured")
            : PROVIDER_LABEL[provider],
        runtimeProviderName,
        ...this.activeModels(provider, state),
        endpoint: activeStatus?.endpoint ?? null,
        health: uncheckedHealth(),
      },
      providers,
      operation: await this.latestOperation(),
      managedByCloud: this.isCloudProvisioned(),
    };
  }

  async listModels(
    provider: ModelProviderId,
    state: ModelSettingsState,
  ): Promise<ProviderModelCatalogDto> {
    if (provider === "elizacloud" || provider === "local") {
      return { provider, state: "not-listable" };
    }
    let apiKey: string | null = null;
    let baseUrl: string;
    if (provider === "ollama") {
      baseUrl = ollamaEndpoint(this.env).url;
    } else {
      const stored = this.credential(provider, state);
      if (!stored) return { provider, state: "missing-credential" };
      apiKey = stored.value;
      baseUrl =
        provider === "grok"
          ? XAI_API_BASE
          : provider === "openai"
            ? openAiEndpoint(
                state.config,
                this.env,
                resolveActiveModelProvider(state.config),
              ).url
            : DEFAULT_OPENAI_ENDPOINT;
    }
    const probe = await this.fetchCatalog(provider, { apiKey, baseUrl });
    const fetchedAt = this.now().toISOString();
    switch (probe.state) {
      case "ok": {
        const models = toCatalogOptions(probe.models);
        return models.length > 0
          ? { provider, state: "ok", models, fetchedAt }
          : { provider, state: "no-models", fetchedAt };
      }
      case "no-models":
        return { provider, state: "no-models", fetchedAt };
      case "unreachable":
      case "auth-failed":
        return {
          provider,
          state: probe.state,
          detail: probe.detail,
          fetchedAt,
        };
    }
  }

  /**
   * Validate an activation against live state and start it. Throws an
   * `ElizaError` whose code is a key of {@link MODEL_SETTINGS_ERROR_STATUS}.
   */
  async activate(
    request: PostActivateModelRequest,
    state: ModelSettingsState,
    options: { idempotencyKey?: string } = {},
  ): Promise<ModelActivationOutcome> {
    const { provider } = request;
    const smallModel = request.smallModel ?? null;
    const largeModel = request.largeModel ?? null;
    const context = { provider };

    if (this.isCloudProvisioned()) {
      throw modelSettingsError(
        "MODEL_SETTINGS_MANAGED_BY_CLOUD",
        "Eliza Cloud manages this agent's models; switch them from your Eliza Cloud account.",
        context,
      );
    }
    if (provider === "elizacloud" && resolveDevCloudEnvAuthority()) {
      throw modelSettingsError(
        "DEV_CLOUD_AUTHORITY_ACTIVE",
        "Cloud provider activation is owned by the immutable local dev launch target; restart with the intended target and credential.",
        context,
      );
    }
    if (provider === "elizacloud" && (smallModel || largeModel)) {
      throw modelSettingsError(
        "MODEL_SELECTION_UNSUPPORTED",
        "Eliza Cloud models are chosen in the Eliza Cloud model routing settings.",
        context,
      );
    }
    if (
      providerRequiresModelSelection(provider) &&
      (!smallModel || !largeModel)
    ) {
      throw modelSettingsError(
        "MODEL_REQUIRED",
        `${PROVIDER_LABEL[provider]} has no default models; choose a small and a large model from its catalog.`,
        context,
      );
    }
    const pluginName = PROVIDER_PLUGIN[provider];
    if (!this.isPluginInstalled(pluginName)) {
      throw modelSettingsError(
        "PROVIDER_PLUGIN_MISSING",
        `${PROVIDER_LABEL[provider]} is unavailable because ${pluginName} is not installed.`,
        { ...context, pluginName },
      );
    }
    if (provider !== "ollama" && !this.credential(provider, state)) {
      throw modelSettingsError(
        "CREDENTIAL_REQUIRED",
        provider === "elizacloud"
          ? "Sign in to Eliza Cloud before switching to it."
          : `Add a ${PROVIDER_LABEL[provider]} API key in Settings → Accounts before switching to it.`,
        context,
      );
    }
    if (smallModel || largeModel) {
      await this.assertModelsInCatalog(
        provider as "openai" | "anthropic" | "grok" | "ollama",
        [smallModel, largeModel].filter((id): id is string => id !== null),
        state,
      );
    }

    const selection = { provider, smallModel, largeModel };
    if (!this.deps.operations) {
      await applyModelSelectionToConfig(state.config, selection, this.env);
      this.deps.saveConfig(state.config);
      logger.info(
        { provider, smallModel, largeModel },
        "[model-settings] Selection persisted for the next boot (no API host)",
      );
      return { kind: "persisted", provider };
    }

    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider,
      modelSelection: { smallModel, largeModel },
    };
    const outcome = await this.deps.operations.start({
      intent,
      idempotencyKey: options.idempotencyKey,
      prepare: async () => {
        await applyModelSelectionToConfig(state.config, selection, this.env);
        this.deps.saveConfig(state.config);
        return intent;
      },
    });
    if (outcome.kind === "rejected-busy") {
      throw modelSettingsError(
        "OPERATION_IN_PROGRESS",
        "Another provider change is still applying; try again when it finishes.",
        { ...context, activeOperationId: outcome.activeOperationId },
      );
    }
    logger.info(
      {
        provider,
        smallModel,
        largeModel,
        operationId: outcome.operation.id,
        outcome: outcome.kind,
      },
      "[model-settings] Provider activation started",
    );
    return { kind: outcome.kind, provider, operationId: outcome.operation.id };
  }

  private async assertModelsInCatalog(
    provider: "openai" | "anthropic" | "grok" | "ollama",
    modelIds: string[],
    state: ModelSettingsState,
  ): Promise<void> {
    const catalog = await this.listModels(provider, state);
    if (catalog.state !== "ok") {
      throw modelSettingsError(
        "MODEL_CATALOG_UNAVAILABLE",
        `Could not confirm the chosen models: the ${PROVIDER_LABEL[provider]} model list is ${catalog.state}.`,
        { provider, catalogState: catalog.state },
      );
    }
    const known = new Set(catalog.models.map((model) => model.id));
    const unknown = modelIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw modelSettingsError(
        "MODEL_NOT_IN_CATALOG",
        `${PROVIDER_LABEL[provider]} does not offer ${unknown.join(", ")}.`,
        { provider, unknown },
      );
    }
  }
}
