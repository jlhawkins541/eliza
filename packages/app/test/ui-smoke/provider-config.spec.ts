/**
 * Exercises provider switching. The live-stack round-trip drives the real
 * account and runtime routes and creates its own linked account, because
 * process-level API-key credentials intentionally do not appear as
 * user-managed account rows. The `/models` case runs in the real renderer
 * against the deterministic model-settings fixtures: it picks a provider tile
 * and both models, confirms, and asserts the activation request body and the
 * restart progress the page shows while the operation applies.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

type SwitchRequest = { provider: unknown; primaryModel?: unknown };

const TEST_PROVIDER_ID = "cerebras-api";

async function mutateAccount(
  page: Page,
  path: string,
  method: "POST" | "DELETE",
  body?: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(
    async ({ path: requestPath, method: requestMethod, body: requestBody }) => {
      const csrfCookie = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("eliza_csrf="));
      const csrfToken = csrfCookie
        ? decodeURIComponent(csrfCookie.slice("eliza_csrf=".length))
        : null;
      const response = await fetch(requestPath, {
        method: requestMethod,
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(csrfToken ? { "x-eliza-csrf": csrfToken } : {}),
        },
        ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
      });
      if (!response.ok) {
        throw new Error(
          `${requestMethod} ${requestPath} failed with ${response.status}: ${await response.text()}`,
        );
      }
      return response.status === 204 ? null : response.json();
    },
    { path, method, body },
  );
}

function captureProviderSwitches(page: Page): SwitchRequest[] {
  const requests: SwitchRequest[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (!/\/api\/provider\/switch(?:\?|$)/.test(req.url())) return;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    if (body && typeof body === "object") {
      requests.push(body as SwitchRequest);
    }
  });
  return requests;
}

test.describe("provider config deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real provider/runtime pipeline (ELIZA_UI_SMOKE_LIVE_STACK=1); the " +
      "keyless stub does not restart the agent or re-derive the active provider.",
  );

  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
  });

  test("selecting a different provider fires POST /api/provider/switch with its id", async ({
    page,
  }) => {
    const switches = captureProviderSwitches(page);

    await openAppPath(page, "/settings");
    const created = (await mutateAccount(
      page,
      `/api/accounts/${TEST_PROVIDER_ID}`,
      "POST",
      {
        source: "api-key",
        label: "Live E2E switch target",
        apiKey: "csk-live-e2e-switch-target",
      },
    )) as { id?: unknown };
    expect(typeof created.id).toBe("string");

    // Reload the inventory after creating the fixture through the real route.
    await openAppPath(page, "/settings");
    await openSettingsSection(page, /Models & Providers/);
    await expect(page.locator("#ai-model")).toBeVisible({ timeout: 30_000 });

    // Connected direct-provider rows expose this as their primary routing
    // action. The active provider instead renders a disabled "Chat" button, so
    // the first enabled match is necessarily a real switch target.
    const useForChat = page
      .locator("#ai-model")
      .getByRole("button", { name: /^Use for chat$/i })
      .first();
    await expect(useForChat).toBeVisible({ timeout: 15_000 });
    await expect(useForChat).toBeEnabled();
    await useForChat.click();

    // Real POST /api/provider/switch carrying a concrete provider id — the
    // load-bearing contract, independent of whether the restart later succeeds
    // (a keyless target provider may be rejected by the backend for lacking a
    // credential, but the switch request itself is what the UI is responsible for).
    await expect.poll(() => switches.length).toBeGreaterThan(0);
    expect(
      switches.some(
        (s) => typeof s.provider === "string" && s.provider.length > 0,
      ),
    ).toBe(true);

    // The clicked account action becomes the active, disabled "Chat" state.
    await expect(useForChat).toHaveCount(0, { timeout: 10_000 });

    await mutateAccount(
      page,
      `/api/accounts/${TEST_PROVIDER_ID}/${String(created.id)}`,
      "DELETE",
    );
  });
});

const MODELS_OPERATION_ID = "op-models-page-e2e";
const SMOKE_UNCHECKED = { state: "unchecked", checkedAt: null, detail: null };

function anthropicReadyStatus(operation: unknown) {
  const openAiEndpoint = {
    url: "https://api.openai.com/v1",
    isDefault: true,
    transport: "https",
    overriddenBy: null,
  };
  const keyed = (last4: string) => ({
    state: "stored",
    last4,
    source: "account-pool",
    lastVerifiedAt: null,
    health: SMOKE_UNCHECKED,
  });
  const tile = (
    id: string,
    label: string,
    credential: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    label,
    pluginInstalled: true,
    credential,
    endpoint: null,
    supportsEndpoint: false,
    activatable: true,
    requiresModelSelection: false,
    ...extra,
  });
  return {
    active: {
      provider: "openai",
      providerLabel: "OpenAI",
      runtimeProviderName: "openai",
      smallModel: "gpt-5.6-luna",
      largeModel: "gpt-5.6-sol",
      smallModelSource: "user",
      largeModelSource: "user",
      endpoint: openAiEndpoint,
      health: SMOKE_UNCHECKED,
    },
    providers: [
      tile("openai", "OpenAI", keyed("smk1"), {
        endpoint: openAiEndpoint,
        supportsEndpoint: true,
      }),
      tile("anthropic", "Anthropic", keyed("ant2")),
      tile(
        "grok",
        "xAI Grok",
        { state: "missing" },
        {
          requiresModelSelection: true,
        },
      ),
      tile("ollama", "Ollama", { state: "not-required" }),
      tile("elizacloud", "Eliza Cloud", { state: "missing" }),
      tile(
        "local",
        "On-device",
        { state: "not-required" },
        {
          activatable: false,
        },
      ),
    ],
    operation,
    managedByCloud: false,
  };
}

test.describe("Models page provider switch", () => {
  test("switching to Anthropic from /models posts the chosen models and shows restart progress", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);

    // Registered after the defaults, so these handlers take precedence.
    const activations: unknown[] = [];
    await page.route("**/api/model-settings", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const operation =
        activations.length > 0
          ? {
              id: MODELS_OPERATION_ID,
              provider: "anthropic",
              state: "applying",
              error: null,
            }
          : null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(anthropicReadyStatus(operation)),
      });
    });
    await page.route(
      "**/api/model-settings/providers/anthropic/models",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            provider: "anthropic",
            state: "ok",
            models: [
              { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
              { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
            ],
            fetchedAt: "2026-10-07T00:00:00.000Z",
          }),
        });
      },
    );
    await page.route("**/api/model-settings/activate", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      activations.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          operationId: MODELS_OPERATION_ID,
          provider: "anthropic",
          deduped: false,
        }),
      });
    });

    await openAppPath(page, "/models");
    await expect(page.getByTestId("models-active-card")).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId("models-provider-anthropic").click();
    await expect(page.getByTestId("models-provider-anthropic")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByTestId("models-small-select").click();
    await page.getByRole("option", { name: "Claude Haiku 4.5" }).click();
    await page.getByTestId("models-large-select").click();
    await page.getByRole("option", { name: "Claude Opus 4.8" }).click();

    const activate = page.getByTestId("models-activate");
    await expect(activate).toHaveText(/Switch Eliza to Anthropic/);
    await expect(activate).toBeEnabled();
    await activate.click();

    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("Anthropic");
    await confirm.getByRole("button", { name: "Switch and restart" }).click();

    await expect.poll(() => activations.length).toBe(1);
    expect(activations[0]).toEqual({
      provider: "anthropic",
      smallModel: "claude-haiku-4-5",
      largeModel: "claude-opus-4-8",
    });
    await expect(page.getByTestId("models-operation-progress")).toBeVisible({
      timeout: 15_000,
    });
  });
});
