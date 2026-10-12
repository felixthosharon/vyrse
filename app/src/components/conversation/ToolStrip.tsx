import { useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { ToolActivity } from "@/lib/vyrse/types";
import { cn } from "@/lib/utils";

/** Friendly names for Hermes' tools; unknown tools fall back to a tidied id. */
const TOOL_NAMES: Record<string, string> = {
  terminal: "Terminal",
  process_manage: "Processes",
  read_file: "Read file",
  write_file: "Write file",
  patch: "Edit file",
  search_files: "Search files",
  computer_use: "Computer control",
  vision_analyze: "Look at image",
  browser_navigate: "Browser",
  browser_exec: "Browser",
  browser_cdp: "Browser",
  memory: "Memory",
  session_search: "Search history",
  skills_list: "Skills",
  skill_view: "Read skill",
  skill_manage: "Manage skills",
  tool_search: "Find tool",
  tool_describe: "Inspect tool",
  tool_call: "Use tool",
  delegate_task: "Delegate",
  execute_code: "Run code",
};

/** Hermes' tool-search plumbing: the real tool it dispatches gets its own chip. */
const META_TOOLS = new Set(["tool_search", "tool_describe", "tool_call"]);

export function toolDisplayName(name: string): string {
  if (TOOL_NAMES[name]) return TOOL_NAMES[name]!;
  if (name.startsWith("browser_")) return "Browser";
  if (name.startsWith("vyrse_ui")) return "Interface";
  return name.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Compact, readable trace of what Hermes did for a reply: one chip per tool call,
 * with the command/path it acted on. Details stay one click away, never dumped.
 */
export function ToolStrip({ tools, className }: { tools: ToolActivity[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const real = tools.filter((t) => !META_TOOLS.has(t.name));
  // While only plumbing has run, show it (the model is still finding the right tool).
  tools = real.length > 0 ? real : tools;
  if (tools.length === 0) return null;
  const running = tools.filter((t) => t.status !== "done").length;
  const visible = open ? tools : tools.slice(-3);

  return (
    <div className={cn("mb-3 space-y-1.5", className)}>
      {visible.map((tool) => (
        <div
          key={tool.id}
          className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/70 bg-surface/45 px-3 py-1.5 text-[11.5px]"
        >
          <span className="grid size-4 shrink-0 place-items-center">
            {tool.status === "done" ? (
              <Check className="size-3.5 text-primary" strokeWidth={2} />
            ) : (
              <Loader2 className="size-3.5 animate-spin text-primary/80" strokeWidth={2} />
            )}
          </span>
          <span className="shrink-0 text-foreground">{toolDisplayName(tool.name)}</span>
          {tool.label && <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">{tool.label}</span>}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {tool.status === "preparing"
              ? "preparing"
              : tool.status === "running"
                ? "running"
                : tool.durationS !== undefined
                  ? `${tool.durationS < 10 ? tool.durationS.toFixed(1) : Math.round(tool.durationS)}s`
                  : ""}
          </span>
        </div>
      ))}
      {tools.length > 3 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 px-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} strokeWidth={1.8} />
          {open ? "Show fewer" : `${tools.length - 3} earlier step${tools.length - 3 === 1 ? "" : "s"}`}
          {running > 0 && !open ? ` · ${running} running` : ""}
        </button>
      )}
    </div>
  );
}
