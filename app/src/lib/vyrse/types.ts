import type { TalkStyle } from "./talk-styles";
export type PresenceState =
  "idle" | "listening" | "thinking" | "speaking" | "working" | "success" | "error";

export type Role = "user" | "vyrse";

export type ArtifactKind = "series" | "timeline" | "compare" | "flow" | "table" | "code" | "file" | "image" | "document" | "citation" | "system_status" | "progress" | "markdown"
  | "rings" | "stats" | "checklist" | "quiz" | "scorecard" | "flashcards"
  | "gauges" | "cards" | "weather" | "timer" | "board" | "heatmap" | "log" | "app" | "picker" | "mindmap" | "folders" | "form";

/**
 * Semantic presentation contract.
 *
 * The backend may only *request* one of these modes. It can never send
 * dimensions, CSS, HTML or any style value — the frontend alone decides what
 * each mode means at the current viewport size.
 *
 *  compact — the presence dominates; only the compact response is visible
 *  split   — the presence stays large; the workspace grows beside it
 *  focus   — the workspace is primary; the presence shrinks but stays visible
 */
export type PresentationMode = "compact" | "split" | "focus";

/** Push-to-talk shortcut choices, with their Electron accelerators. */
export const TALK_SHORTCUTS = {
  "ctrl+shift+space": { label: "Ctrl + Shift + Space", accelerator: "Control+Shift+Space" },
  "ctrl+alt+v": { label: "Ctrl + Alt + V", accelerator: "Control+Alt+V" },
  "alt+backquote": { label: "Alt + `", accelerator: "Alt+`" },
  "f9": { label: "F9", accelerator: "F9" },
  off: { label: "Off", accelerator: null },
} as const;
export type TalkShortcut = keyof typeof TALK_SHORTCUTS;

/** Dictate anywhere: speak, and VYRSE types it into the focused app. */
export const DICTATE_SHORTCUTS = {
  "ctrl+alt+d": { label: "Ctrl + Alt + D", accelerator: "Control+Alt+D" },
  "ctrl+shift+period": { label: "Ctrl + Shift + .", accelerator: "Control+Shift+." },
  "f8": { label: "F8", accelerator: "F8" },
  off: { label: "Off", accelerator: null },
} as const;
export type DictateShortcut = keyof typeof DICTATE_SHORTCUTS;

/** Quick-ask bar: a Spotlight-style bar over any app. */
export const QUICK_SHORTCUTS = {
  "alt+space": { label: "Alt + Space", accelerator: "Alt+Space" },
  "ctrl+alt+space": { label: "Ctrl + Alt + Space", accelerator: "Control+Alt+Space" },
  "alt+q": { label: "Alt + Q", accelerator: "Alt+Q" },
  off: { label: "Off", accelerator: null },
} as const;
export type QuickShortcut = keyof typeof QUICK_SHORTCUTS;

/** Automatic daily briefing: off, the first time VYRSE starts each day, or at a time. */
export const BRIEFING_TIMES = {
  off: "Off",
  start: "When VYRSE starts",
  "07:00": "7:00 AM",
  "08:00": "8:00 AM",
  "09:00": "9:00 AM",
  "10:00": "10:00 AM",
} as const;
export type BriefingTime = keyof typeof BRIEFING_TIMES;

export const PRESENTATION_MODES: readonly PresentationMode[] = ["compact", "split", "focus"];

export function isPresentationMode(value: unknown): value is PresentationMode {
  return typeof value === "string" && (PRESENTATION_MODES as readonly string[]).includes(value);
}

