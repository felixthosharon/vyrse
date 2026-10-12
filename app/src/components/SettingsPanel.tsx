import { BRIEFING_TIMES, type BriefingTime } from "@/lib/vyrse/types";
import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  AudioLines,
  Bell,
  Brain,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Mic2,
  Palette,
  Puzzle,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  Speaker,
  X,
} from "lucide-react";
import { Dropdown, Row, Section, Segmented, Slider, SwitchRow, TextField } from "./settings/controls";
import { RemindersSection } from "./settings/RemindersSection";
import { AlexaSection } from "./settings/AlexaSection";
import { PhoneSection } from "./settings/PhoneSection";
import { SkillsSection } from "./settings/SkillsSection";
import { VoiceSection } from "./settings/VoiceSection";
import { searchSettings, type SettingEntry } from "./settings/search-index";
import { useVyrse } from "@/lib/vyrse/store";
import type { Settings } from "@/lib/vyrse/types";
import { TALK_STYLES } from "@/lib/vyrse/talk-styles";
import { cn } from "@/lib/utils";
import { IS_PHONE } from "@/services/phone";

type PageId = "assistant" | "voice" | "memory" | "reminders" | "alexa" | "phone" | "skills" | "appearance";

interface PageDef {
  id: PageId;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}

/** Settings home: a few short groups of pages instead of one long scroll. */
const GROUPS: { title: string; pages: PageDef[] }[] = [
  {
    title: "VYRSE",
    pages: [
      { id: "assistant", label: "Assistant", icon: Sparkles },
      { id: "voice", label: "Voice", icon: AudioLines },
      { id: "memory", label: "Memory & privacy", icon: Brain },
    ],
  },
  {
    title: "Connections",
    pages: [
      { id: "reminders", label: "Reminders", icon: Bell },
      // Echo setup signs in to Amazon from the PC app, so the phone doesn't show it.
      ...(IS_PHONE ? [] : [{ id: "alexa" as const, label: "Echo / Alexa", icon: Speaker }]),
      { id: "phone", label: "Phone", icon: Smartphone },
    ],
  },
  {
    title: "More",
    pages: [
      { id: "skills", label: "Skills", icon: Puzzle },
      { id: "appearance", label: "Appearance", icon: Palette },
    ],
  },
];
const PAGES = GROUPS.flatMap((g) => g.pages);
const SLIDE_MS = 380;

/** Android back: closes an open settings page first (returns true when it did). */
export const settingsBack: { current: (() => boolean) | null } = { current: null };

