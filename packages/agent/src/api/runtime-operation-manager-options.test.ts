/**
 * Covers the operation-manager wiring the API server installs
 * (`buildRuntimeOperationManagerOptions`): every tier the classifier returns
 * against the live config has a strategy, the cold and warm tiers run the
 * server's restart closure and adopt the runtime it installed, and a failed
 * restart fails the operation. Drives the real classifier, manager,
 * filesystem repository, and cold strategy; only the restart closure and the
 * hot strategy are stubs, since a real restart needs a booted runtime.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  DefaultRuntimeOperationManager,
  FilesystemRuntimeOperationRepository,
  HealthChecker,
  type ReloadStrategy,
  type RuntimeOperation,
  type RuntimeOperationRepository,
} from "../runtime/operations/index.ts";
import {
  buildRuntimeOperationManagerOptions,
  type RuntimeOperationManagerState,
} from "./runtime-operation-manager-options.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-op-manager-opts-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function runtimeStub(id: string): AgentRuntime {
  return { agentId: id } as AgentRuntime;
}

function directRoute(backend: string): ElizaConfig {
  return {
    serviceRouting: { llmText: { transport: "direct", backend } },
  } as ElizaConfig;
}

async function waitForTerminal(
  repository: RuntimeOperationRepository,
  id: string,
): Promise<RuntimeOperation> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const op = await repository.get(id);
    if (op && op.status !== "pending" && op.status !== "running") return op;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation ${id} did not reach a terminal state`);
}

function buildManager(
  state: RuntimeOperationManagerState,
  restartRuntime: (reason: string) => Promise<boolean>,
) {
  const repository = new FilesystemRuntimeOperationRepository(stateDir);
  const hotApply = vi.fn(async (ctx: { runtime: AgentRuntime }) => ctx.runtime);
  const hotStrategy: ReloadStrategy = { tier: "hot", apply: hotApply };
  const manager = new DefaultRuntimeOperationManager(
    buildRuntimeOperationManagerOptions(state, restartRuntime, {
      repository,
      healthChecker: new HealthChecker(),
      hotStrategy,
    }),
  );
  return { manager, repository, hotApply };
}

/** Restart closure shaped like the server's: swaps `state.runtime`, reports ok. */
function restartInstalling(state: RuntimeOperationManagerState, id: string) {
  return vi.fn(async (_reason: string) => {
    state.runtime = runtimeStub(id);
    return true;
  });
}

describe("buildRuntimeOperationManagerOptions", () => {
  it("completes a warm same-family switch through the restart closure", async () => {
    const state: RuntimeOperationManagerState = {
      config: directRoute("openai"),
      runtime: runtimeStub("current"),
    };
    const restartRuntime = restartInstalling(state, "restarted");
    const { manager, repository, hotApply } = buildManager(
      state,
      restartRuntime,
    );

    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "openai-subscription" },
    });
    if (outcome.kind !== "accepted") throw new Error("expected accepted");
    expect(outcome.operation.tier).toBe("warm");

    const finished = await waitForTerminal(repository, outcome.operation.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.error).toBeUndefined();
    expect(restartRuntime).toHaveBeenCalledWith(
      "provider switch to openai-subscription",
    );
    expect(hotApply).not.toHaveBeenCalled();
  });

  it("classifies against the live config at submission time", async () => {
    const state: RuntimeOperationManagerState = {
      config: directRoute("openai"),
      runtime: runtimeStub("current"),
    };
    const { manager, repository } = buildManager(
      state,
      restartInstalling(state, "restarted"),
    );

    // The same target is warm from OpenAI and cold once the config moved on.
    state.config = directRoute("anthropic");
    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "openai-subscription" },
    });
    if (outcome.kind !== "accepted") throw new Error("expected accepted");
    expect(outcome.operation.tier).toBe("cold");
    expect(
      (await waitForTerminal(repository, outcome.operation.id)).status,
    ).toBe("succeeded");
  });

  it("routes a same-provider change to the hot strategy", async () => {
    const state: RuntimeOperationManagerState = {
      config: directRoute("anthropic"),
      runtime: runtimeStub("current"),
    };
    const restartRuntime = restartInstalling(state, "restarted");
    const { manager, repository, hotApply } = buildManager(
      state,
      restartRuntime,
    );

    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "anthropic" },
    });
    if (outcome.kind !== "accepted") throw new Error("expected accepted");
    expect(outcome.operation.tier).toBe("hot");
    expect(
      (await waitForTerminal(repository, outcome.operation.id)).status,
    ).toBe("succeeded");
    expect(hotApply).toHaveBeenCalledTimes(1);
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it("fails the operation when the restart closure reports failure", async () => {
    const state: RuntimeOperationManagerState = {
      config: directRoute("openai"),
      runtime: runtimeStub("current"),
    };
    const restartRuntime = vi.fn(async () => false);
    const { manager, repository } = buildManager(state, restartRuntime);

    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "anthropic" },
    });
    if (outcome.kind !== "accepted") throw new Error("expected accepted");
    const finished = await waitForTerminal(repository, outcome.operation.id);
    expect(finished.status).toBe("failed");
    expect(finished.error?.code).toBe("strategy-failed");
    expect(restartRuntime).toHaveBeenCalledWith("provider switch to anthropic");
  });
});
