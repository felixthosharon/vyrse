import type { WorkspaceUpdate } from "@/services/hermes/workspace-interact";
import {
  AppWindow, BarChart3, Check, ChevronDown, CircleDot, CloudSun, Code2, Copy, FileText, FolderTree, Gauge, GitCommitVertical, GraduationCap, Grid3x3, Hash, Image as ImageIcon, ImageDown, Layers, LayoutGrid, LineChart as LineChartIcon, ListChecks, ListOrdered, Maximize2, Minimize2, MoreHorizontal, Network, NotebookPen, PieChart, Pin, Shuffle, Sparkles, SquareKanban, Table2, TextCursorInput, Timer as TimerIcon, Trophy, X, type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toBlob } from "html-to-image";
import type { CardSize, ChartStyle } from "./board-layout";
import type { Artifact } from "@/lib/vyrse/types";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { Checklist, Donut, Flashcards, ProgressBar, Quiz, Rings, Scorecard, Stats, StatusTiles, artifactText } from "./ArtifactKinds";
import { stagger } from "./motion";
import { AppFrame, Bars, Board, Columns, Folders, Gauges, Heatmap, InfoCards, LineChart, LogView, MindMap, Picker, Timer, Weather, Form } from "./WorkspaceKinds";

const KIND_META: Record<string, { icon: LucideIcon; label: string }> = {
  line: { icon: LineChartIcon, label: "chart" },
  bar: { icon: BarChart3, label: "bar chart" },
  donut: { icon: PieChart, label: "breakdown" },
  table: { icon: Table2, label: "table" },
  compare: { icon: Table2, label: "comparison" },
  markdown: { icon: FileText, label: "document" },
  document: { icon: FileText, label: "document" },
  image: { icon: ImageIcon, label: "image" },
  code: { icon: Code2, label: "code" },
  timeline: { icon: GitCommitVertical, label: "timeline" },
  flow: { icon: ListOrdered, label: "steps" },
  system_status: { icon: Gauge, label: "status" },
  progress: { icon: Gauge, label: "progress" },
  rings: { icon: CircleDot, label: "goals" },
  stats: { icon: Hash, label: "numbers" },
  checklist: { icon: ListChecks, label: "checklist" },
  quiz: { icon: GraduationCap, label: "quiz" },
  scorecard: { icon: Trophy, label: "result" },
  flashcards: { icon: Layers, label: "flashcards" },
  gauges: { icon: Gauge, label: "live" },
  cards: { icon: LayoutGrid, label: "overview" },
  weather: { icon: CloudSun, label: "weather" },
  timer: { icon: TimerIcon, label: "timer" },
  board: { icon: SquareKanban, label: "board" },
  heatmap: { icon: Grid3x3, label: "activity" },
  log: { icon: NotebookPen, label: "log" },
  app: { icon: AppWindow, label: "app" },
  picker: { icon: Shuffle, label: "picker" },
  mindmap: { icon: Network, label: "mind map" },
  folders: { icon: FolderTree, label: "files" },
  form: { icon: TextCursorInput, label: "your details" },
};

function kindKey(a: Artifact): string {
  return a.kind === "series" ? (a.chart?.style ?? "line") : a.kind;
}

/** Wide kinds take the full width of the workspace grid; compact ones can sit side by side. */
export function isWideArtifact(a: Artifact): boolean {
  return !["rings", "stats", "checklist", "scorecard", "flashcards", "progress", "system_status", "donut", "gauges", "weather", "timer", "log", "picker", "folders"].includes(kindKey(a));
}

