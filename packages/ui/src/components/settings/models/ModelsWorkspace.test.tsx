// @vitest-environment jsdom
/**
 * Behavior of the Models workspace: the loading, designed-empty, error,
 * owner-only, and Eliza-Cloud-managed states, the key-masked provider tiles,
 * and the switch flow through the confirm dialog to the activation request.
 * Renders the real controller, hook, translator, and primitives against an
 * in-memory model-settings API; the agent surface is captured so selects are
 * driven through their chat-control `onFill` binding, and the heavy existing
 * provider groups are a stub.
 */

import {
  ModelSettingsStatusSchema,
  type PostActivateModelRequest,
  ProviderModelCatalogSchema,
} from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api";
import {
  GROK_CATALOG_FIXTURE,
  OLLAMA_UNREACHABLE_FIXTURE,
  OPENAI_CATALOG_FIXTURE,
  statusFixture,
  unconfiguredStatusFixture,
} from "./model-settings.fixtures";
import type { ModelSettingsApi } from "./useModelSettings";

const agentElements = vi.hoisted(
  () => new Map<string, { onFill?: (value: string) => void }>(),
);

vi.mock("../../../agent-surface", () => ({
  useAgentElement: (spec: { id: string; onFill?: (v: string) => void }) => {
    agentElements.set(spec.id, { onFill: spec.onFill });
    return { ref: undefined, agentProps: { "data-agent-id": spec.id } };
  },
}));

vi.mock("../ProviderSwitcher", () => ({
  ProviderSwitcher: () => <div data-testid="provider-switcher-stub" />,
}));

import { ModelsSettingsSection, ModelsWorkspaceView } from "./ModelsWorkspace";

afterEach(() => {
  cleanup();
  agentElements.clear();
});

function fixtureApi(
  overrides: Partial<ModelSettingsApi> = {},
): ModelSettingsApi & {
  activations: PostActivateModelRequest[];
} {
  const activations: PostActivateModelRequest[] = [];
  return {
    activations,
    getModelSettings: vi.fn(async () => statusFixture()),
    listProviderModels: vi.fn(async (provider) =>
      provider === "grok"
        ? GROK_CATALOG_FIXTURE
        : provider === "ollama"
          ? OLLAMA_UNREACHABLE_FIXTURE
          : OPENAI_CATALOG_FIXTURE,
    ),
    activateModel: vi.fn(async (request: PostActivateModelRequest) => {
      activations.push(request);
      return {
        operationId: "op-test",
        provider: request.provider,
        deduped: false,
      };
    }),
    ...overrides,
  };
}

describe("model settings fixtures", () => {
  it("satisfy the shared wire schemas", () => {
    expect(() =>
      ModelSettingsStatusSchema.parse(statusFixture()),
    ).not.toThrow();
    expect(() =>
      ModelSettingsStatusSchema.parse(unconfiguredStatusFixture()),
    ).not.toThrow();
    for (const catalog of [
      OPENAI_CATALOG_FIXTURE,
      GROK_CATALOG_FIXTURE,
      OLLAMA_UNREACHABLE_FIXTURE,
    ]) {
      expect(() => ProviderModelCatalogSchema.parse(catalog)).not.toThrow();
    }
  });
});

