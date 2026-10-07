/**
 * Models workspace shared by the `/models` page and Settings → Models &
 * Providers: an "Eliza is using" card, one-tap provider tiles (OpenAI,
 * Anthropic, xAI Grok, Ollama, Eliza Cloud, on-device), and a small/large
 * model picker fed by the provider's live catalog. The existing provider
 * groups (accounts, voice, advanced) render below as `providerSettings`.
 *
 * `ModelsWorkspace` binds `useModelSettings`; `ModelsWorkspaceView` is the pure
 * renderer used by stories and tests. Loading, designed-empty (no provider set
 * up), error, owner-only, and Eliza-Cloud-managed are distinct states. Keys
 * are never entered here; tiles only report the stored key's last four
 * characters. The SETTINGS `update_ai_provider` action is the chat twin of the
 * switch button.
 */

import type {
  ModelProviderId,
  ModelProviderStatusDto,
  ModelSettingsStatusDto,
} from "@elizaos/shared";
import {
  Brain,
  Cloud,
  Cpu,
  Feather,
  type LucideIcon,
  Server,
  Sparkles,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../state/TranslationContext.hooks";
import { OwnerOnlyNotice } from "../../RoleGate";
import { Badge } from "../../ui/badge";
import { Banner } from "../../ui/banner";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Skeleton } from "../../ui/skeleton";
import { ProviderSwitcher } from "../ProviderSwitcher";
import { SettingsSelectRow } from "../settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "../settings-layout";
import {
  type ModelActivationState,
  type ModelSettingsApi,
  type ModelSettingsLoadState,
  type ProviderCatalogLoadState,
  useModelSettings,
} from "./useModelSettings";

type Translator = (key: string, vars?: Record<string, unknown>) => string;

/** Select value for "use the provider's built-in default". */
export const PROVIDER_DEFAULT_MODEL = "__provider-default__";

export interface ModelDraft {
  smallModel: string | null;
  largeModel: string | null;
}

const PROVIDER_ICONS: Record<ModelProviderId, LucideIcon> = {
  openai: Sparkles,
  anthropic: Feather,
  grok: Zap,
  ollama: Server,
  elizacloud: Cloud,
  local: Cpu,
};

function transportLabel(
  transport: NonNullable<ModelProviderStatusDto["endpoint"]>["transport"],
  t: Translator,
): string {
  switch (transport) {
    case "https":
      return t("models.endpoint.https", { defaultValue: "Encrypted" });
    case "http-loopback":
      return t("models.endpoint.loopback", { defaultValue: "This device" });
    case "http-private":
      return t("models.endpoint.private", {
        defaultValue: "Local network · not encrypted",
      });
    case "http-public":
      return t("models.endpoint.public", {
        defaultValue: "Internet · not encrypted",
      });
    case "invalid":
      return t("models.endpoint.invalid", { defaultValue: "Invalid address" });
  }
}

interface TileStatus {
  tone: "ok" | "warn" | "muted";
  label: string;
}

function providerTileStatus(
  provider: ModelProviderStatusDto,
  t: Translator,
): TileStatus {
  if (!provider.pluginInstalled) {
    return {
      tone: "warn",
      label: t("models.tile.pluginMissing", {
        defaultValue: "Plugin not installed",
      }),
    };
  }
  if (provider.id === "local") {
    return {
      tone: "muted",
      label: t("models.tile.onDevice", { defaultValue: "Runs on this device" }),
    };
  }
  if (provider.credential.state === "missing") {
    return {
      tone: "warn",
      label:
        provider.id === "elizacloud"
          ? t("models.tile.signInRequired", {
              defaultValue: "Sign in to Eliza Cloud",
            })
          : t("models.tile.keyMissing", {
              defaultValue: "Add a key in Accounts",
            }),
    };
  }
  if (provider.credential.state === "stored") {
    return {
      tone: "ok",
      label:
        provider.id === "elizacloud"
          ? t("models.tile.signedIn", { defaultValue: "Signed in" })
          : t("models.tile.keyStored", {
              defaultValue: "Key ••••{{last4}}",
              last4: provider.credential.last4,
            }),
    };
  }
  if (provider.endpoint) {
    return {
      tone: provider.endpoint.transport === "invalid" ? "warn" : "ok",
      label: transportLabel(provider.endpoint.transport, t),
    };
  }
  return {
    tone: "ok",
    label: t("models.tile.ready", { defaultValue: "Ready" }),
  };
}

