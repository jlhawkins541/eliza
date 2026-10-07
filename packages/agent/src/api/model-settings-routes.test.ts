/**
 * Transport contract for `/api/model-settings`: the in-handler owner gate
 * (alone and composed with the server's caller resolution over the host
 * bridge), request grammar, and the mapping of use-case outcomes to HTTP
 * statuses.
 * Drives the real handler and `ModelSettingsService` with the real operation
 * manager and filesystem repository; credential storage, plugin presence, and
 * the restart closure are injected.
 */
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { readJsonBody } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { defaultClassifier } from "../runtime/operations/classifier.ts";
import { createColdStrategy } from "../runtime/operations/cold-strategy.ts";
import { HealthChecker } from "../runtime/operations/health.ts";
import { DefaultRuntimeOperationManager } from "../runtime/operations/manager.ts";
import { FilesystemRuntimeOperationRepository } from "../runtime/operations/repository.ts";
import { createRuntimeOperationStrategies } from "../runtime/operations/strategy-table.ts";
import { resolveInboxRequestAuthorization } from "./inbox-request-authorization.ts";
import {
  handleModelSettingsRoutes,
  type ModelSettingsRouteContext,
} from "./model-settings-routes.ts";

const ENV_KEYS = [
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "ANTHROPIC_SMALL_MODEL",
  "ANTHROPIC_LARGE_MODEL",
  "ELIZAOS_CLOUD_ENABLED",
] as const;

const OWNER: AgentHttpRequestAuthorization = { ok: true, role: "OWNER" };

let stateDir: string;
let savedEnv: Record<string, string | undefined>;
let config: ElizaConfig;
let manager: DefaultRuntimeOperationManager;
let saveConfig: ReturnType<typeof vi.fn<(config: ElizaConfig) => void>>;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-model-routes-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  config = {
    serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
  } as ElizaConfig;
  saveConfig = vi.fn<(config: ElizaConfig) => void>();
  manager = new DefaultRuntimeOperationManager({
    repository: new FilesystemRuntimeOperationRepository(stateDir),
    runtime: () => ({ agentId: "current" }) as AgentRuntime,
    classifyContext: () => ({ currentProvider: "openai" }),
    classifier: defaultClassifier,
    healthChecker: new HealthChecker(),
    strategies: createRuntimeOperationStrategies({
      // Never resolves: keeps the accepted operation active for the busy case.
      cold: createColdStrategy({ restartRuntime: () => new Promise(() => {}) }),
      hot: { tier: "hot", apply: async (ctx) => ctx.runtime },
    }),
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  pathname: string,
  options: {
    body?: unknown;
    authorization?: AgentHttpRequestAuthorization;
  } = {},
): Promise<Captured | null> {
  const raw =
    options.body === undefined
      ? []
      : [Buffer.from(JSON.stringify(options.body))];
  const req = Object.assign(Readable.from(raw), {
    headers: { "content-type": "application/json" },
    method,
  }) as unknown as http.IncomingMessage;
  let captured: Captured | null = null;
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: () => {},
    end: (chunk?: string) => {
      captured = {
        status: res.statusCode,
        body: chunk ? (JSON.parse(chunk) as Record<string, unknown>) : {},
      };
    },
  } as unknown as http.ServerResponse;
  const ctx: ModelSettingsRouteContext = {
    req,
    res,
    method,
    pathname,
    state: { config, runtime: null },
    json: (_res, data, status = 200) => {
      captured = { status, body: data as Record<string, unknown> };
    },
    readJsonBody,
    callerAuthorization: options.authorization ?? OWNER,
    serviceDeps: () => ({
      operations: manager,
      saveConfig,
      readCredential: (provider) =>
        provider === "openai" || provider === "grok"
          ? { value: `${provider}-fixture-key-9876`, source: "account-pool" }
          : null,
      isPluginInstalled: () => true,
      isCloudProvisioned: () => false,
    }),
  };
  const handled = await handleModelSettingsRoutes(ctx);
  return handled ? captured : null;
}

