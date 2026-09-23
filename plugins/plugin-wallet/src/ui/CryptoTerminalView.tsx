/**
 * CryptoTerminalView is the dedicated trading-terminal entry point for the
 * wallet plugin. It intentionally reuses InventoryAppView so balances, market
 * data, P&L, activity, and chain readiness keep one canonical data pipeline.
 *
 * Future terminal-only panels (scanner, execution, alerts, strategy controls)
 * should compose around this view rather than reimplement wallet data access.
 */
import { Escape } from "@elizaos/ui/spatial";
import * as React from "react";
import { InventoryAppView } from "./components/InventoryAppView.tsx";

void React;

export function CryptoTerminalView() {
  return (
    <Escape>
      <div className="flex min-h-full w-full flex-col bg-bg">
        <header className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3 md:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              Crypto Terminal
            </h1>
            <p className="text-xs text-muted">
              Wallet, portfolio, market intelligence, and execution readiness
            </p>
          </div>
          <div className="rounded-full border border-border px-2.5 py-1 text-[0.68rem] font-medium uppercase tracking-[0.12em] text-muted">
            Human-confirmed execution
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <InventoryAppView />
        </div>
      </div>
    </Escape>
  );
}
