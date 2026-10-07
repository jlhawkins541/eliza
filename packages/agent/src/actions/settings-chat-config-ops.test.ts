/**
 * Chat-settings leg of #14325: the owner-gated SETTINGS action must, when the
 * chat surface asks to configure a plugin ("configure telegram") or switch the
 * model provider ("switch my model provider to openai"), mutate the REAL on-disk
 * eliza.json config store — not a mock. This drives `settingsAction.handler`
 * against a temp config file (via ELIZA_CONFIG_PATH / ELIZA_PERSIST_CONFIG_PATH,
 * the same load/write path the running agent uses) and asserts the persisted
 * bytes, so a regression that silently stops persisting provider/capability
 * changes fails here. The `[CONFIG:pluginId]` card's fetch/edit/save/enable
 * round-trip is covered deterministically in
 * `packages/ui/src/components/chat/MessageContent.config.test.tsx`; the live
 * chat round-trip (real model emits `[CONFIG:telegram]` / drives SETTINGS) is
 * covered by the `live-only` scenarios in
 * `plugins/plugin-app-control/test/scenarios/settings-in-chat-*.scenario.ts`.
 *
 * Also pins the two `set` branches (#14703): a legacy no-section set
 * ({ action:"set", key, value }) stays on the worldSettings-registry handler,
 * while a section-addressed set routes into plugin-app-control's section
 * registry — asserted against a loopback HTTP stub standing in for the
 * agent server the section routes call.
 *
 * The Models-page providers switch through the shared ModelSettingsService
 * activation (credential, model-tier, and operation-manager paths covered
 * here). xAI Grok, which has no default models, always takes that activation:
 * a chat-supplied key or legacy model slots for it are refused before the
 * store is touched.
 *
 * Deterministic: real config store on a temp dir, stub runtime, no live model.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  getSalt,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type Setting,
  saltWorldSettings,
  unsaltWorldSettings,
  type World,
  type WorldSettings,
} from "@elizaos/core";
import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerModelSettingsHost } from "../api/model-settings-host.ts";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { settingsAction } from "./settings-actions.ts";

// A stub runtime is enough for the config-store ops (toggle_capability /
// update_ai_provider) — they read/write eliza.json and never touch the runtime.
// `character: {}` lets set_backend's live-character write-through no-op safely.
const RUNTIME = { character: {} } as unknown as IAgentRuntime;
const OWNER_MESSAGE = { entityId: "owner" } as unknown as Memory;

function invoke(parameters: Record<string, unknown>): Promise<ActionResult> {
  return settingsAction.handler(RUNTIME, OWNER_MESSAGE, undefined, {
    parameters,
  } as HandlerOptions) as Promise<ActionResult>;
}

let tempDir: string;
let configPath: string;
let priorConfigPath: string | undefined;
let priorPersistPath: string | undefined;
const AUTHORITY_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  // The Models-page activation reads provider credentials from the account
  // store under the state dir and from launch env; isolate both.
  "ELIZA_STATE_DIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "XAI_API_KEY",
  "ELIZA_CLOUD_PROVISIONED",
] as const;
const originalAuthorityEnv = Object.fromEntries(
  AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-chat-ops-"));
  configPath = path.join(tempDir, "eliza.json");
  // Seed a minimal-but-real config so load/merge/save exercise the real path.
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ui: { capabilities: { wallet: false } } }),
  );
  priorConfigPath = process.env.ELIZA_CONFIG_PATH;
  priorPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
  // Point BOTH the read resolver (ELIZA_CONFIG_PATH) and the write resolver
  // (ELIZA_PERSIST_CONFIG_PATH) at the temp file so load and save agree.
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_STATE_DIR = tempDir;
});

afterEach(() => {
  if (priorConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = priorConfigPath;
  if (priorPersistPath === undefined)
    delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  else process.env.ELIZA_PERSIST_CONFIG_PATH = priorPersistPath;
  for (const key of AUTHORITY_ENV_KEYS) {
    const value = originalAuthorityEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SETTINGS action — always available at the chat boundary", () => {
  it("declares the OWNER role gate the chat settings surface relies on", () => {
    // The chat settings direction ("settings is just settings in chat") depends
    // on this gate: any authenticated non-owner in chat must not reach it.
    expect(settingsAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("validate() resolves true (gate is structural, not validate-time)", async () => {
    // SETTINGS has no validate-time preconditions — the OWNER gate is enforced
    // structurally by core (satisfiesRoleGate) before the handler runs, so the
    // action stays selectable and the gate can't be bypassed by a passing
    // validate.
    await expect(settingsAction.validate(RUNTIME, OWNER_MESSAGE)).resolves.toBe(
      true,
    );
  });

  it("lists built-in settings sections through the consolidated registry", async () => {
    const result = await invoke({ action: "list" });

    expect(result.success).toBe(true);
    expect(result.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "permissions",
          writable: true,
          via: "SETTINGS",
        }),
      ]),
    );
  });
});

describe("SETTINGS update_ai_provider — persists to the real config store", () => {
  it.each([
    "staging-default",
    "offline",
    "staging-explicit",
    "production",
    "self-hosted",
  ] as const)(
    "rejects elizacloud under frozen %s authority before loading or mutating config",
    async (authority) => {
      const invalidConfig = "{ deliberately invalid config";
      fs.writeFileSync(configPath, invalidConfig);
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        authority === "self-hosted"
          ? "https://private.example:8787/api/v1"
          : "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "launch-key";
      process.env.ELIZAOS_CLOUD_ENABLED = "true";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      process.env.ELIZAOS_CLOUD_API_KEY = "late-hostile-key";
      const environmentBefore = {
        apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
        enabled: process.env.ELIZAOS_CLOUD_ENABLED,
      };
      const result = await invoke({
        action: "update_ai_provider",
        provider: "elizacloud",
        apiKey: "request-key",
      });

      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "DEV_CLOUD_AUTHORITY_ACTIVE",
        provider: "elizacloud",
        authority,
      });
      expect(fs.readFileSync(configPath, "utf-8")).toBe(invalidConfig);
      expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe(environmentBefore.apiKey);
      expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe(environmentBefore.enabled);
    },
  );

  it('"switch my model provider to openai" writes provider routing to eliza.json', async () => {
    process.env.OPENAI_API_KEY = "fixture-openai-launch-key-1234";
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
    });

    expect(result.success).toBe(true);
    expect(result.data?.op).toBe("update_ai_provider");
    expect(result.data?.provider).toBe("openai");
    // No API host is registered in this process, so the shared Models-page
    // activation persists the change for the next boot.
    expect(result.data?.requiresRestart).toBe(true);

    // The write actually landed on disk with the real provider routing the
    // running agent reads back — not a fabricated success.
    const config = readConfig();
    const routing = config.serviceRouting as
      | { llmText?: { backend?: string } }
      | undefined;
    expect(routing?.llmText?.backend).toBe("openai");
    const agents = config.agents as
      | { defaults?: { model?: { primary?: string } } }
      | undefined;
    expect(agents?.defaults?.model?.primary).toBe("@elizaos/plugin-openai");
  });

  it("carries an API key through to config when supplied", async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
      apiKey: "fixture-openai-api-token",
    });
    expect(result.success).toBe(true);
    // The key must be persisted somewhere reachable via config.env so the
    // switched provider can authenticate on the next boot.
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).toContain("fixture-openai-api-token");
  });

  it("refuses to switch to a keyed provider with no stored credential", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("CREDENTIAL_REQUIRED");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("requires both Grok model tiers before touching the store", async () => {
    process.env.XAI_API_KEY = "xai-fixture-launch-key-5678";
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({
      action: "update_ai_provider",
      provider: "xai",
      smallModel: "grok-4-fast",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MODEL_REQUIRED");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it.each([
    ["an API key", { apiKey: "xai-chat-key-0000" }, "API_KEY_NOT_ACCEPTED"],
    [
      "an API key with both tiers",
      {
        apiKey: "xai-chat-key-0000",
        smallModel: "grok-4-fast",
        largeModel: "grok-4",
      },
      "API_KEY_NOT_ACCEPTED",
    ],
    [
      "legacy modelConfigs",
      { modelConfigs: { small: "grok-4-fast", large: "grok-4" } },
      "MODEL_SELECTION_UNSUPPORTED",
    ],
    ["no model tiers", {}, "MODEL_REQUIRED"],
  ])(
    "never saves a Grok route from %s on the legacy path",
    async (_label, extra, code) => {
      process.env.XAI_API_KEY = "xai-fixture-launch-key-5678";
      const before = fs.readFileSync(configPath, "utf-8");
      const result = await invoke({
        action: "update_ai_provider",
        provider: "grok",
        ...extra,
      });
      expect(result.success).toBe(false);
      expect(result.data?.error).toBe(code);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    },
  );

  it("rejects model tiers for providers outside the Models page", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({
      action: "update_ai_provider",
      provider: "groq",
      smallModel: "openai/gpt-oss-120b",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MODEL_SELECTION_UNSUPPORTED");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("runs through the API host's operation manager when one is registered", async () => {
    process.env.OPENAI_API_KEY = "fixture-openai-launch-key-1234";
    const config = loadElizaConfig();
    const started: unknown[] = [];
    registerModelSettingsHost(() => ({
      state: { config, runtime: null },
      saveConfig: saveElizaConfig,
      operations: {
        start: async (request) => {
          started.push(request.intent);
          await request.prepare?.();
          return {
            kind: "accepted",
            operation: {
              id: "op-chat-switch",
              kind: "provider-switch",
              intent: request.intent,
              tier: "cold",
              status: "pending",
              phases: [],
              startedAt: Date.now(),
            },
          };
        },
        get: async () => null,
        list: async () => [],
        findActive: async () => null,
      },
    }));
    try {
      const result = await invoke({
        action: "update_ai_provider",
        provider: "openai",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        provider: "openai",
        operationId: "op-chat-switch",
        requiresRestart: false,
      });
      expect(started).toEqual([
        {
          kind: "provider-switch",
          provider: "openai",
          modelSelection: { smallModel: null, largeModel: null },
        },
      ]);
      const routing = readConfig().serviceRouting as
        | { llmText?: { backend?: string } }
        | undefined;
      expect(routing?.llmText?.backend).toBe("openai");
    } finally {
      registerModelSettingsHost(null);
    }
  });

  it("rejects a missing provider without touching the store", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({ action: "update_ai_provider" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_PROVIDER");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("rejects an unknown provider with UNKNOWN_PROVIDER", async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "totally-not-a-provider",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("UNKNOWN_PROVIDER");
  });
});

describe("SETTINGS toggle_capability — persists to the real config store", () => {
  it("enabling the wallet capability flips config.ui.capabilities on disk", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });

    const config = readConfig();
    const capabilities = (
      config.ui as { capabilities?: Record<string, unknown> }
    )?.capabilities;
    expect(capabilities?.wallet).toBe(true);
  });

  it("disabling round-trips back to false on disk", async () => {
    await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });
    const enabled = readConfig();
    expect(
      (enabled.ui as { capabilities?: Record<string, unknown> })?.capabilities
        ?.wallet,
    ).toBe(true);

    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: false,
    });
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(
      (config.ui as { capabilities?: Record<string, unknown> })?.capabilities
        ?.wallet,
    ).toBe(false);
  });

  it("rejects an unknown capability with UNKNOWN_CAPABILITY", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "teleportation",
      enabled: true,
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("UNKNOWN_CAPABILITY");
  });

  it("rejects a non-boolean `enabled` with MISSING_ENABLED", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: "yes",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_ENABLED");
  });
});

describe("SETTINGS set — legacy no-section branch (worldSettings registry)", () => {
  // Seed a real salted registry the way production writes it, so the handler
  // exercises the genuine unsalt → mutate → salt → updateWorld path.
  const GREETING_SETTING: Setting = {
    name: "Greeting",
    description: "Greeting the agent uses",
    usageDescription: "Greeting the agent uses",
    required: false,
    value: "hi",
    dependsOn: [],
  };

  function makeOwnerWorldRuntime(): {
    runtime: IAgentRuntime;
    updatedWorlds: World[];
  } {
    const salt = getSalt();
    const world = {
      id: "world-1",
      name: "Owner World",
      agentId: "agent-1",
      serverId: "server-1",
      metadata: {
        ownership: { ownerId: "owner" },
        settings: saltWorldSettings(
          { settings: { greeting: GREETING_SETTING } },
          salt,
        ),
      },
    } as unknown as World;
    const updatedWorlds: World[] = [];
    const runtime = {
      character: {},
      agentId: "agent-1",
      getAllWorlds: async () => [world],
      updateWorld: async (w: World) => {
        updatedWorlds.push(w);
      },
    } as unknown as IAgentRuntime;
    return { runtime, updatedWorlds };
  }

  it("routes { action:'set', key, value } to the worldSettings handler and persists (#14703 regression)", async () => {
    const { runtime, updatedWorlds } = makeOwnerWorldRuntime();
    const result = (await settingsAction.handler(
      runtime,
      OWNER_MESSAGE,
      undefined,
      {
        parameters: { action: "set", key: "greeting", value: "hello" },
      } as HandlerOptions,
    )) as ActionResult;

    // The regression routed this to the section handler, which failed with
    // "Tell me which settings section to change". The legacy branch succeeds
    // and reports the applied registry write.
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      actionName: "SETTINGS",
      op: "set",
      applied: [{ key: "greeting", value: "hello" }],
    });

    expect(updatedWorlds).toHaveLength(1);
    const persisted = updatedWorlds[0].metadata?.settings as WorldSettings;
    const unsalted = unsaltWorldSettings(persisted, getSalt());
    expect(unsalted.settings?.greeting?.value).toBe("hello");
  });

  it("still fails with the legacy error shape for an unknown registry key", async () => {
    const { runtime, updatedWorlds } = makeOwnerWorldRuntime();
    const result = (await settingsAction.handler(
      runtime,
      OWNER_MESSAGE,
      undefined,
      {
        parameters: { action: "set", key: "bogus", value: "x" },
      } as HandlerOptions,
    )) as ActionResult;
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("NO_VALID_UPDATES");
    expect(updatedWorlds).toHaveLength(0);
  });
});

describe("SETTINGS set — section-addressed branch (app-control registry)", () => {
  interface RecordedRequest {
    method: string | undefined;
    url: string | undefined;
    body: unknown;
  }

  let server: http.Server;
  let recorded: RecordedRequest[];
  let priorElizaPort: string | undefined;

  beforeEach(async () => {
    recorded = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        recorded.push({
          method: req.method,
          url: req.url,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("stub server has no port");
    priorElizaPort = process.env.ELIZA_PORT;
    process.env.ELIZA_PORT = String(address.port);
  });

  afterEach(async () => {
    if (priorElizaPort === undefined) delete process.env.ELIZA_PORT;
    else process.env.ELIZA_PORT = priorElizaPort;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("routes a section-addressed set to app-control's permissions route", async () => {
    const result = (await invoke({
      action: "set",
      section: "permissions",
      key: "shell",
      value: "off",
    })) as ActionResult;

    expect(result.success).toBe(true);
    expect(recorded).toEqual([
      {
        method: "PUT",
        url: "/api/permissions/shell",
        body: { enabled: false },
      },
    ]);
    expect(result.values).toMatchObject({
      section: "permissions",
      key: "shell",
      value: false,
    });
  });

  it("set section=capabilities key=wallet value=false resolves through the registry (#14703 residual)", async () => {
    const result = (await invoke({
      action: "set",
      section: "capabilities",
      key: "wallet",
      value: "false",
    })) as ActionResult;

    expect(result.success).toBe(true);
    expect(recorded).toEqual([
      {
        method: "PUT",
        url: "/api/config",
        body: { ui: { capabilities: { wallet: false } } },
      },
    ]);
    expect(result.values).toMatchObject({
      section: "capabilities",
      key: "wallet",
      value: false,
    });
  });
});

describe("SETTINGS dispatch — unknown op fails explicitly", () => {
  it("returns SETTINGS_INVALID (never a fabricated success) for an unknown action", async () => {
    const result = await invoke({ action: "frobnicate" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
  });

  it("returns SETTINGS_INVALID when no action discriminator is supplied", async () => {
    const result = await invoke({});
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
  });
});
