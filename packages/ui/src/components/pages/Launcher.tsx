/**
 * Searchable, theme-aware workspace application grid. Catalog curation and
 * launch callbacks remain host-owned; existing hold/drag suppression and
 * loading, retry, partial-source, and empty states are preserved.
 */

import { memo, useCallback, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "../ui/input";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import { useClickSuppression } from "../../gestures/useClickSuppression";
import { usePointerPressAndHold } from "../../gestures/usePointerPressAndHold";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import { emitViewInteraction } from "../../view-telemetry";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  LauncherAppIcon,
  LauncherAppIconSkeleton,
} from "../views/LauncherAppIcon";

const LAUNCHER_RESPONSIVE_CSS = `
[data-testid="launcher"].eliza-workspace-launcher { background:var(--bg); color:var(--text); padding:clamp(1rem,3vw,2.5rem); }
.eliza-workspace-launcher [data-testid="launcher-page-window"] { align-items:stretch; padding-inline:0; padding-top:0; }
.eliza-workspace-launcher [data-workspace-launcher-content] { max-width:64rem; margin-inline:auto; }
.eliza-workspace-launcher [data-launcher-grid] { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1rem; }
.eliza-workspace-launcher [data-testid^="launcher-tile-"] > button { max-width:none; min-height:130px; align-items:flex-start; justify-content:flex-start; gap:1rem; padding:1.25rem; border:1px solid var(--border); border-radius:.875rem; background:var(--bg-elevated,var(--card)); color:var(--text-strong); text-align:left; transition:background 150ms ease,border-color 150ms ease; }
.eliza-workspace-launcher [data-testid^="launcher-tile-"] > button:hover { background:var(--surface); border-color:var(--border-strong); }
.eliza-workspace-launcher [data-testid^="launcher-tile-"] > button:focus-visible { outline:2px solid var(--ring,var(--accent)); outline-offset:3px; }
.eliza-workspace-launcher[data-testid="launcher"] [data-launcher-icon] { width:44px; height:44px; border-radius:.625rem; background:#262626; border:none; box-shadow:none; }
.eliza-workspace-launcher [data-launcher-label] { color:var(--text-strong); font-size:.875rem; font-weight:500; text-shadow:none; max-width:100%; text-align:left; width:auto; }
.eliza-workspace-search { display:flex; align-items:center; gap:.75rem; padding:.625rem .875rem; border:1px solid var(--border); border-radius:.75rem; background:var(--bg-elevated,var(--card)); max-width:30rem; margin-bottom:1.5rem; }
.eliza-workspace-search:focus-within { outline:2px solid var(--ring,var(--accent)); outline-offset:2px; }
.eliza-workspace-search input { width:100%; min-width:0; border:0; background:transparent; box-shadow:none; height:32px; padding:0; outline:none; }
.eliza-workspace-search input:focus-visible { box-shadow:none; outline:none; }
@media(max-width:900px) { .eliza-workspace-launcher [data-launcher-grid] { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:600px) { .eliza-workspace-launcher [data-launcher-grid] { grid-template-columns:repeat(2,minmax(0,1fr)); gap:.75rem; } .eliza-workspace-launcher [data-testid^="launcher-tile-"] > button { padding:1rem; min-height:122px; } }
@media(prefers-reduced-motion:reduce) { .eliza-workspace-launcher [data-testid^="launcher-tile-"] > button { transition:none; } }

[data-testid="launcher"] { container-type: inline-size; }
[data-testid="launcher"] [data-launcher-icon] {
  width: clamp(3.5rem, 16cqi, 4.5rem);
  height: clamp(3.5rem, 16cqi, 4.5rem);
}
[data-testid="launcher"] [data-launcher-label] {
  font-size: clamp(.75rem, calc(.68rem + .25cqi), .875rem);
}
[data-testid="launcher"] [data-launcher-label][data-compact-label="true"] {
  font-size: .75rem;
  overflow-wrap: anywhere;
}
@media (orientation: landscape) and (max-height: 520px) {
  [data-testid="launcher"] [data-launcher-icon] { width: 3.5rem; height: 3.5rem; }
}
`;

export interface LauncherProps {
  entries: ViewEntry[];
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  onLaunch: (entry: ViewEntry) => void;
  className?: string;
  /** Render at natural height inside Home's app scroll region. */
  embedded?: boolean;
}

interface IconTileProps {
  entry: ViewEntry;
  onLaunch: (entry: ViewEntry) => void;
}