const TONE_BADGE = {
  ok: "statusSuccess",
  warn: "statusWarning",
  muted: "statusMuted",
} as const;

function operationBanner(
  data: ModelSettingsStatusDto,
  reconnecting: boolean,
  t: Translator,
): ReactNode {
  const op = data.operation;
  const providerLabel =
    data.providers.find((entry) => entry.id === op?.provider)?.label ??
    op?.provider;
  if (op && (op.state === "pending" || op.state === "applying")) {
    return (
      <Banner variant="info" data-testid="models-operation-progress">
        {reconnecting
          ? t("models.operation.reconnecting", {
              defaultValue:
                "Switching to {{provider}}. Waiting for Eliza to come back online…",
              provider: providerLabel,
            })
          : t("models.operation.applying", {
              defaultValue: "Switching to {{provider}}. Eliza is restarting…",
              provider: providerLabel,
            })}
      </Banner>
    );
  }
  if (op?.state === "failed") {
    return (
      <Banner variant="error" data-testid="models-operation-failed">
        {t("models.operation.failed", {
          defaultValue: "The last switch to {{provider}} failed: {{error}}",
          provider: providerLabel,
          error:
            op.error ??
            t("models.operation.noDetail", {
              defaultValue: "no details were reported",
            }),
        })}
      </Banner>
    );
  }
  if (reconnecting) {
    return (
      <Banner variant="info">
        {t("models.operation.reconnectingIdle", {
          defaultValue: "Reconnecting to Eliza…",
        })}
      </Banner>
    );
  }
  return null;
}

function modelValueLabel(value: string | null, t: Translator): string {
  return (
    value ??
    t("models.active.providerDefault", { defaultValue: "Provider default" })
  );
}

function sourceLabel(
  source: ModelSettingsStatusDto["active"]["modelSource"],
  t: Translator,
): string {
  switch (source) {
    case "user":
      return t("models.source.user", { defaultValue: "Chosen here" });
    case "environment":
      return t("models.source.environment", {
        defaultValue: "Set by environment",
      });
    case "provider-default":
      return t("models.source.providerDefault", {
        defaultValue: "Provider default",
      });
    case "unknown":
      return t("models.source.unknown", { defaultValue: "Not reported" });
  }
}

export function ActiveBrainCard({
  data,
  reconnecting,
  t,
}: {
  data: ModelSettingsStatusDto;
  reconnecting: boolean;
  t: Translator;
}) {
  const { active } = data;
  const Icon =
    active.provider === "other" ? Brain : PROVIDER_ICONS[active.provider];
  const unconfigured =
    active.provider === "other" && active.runtimeProviderName === null;
  return (
    <SettingsGroup
      title={t("models.active.title", { defaultValue: "Eliza is using" })}
      data-testid="models-active-card"
    >
      <SettingsRow
        icon={Icon}
        iconClassName="text-accent"
        label={active.providerLabel}
        description={
          unconfigured
            ? t("models.active.empty", {
                defaultValue:
                  "No model provider is set up yet. Pick one below to give Eliza a brain.",
              })
            : active.runtimeProviderName
              ? t("models.active.runtime", {
                  defaultValue: "Serving through the {{name}} plugin",
                  name: active.runtimeProviderName,
                })
              : null
        }
        control={
          <Badge variant="metaAccent">
            {t("models.active.badge", { defaultValue: "Active" })}
          </Badge>
        }
      />
      {unconfigured ? null : (
        <>
          <SettingsRow
            label={t("models.active.smallModel", {
              defaultValue: "Small model",
            })}
            description={sourceLabel(active.modelSource, t)}
            control={
              <span className="break-all text-sm text-txt-strong">
                {modelValueLabel(active.smallModel, t)}
              </span>
            }
          />
          <SettingsRow
            label={t("models.active.largeModel", {
              defaultValue: "Large model",
            })}
            description={sourceLabel(active.modelSource, t)}
            control={
              <span className="break-all text-sm text-txt-strong">
                {modelValueLabel(active.largeModel, t)}
              </span>
            }
          />
          {active.endpoint ? (
            <SettingsRow
              label={t("models.active.endpoint", { defaultValue: "Endpoint" })}
              description={transportLabel(active.endpoint.transport, t)}
              control={
                <span className="break-all text-sm text-txt-strong">
                  {active.endpoint.url}
                </span>
              }
            />
          ) : null}
        </>
      )}
      <div className="px-5 pb-4 empty:hidden">
        {operationBanner(data, reconnecting, t)}
      </div>
    </SettingsGroup>
  );
}