export interface Artifact {
  /** stable id for workspace items (same id = update in place) */
  id?: string;
  kind: ArtifactKind;
  title: string;
  caption?: string | undefined;
  /** buttons under the item: tapping one sends `prompt` to VYRSE as the user's message */
  actions?: { label: string; prompt: string }[] | undefined;
  /** fields the user fills in on screen; `sent` = what they sent (the form then reads as sent) */
  form?: { fields: FormField[]; submit: string; sent?: Record<string, string> } | undefined;
  series?: undefined | { label: string; value: number }[];
  timeline?: undefined | { at: string; label: string; detail?: string }[];
  compare?: undefined | { columns: string[]; rows: (string | number)[][] };
  flow?: undefined | { id: string; label: string; note?: string; done?: boolean }[];
  /** `highlight`: index of the row to call out */
  table?: { columns: string[]; rows: (string | number)[][]; highlight?: number };
  /** `highlight`: 1-based line numbers to call out */
  code?: { language?: string; code: string; highlight?: number[] };
  file?: { path: string; label?: string; mime?: string };
  image?: { dataUrl: string; alt?: string };
  document?: { path?: string; kind?: string; summary?: string };
  citation?: { label: string; source: string };
  system_status?: { title: string; values: { label: string; value: string }[] };
  progress?: { label: string; value?: number; message?: string };
  markdown?: string;
  /** completion rings: value out of max */
  rings?: { label: string; value: number; max: number; unit?: string }[];
  /** big numbers, optionally with a change like "+12%" */
  stats?: { label: string; value: string; change?: string; note?: string; trend?: number[] }[];
  checklist?: { label: string; done: boolean }[];
  /** questions with the user's answers; `correct` is absent until answered */
  quiz?: { subject?: string; questions: QuizQuestion[] };
  scorecard?: {
    score: number;
    total: number;
    verdict?: string;
    subject?: string;
    review?: string;
    topics: { label: string; value: number; weak: boolean }[];
  };
  flashcards?: { front: string; back: string }[];
  /** a folder VYRSE sorted into subfolders */
  folders?: { items: { name: string; count: number }[]; total: number; sizeGb?: number; sorted: boolean };
  /** meters (temps, usage); past `warn` they turn hot */
  gauges?: { label: string; value: number; max: number; unit?: string; warn?: number }[];
  /** glass cards with an icon from a fixed set (see CARD_ICONS) */
  cards?: { label: string; detail: string; value?: string; icon?: string }[];
  weather?: {
    location: string;
    condition: string;
    temp: number;
    unit: string;
    high?: number;
    low?: number;
    forecast?: { at: string; label: string; value: number }[];
  };
  /** a countdown: `ends_at` is epoch ms */
  timer?: { label: string; ends_at: number; seconds: number; paused_left?: number; stopped?: boolean };
  board?: { name: string; cards: { label: string; note?: string }[] }[];
  heatmap?: { cells: { label: string; value: number }[]; unit?: string };
  /** a vyrse_log log: totals plus the latest entries (`fresh`: the first entry was just added) */
  log?: {
    name: string;
    unit: string;
    today: number;
    today_count: number;
    week: number;
    streak: number;
    count: number;
    days: { label: string; value: number }[];
    entries: { at: string; label: string; value?: number }[];
    fresh: boolean;
  };
  /** a wheel that spins and picks one option at random (the pick is made in VYRSE, not by the model) */
  picker?: { options: string[] };
  /** a topic (centre) with branches and their leaves */
  mindmap?: { center: string; branches: { label: string; leaves: { label: string; detail?: string }[] }[] };
  /** a small page Hermes wrote, run sandboxed (no network, no access to VYRSE) */
  app?: { html: string };
  /** kind=series: how to draw it; `highlight` = the point label to call out, `threshold` = a limit line */
  chart?: { style: "line" | "bar" | "donut"; unit?: string; highlight?: string; threshold?: number };
  /** when it arrived in this window (set by the app, not Hermes) */
  at?: number;
}

export interface FormField {
  label: string;
  type: "text" | "number" | "date" | "time" | "select";
  options?: string[];
  placeholder?: string;
}

export interface QuizQuestion {
  question: string;
  /** multiple choice: the user taps one (marked by the plugin, not the model) */
  choices?: string[];
  answer?: string;
  correct?: boolean;
  right_answer?: string;
  note?: string;
}

/** One Hermes tool call shown on the reply that made it. */
export interface ToolActivity {
  id: string;
  name: string;
  /** short human label: the command, path or query the tool acts on */
  label?: string;
  status: "preparing" | "running" | "done";
  startedAt: number;
  durationS?: number;
  summary?: string;
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
  streaming?: boolean | undefined;
  artifact?: Artifact | undefined;
  meta?: string | undefined;
  /** tool calls Hermes made while producing this reply */
  tools?: ToolActivity[] | undefined;
  /** characters of model reasoning streamed so far (content itself is not shown) */
  reasoningChars?: number | undefined;
  /** reply ended because the user stopped it */
  interrupted?: boolean | undefined;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  state?: "ok" | "error" | undefined;
  /** full transcript has been fetched from Hermes (list rows carry only summaries) */
  loaded?: boolean | undefined;
  preview?: string | undefined;
}

