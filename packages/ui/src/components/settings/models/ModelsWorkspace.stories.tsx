/**
 * Storybook states for the Models workspace renderer: loading, error,
 * owner-only, designed-empty, ready with a live catalog, Grok's required model
 * choice, an unreachable LAN Ollama, a restart in progress, a failed switch,
 * and the read-only Eliza-Cloud-managed state. Pure fixtures; no backend.
 */

import type { Meta, StoryObj } from "@storybook/react";
import {
  ModelsWorkspaceView,
  type ModelsWorkspaceViewProps,
} from "./ModelsWorkspace";
import {
  GROK_CATALOG_FIXTURE,
  OLLAMA_UNREACHABLE_FIXTURE,
  OPENAI_CATALOG_FIXTURE,
  providerFixtures,
  statusFixture,
  unconfiguredStatusFixture,
} from "./model-settings.fixtures";

const noop = () => {};

const baseArgs: ModelsWorkspaceViewProps = {
  status: { state: "ready", data: statusFixture(), reconnecting: false },
  catalogs: { openai: { state: "ready", catalog: OPENAI_CATALOG_FIXTURE } },
  activation: { state: "idle" },
  selectedProvider: "openai",
  draft: { smallModel: null, largeModel: null },
  confirming: false,
  onSelectProvider: noop,
  onDraftChange: noop,
  onReloadCatalog: noop,
  onRequestActivate: noop,
  onConfirmActivate: noop,
  onCancelActivate: noop,
  onRetry: noop,
};

const meta = {
  title: "Settings/ModelsWorkspace",
  component: ModelsWorkspaceView,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: baseArgs,
} satisfies Meta<typeof ModelsWorkspaceView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** OpenAI is active; its live catalog is loaded and nothing is pending. */
export const Ready: Story = {};

export const Loading: Story = {
  args: { status: { state: "loading" } },
};

export const LoadError: Story = {
  args: {
    status: {
      state: "error",
      message: "Network request failed",
      ownerOnly: false,
    },
  },
};

export const OwnerOnly: Story = {
  args: {
    status: {
      state: "error",
      message: "Model settings are available to the owner only.",
      ownerOnly: true,
    },
  },
};

/** Designed-empty: no provider has been set up yet. */
export const NothingConfigured: Story = {
  args: {
    status: {
      state: "ready",
      data: unconfiguredStatusFixture(),
      reconnecting: false,
    },
    selectedProvider: null,
    catalogs: {},
  },
};

/** Grok has no default models, so both tiers must be chosen first. */
export const GrokNeedsModels: Story = {
  args: {
    selectedProvider: "grok",
    catalogs: { grok: { state: "ready", catalog: GROK_CATALOG_FIXTURE } },
    draft: { smallModel: "grok-4-fast", largeModel: null },
  },
};

export const OllamaUnreachable: Story = {
  args: {
    selectedProvider: "ollama",
    catalogs: {
      ollama: { state: "ready", catalog: OLLAMA_UNREACHABLE_FIXTURE },
    },
  },
};

export const KeyMissing: Story = {
  args: { selectedProvider: "anthropic", catalogs: {} },
};

export const PluginMissing: Story = {
  args: {
    status: {
      state: "ready",
      data: statusFixture({
        providers: providerFixtures({ anthropic: { pluginInstalled: false } }),
      }),
      reconnecting: false,
    },
    selectedProvider: "anthropic",
  },
};

export const Restarting: Story = {
  args: {
    status: {
      state: "ready",
      data: statusFixture({
        operation: {
          id: "op-1",
          provider: "grok",
          state: "applying",
          error: null,
        },
      }),
      reconnecting: true,
    },
    activation: { state: "accepted", provider: "grok", operationId: "op-1" },
  },
};

export const SwitchFailed: Story = {
  args: {
    status: {
      state: "ready",
      data: statusFixture({
        operation: {
          id: "op-2",
          provider: "anthropic",
          state: "failed",
          error: "Cold restart returned null runtime",
        },
      }),
      reconnecting: false,
    },
    activation: {
      state: "error",
      provider: "openai",
      code: "OPERATION_IN_PROGRESS",
      message:
        "Another provider change is still applying; try again when it finishes.",
    },
  },
};

export const ManagedByCloud: Story = {
  args: {
    status: {
      state: "ready",
      data: statusFixture({ managedByCloud: true }),
      reconnecting: false,
    },
  },
};

export const ConfirmingSwitch: Story = {
  args: {
    selectedProvider: "grok",
    catalogs: { grok: { state: "ready", catalog: GROK_CATALOG_FIXTURE } },
    draft: { smallModel: "grok-4-fast", largeModel: "grok-4" },
    confirming: true,
  },
};