function viewKindBadge(entry: ViewEntry): {
  label: string;
  title: string;
} | null {
  if (entry.viewKind === "preview") {
    return {
      label: "Preview",
      title: `${entry.label} is marked preview`,
    };
  }
  if (entry.viewKind === "developer" || entry.developerOnly === true) {
    return {
      label: "Dev",
      title: `${entry.label} is marked developer`,
    };
  }
  return null;
}

// Memoized so a catalog change (install/uninstall/sort) re-renders only the
// tiles whose props actually changed, not the whole page.
const IconTile = memo(function IconTile({ entry, onLaunch }: IconTileProps) {
  const badge = viewKindBadge(entry);
  const hasLongUnbrokenLabel = entry.label
    .split(/\s+/)
    .some((word) => word.length > 10);
  // A long stationary press must NOT ghost-launch on release: the browser
  // synthesizes a compat click from that same press, and a bare onClick would
  // launch whatever tile the finger held (the gesture-matrix "no ghost-launch"
  // contract). The launcher is read-only — a hold has no action of its own —
  // so the hold only ARMS click suppression and the release is inert. A tap
  // (release before the 450ms hold) clears the timer and launches normally;
  // travel past the slop cancels the hold so scroll-drags keep their own
  // semantics. autoDisarm:false because the synthesized click can land a task
  // after the hold fires (touch); consume-on-click still disarms immediately.
  const suppression = useClickSuppression({ autoDisarm: false });
  const hold = usePointerPressAndHold<HTMLButtonElement>({
    onHold: suppression.arm,
  });
  return (
    <div
      className="flex w-full justify-center"
      data-testid={`launcher-tile-${entry.id}`}
    >
      <Button
        type="button"
        variant="launcherTile"
        size="content"
        aria-label={entry.label}
        onPointerDown={hold.onPointerDown}
        onPointerMove={hold.onPointerMove}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
        onClickCapture={suppression.onClickCapture}
        onClick={() => onLaunch(entry)}
        className="group relative w-full max-w-[5.5rem] select-none"
      >
        <div className="relative">
          <LauncherAppIcon
            entry={entry}
            className="size-16 [@media(orientation:landscape)_and_(max-height:520px)]:h-14 [@media(orientation:landscape)_and_(max-height:520px)]:w-14"
          />
          {badge ? (
            <Badge asChild variant="outline" presentation="launcherKind">
              <span
                data-testid={`launcher-kind-${entry.id}`}
                title={badge.title}
              >
                {badge.label}
              </span>
            </Badge>
          ) : null}
        </div>
        {/* 5.5rem, not the icon's 4rem: the narrowest grid cell (4 cols on a
            ~380px phone) leaves just enough room for the longest single-word
            label while keeping OCR-readable 12px copy from clipping mid-glyph
            (#14427). line-clamp-2 still wraps multi-word labels. */}
        <span
          data-launcher-label=""
          data-compact-label={hasLongUnbrokenLabel || undefined}
          className={cn(
            "line-clamp-2 w-max max-w-[5.5rem] text-center text-xs font-bold leading-tight tracking-[0.01em] whitespace-normal",
            "text-txt-strong",
          )}
        >
          {entry.label}
        </span>
      </Button>
    </div>
  );
});

