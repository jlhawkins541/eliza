// @vitest-environment jsdom
/**
 * Owner gate and shared-workspace seam of the `/models` page. Renders the real
 * page, RoleGate, and Models workspace against an in-memory model-settings
 * API; the shell agent-surface wrapper and the heavy existing provider groups
 * are stubs.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleProvider } from "../../hooks/useRole";
import {
  OPENAI_CATALOG_FIXTURE,
  statusFixture,
} from "../settings/models/model-settings.fixtures";
import type { ModelSettingsApi } from "../settings/models/useModelSettings";
import { ModelsPageView } from "./ModelsPageView";

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../settings/ProviderSwitcher", () => ({
  ProviderSwitcher: () => <div data-testid="provider-switcher-stub" />,
}));

afterEach(cleanup);

function fixtureApi(): ModelSettingsApi {
  return {
    getModelSettings: vi.fn(async () => statusFixture()),
    listProviderModels: vi.fn(async () => OPENAI_CATALOG_FIXTURE),
    activateModel: vi.fn(async (request) => ({
      operationId: "op",
      provider: request.provider,
      deduped: false,
    })),
  };
}

describe("ModelsPageView", () => {
  it("renders the shared Models workspace for the owner", async () => {
    const api = fixtureApi();
    render(
      // `role` is an Eliza authorization tier, not an ARIA role.
      // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier.
      <RoleProvider role="OWNER">
        <ModelsPageView api={api} />
      </RoleProvider>,
    );
    expect(
      screen.getByText(/Choose which AI provider and models Eliza uses/),
    ).toBeTruthy();
    expect(await screen.findByTestId("models-active-card")).toBeTruthy();
    // The active provider's live catalog fills the picker.
    expect(await screen.findByTestId("models-small-select")).toBeTruthy();
    expect(screen.getByTestId("provider-switcher-stub")).toBeTruthy();
    expect(
      screen
        .getByTestId("models-page")
        .getAttribute("data-chat-clearance-aware"),
    ).toBe("true");
  });

  it("fails closed for lower-tier roles without calling the API", () => {
    const api = fixtureApi();
    render(
      // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier.
      <RoleProvider role="ADMIN">
        <ModelsPageView api={api} />
      </RoleProvider>,
    );
    expect(screen.getByText(/workspace owner only/i)).toBeTruthy();
    expect(screen.queryByTestId("models-workspace")).toBeNull();
    expect(api.getModelSettings).not.toHaveBeenCalled();
  });
});