function ago(at: number | undefined, now: number): string | null {
  if (!at) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * One workspace card (also used for a reply's own artifact). It renders only typed data — never markup
 * or styling from the model — and owns every dimension itself.
 */
export function ArtifactView({
  artifact,
  onRemove,
  onCheck,
  onZoom,
  zoomed = false,
  fresh = false,
  onAsk,
  onUpdate,
  board,
}: {
  artifact: Artifact;
  onRemove?: (() => void) | undefined;
  onCheck?: ((index: number, done: boolean) => void) | undefined;
  onZoom?: (() => void) | undefined;
  zoomed?: boolean;
  fresh?: boolean;
  /** send a follow-up to VYRSE (the workspace offers one or two that fit the item) */
  onAsk?: ((text: string) => void) | undefined;
  /** the user changed the item (timer controls, a board card moved, a form sent) */
  onUpdate?: ((update: WorkspaceUpdate) => void) | undefined;
  /** the board's arrangement of this card (only on the workspace board) */
  board?: {
    size: CardSize;
    pinned: boolean;
    chart?: ChartStyle;
    onSize: (size: CardSize) => void;
    onPin: () => void;
    onChart: (style: ChartStyle) => void;
  };
}) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const menuButton = useRef<HTMLSpanElement>(null);
  const menuList = useRef<HTMLSpanElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const figure = useRef<HTMLElement>(null);
  // the chart type the user picked from the menu, else what VYRSE chose
  const chartStyle = board?.chart ?? artifact.chart?.style;
  useEffect(() => {
    if (!menu) return;
    const r = menuButton.current?.getBoundingClientRect();
    if (r) setMenuAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuButton.current?.contains(t) && !menuList.current?.contains(t)) setMenu(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);

  /** The card as a PNG (the body only, no buttons), copied to the clipboard or saved. */
  const image = async (how: "copy" | "save") => {
    setMenu(false);
    const node = figure.current;
    if (!node) return;
    const bg = getComputedStyle(document.body).backgroundColor;
    const blob = await toBlob(node, { pixelRatio: 2, backgroundColor: bg, filter: (el) => !(el instanceof HTMLElement && el.dataset["cardChrome"] !== undefined) }).catch(() => null);
    if (!blob) return;
    if (how === "copy") {
      await navigator.clipboard?.write?.([new ClipboardItem({ "image/png": blob })]).catch(() => undefined);
      setSaved("Copied as image");
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(artifact.title || "workspace").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60)}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setSaved("Saved as image");
    }
    window.setTimeout(() => setSaved(null), 1600);
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!artifact.at) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [artifact.at]);
  const meta = KIND_META[kindKey(artifact)] ?? KIND_META["markdown"]!;
  const Icon = meta.icon;
  const text = artifactText(artifact);
  const when = ago(artifact.at, now);

  const copy = () => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <figure
      ref={figure}
      className={cn(
        "vyr-card-in vyr-liquid-card group/card relative my-0 overflow-hidden rounded-[1.25rem] border border-border bg-card shadow-[var(--glow-soft)]",
        fresh && "vyr-fresh",
      )}
    >
      {/* a faint glass sheen along the top edge */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-foreground/[0.035] to-transparent" />
      {/* a new card lands like a drop: a ripple spreads out from its icon */}
      {fresh && <span aria-hidden className="vyr-drop" />}
      {/* …and a light sweep across it as it arrives */}
      <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="vyr-card-sheen absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/[0.07] to-transparent" />
      </span>
      <div data-card-head className="relative flex items-center gap-3 px-4 pt-3.5 pb-3">
        <span className="vyr-pop grid size-8 shrink-0 place-items-center rounded-[0.65rem] border border-primary/20 bg-primary/10 text-primary" style={stagger(0)}>
          <Icon className="size-4" strokeWidth={1.6} />
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left focus-visible:outline-none" aria-expanded={open}>
          <span className="eyebrow block truncate">
            {meta.label}
            {when && <span className="tracking-normal normal-case"> · {when}</span>}
          </span>
          <span className="mt-0.5 block truncate font-display text-[14.5px] text-foreground">{artifact.title}</span>
        </button>
        <span data-card-chrome className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover/card:opacity-100 focus-within:opacity-100">
          {text && (
            <CardButton label={copied ? "Copied" : "Copy"} onClick={copy}>
              {copied ? <Check className="size-3.5 text-success" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.6} />}
            </CardButton>
          )}
          {saved && <span className="mr-1 font-mono text-[10.5px] text-success">{saved}</span>}
          {board && (
            <span ref={menuButton} className="relative" data-card-menu data-card-chrome>
              <CardButton label="More" onClick={() => setMenu((v) => !v)}>
                <MoreHorizontal className="size-3.5" strokeWidth={1.6} />
              </CardButton>
              {menu && menuAt && createPortal(
                <span ref={menuList} role="menu" style={{ top: menuAt.top, right: menuAt.right }} className="vyr-emerge liquid-menu fixed z-[70] flex w-52 flex-col rounded-2xl p-1.5 text-[12.5px]">
                  {onAsk && (
                    <MenuItem onClick={() => { setMenu(false); onAsk(`Explain the "${artifact.title}" card in two or three sentences: what it shows and what stands out.`); }}>
                      <Sparkles className="size-3.5" strokeWidth={1.6} /> Explain this
                    </MenuItem>
                  )}
                  {artifact.kind === "series" && (
                    <span className="flex items-center gap-1 px-2 py-1.5">
                      <span className="mr-auto text-muted-foreground">Chart</span>
                      {(["line", "bar", "donut"] as ChartStyle[]).map((st) => (
                        <button key={st} type="button" onClick={() => board.onChart(st)} className={cn("rounded-full px-2 py-0.5 capitalize", chartStyle === st ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                          {st}
                        </button>
                      ))}
                    </span>
                  )}
                  <span className="flex items-center gap-1 px-2 py-1.5">
                    <span className="mr-auto text-muted-foreground">Size</span>
                    {(["s", "m", "l"] as CardSize[]).map((sz) => (
                      <button key={sz} type="button" onClick={() => board.onSize(sz)} className={cn("rounded-full px-2 py-0.5 uppercase", board.size === sz ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                        {sz}
                      </button>
                    ))}
                  </span>
                  <MenuItem onClick={() => { setMenu(false); board.onPin(); }}>
                    <Pin className="size-3.5" strokeWidth={1.6} /> {board.pinned ? "Unpin" : "Pin to top"}
                  </MenuItem>
                  <MenuItem onClick={() => void image("copy")}>
                    <Copy className="size-3.5" strokeWidth={1.6} /> Copy as image
                  </MenuItem>
                  <MenuItem onClick={() => void image("save")}>
                    <ImageDown className="size-3.5" strokeWidth={1.6} /> Save as image
                  </MenuItem>
                </span>,
                document.body,
              )}
            </span>
          )}
          {board?.pinned && <Pin aria-label="Pinned" className="mx-1 size-3 text-primary" strokeWidth={1.8} />}
          {onZoom && (
            <CardButton label={zoomed ? "Back to all items" : "Show only this"} onClick={onZoom}>
              {zoomed ? <Minimize2 className="size-3.5" strokeWidth={1.6} /> : <Maximize2 className="size-3.5" strokeWidth={1.6} />}
            </CardButton>
          )}
          {onRemove && (
            <CardButton label={`Remove ${artifact.title}`} onClick={onRemove}>
              <X className="size-3.5" strokeWidth={1.6} />
            </CardButton>
          )}
          <CardButton label={open ? "Collapse" : "Expand"} onClick={() => setOpen((v) => !v)}>
            <ChevronDown className={cn("size-4 transition-transform duration-300", open && "rotate-180")} strokeWidth={1.5} />
          </CardButton>
        </span>
      </div>

      <div
        className={cn(
          "grid transition-all duration-500 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border/70 px-4 pt-4 pb-4">
            {artifact.kind === "series" && artifact.series && (
              chartStyle === "bar" ? (
                // Columns like the reels; long or many labels read better as horizontal bars.
                artifact.series.length > 16 || artifact.series.some((p) => p.label.length > 12)
                  ? <Bars data={artifact.series} unit={artifact.chart?.unit} highlight={artifact.chart?.highlight} />
                  : <Columns data={artifact.series} unit={artifact.chart?.unit} highlight={artifact.chart?.highlight} threshold={artifact.chart?.threshold} />
              )
              : chartStyle === "donut" ? <Donut data={artifact.series} unit={artifact.chart?.unit} />
              : <LineChart data={artifact.series} unit={artifact.chart?.unit} highlight={artifact.chart?.highlight} threshold={artifact.chart?.threshold} />
            )}
            {artifact.kind === "markdown" && artifact.markdown && <Markdown text={artifact.markdown} />}
            {artifact.kind === "timeline" && artifact.timeline && <Timeline data={artifact.timeline} />}
            {artifact.kind === "compare" && artifact.compare && <Compare data={artifact.compare} />}
            {artifact.kind === "flow" && artifact.flow && <Flow data={artifact.flow} />}
            {artifact.kind === "table" && artifact.table && <Compare data={artifact.table} highlight={artifact.table.highlight} />}
            {artifact.kind === "code" && artifact.code && <CodeBlock code={artifact.code} />}
            {artifact.kind === "file" && artifact.file && <p className="font-mono text-[12px] text-foreground">{artifact.file.label || artifact.file.path}</p>}
            {artifact.kind === "image" && artifact.image && <img src={artifact.image.dataUrl} alt={artifact.image.alt || artifact.title} className="max-h-[32rem] w-full rounded-xl object-contain" />}
            {artifact.kind === "document" && artifact.document && <p className="text-[13px] leading-relaxed text-muted-foreground">{artifact.document.summary || artifact.document.path || artifact.document.kind}</p>}
            {artifact.kind === "citation" && artifact.citation && <p className="text-[13px] text-foreground">{artifact.citation.label}<span className="ml-2 font-mono text-[10px] text-muted-foreground">{artifact.citation.source}</span></p>}
            {artifact.kind === "system_status" && artifact.system_status && <StatusTiles data={artifact.system_status.values} />}
            {artifact.kind === "progress" && artifact.progress && <ProgressBar data={artifact.progress} />}
            {artifact.kind === "rings" && artifact.rings && <Rings data={artifact.rings} />}
            {artifact.kind === "stats" && artifact.stats && <Stats data={artifact.stats} />}
            {artifact.kind === "checklist" && artifact.checklist && <Checklist data={artifact.checklist} onToggle={onCheck} />}
            {artifact.kind === "quiz" && artifact.quiz && <Quiz data={artifact.quiz} onAnswer={onAsk} />}
            {artifact.kind === "scorecard" && artifact.scorecard && <Scorecard data={artifact.scorecard} />}
            {artifact.kind === "flashcards" && artifact.flashcards && <Flashcards data={artifact.flashcards} onAsk={onAsk} />}
            {artifact.kind === "gauges" && artifact.gauges && <Gauges data={artifact.gauges} />}
            {artifact.kind === "folders" && artifact.folders && <Folders data={artifact.folders} />}
            {artifact.kind === "cards" && artifact.cards && <InfoCards data={artifact.cards} />}
            {artifact.kind === "weather" && artifact.weather && <Weather data={artifact.weather} />}
            {artifact.kind === "timer" && artifact.timer && <Timer data={artifact.timer} onUpdate={onUpdate} />}
            {artifact.kind === "board" && artifact.board && <Board data={artifact.board} onUpdate={onUpdate} />}
            {artifact.kind === "heatmap" && artifact.heatmap && <Heatmap data={artifact.heatmap} />}
            {artifact.kind === "log" && artifact.log && <LogView data={artifact.log} />}
            {artifact.kind === "app" && artifact.app && <AppFrame html={artifact.app.html} title={artifact.title} onSend={onAsk} />}
            {artifact.kind === "picker" && artifact.picker && <Picker data={artifact.picker} spinKey={`${artifact.id}:${artifact.at ?? 0}`} onAsk={onAsk} />}
            {artifact.kind === "mindmap" && artifact.mindmap && <MindMap data={artifact.mindmap} />}
            {artifact.kind === "form" && artifact.form && (
              <Form
                data={artifact.form}
                title={artifact.title}
                onSubmit={
                  onAsk
                    ? (values, message) => {
                        onUpdate?.({ op: "form_sent", args: { values } });
                        onAsk(message);
                      }
                    : undefined
                }
              />
            )}
            {artifact.actions && artifact.actions.length > 0 && (
              <div data-card-chrome className="mt-4 flex flex-wrap gap-1.5">
                {artifact.actions.map((b, i) => (
                  <button
                    key={b.label}
                    type="button"
                    disabled={!onAsk}
                    onClick={() => onAsk?.(b.prompt)}
                    className={cn(
                      "rounded-full px-3.5 py-1.5 text-[12.5px] transition-[background-color,opacity,transform] duration-200 enabled:active:scale-[0.97] disabled:opacity-45 focus-visible:outline-none",
                      i === 0
                        ? "bg-primary font-medium text-primary-foreground enabled:hover:bg-primary/90"
                        : "liquid-hover relative border border-border text-foreground/90 enabled:hover:text-foreground",
                    )}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )}
            {artifact.caption && <figcaption className="mt-4 font-mono text-[11px] text-muted-foreground">{artifact.caption}</figcaption>}
            {onAsk && followUps(artifact).length > 0 && (
              <div data-card-chrome className="mt-4 flex flex-wrap gap-1.5">
                {followUps(artifact).map((f) => (
                  <button
                    key={f.label}
                    type="button"
                    onClick={() => onAsk(f.prompt)}
                    className="liquid-hover relative rounded-full border border-border px-3 py-1 text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:outline-none"
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </figure>
  );
}

/** Next steps that fit the item, e.g. a quiz result offers flashcards for the weak spots. */
function followUps(a: Artifact): { label: string; prompt: string }[] {
  const weak = a.scorecard?.topics.filter((t) => t.weak).map((t) => t.label) ?? [];
  switch (a.kind) {
    case "scorecard":
      return weak.length
        ? [{ label: "Flashcards for my weak spots", prompt: `Make me flashcards for ${weak.join(", ")} and show them in the workspace.` },
           { label: "Quiz me again", prompt: `Quiz me again on ${weak.join(", ")}, one question at a time.` }]
        : [{ label: "Harder questions", prompt: `Quiz me again on ${a.scorecard?.subject ?? a.title} with harder questions.` }];
    case "quiz":
      return a.quiz?.questions.some((q) => q.correct === undefined) ? [] : [{ label: "Show my result", prompt: "Show my quiz result as a scorecard with my weak spots." }];
    case "flashcards":
      return [{ label: "Quiz me on these", prompt: `Quiz me out loud on the flashcards "${a.title}", one at a time.` }];
    case "table":
      return [{ label: "Chart this", prompt: `Chart the table "${a.title}" in the workspace.` }];
    case "log":
      return [{ label: "My month as a heatmap", prompt: `Show my ${a.log?.name ?? a.title} log for the last 30 days as a heatmap in the workspace.` }];
    case "gauges":
      return [{ label: "Watch it live", prompt: `Keep the "${a.title}" gauges updated live in the workspace for the next minute.` }];
    default:
      return [];
  }
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-foreground/90 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none">
      {children}
    </button>
  );
}

function CardButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="liquid-hover relative grid size-7 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function Timeline({ data }: { data: { at: string; label: string; detail?: string }[] }) {
  return (
    <ol className="relative space-y-4 pl-5">
      <span className="absolute top-1 bottom-1 left-[3px] w-px bg-border-strong" />
      {data.map((d, i) => (
        <li key={`${d.at}-${i}`} className="vyr-rise relative" style={stagger(i)}>
          <span className="absolute top-[6px] -left-5 size-[7px] rounded-full bg-primary" />
          <p className="eyebrow">{d.at}</p>
          <p className="mt-0.5 text-[14px] text-foreground">{d.label}</p>
          {d.detail && <p className="text-[13px] text-muted-foreground">{d.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

function Compare({ data, highlight }: { data: { columns: string[]; rows: (string | number)[][] }; highlight?: number | undefined }) {
  return (
    <div className="field-scroll-x -mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[380px] border-collapse text-left">
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c} className="eyebrow border-b border-border pb-2 font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} className={cn("vyr-rise", i === highlight && "bg-primary/10")} style={stagger(i)}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={cn(
                    "border-b border-border/60 py-2.5 text-[13.5px]",
                    j === 0 ? "text-muted-foreground" : "text-foreground/90",
                    i === highlight && "border-primary/30 text-foreground",
                    i === highlight && j === 0 && "relative pl-3 font-medium text-primary before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Flow({ data }: { data: { id: string; label: string; note?: string; done?: boolean }[] }) {
  // With done marks it's a chain of actions ticking off one after another (the reels' "I'm heading out").
  if (data.some((n) => n.done !== undefined)) {
    const current = data.findIndex((n) => !n.done);
    return (
      <ol className="space-y-1.5">
        {data.map((n, i) => (
          <li key={n.id} className="vyr-rise flex items-center gap-3 rounded-xl border border-border bg-secondary/15 px-3 py-2" style={stagger(i * 2)}>
            {n.done ? (
              <span className="vyr-pop grid size-6 shrink-0 place-items-center rounded-full bg-success text-background shadow-[0_0_14px_-2px] shadow-success/60" style={stagger(i * 3 + 2)}>
                <Check className="size-3.5" strokeWidth={3} />
              </span>
            ) : (
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border border-dashed font-mono text-[10px]",
                  i === current ? "animate-pulse border-primary text-primary" : "border-border-strong text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[13.5px]", n.done ? "text-foreground" : "text-foreground/80")}>{n.label}</span>
              {n.note && <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{n.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {data.map((n, i) => (
        <div key={n.id} className="vyr-rise flex min-w-0 flex-1 items-center gap-2" style={stagger(i)}>
          <div className="min-w-0 flex-1 rounded-xl border border-border bg-secondary/25 px-3 py-2.5">
            <p className="truncate font-display text-[13.5px] text-foreground">{n.label}</p>
            {n.note && (
              <p className="truncate font-mono text-[10.5px] text-muted-foreground">{n.note}</p>
            )}
          </div>
          {i < data.length - 1 && (
            <span className="hidden h-px w-4 shrink-0 bg-border-strong sm:block" />
          )}
        </div>
      ))}
    </div>
  );
}

/** Code; called-out lines (e.g. the bug) are numbered, flash once and stay marked. */
function CodeBlock({ code }: { code: { language?: string; code: string; highlight?: number[] } }) {
  const marked = new Set(code.highlight ?? []);
  return (
    <pre className="field-scroll-x overflow-x-auto rounded-xl border border-border bg-secondary/20 p-3.5">
      {code.language && <span className="eyebrow mb-2 block">{code.language}</span>}
      {marked.size ? (
        <code className="block font-mono text-[12px] leading-relaxed text-foreground/90">
          {code.code.split("\n").map((line, i) => (
            <span key={i} className={cn("-mx-3.5 flex px-3.5", marked.has(i + 1) && "vyr-line-flash shadow-[inset_3px_0_0] shadow-accent")}>
              <span className={cn("mr-4 w-6 shrink-0 text-right select-none", marked.has(i + 1) ? "text-accent" : "text-muted-foreground/60")}>{i + 1}</span>
              <span className="whitespace-pre">{line || " "}</span>
            </span>
          ))}
        </code>
      ) : (
        <code className="font-mono text-[12px] leading-relaxed text-foreground/90">{code.code}</code>
      )}
    </pre>
  );
}
