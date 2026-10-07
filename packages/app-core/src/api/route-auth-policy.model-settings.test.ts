/**
 * Owner gate for `/api/model-settings` at the app-core host: drives the real
 * `enforceCompatRouteAuthPolicy` → `ensureRouteMinRole` path for every model
 * settings route plus an unknown sub-path. A paired machine identity (the
 * USER tier) is refused 403 and an owner session passes through to the agent
 * handler. Only the session store primitives are mocked, and the trusted
 * loopback shortcut is disabled so every request resolves a session role.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  vi.resetModules();
  return {
    findActiveSession: vi.fn(),
    findIdentity: vi.fn(),
    verifyCsrfToken: vi.fn(),
  };
});

vi.mock("./compat-route-shared", () => ({
  isTrustedLocalRequest: () => false,
}));

vi.mock("./auth/sessions.js", () => ({
  CSRF_HEADER_NAME: "x-eliza-csrf",
  denyOnAuthStoreError: () => () => null,
  findActiveSession: mocks.findActiveSession,
  verifyCsrfToken: mocks.verifyCsrfToken,
}));

vi.mock("../services/auth-store.js", () => ({
  AuthStore: class MockAuthStore {
    findIdentity = mocks.findIdentity;
  },
}));

const { enforceCompatRouteAuthPolicy } = await import("./route-auth-policy");

type RouteState = Parameters<typeof enforceCompatRouteAuthPolicy>[2];

const STATE_WITH_DB = {
  current: { adapter: { db: {} } },
  pendingAgentName: null,
  pendingRestartReasons: [],
} as unknown as RouteState;

const MODEL_SETTINGS_ROUTES = [
  ["GET", "/api/model-settings"],
  ["GET", "/api/model-settings/providers/ollama/models"],
  ["POST", "/api/model-settings/activate"],
  ["DELETE", "/api/model-settings/not-a-route"],
] as const;

function session(kind: "browser" | "machine", identityId: string) {
  return {
    createdAt: 0,
    csrfSecret: "csrf-secret",
    expiresAt: Date.now() + 60_000,
    id: `${kind}-session`,
    identityId,
    ip: null,
    kind,
    lastSeenAt: 0,
    rememberDevice: false,
    revokedAt: null,
    scopes: [],
    userAgent: null,
  };
}

function identity(kind: "owner" | "machine") {
  return {
    cloudUserId: null,
    createdAt: 0,
    displayName: kind,
    id: `${kind}-identity`,
    kind,
    passwordHash: null,
  };
}

function request(
  method: string,
  pathname: string,
  headers: http.IncomingHttpHeaders,
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "example.test:2138", ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: "203.0.113.9",
  });
  return req;
}

function response() {
  let body = "";
  const res = new http.ServerResponse(new http.IncomingMessage(new Socket()));
  res.statusCode = 200;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

beforeEach(() => {
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  mocks.findActiveSession.mockReset();
  mocks.findIdentity.mockReset();
  mocks.verifyCsrfToken.mockReset();
  mocks.verifyCsrfToken.mockReturnValue(true);
});

afterEach(() => {
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
});

describe("model-settings owner gate", () => {
  it.each(MODEL_SETTINGS_ROUTES)(
    "refuses a paired machine session on %s %s with 403",
    async (method, pathname) => {
      mocks.findActiveSession.mockResolvedValue(
        session("machine", "machine-identity"),
      );
      mocks.findIdentity.mockResolvedValue(identity("machine"));
      const res = response();

      await expect(
        enforceCompatRouteAuthPolicy(
          request(method, pathname, {
            authorization: "Bearer machine-session",
          }),
          res.res,
          STATE_WITH_DB,
          method,
          pathname,
        ),
      ).resolves.toBe("denied");
      expect(res.status()).toBe(403);
      expect(res.json()).toEqual({ error: "Insufficient role" });
    },
  );

  it.each(MODEL_SETTINGS_ROUTES)(
    "passes an owner session on %s %s through to the agent handler",
    async (method, pathname) => {
      mocks.findActiveSession.mockResolvedValue(
        session("browser", "owner-identity"),
      );
      mocks.findIdentity.mockResolvedValue(identity("owner"));
      const res = response();

      await expect(
        enforceCompatRouteAuthPolicy(
          request(method, pathname, {
            cookie: "eliza_session=browser-session",
            "x-eliza-csrf": "csrf-token",
          }),
          res.res,
          STATE_WITH_DB,
          method,
          pathname,
        ),
      ).resolves.toBe("allowed");
      expect(res.status()).toBe(200);
      expect(mocks.findIdentity).toHaveBeenCalledWith("owner-identity");
    },
  );

  it("refuses an owner session whose mutation lacks a valid CSRF token", async () => {
    mocks.findActiveSession.mockResolvedValue(
      session("browser", "owner-identity"),
    );
    mocks.findIdentity.mockResolvedValue(identity("owner"));
    mocks.verifyCsrfToken.mockReturnValue(false);
    const res = response();

    await expect(
      enforceCompatRouteAuthPolicy(
        request("POST", "/api/model-settings/activate", {
          cookie: "eliza_session=browser-session",
        }),
        res.res,
        STATE_WITH_DB,
        "POST",
        "/api/model-settings/activate",
      ),
    ).resolves.toBe("denied");
    expect(res.status()).toBe(403);
  });
});