describe("ModelsSettingsSection", () => {
  it("shows loading, then the active provider with masked key tiles", async () => {
    let resolveStatus: (value: ReturnType<typeof statusFixture>) => void =
      () => {};
    const api = fixtureApi({
      getModelSettings: vi.fn(
        () =>
          new Promise<ReturnType<typeof statusFixture>>((resolve) => {
            resolveStatus = resolve;
          }),
      ),
    });
    render(<ModelsSettingsSection api={api} />);

    expect(screen.getByTestId("models-loading")).toBeTruthy();
    // The existing provider groups never wait on this status.
    expect(screen.getByTestId("provider-switcher-stub")).toBeTruthy();

    await act(async () => resolveStatus(statusFixture()));

    const card = await screen.findByTestId("models-active-card");
    expect(card.textContent).toContain("OpenAI");
    expect(card.textContent).toContain("gpt-5.6-luna");
    expect(card.textContent).toContain("gpt-5.6-sol");
    expect(screen.getByTestId("models-provider-grok").textContent).toContain(
      "Key ••••abcd",
    );
    expect(
      screen.getByTestId("models-provider-anthropic").textContent,
    ).toContain("Add a key in Accounts");
    expect(screen.getByTestId("models-provider-ollama").textContent).toContain(
      "Local network · not encrypted",
    );
    // The active provider's catalog is requested once status arrives.
    await waitFor(() =>
      expect(api.listProviderModels).toHaveBeenCalledWith("openai"),
    );
  });

  it("renders the designed-empty state when nothing is configured", async () => {
    render(
      <ModelsSettingsSection
        api={fixtureApi({
          getModelSettings: vi.fn(async () => unconfiguredStatusFixture()),
        })}
      />,
    );
    expect(
      await screen.findByText(/No model provider is set up yet/),
    ).toBeTruthy();
    expect(screen.queryByTestId("models-picker")).toBeNull();
  });

  it("shows a load error with a working retry", async () => {
    const getModelSettings = vi
      .fn<ModelSettingsApi["getModelSettings"]>()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValueOnce(statusFixture());
    render(<ModelsSettingsSection api={fixtureApi({ getModelSettings })} />);

    expect((await screen.findByTestId("models-error")).textContent).toContain(
      "Network request failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("models-active-card")).toBeTruthy();
    expect(getModelSettings).toHaveBeenCalledTimes(2);
  });

  it("shows the owner-only notice when the server refuses the caller", async () => {
    render(
      <ModelsSettingsSection
        api={fixtureApi({
          getModelSettings: vi.fn(async () => {
            throw new ApiError({
              kind: "http",
              path: "/api/model-settings",
              status: 403,
              code: "OWNER_REQUIRED",
              message: "Model settings are available to the owner only.",
            });
          }),
        })}
      />,
    );
    expect(await screen.findByText(/workspace owner only/)).toBeTruthy();
    expect(screen.queryByTestId("models-error")).toBeNull();
  });

  it("is read-only when Eliza Cloud manages the agent", async () => {
    render(
      <ModelsSettingsSection
        api={fixtureApi({
          getModelSettings: vi.fn(async () =>
            statusFixture({ managedByCloud: true }),
          ),
        })}
      />,
    );
    expect(await screen.findByTestId("models-managed-by-cloud")).toBeTruthy();
    expect(
      (screen.getByTestId("models-provider-grok") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByTestId("models-picker")).toBeNull();
    expect(screen.queryByTestId("provider-switcher-stub")).toBeNull();
  });

  it("switches to Grok only after both tiers are chosen and the restart is confirmed", async () => {
    const api = fixtureApi();
    render(<ModelsSettingsSection api={api} />);

    fireEvent.click(await screen.findByTestId("models-provider-grok"));
    await waitFor(() =>
      expect(api.listProviderModels).toHaveBeenCalledWith("grok"),
    );
    await screen.findByTestId("models-small-select");
    const activateButton = () =>
      screen.getByTestId("models-activate") as HTMLButtonElement;
    expect(activateButton().disabled).toBe(true);

    act(() => agentElements.get("models-grok-small")?.onFill?.("grok-4-fast"));
    expect(activateButton().disabled).toBe(true);
    act(() => agentElements.get("models-grok-large")?.onFill?.("grok-4"));
    expect(activateButton().disabled).toBe(false);

    fireEvent.click(activateButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch and restart" }),
    );

    await waitFor(() =>
      expect(api.activations).toEqual([
        { provider: "grok", smallModel: "grok-4-fast", largeModel: "grok-4" },
      ]),
    );
  });

  it("shows the server's refusal on the picker", async () => {
    const api = fixtureApi({
      activateModel: vi.fn(async () => {
        throw new ApiError({
          kind: "http",
          path: "/api/model-settings/activate",
          status: 409,
          code: "OPERATION_IN_PROGRESS",
          message:
            "Another provider change is still applying; try again when it finishes.",
        });
      }),
    });
    render(<ModelsSettingsSection api={api} />);
    await screen.findByTestId("models-small-select");

    fireEvent.click(screen.getByTestId("models-activate"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch and restart" }),
    );

    expect(
      (await screen.findByTestId("models-activation-error")).textContent,
    ).toContain("still applying");
  });

  it("keeps an unreachable Ollama distinct from an empty model list", async () => {
    render(<ModelsSettingsSection api={fixtureApi()} />);
    fireEvent.click(await screen.findByTestId("models-provider-ollama"));
    expect(await screen.findByText(/Could not reach Ollama/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload models" })).toBeTruthy();
  });
});

describe("ModelsWorkspaceView", () => {
  it("reports an in-flight restart and blocks another switch", () => {
    render(
      <ModelsWorkspaceView
        status={{
          state: "ready",
          data: statusFixture({
            operation: {
              id: "op-1",
              provider: "grok",
              state: "applying",
              error: null,
            },
          }),
          reconnecting: false,
        }}
        catalogs={{
          openai: { state: "ready", catalog: OPENAI_CATALOG_FIXTURE },
        }}
        activation={{ state: "idle" }}
        selectedProvider="openai"
        draft={{ smallModel: null, largeModel: null }}
        confirming={false}
        onSelectProvider={() => {}}
        onDraftChange={() => {}}
        onReloadCatalog={() => {}}
        onRequestActivate={() => {}}
        onConfirmActivate={() => {}}
        onCancelActivate={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByTestId("models-operation-progress").textContent,
    ).toContain("Switching to xAI Grok");
    expect(
      (screen.getByTestId("models-activate") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
