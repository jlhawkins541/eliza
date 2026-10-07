/**
 * Builds the options the API server hands to its runtime operation manager:
 * the persisted repository, health checker, classifier with its live config
 * snapshot, and the complete tier → reload-strategy table. The cold strategy
 * restarts through the server's restart closure and resolves the runtime that
 * closure installed on `state`.
 *
 * Kept out of `server.ts` so the wiring the provider-switch routes, Models
 * page, and SETTINGS action depend on is testable without building the HTTP
 * host. The repository, health checker, and hot strategy are injectable for
 * tests; production uses the process defaults.
 */

import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import {
  resolvePreferredProviderId,
  resolvePrimaryModel,
} from "../runtime/model-resolution.ts";
import {
  type ClassifyContext,
  createColdStrategy,
  createHotStrategy,
  createRuntimeOperationStrategies,
  type DefaultRuntimeOperationManagerOptions,
  defaultClassifier,
  getDefaultHealthChecker,
  getDefaultRepository,
  type HealthChecker,
  type ReloadStrategy,
  type RuntimeOperationRepository,
} from "../runtime/operations/index.ts";

/** The slice of server state the operation manager reads. */
export interface RuntimeOperationManagerState {
  config: ElizaConfig;
  runtime: AgentRuntime | null;
}

export interface RuntimeOperationManagerOptionOverrides {
  repository?: RuntimeOperationRepository;
  healthChecker?: HealthChecker;
  hotStrategy?: ReloadStrategy;
}

export function buildRuntimeOperationManagerOptions(
  state: RuntimeOperationManagerState,
  restartRuntime: (reason: string) => Promise<boolean>,
  overrides: RuntimeOperationManagerOptionOverrides = {},
): DefaultRuntimeOperationManagerOptions {
  const coldStrategy = createColdStrategy({
    restartRuntime: async (reason) => {
      const ok = await restartRuntime(reason);
      if (!ok) return null;
      return state.runtime;
    },
  });
  const classifyContext = (): ClassifyContext => ({
    currentProvider: resolvePreferredProviderId(state.config),
    currentPrimaryModel: resolvePrimaryModel(state.config),
  });
  return {
    repository: overrides.repository ?? getDefaultRepository(),
    runtime: () => state.runtime,
    classifyContext,
    classifier: defaultClassifier,
    healthChecker: overrides.healthChecker ?? getDefaultHealthChecker(),
    strategies: createRuntimeOperationStrategies({
      cold: coldStrategy,
      hot: overrides.hotStrategy ?? createHotStrategy({}),
    }),
  };
}
