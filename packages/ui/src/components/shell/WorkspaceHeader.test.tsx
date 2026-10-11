/** Verifies workspace controls through the canonical shell navigation store. */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getShellSurface,
  resetShellSurfaceForTests,
} from "../../state/shell-surface-store";
import { WorkspaceHeader } from "./WorkspaceHeader";
beforeEach(resetShellSurfaceForTests);
afterEach(() => {
  cleanup();
  resetShellSurfaceForTests();
});
describe("workspace navigation", () => {
  it("opens applications and returns to the overview using the shared page store", () => {
    render(<WorkspaceHeader />);
    fireEvent.click(
      screen.getByRole("button", { name: "Browse applications" }),
    );
    expect(getShellSurface().page).toBe("launcher");
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(getShellSurface().page).toBe("home");
  });
  it("opens host settings through the existing tile callback", () => {
    const onOpenTile = vi.fn();
    render(<WorkspaceHeader onOpenTile={onOpenTile} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenTile).toHaveBeenCalledExactlyOnceWith({
      kind: "tab",
      tab: "settings",
    });
  });
  it("exposes the selected application page and omits unavailable host actions", () => {
    render(<WorkspaceHeader page="launcher" />);
    expect(
      screen
        .getByRole("button", { name: "Applications" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });
});