export function Launcher({
  entries,
  loading = false,
  error = null,
  onRetry,
  onLaunch,
  className,
  embedded = false,
}: LauncherProps) {
  const [query, setQuery] = useState("");
  const visibleEntries = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? entries.filter((entry) =>
          entry.label.toLocaleLowerCase().includes(term),
        )
      : entries;
  }, [entries, query]);
  const handleLaunch = useCallback(
    (entry: ViewEntry) => {
      emitViewInteraction({
        source: "launcher",
        action: "launch",
        viewId: entry.id,
      });
      onLaunch(entry);
    },
    [onLaunch],
  );

  const showSkeleton = loading && entries.length === 0;
  const showError = !showSkeleton && error !== null && entries.length === 0;
  const showSourceStatus =
    !showSkeleton && error !== null && entries.length > 0;
  const showEmpty = !showSkeleton && !showError && entries.length === 0;

  return (
    <div
      className={cn(
        "eliza-workspace-launcher flex flex-col",
        !embedded && "min-h-0 flex-1",
        className,
      )}
      data-testid="launcher"
      aria-busy={showSkeleton || undefined}
    >
      <style>{LAUNCHER_RESPONSIVE_CSS}</style>
      <div
        className={cn(
          "relative flex flex-col",
          !embedded && "min-h-0 flex-1 overflow-hidden",
        )}
      >
        {/* The fixed composer sits outside this flex tree. Inner padding only
            extends the scroll range; it cannot stop an initially visible tile
            from painting beneath that overlay. The full-page margin therefore
            shortens the viewport, while its small inner padding lets the final
            row scroll fully clear. Home's app region owns embedded scrolling. */}
        <div
          data-testid="launcher-page-window"
          className={cn(
            "scrollbar-hide relative flex touch-pan-y flex-col items-center overscroll-y-contain pt-2 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden",
            embedded
              ? "overflow-visible px-2 pb-8 [@media(orientation:landscape)_and_(max-height:520px)]:pt-0"
              : "scroll-fade-b scroll-fade-b-[1.25rem] [--scroll-fade-reveal:1px] mb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem)+0.5rem)] min-h-0 flex-1 scroll-pb-7 overflow-y-auto ps-6 pe-[calc(1.5rem+var(--eliza-chat-side-clearance,0px))] pb-7",
          )}
        >
          <div
            data-workspace-launcher-content=""
            className="flex w-full max-w-2xl flex-col gap-6"
          >
            {!embedded ? <WorkspaceHeader page="launcher" /> : null}
            {!showSkeleton && !showError && entries.length > 0 ? (
              <div className="eliza-workspace-search">
                <Search
                  size={18}
                  className="shrink-0 text-muted"
                  aria-hidden="true"
                />
                <Input
                  aria-label="Search applications"
                  placeholder="Search applications…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setQuery("");
                  }}
                />
                {query ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Clear application search"
                    onClick={() => setQuery("")}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            {showSkeleton ? (
              <div
                data-launcher-grid=""
                className="grid w-full grid-cols-3 gap-x-4 gap-y-5 min-[360px]:grid-cols-4 sm:grid-cols-5"
              >
                {["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => (
                  <div
                    key={id}
                    className="flex flex-col items-center gap-1.5 opacity-60"
                  >
                    <LauncherAppIconSkeleton className="size-16" />
                    <Skeleton className="h-2.5 w-12" />
                  </div>
                ))}
              </div>
            ) : showError ? (
              <div
                role="alert"
                data-testid="launcher-error"
                className="mx-auto flex min-h-48 max-w-sm flex-col items-center justify-center gap-3 px-5 text-center"
              >
                <div className={cn("text-sm font-semibold", "text-txt-strong")}>
                  Couldn&apos;t load apps
                </div>
                <p className={cn("text-xs", "text-muted-strong")}>
                  Check the connection and try again.
                </p>
                {onRetry ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="overlayEdge"
                    onClick={onRetry}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : showEmpty ? (
              <div
                role="status"
                data-testid="launcher-empty"
                className="mx-auto flex min-h-48 max-w-sm flex-col items-center justify-center gap-2 px-5 text-center"
              >
                <div className={cn("text-sm font-semibold", "text-txt-strong")}>
                  No apps available
                </div>
                <p className={cn("text-xs", "text-muted-strong")}>
                  Available apps and views will appear here.
                </p>
              </div>
            ) : (
              <>
                <div
                  data-launcher-grid=""
                  className="grid w-full grid-cols-3 gap-x-4 gap-y-5 min-[360px]:grid-cols-4 max-sm:portrait:gap-y-8 sm:grid-cols-5"
                >
                  {visibleEntries.map((entry) => (
                    <div key={entry.id} className="flex justify-center">
                      <IconTile entry={entry} onLaunch={handleLaunch} />
                    </div>
                  ))}
                </div>
                {visibleEntries.length === 0 ? (
                  <div
                    role="status"
                    className="flex min-h-48 flex-col items-center justify-center gap-3 text-center"
                  >
                    <p className="text-sm text-muted-strong">
                      No applications match your search.
                    </p>
                    <Button variant="outline" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  </div>
                ) : null}
                {showSourceStatus ? (
                  <div
                    role="status"
                    data-testid="launcher-source-status"
                    className={cn(
                      "mx-auto flex min-h-11 items-center gap-2 text-xs",
                      "text-muted-strong",
                    )}
                  >
                    <span>More apps unavailable</span>
                    {onRetry ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="overlayEdge"
                        className="min-h-9"
                        onClick={onRetry}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
