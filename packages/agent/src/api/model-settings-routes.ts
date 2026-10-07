/**
 * Owner-only HTTP surface for the Models page:
 *
 *   GET  /api/model-settings                        → ModelSettingsStatusDto
 *   GET  /api/model-settings/providers/:id/models   → ProviderModelCatalogDto
 *   POST /api/model-settings/activate               → 202 { operationId, provider, deduped }
 *
 * The handler enforces the owner role itself, independent of any host-level
 * gate, so a USER or paired machine session never reaches the use-case. It
 * only translates the transport: validation and business rules live in
 * `ModelSettingsService`, and its typed error codes map to HTTP statuses here.
 */

import type http from "node:http";
import { ElizaError, logger } from "@elizaos/core";
import {
  isModelProviderId,
  MODEL_SETTINGS_PROVIDER_ID_PATTERN,
  PostActivateModelRequestSchema,
  type PostActivateModelResponse,
  type ReadJsonBodyOptions,
} from "@elizaos/shared";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import type { ModelSettingsState } from "./model-settings-host.ts";
import {
  MODEL_SETTINGS_ERROR_STATUS,
  ModelSettingsService,
  type ModelSettingsServiceDeps,
} from "./model-settings-service.ts";

export const MODEL_SETTINGS_ROUTE_PREFIX = "/api/model-settings";

const PROVIDER_MODELS_PATH =
  /^\/api\/model-settings\/providers\/([^/]+)\/models$/;

export interface ModelSettingsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: ModelSettingsState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  callerAuthorization: AgentHttpRequestAuthorization;
  /** Resolved lazily so an unauthorized request never builds the use-case. */
  serviceDeps: () => ModelSettingsServiceDeps;
}

function readIdempotencyKey(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  const raw = headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const key = typeof value === "string" ? value.trim() : "";
  return key.length > 0 && key.length <= 128 ? key : undefined;
}

function sendError(
  ctx: ModelSettingsRouteContext,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  ctx.json(ctx.res, { error: message, code, ...extra }, status);
}

function sendServiceError(ctx: ModelSettingsRouteContext, err: unknown): void {
  if (err instanceof ElizaError) {
    const status = MODEL_SETTINGS_ERROR_STATUS[err.code];
    if (status !== undefined) {
      const activeOperationId = err.context?.activeOperationId;
      sendError(
        ctx,
        status,
        err.code,
        err.message,
        typeof activeOperationId === "string" ? { activeOperationId } : {},
      );
      return;
    }
  }
  logger.error(
    {
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof ElizaError ? err.code : undefined,
      method: ctx.method,
      pathname: ctx.pathname,
    },
    "[model-settings] Request failed",
  );
  sendError(
    ctx,
    500,
    "MODEL_SETTINGS_FAILED",
    "Model settings request failed. Check the agent logs for details.",
  );
}

export async function handleModelSettingsRoutes(
  ctx: ModelSettingsRouteContext,
): Promise<boolean> {
  const { method, pathname } = ctx;
  if (
    pathname !== MODEL_SETTINGS_ROUTE_PREFIX &&
    !pathname.startsWith(`${MODEL_SETTINGS_ROUTE_PREFIX}/`)
  ) {
    return false;
  }
  if (!ctx.callerAuthorization.ok) {
    sendError(ctx, 401, "UNAUTHORIZED", "Authentication required.");
    return true;
  }
  if (ctx.callerAuthorization.role !== "OWNER") {
    sendError(
      ctx,
      403,
      "OWNER_REQUIRED",
      "Model settings are available to the owner only.",
    );
    return true;
  }

  const service = () => new ModelSettingsService(ctx.serviceDeps());
  // error-policy:J1 every service failure becomes a structured HTTP response.
  try {
    if (pathname === MODEL_SETTINGS_ROUTE_PREFIX) {
      if (method !== "GET") {
        sendError(ctx, 405, "METHOD_NOT_ALLOWED", "Use GET.");
        return true;
      }
      ctx.json(ctx.res, await service().getStatus(ctx.state));
      return true;
    }

    const modelsMatch = PROVIDER_MODELS_PATH.exec(pathname);
    if (modelsMatch) {
      if (method !== "GET") {
        sendError(ctx, 405, "METHOD_NOT_ALLOWED", "Use GET.");
        return true;
      }
      const providerId = decodeURIComponentSafe(modelsMatch[1] ?? "");
      if (
        providerId === null ||
        !MODEL_SETTINGS_PROVIDER_ID_PATTERN.test(providerId)
      ) {
        sendError(ctx, 400, "INVALID_PROVIDER_ID", "Invalid provider id.");
        return true;
      }
      if (!isModelProviderId(providerId)) {
        sendError(ctx, 404, "UNKNOWN_PROVIDER", "Unknown model provider.");
        return true;
      }
      ctx.json(ctx.res, await service().listModels(providerId, ctx.state));
      return true;
    }

    if (pathname === `${MODEL_SETTINGS_ROUTE_PREFIX}/activate`) {
      if (method !== "POST") {
        sendError(ctx, 405, "METHOD_NOT_ALLOWED", "Use POST.");
        return true;
      }
      const body = await ctx.readJsonBody<Record<string, unknown>>(
        ctx.req,
        ctx.res,
      );
      if (body === null) return true;
      const parsed = PostActivateModelRequestSchema.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const modelRequired =
          (issue as { params?: { reason?: unknown } } | undefined)?.params
            ?.reason === "MODEL_REQUIRED";
        sendError(
          ctx,
          400,
          modelRequired ? "MODEL_REQUIRED" : "INVALID_REQUEST",
          issue?.message ?? "Invalid activation request.",
        );
        return true;
      }
      const outcome = await service().activate(parsed.data, ctx.state, {
        idempotencyKey: readIdempotencyKey(ctx.req.headers),
      });
      if (outcome.kind === "persisted") {
        throw new ElizaError(
          "[model-settings] The API host activated without an operation manager",
          { code: "MODEL_SETTINGS_HOST_MISCONFIGURED" },
        );
      }
      const response: PostActivateModelResponse = {
        operationId: outcome.operationId,
        provider: outcome.provider,
        deduped: outcome.kind === "deduped",
      };
      ctx.json(ctx.res, response, outcome.kind === "accepted" ? 202 : 200);
      return true;
    }

    sendError(ctx, 404, "NOT_FOUND", "Unknown model settings route.");
    return true;
  } catch (err) {
    sendServiceError(ctx, err);
    return true;
  }
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // error-policy:J3 a malformed escape is an explicitly invalid id.
    return null;
  }
}