describe("model settings route owner gate", () => {
  it("leaves unrelated paths to the next handler", async () => {
    expect(await call("GET", "/api/model-settingsx")).toBeNull();
    expect(await call("GET", "/api/models")).toBeNull();
  });

  it("answers 401 for an unauthenticated caller", async () => {
    const result = await call("GET", "/api/model-settings", {
      authorization: { ok: false, role: "NONE" },
    });
    expect(result?.status).toBe(401);
  });

  it.each([
    ["a USER session", { ok: true, role: "USER" }],
    [
      "a paired machine session",
      { ok: true, role: "USER", identityId: "machine-session-1" },
    ],
    ["a guest", { ok: true, role: "GUEST" }],
  ] as const)("answers 403 for %s on every route", async (_label, auth) => {
    for (const [method, pathname, body] of [
      ["GET", "/api/model-settings", undefined],
      ["GET", "/api/model-settings/providers/openai/models", undefined],
      ["POST", "/api/model-settings/activate", { provider: "openai" }],
    ] as const) {
      const result = await call(method, pathname, {
        body,
        authorization: auth as AgentHttpRequestAuthorization,
      });
      expect(result?.status).toBe(403);
      expect(result?.body.code).toBe("OWNER_REQUIRED");
    }
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe("model settings routes for the owner", () => {
  it("returns the status DTO", async () => {
    const result = await call("GET", "/api/model-settings");
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({
      active: { provider: "openai" },
      managedByCloud: false,
    });
  });

  it("validates the provider path segment", async () => {
    expect(
      (await call("GET", "/api/model-settings/providers/..%2Fetc/models"))
        ?.status,
    ).toBe(400);
    expect(
      (await call("GET", "/api/model-settings/providers/groq/models"))?.status,
    ).toBe(404);
    expect(
      (await call("POST", "/api/model-settings/providers/openai/models"))
        ?.status,
    ).toBe(405);
    expect((await call("GET", "/api/model-settings/unknown"))?.status).toBe(
      404,
    );
  });

  it("rejects unknown fields, including a key, and missing Grok models", async () => {
    const withKey = await call("POST", "/api/model-settings/activate", {
      body: { provider: "openai", apiKey: "sk-never-accepted-here" },
    });
    expect(withKey?.status).toBe(400);
    expect(withKey?.body.code).toBe("INVALID_REQUEST");

    const grok = await call("POST", "/api/model-settings/activate", {
      body: { provider: "grok", smallModel: "grok-4-fast" },
    });
    expect(grok?.status).toBe(400);
    expect(grok?.body.code).toBe("MODEL_REQUIRED");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("maps a use-case refusal to its status and code", async () => {
    const result = await call("POST", "/api/model-settings/activate", {
      body: { provider: "anthropic" },
    });
    expect(result?.status).toBe(409);
    expect(result?.body.code).toBe("CREDENTIAL_REQUIRED");
  });

  it("accepts an activation with 202 and reports a concurrent one as busy", async () => {
    const accepted = await call("POST", "/api/model-settings/activate", {
      body: { provider: "openai" },
    });
    expect(accepted?.status).toBe(202);
    expect(accepted?.body).toMatchObject({
      provider: "openai",
      deduped: false,
    });
    expect(typeof accepted?.body.operationId).toBe("string");
    expect(saveConfig).toHaveBeenCalledTimes(1);

    const busy = await call("POST", "/api/model-settings/activate", {
      body: { provider: "openai" },
    });
    expect(busy?.status).toBe(409);
    expect(busy?.body).toMatchObject({
      code: "OPERATION_IN_PROGRESS",
      activeOperationId: accepted?.body.operationId,
    });
  });
});

describe("model settings caller resolution as the server composes it", () => {
  const ENV = ["ELIZA_API_TOKEN", "ELIZA_REQUIRE_LOCAL_AUTH"] as const;
  let savedAuthEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedAuthEnv = Object.fromEntries(
      ENV.map((key) => [key, process.env[key]]),
    );
    for (const key of ENV) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV) {
      const value = savedAuthEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A remote request, so neither loopback trust nor a token makes it OWNER. */
  function remoteRequest(
    method: string,
    pathname: string,
    headers: http.IncomingHttpHeaders = {},
  ): http.IncomingMessage {
    const req = new http.IncomingMessage(new Socket());
    req.method = method;
    req.url = pathname;
    req.headers = { host: "agent.example.test", ...headers };
    Object.defineProperty(req.socket, "remoteAddress", {
      configurable: true,
      value: "203.0.113.9",
    });
    return req;
  }

  async function callComposed(
    method: string,
    pathname: string,
    hostAuthorization: AgentHttpRequestAuthorization,
    headers: http.IncomingHttpHeaders = {},
  ): Promise<{ captured: Captured | null; builtService: boolean }> {
    const req = remoteRequest(method, pathname, headers);
    let captured: Captured | null = null;
    let builtService = false;
    await handleModelSettingsRoutes({
      req,
      res: {} as http.ServerResponse,
      method,
      pathname,
      state: { config, runtime: null },
      json: (_res, data, status = 200) => {
        captured = { status, body: data as Record<string, unknown> };
      },
      readJsonBody,
      callerAuthorization: resolveInboxRequestAuthorization(
        req,
        method,
        pathname,
        hostAuthorization,
      ),
      serviceDeps: () => {
        builtService = true;
        return {
          operations: manager,
          saveConfig,
          readCredential: () => null,
          isPluginInstalled: () => true,
          isCloudProvisioned: () => false,
        };
      },
    });
    return { captured, builtService };
  }

  it.each([
    ["GET", "/api/model-settings"],
    ["GET", "/api/model-settings/providers/openai/models"],
    ["POST", "/api/model-settings/activate"],
  ] as const)(
    "refuses a host-bridge USER session on %s %s before building the use-case",
    async (method, pathname) => {
      const { captured, builtService } = await callComposed(method, pathname, {
        ok: true,
        role: "USER",
        identityId: "machine-session-1",
      });
      expect(captured).toMatchObject({
        status: 403,
        body: { code: "OWNER_REQUIRED" },
      });
      expect(builtService).toBe(false);
      expect(saveConfig).not.toHaveBeenCalled();
    },
  );

  it("answers 401 when neither the boundary nor the host bridge authenticates", async () => {
    const { captured, builtService } = await callComposed(
      "GET",
      "/api/model-settings",
      { ok: false, role: "NONE" },
    );
    expect(captured?.status).toBe(401);
    expect(builtService).toBe(false);
  });

  it("treats the configured API token as the owner even when the bridge says USER", async () => {
    process.env.ELIZA_API_TOKEN = "model-settings-route-token-1234";
    const { captured, builtService } = await callComposed(
      "GET",
      "/api/model-settings",
      { ok: true, role: "USER" },
      { authorization: "Bearer model-settings-route-token-1234" },
    );
    expect(captured?.status).toBe(200);
    expect(builtService).toBe(true);
  });
});
