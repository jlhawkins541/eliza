/** Checks the professional workspace in the real app shell with deterministic API fixtures. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { navigateHomeLauncher } from "./helpers/launcher-navigation";

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    test(`workspace navigation and search: ${theme} ${viewport.width}`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await seedAppStorage(page, { "eliza:ui-theme": theme });
      await installDefaultAppRoutes(page);
      await openAppPath(page, "/views");
      const home = await navigateHomeLauncher(page, "home");
      await expect(
        home.getByRole("heading", { name: "Workspace overview" }),
      ).toBeVisible();
      await home.getByRole("button", { name: "Browse applications" }).click();
      const grid = await navigateHomeLauncher(page, "launcher");
      const launcher = page.getByTestId("home-launcher-launcher-page");
      const search = launcher.getByRole("textbox", {
        name: "Search applications",
      });
      const tiles = grid.locator('[data-testid^="launcher-tile-"]');
      const count = await tiles.count();
      expect(count).toBeGreaterThan(0);
      await search.fill("  settings  ");
      await expect(tiles).toHaveCount(1);
      await expect(grid.getByTestId("launcher-tile-settings")).toBeVisible();
      await search.fill("no-app-matches-this-query");
      await expect(tiles).toHaveCount(0);
      await expect(
        launcher.getByText("No applications match your search."),
      ).toBeVisible();
      await launcher
        .getByRole("button", { name: "Clear search", exact: true })
        .click();
      await expect(tiles).toHaveCount(count);
      await search.fill("wallet");
      await search.press("Escape");
      await expect(search).toHaveValue("");
      await expect(tiles).toHaveCount(count);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await testInfo.attach("workspace", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await grid
        .getByTestId("launcher-tile-settings")
        .getByRole("button")
        .click();
      await expect(page.getByTestId("settings-shell")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}