/** Settings, grouped by what they affect. Hermes-owned values are read/written through Hermes. */
export function SettingsPanel() {
  const {
    settingsOpen, setSettingsOpen, settings: s, setSettings, micLive, link, restartBackend,
    agent, setModel, setReasoning, setApprovalMode, setMemoryEnabled, setMode, setTalkStyle, phoneWake,
  } = useVyrse();
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ [k]: v } as Partial<Settings>);
  const [page, setPage] = useState<PageId | null>(null);
  // The page being shown stays mounted while it slides back out.
  const [shown, setShown] = useState<PageId | null>(null);
  const scrollers = useRef(new Map<PageId, HTMLDivElement>());
  /*
   * Pages are built ahead of time, quietly, once Settings has slid open and is idle: tapping a page then
   * only slides an already-built page in (building it on tap cost ~100 ms on a phone before it could move).
   * They're dropped again when Settings closes, so they don't re-render while you chat.
   */
  const [built, setBuilt] = useState<PageId[]>([]);
  useEffect(() => {
    if (!settingsOpen) {
      const t = window.setTimeout(() => setBuilt([]), 600);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    let timer = 0;
    const next = (i: number) => {
      if (cancelled || i >= PAGES.length) return;
      setBuilt((b) => (b.includes(PAGES[i]!.id) ? b : [...b, PAGES[i]!.id]));
      timer = window.setTimeout(() => next(i + 1), 90);
    };
    timer = window.setTimeout(() => next(0), 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settingsOpen]);

  // Search: matching settings by name or everyday words; picking one opens its page and points at it.
  const [query, setQuery] = useState("");
  const results = searchSettings(query);
  const pointAt = useRef<string | null>(null);
  const openResult = (e: SettingEntry) => {
    pointAt.current = e.label;
    setQuery("");
    setPage(e.page);
  };

  // The page is built first and slides in on the next frames, so the slide never waits on the build.
  const [slid, setSlid] = useState<PageId | null>(null);
  useEffect(() => {
    if (page) {
      setShown(page);
      setBuilt((b) => (b.includes(page) ? b : [...b, page]));
      let b = 0;
      const a = requestAnimationFrame(() => (b = requestAnimationFrame(() => setSlid(page))));
      return () => {
        cancelAnimationFrame(a);
        cancelAnimationFrame(b);
      };
    }
    setSlid(null);
    const t = window.setTimeout(() => {
      // back at the top for next time (the page is hidden by now, so this costs nothing visible)
      if (shownRef.current) scrollers.current.get(shownRef.current)?.scrollTo({ top: 0 });
      setShown(null);
    }, SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [page]);
  const shownRef = useRef<PageId | null>(null);
  shownRef.current = shown;

  // After a search jump: scroll the setting into view and light it up briefly.
  useEffect(() => {
    const label = pointAt.current;
    const scroller = slid ? scrollers.current.get(slid) : undefined;
    if (!slid || !label || !scroller) return;
    pointAt.current = null;
    const t = window.setTimeout(() => {
      const target = [...scroller.querySelectorAll<HTMLElement>("span, p")].find(
        (el) => el.childElementCount === 0 && el.textContent?.trim() === label,
      );
      const row = target?.closest<HTMLElement>(".grid, .flex.items-center, .rounded-2xl") ?? target;
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.remove("vyr-flash");
      void row.offsetWidth;
      row.classList.add("vyr-flash");
    }, SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [slid]);

  // Closing Settings returns to the home list next time.
  useEffect(() => {
    if (settingsOpen) return;
    const t = window.setTimeout(() => setPage(null), 500);
    return () => window.clearTimeout(t);
  }, [settingsOpen]);

  useEffect(() => {
    settingsBack.current = () => {
      if (!page) return false;
      setPage(null);
      return true;
    };
    return () => {
      settingsBack.current = null;
    };
  }, [page]);

  // Other parts of the app can open a page directly (first-run "Teach it my voice").
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail as PageId;
      if (PAGES.some((p) => p.id === id)) setPage(id);
    };
    window.addEventListener("vyrse:open-settings-page", open);
    return () => window.removeEventListener("vyrse:open-settings-page", open);
  }, []);

  // Esc steps back out of a page before it closes Settings.
  useEffect(() => {
    if (!settingsOpen || !page) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setPage(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [settingsOpen, page]);

  const localModels = agent?.models.filter((m) => m.local) ?? [];
  const onlineModels = s.mode === "private" ? [] : (agent?.models.filter((m) => !m.local) ?? []);
  const current = agent ? `${agent.provider}::${agent.model}` : "";
  const known = agent?.models.some((m) => `${m.provider}::${m.model}` === current);
  const styleLabel = TALK_STYLES.find((t) => t.id === s.talkStyle)?.label ?? "Normal";

  const summary: Record<PageId, string> = {
    assistant: [styleLabel, agent?.model, s.mode !== "assistant" ? s.mode : null].filter(Boolean).join(" · "),
    voice: IS_PHONE
      ? `${phoneWake ? "Wake word on" : "Tap to talk"} · voice replies ${s.voiceResponses ? "on" : "off"}`
      : [s.voiceActivation ? "Wake word on" : "Wake word off", s.voiceResponses ? "voice replies on" : "voice replies off"].join(" · "),
    memory: agent ? (agent.memoryEnabled ? "Long-term memory on" : "Long-term memory off") : "Memory and microphone",
    reminders: "Reminders and routines",
    alexa: "Your Echo speaks and answers for VYRSE",
    phone: IS_PHONE ? "Connected to your PC" : "Use VYRSE on your Android phone",
    skills: "Add-on know-how Hermes can use",
    appearance: `${s.theme === "system" ? "System" : s.theme === "dark" ? "Dark" : "Light"} theme · ${s.glass === "off" ? "no glass" : `${s.glass ?? "liquid"} glass`}`,
  };

  const content = (id: PageId) => {
    switch (id) {
      case "assistant":
        return (
          <Section title="Assistant">
            {!agent ? (
              <p className="text-[11px] text-muted-foreground">Waiting for Hermes…</p>
            ) : (
              <>
                <Row label="Talk style" hint={TALK_STYLES.find((t) => t.id === s.talkStyle)?.hint}>
                  <Dropdown
                    value={s.talkStyle ?? "normal"}
                    onChange={setTalkStyle}
                    label="Talk style"
                    options={TALK_STYLES.map((t) => ({ value: t.id, label: t.label, hint: t.hint }))}
                  />
                </Row>
                <Row label="Your name" hint="what VYRSE calls you">
                  <TextField value={s.userName ?? ""} onCommit={(v) => v && setSettings({ userName: v })} label="Your name" placeholder="Your name" />
                </Row>
                <Row label="Daily briefing" hint="or just say “good morning”">
                  <Dropdown
                    value={s.briefing ?? "off"}
                    onChange={(v) => setSettings({ briefing: v })}
                    label="Daily briefing"
                    options={(Object.keys(BRIEFING_TIMES) as BriefingTime[]).map((k) => ({ value: k, label: BRIEFING_TIMES[k] }))}
                  />
                </Row>
                <Row label="Briefing games" hint="one gaming story a day about these">
                  <TextField value={s.briefingGames ?? ""} onCommit={(v) => setSettings({ briefingGames: v })} label="Briefing games" placeholder="e.g. Valorant, Minecraft" maxLength={120} />
                </Row>
                <Row label="Mode" hint={s.mode === "gaming" ? "GPU freed" : s.mode === "private" ? "local only" : undefined}>
                  <Segmented value={s.mode} onChange={setMode} options={[{ value: "assistant", label: "Assistant" }, { value: "private", label: "Private" }, { value: "gaming", label: "Gaming" }]} />
                </Row>
                <Row label="Model" hint={onlineModels.some((m) => `${m.provider}::${m.model}` === current) ? "online" : "on your PC"}>
                  <Dropdown
                    value={current}
                    onChange={(v) => {
                      const m = agent.models.find((x) => `${x.provider}::${x.model}` === v);
                      if (m) setModel(m);
                    }}
                    label="Model"
                    options={[
                      ...(known ? [] : [{ value: current, label: agent.model, hint: agent.provider }]),
                      ...localModels.map((m) => ({ value: `${m.provider}::${m.model}`, label: m.model, hint: "runs on your PC" })),
                      ...onlineModels.map((m) => ({ value: `${m.provider}::${m.model}`, label: m.model, hint: `${m.providerLabel} · online` })),
                    ]}
                  />
                </Row>
                {onlineModels.length === 0 && !IS_PHONE && (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-dashed border-border/80 px-3 py-2.5">
                    <Cloud className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.6} />
                    <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                      <span className="text-foreground">Online models — not connected.</span> VYRSE runs fully on this PC. To add an
                      online provider later, run <span className="font-mono">hermes model</span> in a terminal; it will appear here.
                      New local models: drop a <span className="font-mono">.gguf</span> into <span className="font-mono">C:\dev\VYRSE\models</span>.
                    </p>
                  </div>
                )}
                <Row label="Reasoning when typing" hint="more = slower, more careful">
                  <Segmented value={agent.reasoning} onChange={setReasoning} options={[{ value: "none", label: "Off" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} />
                </Row>
                <Row label="Approvals">
                  <Dropdown value={agent.approvalMode} onChange={setApprovalMode} label="Approval mode" options={[{ value: "manual", label: "Ask before risky actions", hint: "Hermes flags dangerous commands; you decide" }, { value: "smart", label: "Smart screening", hint: "a model reviews flagged actions first; fewer prompts, slower" }, { value: "off", label: "Never ask", hint: "full autonomy; only hard-blocked commands are stopped" }]} />
                </Row>
              </>
            )}
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-surface/40 px-3 py-2.5">
              <span className="min-w-0 text-[11.5px] text-foreground">{link.message}</span>
              <button type="button" onClick={restartBackend} className="liquid-hover relative shrink-0 rounded-full border border-border-strong px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                {IS_PHONE ? "Reconnect" : "Restart Hermes"}
              </button>
            </div>
          </Section>
        );
      case "voice":
        return <VoiceSection />;
      case "memory":
        return (
          <Section title="Memory & privacy">
            {agent && (
              <SwitchRow label="Long-term memory" hint={agent.memoryEnabled ? `${Math.max(0, Math.round(agent.memoryBytes / 102.4) / 10)} KB of notes kept by Hermes` : "Hermes keeps no notes between conversations"} checked={agent.memoryEnabled} onChange={setMemoryEnabled} />
            )}
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-surface/40 px-3 py-2.5">
              <div className="flex items-center gap-2"><Mic2 className="size-3.5 text-muted-foreground" /><span className="text-[11.5px] text-foreground">Microphone</span></div>
              <span className={cn("rounded-full border px-2.5 py-1 font-mono text-[9px]", micLive ? "border-primary/35 text-primary" : "border-border text-muted-foreground")}>{micLive ? "live" : "off"}</span>
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {IS_PHONE
                ? "Your phone only records while you talk; conversations, memory and voice processing stay on your PC."
                : "Conversations, memory and voice processing stay on this PC."}
            </p>
          </Section>
        );
      case "reminders":
        return <RemindersSection open={settingsOpen} />;
      case "alexa":
        return <AlexaSection open={settingsOpen} />;
      case "phone":
        return <PhoneSection />;
      case "skills":
        return <SkillsSection open={settingsOpen} />;
      case "appearance":
        return (
          <>
            <Section title="Appearance">
              <Row label="Theme"><Segmented value={s.theme} onChange={(v) => set("theme", v)} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></Row>
              <Row label="Glass" hint="liquid glass on floating controls and panels"><Segmented value={s.glass ?? "liquid"} onChange={(v) => set("glass", v)} options={[{ value: "liquid", label: "Liquid" }, { value: "subtle", label: "Subtle" }, { value: "off", label: "Off" }]} /></Row>
              <Row label="Interface density"><Segmented value={s.density} onChange={(v) => set("density", v)} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} /></Row>
              <Row label="Animations"><Segmented value={s.animations} onChange={(v) => set("animations", v)} options={[{ value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }, { value: "off", label: "Off" }]} /></Row>
            </Section>
            <Section title="Orb">
              <Row label="Presence intensity"><Segmented value={s.presenceIntensity} onChange={(v) => set("presenceIntensity", v)} options={[{ value: "subtle", label: "Subtle" }, { value: "balanced", label: "Balanced" }, { value: "expressive", label: "Expressive" }]} /></Row>
              <Row label="Reaction to voice"><Segmented value={s.voiceReactivity} onChange={(v) => set("voiceReactivity", v)} options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} /></Row>
              <Row label="Idle activity"><Segmented value={s.idleActivity} onChange={(v) => set("idleActivity", v)} options={[{ value: "minimal", label: "Minimal" }, { value: "normal", label: "Normal" }, { value: "lively", label: "Lively" }]} /></Row>
              <Row label="Detail"><Segmented value={s.voiceVisualization} onChange={(v) => set("voiceVisualization", v)} options={[{ value: "minimal", label: "Minimal" }, { value: "reactive", label: "Reactive" }, { value: "full", label: "Full" }]} /></Row>
            </Section>
            <Section title="Accessibility">
              <SwitchRow label="Reduced motion" checked={s.reducedMotion} onChange={(v) => set("reducedMotion", v)} />
              <SwitchRow label="High contrast" checked={s.highContrast} onChange={(v) => set("highContrast", v)} />
              <Row label="Text size" hint={`${Math.round(s.textSize * 100)}%`}><Slider value={s.textSize} onChange={(v) => set("textSize", v)} min={0.9} max={1.25} step={0.05} /></Row>
              {!IS_PHONE && <SwitchRow label="Keyboard navigation hints" checked={s.keyboardNav} onChange={(v) => set("keyboardNav", v)} />}
            </Section>
          </>
        );
    }
  };

  const shownDef = PAGES.find((p) => p.id === shown);
  const slide = `transform ${SLIDE_MS}ms cubic-bezier(0.16,0.84,0.24,1), opacity ${SLIDE_MS}ms cubic-bezier(0.16,0.84,0.24,1)`;

  return (
    <>
      <div onClick={() => setSettingsOpen(false)} className={cn("fixed inset-0 z-40 bg-background/55 backdrop-blur-[3px] transition-opacity", settingsOpen ? "opacity-100" : "pointer-events-none opacity-0")} aria-hidden="true" />
      <aside aria-label="Settings" aria-hidden={!settingsOpen} className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden liquid-strong transition-transform duration-500 sm:max-w-[30rem] sm:rounded-l-[1.75rem]", settingsOpen ? "translate-x-0" : "translate-x-full")}>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Home: the list of pages */}
          <div
            aria-hidden={page !== null}
            className={cn("field-scroll absolute inset-0 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))] [contain:strict]", page && "pointer-events-none")}
            style={{ transition: slide, transform: slid ? "translateX(-28%)" : "none", opacity: slid ? 0 : 1 }}
          >
            <div className="flex items-center justify-between gap-4 px-[clamp(1rem,2vw,1.35rem)] pt-4 pb-1">
              <div className="flex min-w-0 items-center gap-3">
                <span className="liquid relative grid size-9 place-items-center rounded-xl text-primary"><Settings2 className="size-4" strokeWidth={1.5} /></span>
                <div className="min-w-0">
                  <p className="font-display text-[15px] text-foreground">Settings</p>
                  <p className="truncate text-[10.5px] text-muted-foreground">
                    {link.hermesVersion ? `Hermes Agent ${link.hermesVersion} · ${link.phase === "online" ? "connected" : link.phase}` : link.message}
                  </p>
                </div>
              </div>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings" className="liquid-hover relative grid size-9 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none">
                <X className="size-4" strokeWidth={1.5} />
              </button>
            </div>
            <div className="px-[clamp(0.75rem,1.6vw,1.1rem)] pt-4">
              <label className="liquid relative flex items-center gap-2.5 rounded-full px-4 py-2.5 transition-shadow focus-within:shadow-[var(--glow-core)]">
                <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.6} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && results[0]) openResult(results[0]);
                    if (e.key === "Escape" && query) {
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                  placeholder="Search settings"
                  aria-label="Search settings"
                  className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="grid size-5 place-items-center rounded-full text-muted-foreground hover:text-foreground">
                    <X className="size-3.5" strokeWidth={1.6} />
                  </button>
                )}
              </label>
            </div>
            {query.trim() && (
              <section className="px-[clamp(0.75rem,1.6vw,1.1rem)] pt-4">
                {results.length === 0 ? (
                  <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">Nothing matches “{query.trim()}”.</p>
                ) : (
                  <div className="liquid relative overflow-hidden rounded-[1.35rem] p-1">
                    {results.map((r, i) => {
                      const def = PAGES.find((p) => p.id === r.page);
                      return (
                        <button
                          key={`${r.page}-${r.label}`}
                          type="button"
                          onClick={() => openResult(r)}
                          className={cn(
                            "liquid-hover relative flex w-full items-center gap-3 rounded-[1.05rem] px-3 py-2.5 text-left focus-visible:outline-none",
                            i > 0 && "before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-border/50",
                          )}
                        >
                          {def && (
                            <span className="grid size-7 shrink-0 place-items-center rounded-[0.6rem] border border-primary/20 bg-primary/10 text-primary">
                              <def.icon className="size-3.5" strokeWidth={1.6} />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-foreground">{r.label}</span>
                            <span className="block truncate text-[10.5px] text-muted-foreground">{def?.label}</span>
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.6} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
            {!query.trim() && GROUPS.map((g) => (
              <section key={g.title} className="px-[clamp(0.75rem,1.6vw,1.1rem)] pt-5">
                <p className="eyebrow px-2 pb-2">{g.title}</p>
                <div className="liquid relative overflow-hidden rounded-[1.35rem] p-1">
                  {g.pages.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      data-page={p.id}
                      onClick={() => setPage(p.id)}
                      className={cn(
                        "liquid-hover relative flex w-full items-center gap-3 rounded-[1.05rem] px-3 py-3 text-left focus-visible:outline-none",
                        i > 0 && "before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-border/50",
                      )}
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-[0.7rem] border border-primary/20 bg-primary/10 text-primary">
                        <p.icon className="size-4" strokeWidth={1.6} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] text-foreground">{p.label}</span>
                        <span className="block truncate pt-0.5 text-[11px] text-muted-foreground">{summary[p.id]}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.6} />
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/* One page at a time, sliding in from the side */}
          <div
            aria-hidden={page === null}
            className={cn("absolute inset-0 flex flex-col [contain:strict]", !page && "pointer-events-none")}
            style={{ transition: slide, transform: slid ? "none" : "translateX(100%)", opacity: slid ? 1 : 0, willChange: shown ? "transform" : undefined }}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-[clamp(0.6rem,1.4vw,1rem)] py-3">
              <button type="button" onClick={() => setPage(null)} aria-label="Back to settings" className="liquid-hover relative grid size-9 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none">
                <ChevronLeft className="size-5" strokeWidth={1.6} />
              </button>
              {shownDef && (
                <span className="flex min-w-0 items-center gap-2">
                  <shownDef.icon className="size-4 shrink-0 text-primary" strokeWidth={1.6} />
                  <span className="truncate font-display text-[15px] text-foreground">{shownDef.label}</span>
                </span>
              )}
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings" className="liquid-hover relative ml-auto grid size-9 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none">
                <X className="size-4" strokeWidth={1.5} />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              {built.map((id) => (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) scrollers.current.set(id, el);
                    else scrollers.current.delete(id);
                  }}
                  aria-hidden={id !== shown}
                  className="field-scroll absolute inset-0 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))] [contain:strict] [&>section:first-child>p.eyebrow]:hidden"
                  // Hidden pages are already laid out, just not painted: showing one only paints it.
                  style={id === shown ? undefined : { visibility: "hidden", pointerEvents: "none" }}
                >
                  {content(id)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
