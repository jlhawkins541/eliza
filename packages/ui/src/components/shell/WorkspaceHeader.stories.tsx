/** Professional workspace header states using real shell navigation controls. */
import type { Meta, StoryObj } from "@storybook/react";
import { WorkspaceHeader } from "./WorkspaceHeader";
const meta = {
  title: "Shell/Workspace Header",
  component: WorkspaceHeader,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { onOpenTile: () => {} },
} satisfies Meta<typeof WorkspaceHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Applications: Story = { args: { page: "launcher" } };
export const Compact: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
