/**
 * Builds the tier → reload-strategy table the API server hands to the
 * runtime operation manager.
 *
 * The classifier can return every `ReloadTier`, so the table is a complete
 * record: a tier without a strategy fails the operation with
 * `no-strategy-for-tier` after it was accepted. Warm (a switch within one
 * provider family, such as `openai` ↔ `openai-subscription`) has no lighter
 * implementation yet, so it runs the cold restart, which is a safe superset.
 */

import type { ReloadStrategy, ReloadTier } from "./types.ts";

export interface RuntimeOperationStrategyDeps {
  cold: ReloadStrategy;
  hot: ReloadStrategy;
}

export function createRuntimeOperationStrategies(
  deps: RuntimeOperationStrategyDeps,
): Record<ReloadTier, ReloadStrategy> {
  return {
    cold: deps.cold,
    hot: deps.hot,
    warm: { tier: "warm", apply: (ctx) => deps.cold.apply(ctx) },
  };
}
