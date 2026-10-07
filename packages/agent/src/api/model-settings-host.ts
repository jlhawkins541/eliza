/**
 * Process-wide handle through which the SETTINGS agent action reaches the API
 * host's live config, runtime, and runtime operation manager, so a model
 * switch requested in chat runs the same activation as the Models page.
 *
 * The API server re-registers the resolver on every request it handles (the
 * operation manager is created lazily on first use). Without a registered host
 * the runtime has no API server, and callers persist the change for the next
 * boot instead.
 */

import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import type { RuntimeOperationManager } from "../runtime/operations/index.ts";

/** Live state the model settings use-case reads and mutates. */
export interface ModelSettingsState {
  config: ElizaConfig;
  runtime: AgentRuntime | null;
}

export interface ModelSettingsHost {
  state: ModelSettingsState;
  operations: RuntimeOperationManager;
  saveConfig: (config: ElizaConfig) => void;
}

let resolveHost: (() => ModelSettingsHost) | null = null;

export function registerModelSettingsHost(
  resolver: (() => ModelSettingsHost) | null,
): void {
  resolveHost = resolver;
}

export function getModelSettingsHost(): ModelSettingsHost | null {
  return resolveHost ? resolveHost() : null;
}
