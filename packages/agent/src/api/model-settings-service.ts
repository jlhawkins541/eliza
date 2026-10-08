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
 * (`projectDirectProviderModelSelection`) reaches the provider plugins.
 * Without an operation manager (a headless runtime with no API host) the same
 * config mutation is persisted for the next boot, and the running process's
 * model env is left as it is.
 *
 * Failures are typed `ElizaError`s whose codes the route layer maps to HTTP
 * statuses; nothing here fabricates a healthy-looking default.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { listAccounts } from "@elizaos/auth/account-storage";
import type { DirectAccountProvider } from "@elizaos/auth/types";
import {
  ElizaError,
  logger,
  type ServiceRouteAccountStrategy,
} from "@elizaos/core";
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
  MODEL_REQUIRED_PROVIDER_IDS,
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
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
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

/**
 * Plugin package a Models-page provider is served by: the first-run catalog's
 * mapping (the same one boot resolves the preferred provider plugin from), and
 * the on-device runtime, which is not a first-run catalog provider.
 */
export function providerPluginName(provider: ModelProviderId): string {
  if (provider === "local") return "@elizaos/plugin-local-inference";
  const option = getFirstRunProviderOption(provider);
  if (!option) {
    throw new ElizaError(
      `[model-settings] The provider catalog has no entry for ${provider}`,
      { code: "MODEL_SETTINGS_PROVIDER_UNRESOLVED", context: { provider } },
    );
  }
  return option.pluginName;
}

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

/** The slice of the host account pool the credential reader consults. */
export interface AccountPoolSelector {
  list(providerId?: string): ReadonlyArray<{ id: string; enabled?: boolean }>;
  /** Non-mutating "which account is next" dry run; absent on older hosts. */
  selectionState?(
    providerId: string,
    strategy?: ServiceRouteAccountStrategy,
  ): { activeAccountId: string | null; reason: string | null };
}

function accountStrategy(
  config: ElizaConfig,
  accountProvider: DirectAccountProvider,
): ServiceRouteAccountStrategy {
  const strategies = (
    config as {
      accountStrategies?: Partial<Record<string, ServiceRouteAccountStrategy>>;
    }
  ).accountStrategies;
  return strategies?.[accountProvider] ?? "priority";
}

/**
 * The stored key of the account the pool would export for `accountProvider`:
 * the pool's own dry-run selection (the row the Accounts panel labels
 * active), so a disabled, unhealthy, or unlinked account is never reported.
 * Null when the pool would export none of the stored accounts.
 */
