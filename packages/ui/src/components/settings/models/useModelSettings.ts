/**
 * State for the Models workspace: the owner-only model settings status, the
 * per-provider live model catalogs, and provider activation.
 *
 * Every remote read is a distinct loading / ready / error state; nothing is
 * defaulted. Activation restarts the agent server-side, so while a provider
 * switch is pending or applying the hook polls status. A poll that fails during
 * that restart keeps the last good status and reports `reconnecting` instead
 * of replacing the page with an error.
 */

import type {
  ModelProviderId,
  ModelSettingsStatusDto,
  PostActivateModelRequest,
  PostActivateModelResponse,
  ProviderModelCatalogDto,
} from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, client } from "../../../api";

/** The client surface this hook needs; injectable for tests and stories. */
export interface ModelSettingsApi {
  getModelSettings(): Promise<ModelSettingsStatusDto>;
  listProviderModels(
    provider: ModelProviderId,
  ): Promise<ProviderModelCatalogDto>;
  activateModel(
    request: PostActivateModelRequest,
  ): Promise<PostActivateModelResponse>;
}

export type ModelSettingsLoadState =
  | { state: "loading" }
  | { state: "ready"; data: ModelSettingsStatusDto; reconnecting: boolean }
  | { state: "error"; message: string; ownerOnly: boolean };

export type ProviderCatalogLoadState =
  | { state: "loading" }
  | { state: "ready"; catalog: ProviderModelCatalogDto }
  | { state: "error"; message: string };

export type ModelActivationState =
  | { state: "idle" }
  | { state: "submitting"; provider: ModelProviderId }
  | { state: "accepted"; provider: ModelProviderId; operationId: string }
  | {
      state: "error";
      provider: ModelProviderId;
      code: string | null;
      message: string;
    };

export interface ModelSettingsController {
  status: ModelSettingsLoadState;
  catalogs: Partial<Record<ModelProviderId, ProviderCatalogLoadState>>;
  activation: ModelActivationState;
  refresh: () => void;
  loadCatalog: (provider: ModelProviderId) => void;
  activate: (request: PostActivateModelRequest) => void;
}

export const MODEL_SETTINGS_POLL_INTERVAL_MS = 2_000;

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function isOwnerOnlyError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function operationInFlight(status: ModelSettingsLoadState): boolean {
  if (status.state !== "ready") return false;
  const op = status.data.operation;
  return op !== null && (op.state === "pending" || op.state === "applying");
}

export function useModelSettings(
  api: ModelSettingsApi = client,
): ModelSettingsController {
  const [status, setStatus] = useState<ModelSettingsLoadState>({
    state: "loading",
  });
  const [catalogs, setCatalogs] = useState<
    Partial<Record<ModelProviderId, ProviderCatalogLoadState>>
  >({});
  const [activation, setActivation] = useState<ModelActivationState>({
    state: "idle",
  });
  const mounted = useRef(true);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadStatus = useCallback(
    async (mode: "initial" | "poll") => {
      try {
        const data = await api.getModelSettings();
        if (!mounted.current) return;
        setStatus({ state: "ready", data, reconnecting: false });
      } catch (error) {
        if (!mounted.current) return;
        const previous = statusRef.current;
        // error-policy:J4 a failed read during an in-flight restart is the
        // expected reconnecting state; any other failure is the error state.
        if (mode === "poll" && previous.state === "ready") {
          setStatus({ ...previous, reconnecting: true });
          return;
        }
        setStatus({
          state: "error",
          message: describeError(error, "Could not load model settings."),
          ownerOnly: isOwnerOnlyError(error),
        });
      }
    },
    [api],
  );

  useEffect(() => {
    void loadStatus("initial");
  }, [loadStatus]);

  const refresh = useCallback(() => {
    setStatus({ state: "loading" });
    void loadStatus("initial");
  }, [loadStatus]);

  const shouldPoll =
    activation.state === "accepted" ||
    operationInFlight(status) ||
    (status.state === "ready" && status.reconnecting);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      void loadStatus("poll");
    }, MODEL_SETTINGS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, loadStatus]);

  // An accepted activation is finished once status reports that operation
  // as terminal; the operation card then carries the outcome.
  useEffect(() => {
    if (activation.state !== "accepted" || status.state !== "ready") return;
    const op = status.data.operation;
    if (
      op?.id === activation.operationId &&
      (op.state === "succeeded" || op.state === "failed")
    ) {
      setActivation({ state: "idle" });
    }
  }, [activation, status]);

  const loadCatalog = useCallback(
    (provider: ModelProviderId) => {
      setCatalogs((current) => ({
        ...current,
        [provider]: { state: "loading" },
      }));
      void api.listProviderModels(provider).then(
        (catalog) => {
          if (!mounted.current) return;
          setCatalogs((current) => ({
            ...current,
            [provider]: { state: "ready", catalog },
          }));
        },
        (error: unknown) => {
          if (!mounted.current) return;
          // error-policy:J4 a failed catalog read is the visible error state.
          setCatalogs((current) => ({
            ...current,
            [provider]: {
              state: "error",
              message: describeError(error, "Could not load models."),
            },
          }));
        },
      );
    },
    [api],
  );

  const activate = useCallback(
    (request: PostActivateModelRequest) => {
      setActivation({ state: "submitting", provider: request.provider });
      void api.activateModel(request).then(
        (response) => {
          if (!mounted.current) return;
          setActivation({
            state: "accepted",
            provider: response.provider,
            operationId: response.operationId,
          });
          void loadStatus("poll");
        },
        (error: unknown) => {
          if (!mounted.current) return;
          // error-policy:J4 the server's typed refusal is shown on the page.
          setActivation({
            state: "error",
            provider: request.provider,
            code: error instanceof ApiError ? (error.code ?? null) : null,
            message: describeError(error, "Could not switch the provider."),
          });
        },
      );
    },
    [api, loadStatus],
  );

  return { status, catalogs, activation, refresh, loadCatalog, activate };
}