export type Density = "comfortable" | "compact";
export type Motion = "full" | "reduced" | "off";
export type Theme = "system" | "dark" | "light";

export interface Settings {
  theme: Theme;
  density: Density;
  animations: Motion;
  /** liquid-glass material on floating controls and panels */
  glass: "liquid" | "subtle" | "off";

  micDevice: string;
  /** where VYRSE's voice plays (e.g. an Echo paired over Bluetooth) */
  outputDevice: string;
  micSensitivity: number;
  voiceActivation: boolean;
  voiceResponses: boolean;
  /** keep listening ~6 s after VYRSE answers, without the wake word */
  autoListen: boolean;
  /** speech output volume 0..1 */
  volume: number;
  /** speak replies to typed messages too (not only spoken ones) */
  speakTyped: boolean;
  /** remember text the user copies (on this PC; never passwords, codes or keys) */
  clipboardMemory?: boolean;
  /** a glowing cursor shows where VYRSE is clicking/typing while it drives an app (Esc stops it) */
  ghostHands?: boolean;
  /** soft interface sounds (a card built, a step ticked, a timer done) */
  uiSounds: boolean;
  /** let the OS/browser boost quiet microphones */
  autoGain: boolean;
  /** Hermes reasoning level for spoken turns (typed turns use Hermes' own setting) */
  voiceReasoning: "none" | "low" | "medium" | "high";
  /** system-wide push-to-talk shortcut (desktop app) */
  talkShortcut: TalkShortcut;
  dictateShortcut: DictateShortcut;
  quickShortcut: QuickShortcut;
  /** automatic daily briefing (it's always available by saying "good morning") */
  briefing: BriefingTime;
  /** how VYRSE talks (see talk-styles.ts) */
  talkStyle: TalkStyle;
  /** the app's highlight colour and the orb's light */
  accent?: Accent;
  /** talk style -> Kokoro voice for that style ("" or missing = VYRSE's usual voice) */
  styleVoices?: Record<string, string>;
  /** talk styles the user made (read from the plugin; never saved back from here) */
  customStyles?: { id: `custom:${string}`; label: string; hint: string }[];
  /** what VYRSE calls the user (first-run screen / Settings) */
  userName?: string;
  /** games for the daily briefing, comma-separated */
  briefingGames?: string;
  voiceVisualization: "minimal" | "reactive" | "full";

  /** VYRSE mode (mapped onto real Hermes features in Phase 5); model/reasoning live in Hermes. */
  mode: "assistant" | "private" | "gaming" | "coding" | "research";

  presenceIntensity: "subtle" | "balanced" | "expressive";
  voiceReactivity: "low" | "medium" | "high";
  idleActivity: "minimal" | "normal" | "lively";

  reducedMotion: boolean;
  highContrast: boolean;
  textSize: number;
  keyboardNav: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  density: "comfortable",
  animations: "full",
  glass: "liquid",
  micDevice: "auto",
  outputDevice: "default",
  micSensitivity: 0.6,
  voiceActivation: true,
  voiceResponses: true,
  autoListen: true,
  volume: 0.9,
  voiceReasoning: "none",
  talkShortcut: "ctrl+shift+space",
  dictateShortcut: "ctrl+alt+d",
  quickShortcut: "alt+space",
  briefing: "off",
  talkStyle: "normal",
  accent: "cyan",
  speakTyped: true,
  uiSounds: true,
  autoGain: true,
  voiceVisualization: "reactive",
  mode: "assistant",
  presenceIntensity: "balanced",
  voiceReactivity: "medium",
  idleActivity: "normal",
  reducedMotion: false,
  highContrast: false,
  textSize: 1,
  keyboardNav: true,
};

export type Accent = "cyan" | "violet" | "ember" | "mint" | "rose";