export function selectPooledCredential(
  accountProvider: DirectAccountProvider,
  records: ReadonlyArray<{
    id: string;
    updatedAt: number;
    credentials: { access: string };
  }>,
  pool: AccountPoolSelector,
  strategy: ServiceRouteAccountStrategy,
): string | null {
  const withKey = records.filter(
    (record) => trimmed(record.credentials.access) !== null,
  );
  if (pool.selectionState) {
    const activeId = pool.selectionState(
      accountProvider,
      strategy,
    ).activeAccountId;
    const selected = withKey.find((record) => record.id === activeId);
    return selected ? selected.credentials.access.trim() : null;
  }
  const enabled = new Set(
    pool
      .list(accountProvider)
      .filter((account) => account.enabled !== false)
      .map((account) => account.id),
  );
  const newest = withKey
    .filter((record) => enabled.has(record.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return newest ? newest.credentials.access.trim() : null;
}

/**
 * Production credential reader. The account pool is the authority for direct
 * keys: a stored account counts only when the pool would export it, and only
 * when a pool is installed at all (a host without one never exports stored
 * accounts). Launch env is consulted only when it is not another provider's
 * OpenAI/Anthropic-compatible alias (the account pool exports the active xAI
 * key as `OPENAI_API_KEY` with an x.ai base URL, and Cloud inference reuses
 * the `*_BASE_URL` pair for its proxy), and for Grok only while xAI has no
 * stored accounts, because the pool ignores launch env for its compatibility
 * alias once accounts exist.
 */
export function readProviderCredential(
  provider: ModelProviderId,
  context: {
    config: ElizaConfig;
    env: NodeJS.ProcessEnv;
    activeProvider: ModelProviderId | "other";
    pool: AccountPoolSelector | null;
  },
): StoredProviderCredential | null {
  const { config, env, activeProvider, pool } = context;
  if (provider === "elizacloud") {
    const cloud = config.cloud as { apiKey?: unknown } | undefined;
    const value = trimmed(cloud?.apiKey) ?? trimmed(env.ELIZAOS_CLOUD_API_KEY);
    return value ? { value, source: "cloud-account" } : null;
  }
  if (provider !== "openai" && provider !== "anthropic" && provider !== "grok")
    return null;

  const accountProvider = KEYED_PROVIDER_ACCOUNT[provider];
  const records = listAccounts(accountProvider);
  if (pool && records.length > 0) {
    const pooled = selectPooledCredential(
      accountProvider,
      records,
      pool,
      accountStrategy(config, accountProvider),
    );
    if (pooled) return { value: pooled, source: "account-pool" };
    if (provider === "grok") return null;
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
 * Whether a provider plugin package can be loaded in this process, from the
 * same sources the plugin resolver loads from: the static registry (the only
 * source in a mobile bundle), an install record in config (plugins installed
 * into the state dir), or a `node_modules` directory on this module's
 * resolution path. Uses package directories rather than export maps, which
 * differ between ESM-only and dual packages.
 */
export function isProviderPluginInstalled(
  pluginName: string,
  config?: ElizaConfig,
): boolean {
  if (
    STATIC_ELIZA_PLUGINS[pluginName] ||
    STATIC_ELIZA_PLUGIN_LOADERS[pluginName]
  )
    return true;
  if (isMobilePlatform()) return false;
  const installPath = config?.plugins?.installs?.[pluginName]?.installPath;
  if (typeof installPath === "string" && existsSync(installPath)) return true;
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
  isPluginInstalled?: (pluginName: string, config: ElizaConfig) => boolean;
  fetchCatalog?: ModelCatalogFetcher;
  isCloudProvisioned?: () => boolean;
  /** The host account pool; defaults to the agent host bridge's pool. */
  accountPool?: () => AccountPoolSelector | null;
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

interface ActiveTierModel {
  model: string | null;
  source: ModelSettingsStatusDto["active"]["smallModelSource"];
}

/**
 * One tier's effective model: the owner's pick, then the launch environment,
 * then the provider's built-in default. A provider whose default id this host
 * does not know reports `provider-default` with a null id.
 */
function activeTier(
  picked: string | null,
  fromEnv: string | null,
  providerDefault: string | null,
): ActiveTierModel {
  if (picked) return { model: picked, source: "user" };
  if (fromEnv) return { model: fromEnv, source: "environment" };
  return { model: providerDefault, source: "provider-default" };
}

export class ModelSettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly readCredential: typeof readProviderCredential;
  private readonly isPluginInstalled: (
    pluginName: string,
    config: ElizaConfig,
  ) => boolean;
  private readonly fetchCatalog: ModelCatalogFetcher;
  private readonly isCloudProvisioned: () => boolean;
  private readonly accountPool: () => AccountPoolSelector | null;
  private readonly now: () => Date;

  constructor(private readonly deps: ModelSettingsServiceDeps) {
    this.env = deps.env ?? process.env;
    this.readCredential = deps.readCredential ?? readProviderCredential;
    this.isPluginInstalled =
      deps.isPluginInstalled ?? isProviderPluginInstalled;
    this.fetchCatalog = deps.fetchCatalog ?? fetchProviderModelCatalog;
    this.isCloudProvisioned =
      deps.isCloudProvisioned ?? isCloudProvisionedContainer;
    this.accountPool =
      deps.accountPool ??
      (() =>
        getAgentHostBridge().getDefaultAccountPool() as AccountPoolSelector | null);
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
      pool: this.accountPool(),
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
      pluginInstalled: this.isPluginInstalled(
        providerPluginName(provider),
        state.config,
      ),
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
    "smallModel" | "largeModel" | "smallModelSource" | "largeModelSource"
  > {
    const tiers = (
      small: ActiveTierModel,
      large: ActiveTierModel,
    ): ReturnType<ModelSettingsService["activeModels"]> => ({
      smallModel: small.model,
      largeModel: large.model,
      smallModelSource: small.source,
      largeModelSource: large.source,
    });
    if (provider === "elizacloud") {
      const llmText = state.config.serviceRouting?.llmText;
      const models = state.config.models as
        | { small?: unknown; large?: unknown }
        | undefined;
      return tiers(
        activeTier(
          trimmed(llmText?.smallModel) ?? trimmed(models?.small),
          trimmed(this.env.ELIZAOS_CLOUD_SMALL_MODEL),
          DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
        ),
        activeTier(
          trimmed(llmText?.largeModel) ?? trimmed(models?.large),
          trimmed(this.env.ELIZAOS_CLOUD_LARGE_MODEL),
          DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
        ),
      );
    }
    const direct = resolveDirectProviderModelEnv(state.config);
    if (!direct) {
      const unknown: ActiveTierModel = { model: null, source: "unknown" };
      return tiers(unknown, unknown);
    }
    // A provider without built-in model ids runs only the owner's picks; the
    // shared OpenAI-compatible env keys may hold another provider's ids.
    const requiresPicks = (
      MODEL_REQUIRED_PROVIDER_IDS as readonly string[]
    ).includes(direct.provider);
    const tierFor = (key: string): ActiveTierModel => {
      const picked = direct.assignments[key];
      if (picked) return { model: picked, source: "user" };
      if (requiresPicks) return { model: null, source: "unknown" };
      return activeTier(null, trimmed(this.env[key]), null);
    };
    return tiers(tierFor(direct.smallKey), tierFor(direct.largeKey));
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
              trimmed(llmText?.backend))
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
    const pluginName = providerPluginName(provider);
    if (!this.isPluginInstalled(pluginName, state.config)) {
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
      // Persisted for the next boot: the loaded provider plugin keeps serving
      // from this process's env until then, so the model projection goes to a
      // scratch copy and only the saved config changes. Boot re-projects it.
      await applyModelSelectionToConfig(state.config, selection, {
        ...this.env,
      });
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
