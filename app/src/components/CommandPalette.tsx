import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Captions, History, Mic, Moon, PanelRight, Plus, Settings2, Sparkles, Sun, Trash2, UserRound, Wand2 } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { IS_PHONE } from "@/services/phone";
import { TALK_STYLES } from "@/lib/vyrse/talk-styles";
import { cn } from "@/lib/utils";
import { SETTINGS_INDEX } from "./settings/search-index";
import { openSettingsPage, startPersonalSetup } from "./Onboarding";

type Command = { id: string; label: string; hint?: string; icon: typeof Plus; keywords?: string; run: () => void };

/**
 * Ctrl+K: everything VYRSE's interface can do, one search away: start a chat, switch talk style or mode, open a
 * settings row, drive the workspace, start the personal setup. Whatever you type that isn't a command, Enter asks
 * VYRSE it.
 */
export function CommandPalette() {
  const v = useVyrse();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const light = v.resolvedTheme === "light";
    const list: Command[] = [
      { id: "new", label: "New conversation", icon: Plus, keywords: "chat start fresh", run: v.startNew },
      { id: "history", label: "Conversation history", icon: History, keywords: "past chats", run: () => v.setHistoryOpen(true) },
      { id: "settings", label: "Settings", icon: Settings2, keywords: "preferences options", run: () => v.setSettingsOpen(true) },
      { id: "theme", label: light ? "Dark theme" : "Light theme", icon: light ? Moon : Sun, keywords: "appearance mode colour", run: () => v.setSettings({ theme: light ? "dark" : "light" }) },
      { id: "setup", label: "Get to know you (personal setup)", icon: UserRound, keywords: "profile personalise onboarding redo", run: () => startPersonalSetup(v) },
      v.recording
        ? { id: "rec-stop", label: "Stop recording", icon: Mic, keywords: "lecture meeting", run: v.stopRecording }
        : { id: "rec", label: "Record a lecture or meeting", icon: Mic, keywords: "notes flashcards class record audio", run: () => v.startRecording("Lecture") },
      ...(IS_PHONE
        ? []
        : [
            v.captionsOn
              ? { id: "cc-stop", label: "Stop live captions", icon: Captions, keywords: "subtitles translate", run: v.stopCaptions }
              : { id: "cc", label: "Live captions for what's playing", icon: Captions, keywords: "subtitles translate video call", run: () => v.startCaptions("en") },
          ]),
      { id: "ws-open", label: "Show the workspace", icon: PanelRight, keywords: "board panel", run: () => v.setPresentation("split") },
      { id: "ws-focus", label: "Workspace full view", icon: PanelRight, keywords: "focus board big", run: () => v.setPresentation("focus") },
      { id: "ws-clear", label: "Clear the workspace", icon: Trash2, keywords: "remove cards", run: v.clearWorkspace },
      ...TALK_STYLES.map((t) => ({ id: `style-${t.id}`, label: `Talk style: ${t.label}`, hint: t.hint, icon: Wand2, keywords: "personality tone", run: () => v.setTalkStyle(t.id) })),
      ...(v.settings.customStyles ?? []).map((t) => ({ id: `style-${t.id}`, label: `Talk style: ${t.label}`, hint: t.hint || "your style", icon: Wand2, keywords: "personality tone custom", run: () => v.setTalkStyle(t.id) })),
      { id: "style-new", label: "Make my own talk style", icon: Wand2, keywords: "custom personality create", run: () => v.send("I want to make my own talk style. Ask me how it should talk, then create it.") },
      ...(["assistant", "private", "gaming"] as const).map((m) => ({ id: `mode-${m}`, label: `Mode: ${m[0]!.toUpperCase()}${m.slice(1)}`, icon: Sparkles, keywords: "offline gpu", run: () => v.setMode(m) })),
      ...SETTINGS_INDEX.map((s) => ({
        id: `set-${s.label}`,
        label: s.label,
        hint: "Settings",
        icon: Settings2,
        keywords: s.keywords,
        run: () => {
          v.setSettingsOpen(true);
          window.setTimeout(() => openSettingsPage(s.page), 50);
        },
      })),
    ];
    return list;
  }, [v]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? commands
        .map((c) => {
          const hay = `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase();
          const words = q.split(/\s+/);
          const score = words.every((w) => hay.includes(w)) ? (c.label.toLowerCase().startsWith(q) ? 2 : 1) : 0;
          return { c, score };
        })
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((m) => m.c)
    : commands.slice(0, 8);
  const ask: Command | null = q ? { id: "ask", label: `Ask VYRSE: “${query.trim()}”`, icon: ArrowRight, run: () => v.send(query.trim()) } : null;
  const rows = ask ? [...matches, ask] : matches;
  const pick = (c: Command) => {
    setOpen(false);
    c.run();
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex justify-center bg-background/40 px-4 pt-[14vh] backdrop-blur-[2px]" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div role="dialog" aria-label="Command palette" className="vyr-emerge liquid-strong h-fit w-full max-w-lg overflow-hidden rounded-[1.4rem]">
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && rows[index]) {
              e.preventDefault();
              pick(rows[index]!);
            }
          }}
          placeholder="Type a command, a setting, or ask VYRSE…"
          aria-label="Command"
          className="w-full bg-transparent px-5 py-4 text-[14.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <ul className="max-h-[50vh] overflow-y-auto border-t border-border/70 p-1.5">
          {rows.map((c, i) => {
            const Icon = c.icon;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pick(c)}
                  className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] focus-visible:outline-none", i === index ? "bg-foreground/[0.07] text-foreground" : "text-foreground/85")}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.6} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">{c.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-border/70 px-5 py-2 font-mono text-[10.5px] text-muted-foreground">↑↓ to move · Enter to run · Esc to close · Ctrl+K any time</p>
      </div>
    </div>
  );
}
