/**
 * Regression coverage for the reload-strategy table the API server installs.
 * Drives the real classifier, operation manager, filesystem repository and
 * health checker; only the restart closure behind the cold strategy is a stub,
 * because a real restart needs a booted runtime.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyOperation, defaultClassifier } from "./classifier.ts";
import { createColdStrategy } from "./cold-strategy.ts";
import { HealthChecker } from "./health.ts";
import { DefaultRuntimeOperationManager } from "./manager.ts";
import { FilesystemRuntimeOperationRepository } from "./repository.ts";
import { createRuntimeOperationStrategies } from "./strategy-table.ts";
import type {
  ReloadStrategy,
  ReloadTier,
  RuntimeOperation,
  RuntimeOperationRepository,
} from "./types.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-strategy-table-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function runtimeStub(id: string): AgentRuntime {
  return { agentId: id } as AgentRuntime;
}

/** Hot reload is not under test; it keeps the current runtime. */
const hotStub: ReloadStrategy = {
  tier: "hot",
  apply: async (ctx) => ctx.runtime,
};

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
  strategies: Partial<Record<ReloadTier, ReloadStrategy>>,
  currentRuntime: AgentRuntime,
) {
  const repository = new FilesystemRuntimeOperationRepository(stateDir);
  const manager = new DefaultRuntimeOperationManager({
    repository,
    runtime: () => currentRuntime,
    classifyContext: () => ({ currentProvider: "openai" }),
    classifier: defaultClassifier,
    healthChecker: new HealthChecker(),
    strategies,
  });
  return { manager, repository };
}

describe("createRuntimeOperationStrategies", () => {
  it("registers a strategy for every tier the classifier can return", () => {
    const restartedRuntime = runtimeStub("restarted");
    const cold = createColdStrategy({
      restartRuntime: async () => restartedRuntime,
    });
    const table = createRuntimeOperationStrategies({
      cold,
      hot: hotStub,
    });
    const tiers: ReloadTier[] = [
      classifyOperation(
        { kind: "provider-switch", provider: "openai" },
        { currentProvider: "openai" },
      ),
      classifyOperation(
        { kind: "provider-switch", provider: "openai-subscription" },
        { currentProvider: "openai" },
      ),
      classifyOperation(
        { kind: "provider-switch", provider: "anthropic" },
        { currentProvider: "openai" },
      ),
    ];
    expect(new Set(tiers)).toEqual(new Set(["hot", "warm", "cold"]));
    for (const tier of tiers) {
      expect(table[tier]?.tier).toBe(tier);
    }
  });

  it("completes a warm same-family switch through the cold restart", async () => {
    const restartedRuntime = runtimeStub("restarted");
    const restartRuntime = vi.fn(async () => restartedRuntime);
    const strategies = createRuntimeOperationStrategies({
      cold: createColdStrategy({ restartRuntime }),
      hot: hotStub,
    });
    const { manager, repository } = buildManager(
      strategies,
      runtimeStub("current"),
    );

    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "openai-subscription" },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.operation.tier).toBe("warm");

    const finished = await waitForTerminal(repository, outcome.operation.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.error).toBeUndefined();
    expect(restartRuntime).toHaveBeenCalledWith(
      "provider switch to openai-subscription",
    );
  });

  it("documents the regression: a table without warm fails the accepted switch", async () => {
    const restartRuntime = vi.fn(async () => runtimeStub("restarted"));
    const { manager, repository } = buildManager(
      {
        cold: createColdStrategy({ restartRuntime }),
        hot: hotStub,
      },
      runtimeStub("current"),
    );

    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "openai-subscription" },
    });
    if (outcome.kind !== "accepted") throw new Error("expected accepted");
    const finished = await waitForTerminal(repository, outcome.operation.id);
    expect(finished.status).toBe("failed");
    expect(finished.error?.code).toBe("no-strategy-for-tier");
    expect(restartRuntime).not.toHaveBeenCalled();
  });
});
