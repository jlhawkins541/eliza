/** Shared workspace navigation and overview heading, using canonical shell actions and kit controls. */
import { ArrowRight, LayoutGrid, Settings2 } from "lucide-react";
import { goHome, goLauncher } from "../../state/shell-surface-store";
import { Button } from "../ui/button";
import type { HomeTileTarget } from "./HomeScreen";

export interface WorkspaceHeaderProps {
  page?: "home" | "launcher";
  onOpenTile?: (target: HomeTileTarget) => void;
}

const WORKSPACE_HEADER_CSS = `
.eliza-workspace-header { display:grid; gap:1.75rem; margin-bottom:1.5rem; color:var(--text-strong); }
.eliza-workspace-nav { display:flex; align-items:center; justify-content:space-between; gap:1rem; min-width:0; padding-bottom:1rem; border-bottom:1px solid var(--border); }
.eliza-workspace-brand { display:flex; align-items:center; gap:.625rem; font-size:.8125rem; font-weight:600; letter-spacing:.02em; }
.eliza-workspace-brand-mark { display:grid; place-items:center; width:1.75rem; height:1.75rem; border-radius:.5rem; background:var(--accent); color:var(--accent-fg,var(--primary-foreground)); font-size:.875rem; }
.eliza-workspace-tabs { display:flex; align-items:center; gap:.375rem; }
.eliza-workspace-tabs button { min-height:44px; padding-inline:.875rem; color:var(--muted-strong); border-radius:.5rem; }
.eliza-workspace-tabs button[aria-pressed=true] { background:var(--surface); color:var(--text-strong); }
.eliza-workspace-title-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.eliza-workspace-title { margin:0; font-size:clamp(1.5rem,3.3vw,2rem); font-weight:600; line-height:1.2; letter-spacing:-.035em; }
.eliza-workspace-description { margin:.5rem 0 0; color:var(--muted-strong); font-size:.875rem; line-height:1.6; max-width:40rem; }
.eliza-workspace-primary { min-height:44px; flex-shrink:0; gap:.5rem; border-radius:.625rem; }
@media(max-width:560px) { .eliza-workspace-header { gap:1.25rem; } .eliza-workspace-nav { gap:.5rem; } .eliza-workspace-brand-word { display:none; } .eliza-workspace-tabs button { padding-inline:.75rem; font-size:.8125rem; } .eliza-workspace-title-row { align-items:flex-start; flex-wrap:wrap; } .eliza-workspace-primary { width:100%; } }
@media(max-height:520px) { .eliza-workspace-header { gap:.75rem; margin-bottom:1rem; } .eliza-workspace-description { display:none; } }
`;

export function WorkspaceHeader({
  page = "home",
  onOpenTile,
}: WorkspaceHeaderProps) {
  return (
    <header className="eliza-workspace-header" data-testid="workspace-header">
      <style>{WORKSPACE_HEADER_CSS}</style>
      <div className="eliza-workspace-nav">
        <div className="eliza-workspace-brand">
          <span className="eliza-workspace-brand-mark" aria-hidden="true">
            e
          </span>
          <span className="eliza-workspace-brand-word">
            Eliza <span className="text-muted font-normal">/ Workspace</span>
          </span>
        </div>
        <nav className="eliza-workspace-tabs" aria-label="Workspace">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={page === "home"}
            onClick={goHome}
          >
            Overview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={page === "launcher"}
            onClick={goLauncher}
          >
            Applications
          </Button>
          {onOpenTile ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open settings"
              title="Settings"
              onClick={() => onOpenTile({ kind: "tab", tab: "settings" })}
            >
              <Settings2 size={18} aria-hidden="true" />
            </Button>
          ) : null}
        </nav>
      </div>
      <div className="eliza-workspace-title-row">
        <div>
          <h1 className="eliza-workspace-title">
            {page === "home" ? "Workspace overview" : "Applications"}
          </h1>
          <p className="eliza-workspace-description">
            {page === "home"
              ? "Your assistant, updates, and daily work in one place."
              : "Open the tools connected to your workspace."}
          </p>
        </div>
        {page === "home" ? (
          <Button className="eliza-workspace-primary" onClick={goLauncher}>
            <LayoutGrid size={16} aria-hidden="true" /> Browse applications{" "}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
