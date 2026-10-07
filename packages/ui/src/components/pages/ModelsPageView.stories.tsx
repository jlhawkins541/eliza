/**
 * Storybook states for the owner-only `/models` page shell: the owner sees the
 * workspace (served by an in-memory fixture API, with the existing provider
 * groups under the mock app context), and a lower role sees the owner-only
 * notice. No backend.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { RoleProvider } from "../../hooks/useRole";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import {
  OPENAI_CATALOG_FIXTURE,
  statusFixture,
} from "../settings/models/model-settings.fixtures";
import type { ModelSettingsApi } from "../settings/models/useModelSettings";
import { ModelsPageView } from "./ModelsPageView";

const fixtureApi: ModelSettingsApi = {
  getModelSettings: async () => statusFixture(),
  listProviderModels: async () => OPENAI_CATALOG_FIXTURE,
  activateModel: async (request) => ({
    operationId: "story-operation",
    provider: request.provider,
    deduped: false,
  }),
};

const meta = {
  title: "Pages/ModelsPageView",
  component: ModelsPageView,
  decorators: [withMockApp],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ModelsPageView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Owner: Story = {
  render: () => (
    // `role` is an Eliza authorization tier, not an ARIA role.
    // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier.
    <RoleProvider role="OWNER">
      <ModelsPageView api={fixtureApi} />
    </RoleProvider>
  ),
};

export const NonOwner: Story = {
  render: () => (
    // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier.
    <RoleProvider role="USER">
      <ModelsPageView api={fixtureApi} />
    </RoleProvider>
  ),
};