export function ProviderQuickSwitch({
  providers,
  activeProvider,
  selectedProvider,
  disabled,
  onSelect,
  t,
}: {
  providers: ModelProviderStatusDto[];
  activeProvider: ModelSettingsStatusDto["active"]["provider"];
  selectedProvider: ModelProviderId | null;
  disabled: boolean;
  onSelect: (provider: ModelProviderId) => void;
  t: Translator;
}) {
  return (
    <SettingsGroup
      title={t("models.switch.title", { defaultValue: "Switch provider" })}
      description={t("models.switch.description", {
        defaultValue:
          "Pick who answers Eliza's chat. Keys stay in your encrypted Accounts.",
      })}
      bare
    >
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="models-provider-tiles"
      >
        {providers.map((provider) => {
          const Icon = PROVIDER_ICONS[provider.id];
          const status = providerTileStatus(provider, t);
          const isActive = provider.id === activeProvider;
          const isSelected = provider.id === selectedProvider;
          return (
            <Button
              key={provider.id}
              type="button"
              variant={
                isActive ? "surfaceAccent" : isSelected ? "outline" : "choice"
              }
              size="card"
              align="start"
              disabled={disabled}
              aria-pressed={isSelected}
              aria-current={isActive ? "true" : undefined}
              data-testid={`models-provider-${provider.id}`}
              onClick={() => onSelect(provider.id)}
              className="w-full"
            >
              <span className="flex w-full min-w-0 items-start gap-3">
                <Icon
                  className={
                    isActive
                      ? "mt-0.5 size-5 shrink-0 text-accent"
                      : "mt-0.5 size-5 shrink-0 text-muted"
                  }
                  aria-hidden
                />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className="text-sm font-medium text-txt-strong">
                    {provider.label}
                  </span>
                  <Badge
                    variant={isActive ? "metaAccent" : TONE_BADGE[status.tone]}
                  >
                    {isActive
                      ? t("models.active.badge", { defaultValue: "Active" })
                      : status.label}
                  </Badge>
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </SettingsGroup>
  );
}

function catalogProblem(
  catalog: ProviderCatalogLoadState | undefined,
  provider: ModelProviderStatusDto,
  t: Translator,
): string | null {
  if (catalog?.state !== "ready") return null;
  const result = catalog.catalog;
  switch (result.state) {
    case "ok":
    case "not-listable":
      return null;
    case "no-models":
      return provider.id === "ollama"
        ? t("models.catalog.noModelsOllama", {
            defaultValue:
              "Ollama is reachable but has no chat models. Pull one with `ollama pull`, then reload.",
          })
        : t("models.catalog.noModels", {
            defaultValue: "{{provider}} returned no chat models for this key.",
            provider: provider.label,
          });
    case "unreachable":
      return t("models.catalog.unreachable", {
        defaultValue: "Could not reach {{provider}}: {{detail}}",
        provider: provider.label,
        detail: result.detail,
      });
    case "auth-failed":
      return t("models.catalog.authFailed", {
        defaultValue:
          "{{provider}} rejected the stored key ({{detail}}). Replace it in Accounts.",
        provider: provider.label,
        detail: result.detail,
      });
    case "missing-credential":
      return t("models.catalog.missingCredential", {
        defaultValue: "Add a {{provider}} key in Accounts to list its models.",
        provider: provider.label,
      });
  }
}

export function ModelPicker({
  provider,
  isActive,
  catalog,
  draft,
  activation,
  operationBusy,
  onDraftChange,
  onReloadCatalog,
  onActivate,
  t,
}: {
  provider: ModelProviderStatusDto;
  isActive: boolean;
  catalog: ProviderCatalogLoadState | undefined;
  draft: ModelDraft;
  activation: ModelActivationState;
  operationBusy: boolean;
  onDraftChange: (tier: keyof ModelDraft, value: string | null) => void;
  onReloadCatalog: () => void;
  onActivate: () => void;
  t: Translator;
}) {
  const title = t("models.picker.title", {
    defaultValue: "{{provider}} models",
    provider: provider.label,
  });
  if (!provider.activatable) {
    return (
      <SettingsGroup title={title}>
        <SettingsRow
          label={t("models.picker.localTitle", {
            defaultValue: "On-device models",
          })}
          description={t("models.picker.localDescription", {
            defaultValue:
              "On-device models are downloaded and chosen in the Local section below.",
          })}
        />
      </SettingsGroup>
    );
  }
  const needsKey =
    provider.credential.state === "missing" && provider.id !== "elizacloud";
  const needsSignIn =
    provider.credential.state === "missing" && provider.id === "elizacloud";
  const listable = provider.id !== "elizacloud";
  const ready =
    catalog?.state === "ready" && catalog.catalog.state === "ok"
      ? catalog.catalog.models
      : null;
  const problem = catalogProblem(catalog, provider, t);
  const submitting =
    activation.state === "submitting" && activation.provider === provider.id;
  const activationError =
    activation.state === "error" && activation.provider === provider.id
      ? activation.message
      : null;
  const missingRequired =
    provider.requiresModelSelection && (!draft.smallModel || !draft.largeModel);
  const blocked =
    !provider.pluginInstalled ||
    needsKey ||
    needsSignIn ||
    missingRequired ||
    (listable && (draft.smallModel || draft.largeModel) && !ready) ||
    submitting ||
    operationBusy;

  const providerDefaultLabel = t("models.active.providerDefault", {
    defaultValue: "Provider default",
  });
  const options = (ready ?? []).map((model) => ({
    value: model.id,
    label: model.label,
    textValue: model.label,
  }));
  const tierOptions = provider.requiresModelSelection
    ? options
    : [
        {
          value: PROVIDER_DEFAULT_MODEL,
          label: providerDefaultLabel,
          textValue: providerDefaultLabel,
        },
        ...options,
      ];

  return (
    <SettingsGroup title={title} data-testid="models-picker">
      {!provider.pluginInstalled ? (
        <SettingsRow
          label={t("models.tile.pluginMissing", {
            defaultValue: "Plugin not installed",
          })}
          description={t("models.picker.pluginMissing", {
            defaultValue:
              "This build does not include the {{provider}} plugin, so Eliza cannot use it.",
            provider: provider.label,
          })}
        />
      ) : needsKey ? (
        <SettingsRow
          label={t("models.tile.keyMissing", {
            defaultValue: "Add a key in Accounts",
          })}
          description={t("models.picker.keyMissing", {
            defaultValue:
              "Add a {{provider}} API key in Accounts below. It is stored encrypted and never shown again.",
            provider: provider.label,
          })}
        />
      ) : needsSignIn ? (
        <SettingsRow
          label={t("models.tile.signInRequired", {
            defaultValue: "Sign in to Eliza Cloud",
          })}
          description={t("models.picker.signIn", {
            defaultValue: "Sign in to Eliza Cloud in the section below first.",
          })}
        />
      ) : !listable ? (
        <SettingsRow
          label={t("models.picker.cloudTitle", {
            defaultValue: "Models chosen by Eliza Cloud",
          })}
          description={t("models.picker.cloudDescription", {
            defaultValue:
              "Eliza Cloud routes each request to its own models; tune them in the Eliza Cloud section below.",
          })}
        />
      ) : catalog === undefined || catalog.state === "loading" ? (
        <div
          className="flex flex-col gap-2 px-5 py-4"
          aria-busy="true"
          data-testid="models-catalog-loading"
        >
          <span className="text-sm text-muted">
            {t("models.catalog.loading", { defaultValue: "Loading models…" })}
          </span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : catalog.state === "error" || problem ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <Banner variant={catalog.state === "error" ? "error" : "warning"}>
            {catalog.state === "error" ? catalog.message : problem}
          </Banner>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="self-start"
            onClick={onReloadCatalog}
          >
            {t("models.catalog.reload", { defaultValue: "Reload models" })}
          </Button>
        </div>
      ) : (
        <>
          <SettingsSelectRow
            agentId={`models-${provider.id}-small`}
            label={t("models.active.smallModel", {
              defaultValue: "Small model",
            })}
            description={t("models.picker.smallDescription", {
              defaultValue: "Fast replies, planning, and tool calls.",
            })}
            value={
              draft.smallModel ??
              (provider.requiresModelSelection ? "" : PROVIDER_DEFAULT_MODEL)
            }
            placeholder={t("models.picker.choose", {
              defaultValue: "Choose a model",
            })}
            options={tierOptions}
            onValueChange={(value) =>
              onDraftChange(
                "smallModel",
                value === PROVIDER_DEFAULT_MODEL ? null : value,
              )
            }
            testId="models-small-select"
          />
          <SettingsSelectRow
            agentId={`models-${provider.id}-large`}
            label={t("models.active.largeModel", {
              defaultValue: "Large model",
            })}
            description={t("models.picker.largeDescription", {
              defaultValue: "Long answers and harder reasoning.",
            })}
            value={
              draft.largeModel ??
              (provider.requiresModelSelection ? "" : PROVIDER_DEFAULT_MODEL)
            }
            placeholder={t("models.picker.choose", {
              defaultValue: "Choose a model",
            })}
            options={tierOptions}
            onValueChange={(value) =>
              onDraftChange(
                "largeModel",
                value === PROVIDER_DEFAULT_MODEL ? null : value,
              )
            }
            testId="models-large-select"
          />
        </>
      )}
      <div className="flex flex-col gap-3 px-5 py-4">
        {missingRequired && ready ? (
          <span className="text-xs text-muted">
            {t("models.picker.required", {
              defaultValue:
                "{{provider}} has no default models; choose both to switch.",
              provider: provider.label,
            })}
          </span>
        ) : null}
        {activationError ? (
          <Banner variant="error" data-testid="models-activation-error">
            {activationError}
          </Banner>
        ) : null}
        <Button
          type="button"
          variant="accentDarkHover"
          size="touch"
          className="self-start"
          disabled={Boolean(blocked)}
          onClick={onActivate}
          data-testid="models-activate"
        >
          {submitting
            ? t("models.picker.submitting", { defaultValue: "Switching…" })
            : isActive
              ? t("models.picker.apply", { defaultValue: "Apply models" })
              : t("models.picker.switch", {
                  defaultValue: "Switch Eliza to {{provider}}",
                  provider: provider.label,
                })}
        </Button>
      </div>
    </SettingsGroup>
  );
}

export interface ModelsWorkspaceViewProps {
  status: ModelSettingsLoadState;
  catalogs: Partial<Record<ModelProviderId, ProviderCatalogLoadState>>;
  activation: ModelActivationState;
  selectedProvider: ModelProviderId | null;
  draft: ModelDraft;
  confirming: boolean;
  onSelectProvider: (provider: ModelProviderId) => void;
  onDraftChange: (tier: keyof ModelDraft, value: string | null) => void;
  onReloadCatalog: (provider: ModelProviderId) => void;
  onRequestActivate: () => void;
  onConfirmActivate: () => void;
  onCancelActivate: () => void;
  onRetry: () => void;
  /** The existing account, voice, and advanced provider groups. */
  providerSettings?: ReactNode;
}

export function ModelsWorkspaceView({
  status,
  catalogs,
  activation,
  selectedProvider,
  draft,
  confirming,
  onSelectProvider,
  onDraftChange,
  onReloadCatalog,
  onRequestActivate,
  onConfirmActivate,
  onCancelActivate,
  onRetry,
  providerSettings,
}: ModelsWorkspaceViewProps) {
  const { t } = useTranslation();
  const managedByCloud = status.state === "ready" && status.data.managedByCloud;
  return (
    <SettingsStack data-testid="models-workspace">
      <ModelsStatusContent
        status={status}
        catalogs={catalogs}
        activation={activation}
        selectedProvider={selectedProvider}
        draft={draft}
        onSelectProvider={onSelectProvider}
        onDraftChange={onDraftChange}
        onReloadCatalog={onReloadCatalog}
        onRequestActivate={onRequestActivate}
        onRetry={onRetry}
        t={t}
      />
      {/* The account, voice, and advanced groups do not depend on this
          status, so a failed model-settings read never hides them. */}
      {managedByCloud ? null : providerSettings}
      <ConfirmDialog
        open={confirming}
        title={t("models.confirm.title", { defaultValue: "Switch provider?" })}
        message={t("models.confirm.message", {
          defaultValue:
            "Eliza restarts to load {{provider}}. Chat pauses for up to a minute.",
          provider:
            status.state === "ready"
              ? (status.data.providers.find(
                  (provider) => provider.id === selectedProvider,
                )?.label ?? "")
              : "",
        })}
        confirmLabel={t("models.confirm.confirm", {
          defaultValue: "Switch and restart",
        })}
        cancelLabel={t("models.confirm.cancel", { defaultValue: "Cancel" })}
        onConfirm={onConfirmActivate}
        onCancel={onCancelActivate}
      />
    </SettingsStack>
  );
}

function ModelsStatusContent({
  status,
  catalogs,
  activation,
  selectedProvider,
  draft,
  onSelectProvider,
  onDraftChange,
  onReloadCatalog,
  onRequestActivate,
  onRetry,
  t,
}: Pick<
  ModelsWorkspaceViewProps,
  | "status"
  | "catalogs"
  | "activation"
  | "selectedProvider"
  | "draft"
  | "onSelectProvider"
  | "onDraftChange"
  | "onReloadCatalog"
  | "onRequestActivate"
  | "onRetry"
> & { t: Translator }) {
  if (status.state === "loading") {
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        data-testid="models-loading"
      >
        <span className="text-sm text-muted">
          {t("models.loading", { defaultValue: "Loading model settings…" })}
        </span>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (status.state === "error") {
    if (status.ownerOnly) {
      return (
        <OwnerOnlyNotice
          message={t("models.ownerOnly", {
            defaultValue:
              "Model settings are available to the workspace owner only.",
          })}
        />
      );
    }
    return (
      <div className="flex flex-col gap-3" data-testid="models-error">
        <Banner variant="error">
          {t("models.error", {
            defaultValue: "Could not load model settings: {{message}}",
            message: status.message,
          })}
        </Banner>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          onClick={onRetry}
        >
          {t("models.retry", { defaultValue: "Try again" })}
        </Button>
      </div>
    );
  }

  const { data, reconnecting } = status;
  const operationBusy =
    data.operation !== null &&
    (data.operation.state === "pending" || data.operation.state === "applying");
  const selected =
    data.providers.find((provider) => provider.id === selectedProvider) ?? null;

  return (
    <>
      {data.managedByCloud ? (
        <Banner variant="info" data-testid="models-managed-by-cloud">
          {t("models.managedByCloud", {
            defaultValue:
              "Eliza Cloud manages this agent's models. Change them from your Eliza Cloud account.",
          })}
        </Banner>
      ) : null}
      <ActiveBrainCard data={data} reconnecting={reconnecting} t={t} />
      <ProviderQuickSwitch
        providers={data.providers}
        activeProvider={data.active.provider}
        selectedProvider={selectedProvider}
        disabled={data.managedByCloud}
        onSelect={onSelectProvider}
        t={t}
      />
      {selected && !data.managedByCloud ? (
        <ModelPicker
          provider={selected}
          isActive={selected.id === data.active.provider}
          catalog={catalogs[selected.id]}
          draft={draft}
          activation={activation}
          operationBusy={operationBusy}
          onDraftChange={onDraftChange}
          onReloadCatalog={() => onReloadCatalog(selected.id)}
          onActivate={onRequestActivate}
          t={t}
        />
      ) : null}
    </>
  );
}

function draftFromActive(
  data: ModelSettingsStatusDto,
  provider: ModelProviderId,
): ModelDraft {
  if (data.active.provider !== provider || data.active.modelSource !== "user") {
    return { smallModel: null, largeModel: null };
  }
  return {
    smallModel: data.active.smallModel,
    largeModel: data.active.largeModel,
  };
}

export interface ModelsWorkspaceProps {
  /** Client seam for stories and tests; defaults to the app client. */
  api?: ModelSettingsApi;
  providerSettings?: ReactNode;
}

export function ModelsWorkspace({
  api,
  providerSettings,
}: ModelsWorkspaceProps) {
  const controller = useModelSettings(api);
  const { status, catalogs, activation, loadCatalog, activate, refresh } =
    controller;
  const [selectedProvider, setSelectedProvider] =
    useState<ModelProviderId | null>(null);
  const [draft, setDraft] = useState<ModelDraft>({
    smallModel: null,
    largeModel: null,
  });
  const [confirming, setConfirming] = useState(false);

  const data = status.state === "ready" ? status.data : null;

  // Open the active provider's picker once status first arrives.
  useEffect(() => {
    if (!data || selectedProvider !== null) return;
    const active = data.active.provider;
    if (active === "other") return;
    setSelectedProvider(active);
    setDraft(draftFromActive(data, active));
    loadCatalog(active);
  }, [data, selectedProvider, loadCatalog]);

  const onSelectProvider = useCallback(
    (provider: ModelProviderId) => {
      setSelectedProvider(provider);
      if (data) setDraft(draftFromActive(data, provider));
      loadCatalog(provider);
    },
    [data, loadCatalog],
  );

  const onDraftChange = useCallback(
    (tier: keyof ModelDraft, value: string | null) => {
      setDraft((current) => ({ ...current, [tier]: value }));
    },
    [],
  );

  const onConfirmActivate = useCallback(() => {
    setConfirming(false);
    if (!selectedProvider || selectedProvider === "local") return;
    activate({
      provider: selectedProvider,
      ...(draft.smallModel ? { smallModel: draft.smallModel } : {}),
      ...(draft.largeModel ? { largeModel: draft.largeModel } : {}),
    });
  }, [activate, draft, selectedProvider]);

  return (
    <ModelsWorkspaceView
      status={status}
      catalogs={catalogs}
      activation={activation}
      selectedProvider={selectedProvider}
      draft={draft}
      confirming={confirming}
      onSelectProvider={onSelectProvider}
      onDraftChange={onDraftChange}
      onReloadCatalog={loadCatalog}
      onRequestActivate={() => setConfirming(true)}
      onConfirmActivate={onConfirmActivate}
      onCancelActivate={() => setConfirming(false)}
      onRetry={refresh}
      providerSettings={providerSettings}
    />
  );
}

/**
 * Settings → Models & Providers body and the `/models` page body: the
 * workspace above the existing account, voice, and advanced provider groups.
 */
export function ModelsSettingsSection({
  api,
}: {
  api?: ModelSettingsApi;
} = {}) {
  return <ModelsWorkspace api={api} providerSettings={<ProviderSwitcher />} />;
}
