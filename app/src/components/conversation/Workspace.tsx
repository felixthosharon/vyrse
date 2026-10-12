import {
  AppWindow,
  CircleDot,
  Gauge,
  GraduationCap,
  LineChart,
  ListChecks,
  Maximize2,
  Minimize2,
  NotebookPen,
  PanelRightClose,
  SquareKanban,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useVyrse } from "@/lib/vyrse/store";
import type { Artifact } from "@/lib/vyrse/types";
import { cn } from "@/lib/utils";
import { ArtifactView, isWideArtifact } from "./ArtifactView";
import { Markdown } from "./Markdown";

const STARTERS = [
  {
    icon: Gauge,
    label: "How's my PC doing?",
    prompt:
      "How's my PC doing? Show it as a dashboard in the workspace: gauges for CPU, RAM and GPU, and what needs attention.",
  },
  {
    icon: LineChart,
    label: "Graph my CPU for 10 seconds",
    prompt: "Graph my CPU usage for 10 seconds.",
  },
  { icon: NotebookPen, label: "Log 20 min of study", prompt: "Log study, 20 minutes." },
  {
    icon: CircleDot,
    label: "My goals as rings",
    prompt:
      "Show my goals for today as completion rings. Ask me what they are and how far I've got first.",
  },
  {
    icon: SquareKanban,
    label: "Plan my week as a board",
    prompt:
      "Help me plan my week as a board in the workspace (To do, Doing, Done). Ask me what's on first.",
  },
  {
    icon: ListChecks,
    label: "Plan my day as a checklist",
    prompt: "Make me a checklist for today. Ask me what I need to get done first.",
  },
  {
    icon: GraduationCap,
    label: "Quiz me",
    prompt:
      "Quiz me out loud, one question at a time, and track my answers in the workspace. Ask me the topic first.",
  },
  {
    icon: AppWindow,
    label: "Build me a tip calculator",
    prompt: "Build me a tip calculator app in the workspace.",
  },
];

/**
 * The contextual workspace surface.
 *
 * It holds what Hermes chose to *show* (vyrse_workspace: charts, rings, quizzes, tables, images, code…),
 * newest first, and otherwise the current reply's own artifact. It renders only structured, typed data
 * — never markup or styling supplied by the model. The frontend owns every dimension; the mode only
 * says how important the workspace is right now. Compact items (rings, numbers, scorecards…) sit side
 * by side when the panel is wide; any item can be zoomed to fill the panel.
 */
