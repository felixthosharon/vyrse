import { Clock3, PanelRight, Plus, Settings2 } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";
import { VyrseMark } from "./VyrseMark";

const STATE_LABEL: Record<string, string> = {
  idle: "present",
  listening: "listening",
  thinking: "thinking",
  speaking: "responding",
  working: "working",
  success: "done",
  error: "recovering",
};

function ChromeButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  /** toggle buttons: whether the thing it opens is open */
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
        pressed ? "liquid text-primary" : "liquid-hover",
      )}
    >
      {children}
    </button>
  );
}

export function TopChrome() {
  const {
    setHistoryOpen, setSettingsOpen, startNew, presenceState, booted, link, settings,
    presentation, setPresentation, expanded, setExpanded, workspaceUnseen, resolvedTheme,
  } = useVyrse();
  const workspaceOpen = presentation !== "compact" && !expanded;
  // Only what arrived while the workspace was hidden; opening it clears the badge.
  const unseen = workspaceOpen ? 0 : workspaceUnseen.length;
  const toggleWorkspace = () => {
    if (workspaceOpen) {
      setPresentation("compact");
      return;
    }
    // The workspace and the full transcript share the same space.
    if (expanded) setExpanded(false);
    setPresentation(presentation === "compact" ? "split" : presentation);
  };
  const linkLabel =
    link.phase === "online" ? null : link.phase === "reconnecting" ? "reconnecting" : link.phase === "connecting" || link.phase === "starting" ? "connecting" : "offline";

  return (
    <header
      className={cn(
        "pointer-events-none relative z-30 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-[clamp(0.9rem,2vw,2.5rem)] py-[clamp(0.9rem,1.6vh,1.5rem)]",
        booted ? "opacity-100" : "opacity-0",
        "transition-opacity duration-1000",
      )}
    >
      <div className="pointer-events-auto flex min-w-0 items-center gap-3">
        <VyrseMark light={resolvedTheme === "light"} className="h-7 w-[26px] shrink-0 drop-shadow-[0_2px_6px_rgba(80,170,210,0.35)]" />
        <span className="truncate font-display text-sm font-medium tracking-[0.34em] text-foreground">
          VYRSE
        </span>
        <span className="hidden items-center gap-2 sm:flex">
          <span className="h-3 w-px bg-border-strong" />
          <span className="eyebrow">{linkLabel ?? STATE_LABEL[presenceState]}</span>
          {settings.mode !== "assistant" && !linkLabel && (
            <span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              {settings.mode}
            </span>
          )}
          {linkLabel && (
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                linkLabel === "offline" ? "bg-destructive" : "animate-pulse bg-primary/70",
              )}
            />
          )}
        </span>
      </div>

      <div className="pointer-events-auto flex items-center gap-1">
        <ChromeButton label="New conversation" onClick={startNew}>
          <Plus className="size-[18px]" strokeWidth={1.5} />
        </ChromeButton>
        <ChromeButton
          label={workspaceOpen ? "Hide workspace" : unseen ? `Show workspace (${unseen} new)` : "Show workspace"}
          onClick={toggleWorkspace}
          pressed={workspaceOpen}
        >
          <PanelRight className="size-[18px]" strokeWidth={1.5} />
          {unseen > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-[9px] leading-4 text-primary-foreground">
              {unseen}
            </span>
          )}
        </ChromeButton>
        <ChromeButton label="History" onClick={() => setHistoryOpen(true)}>
          <Clock3 className="size-[18px]" strokeWidth={1.5} />
        </ChromeButton>
        <ChromeButton label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 className="size-[18px]" strokeWidth={1.5} />
        </ChromeButton>
      </div>
    </header>
  );
}