export function Workspace() {
  const {
    active,
    presentation,
    setPresentation,
    workspace,
    removeWorkspaceItem,
    checkWorkspaceItem,
    clearWorkspace,
    workspaceFocus: zoom,
    focusWorkspaceItem: setZoom,
    send,
    busy,
  } = useVyrse();
  const [now, setNow] = useState(() => Date.now());
  const messages = active?.messages ?? [];
  const lastVyrse = [...messages].reverse().find((m) => m.role === "vyrse");
  const focus = presentation === "focus";
  const zoomed = zoom ? workspace.find((a) => a.id === zoom) : undefined;
  const shown = zoomed ? [zoomed] : workspace;

  // "Fresh" glow for items that just arrived; re-evaluated when something new comes in.
  useEffect(() => setNow(Date.now()), [workspace]);

  const ask = busy ? undefined : (text: string) => send(text);
  const spanning = new Set(
    runs(shown, !!zoomed)
      .filter((run) => run.length === 1)
      .map((run) => run[0]!.id ?? ""),
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-3 px-1">
        <p className="flex items-baseline gap-2">
          <span className="font-display text-[15px] font-medium tracking-tight text-foreground">
            Workspace
          </span>
          {workspace.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {workspace.length} {workspace.length === 1 ? "item" : "items"}
            </span>
          )}
        </p>
        <div className="flex items-center gap-1">
          {workspace.length > 0 && (
            <HeaderButton
              onClick={clearWorkspace}
              label="Clear workspace"
              icon={<Trash2 className="size-3" strokeWidth={1.6} />}
            >
              Clear
            </HeaderButton>
          )}
          <HeaderButton
            onClick={() => setPresentation(focus ? "split" : "focus")}
            label={focus ? "Show the workspace beside VYRSE" : "Make the workspace the main view"}
            icon={
              focus ? (
                <Minimize2 className="size-3" strokeWidth={1.6} />
              ) : (
                <Maximize2 className="size-3" strokeWidth={1.6} />
              )
            }
          >
            {focus ? "Split" : "Focus"}
          </HeaderButton>
          <HeaderButton
            onClick={() => setPresentation("compact")}
            label="Close workspace"
            icon={<PanelRightClose className="size-3" strokeWidth={1.6} />}
          >
            Close
          </HeaderButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* liquid light drifting slowly behind the board */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[1.5rem]"
        >
          <span className="vyr-blob -top-16 -left-10 size-72 bg-primary/[0.14]" />
          <span className="vyr-blob -right-16 bottom-0 size-80 bg-accent/[0.09] [animation-delay:-9s] [animation-duration:32s]" />
          <span className="vyr-blob top-1/3 left-1/3 size-56 bg-trace/[0.1] [animation-delay:-17s] [animation-duration:38s]" />
        </div>
        <div className="field-scroll @container relative h-full overflow-y-auto rounded-[1.5rem] border border-border bg-surface/60 p-3 sm:p-4">
          {workspace.length > 0 ? (
            // One flat list with stable keys: an arriving card never rebuilds the others (that replayed their
            // entrance and re-spun wheels). Compact cards flow into two columns when the panel is wide; wide
            // ones, and a compact card on its own, span both.
            <div className="gap-3 @[40rem]:columns-2 [&>*]:break-inside-avoid [&>*]:pb-3">
              {shown.map((artifact) => (
                <div
                  key={artifact.id}
                  className={cn(spanning.has(artifact.id ?? "") && "[column-span:all]")}
                >
                  <ArtifactView
                    artifact={artifact}
                    fresh={!!artifact.at && now - artifact.at < 5000}
                    zoomed={!!zoomed}
                    onZoom={
                      workspace.length > 1
                        ? () => setZoom(zoomed ? null : (artifact.id ?? null))
                        : undefined
                    }
                    onRemove={() => artifact.id && removeWorkspaceItem(artifact.id)}
                    onCheck={(index, done) =>
                      artifact.id && checkWorkspaceItem(artifact.id, index, done)
                    }
                    onAsk={ask}
                  />
                </div>
              ))}
            </div>
          ) : lastVyrse?.artifact ? (
            <>
              <ArtifactView artifact={lastVyrse.artifact} />
              {lastVyrse.text && (
                <div className="mt-4 border-t border-border/70 px-1 pt-4">
                  <Markdown text={lastVyrse.text} />
                </div>
              )}
            </>
          ) : (
            <div className="px-1 py-3">
              <p className="text-[13.5px] text-foreground">Nothing here yet.</p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                When VYRSE analyses, tracks, plans or teaches, it builds it here: charts, live
                gauges, logs, boards, quizzes, even small apps. Try one:
              </p>
              <div className="mt-4 grid grid-cols-1 gap-2 @[30rem]:grid-cols-2">
                {STARTERS.map(({ icon: Icon, label, prompt }) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={() => send(prompt)}
                    className="liquid-hover relative flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-[13px] text-foreground/90 enabled:hover:text-foreground disabled:opacity-50 focus-visible:outline-none"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-3.5" strokeWidth={1.6} />
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Consecutive compact items grouped together; each wide item (or a zoomed one) on its own. */
function runs(items: Artifact[], single: boolean): Artifact[][] {
  const out: Artifact[][] = [];
  for (const a of items) {
    const last = out.at(-1);
    if (!single && !isWideArtifact(a) && last && !isWideArtifact(last[0]!)) last.push(a);
    else out.push([a]);
  }
  return out;
}

function HeaderButton({
  onClick,
  label,
  icon,
  children,
}: {
  onClick: () => void;
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="liquid-hover relative flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none"
    >
      {icon}
      {children}
    </button>
  );
}
