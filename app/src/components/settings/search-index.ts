import { IS_PHONE } from "@/services/phone";

export type SettingsPage = "assistant" | "voice" | "memory" | "reminders" | "alexa" | "phone" | "skills" | "appearance";

/** One searchable setting: `label` is the row's exact on-screen label (used to scroll to it). */
export interface SettingEntry {
  label: string;
  page: SettingsPage;
  keywords: string;
  pc?: boolean;
  phone?: boolean;
}

const ALL: SettingEntry[] = [
  { label: "Your name", page: "assistant", keywords: "name call me nickname" },
  { label: "Briefing games", page: "assistant", keywords: "games gaming news valorant minecraft" },
  { label: "Talk style", page: "assistant", keywords: "personality vibe fam slang tone chill hype focus pro normal" },
  { label: "Daily briefing", page: "assistant", keywords: "good morning news weather briefing schedule" },
  { label: "Mode", page: "assistant", keywords: "private gaming assistant offline gpu" },
  { label: "Model", page: "assistant", keywords: "llm qwen gemma ai brain local online" },
  { label: "Reasoning when typing", page: "assistant", keywords: "thinking effort slow careful" },
  { label: "Approvals", page: "assistant", keywords: "permission ask risky safety autonomy" },
  { label: "Wake word “VYRSE”", page: "voice", keywords: "hey wake listen always hotword" },
  { label: "Talk shortcut", page: "voice", keywords: "push to talk hotkey keyboard", pc: true },
  { label: "Quick ask", page: "voice", keywords: "alt space bar popup", pc: true },
  { label: "Dictate anywhere", page: "voice", keywords: "dictation type speech to text", pc: true },
  { label: "Voice output", page: "voice", keywords: "speaker headphones echo bluetooth sound device", pc: true },
  { label: "Microphone", page: "voice", keywords: "mic input headset", pc: true },
  { label: "Teach it your voice", page: "voice", keywords: "train wake word my voice record vyrse", pc: true },
  { label: "Automatic mic gain", page: "voice", keywords: "quiet microphone boost level" },
  { label: "Test microphone", page: "voice", keywords: "mic check wake test", pc: true },
  { label: "Speech sensitivity", page: "voice", keywords: "noise threshold hearing" },
  { label: "Recognition", page: "voice", keywords: "whisper speech to text accurate fast transcription" },
  { label: "Follow-up listening", page: "voice", keywords: "keep listening conversation" },
  { label: "Voice replies", page: "voice", keywords: "speak out loud tts talk back mute" },
  { label: "Speak typed replies too", page: "voice", keywords: "read aloud typed" },
  { label: "Reasoning when talking", page: "voice", keywords: "voice thinking speed" },
  { label: "Voice volume", page: "voice", keywords: "loudness sound level" },
  { label: "Long-term memory", page: "memory", keywords: "remember notes forget privacy" },
  { label: "Reminders & routines", page: "reminders", keywords: "alarm timer schedule cron routine" },
  { label: "Echo / Alexa", page: "alexa", keywords: "amazon echo dot alexa sign in voice monkey skill", pc: true },
  { label: "Phone access", page: "phone", keywords: "android mobile app pair", pc: true },
  { label: "Pair a phone", page: "phone", keywords: "android mobile code connect", pc: true },
  { label: "Let my PC reach this phone", page: "phone", keywords: "flashlight find ring battery control link background", phone: true },
  { label: "Notification access", page: "phone", keywords: "notifications messages read", phone: true },
  { label: "Full control", page: "phone", keywords: "control phone accessibility tap type screen remote", phone: true },
  { label: "Skills", page: "skills", keywords: "plugins add-ons hub install abilities" },
  { label: "Theme", page: "appearance", keywords: "dark mode light mode colors system" },
  { label: "Glass", page: "appearance", keywords: "liquid glass blur transparency subtle" },
  { label: "Interface density", page: "appearance", keywords: "compact spacing comfortable" },
  { label: "Animations", page: "appearance", keywords: "motion effects reduced off" },
  { label: "Presence intensity", page: "appearance", keywords: "orb brightness glow planet" },
  { label: "Reaction to voice", page: "appearance", keywords: "orb reactive audio" },
  { label: "Idle activity", page: "appearance", keywords: "orb movement calm lively" },
  { label: "Detail", page: "appearance", keywords: "orb quality rings performance" },
  { label: "Reduced motion", page: "appearance", keywords: "accessibility motion sickness" },
  { label: "High contrast", page: "appearance", keywords: "accessibility contrast readability" },
  { label: "Text size", page: "appearance", keywords: "font size bigger smaller zoom accessibility" },
];

export const SETTINGS_INDEX = ALL.filter((e) => (IS_PHONE ? !e.pc : !e.phone));

/** Best matches first: label starts with the query, then label contains it, then keywords do. */
export function searchSettings(query: string): SettingEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored: { e: SettingEntry; score: number }[] = [];
  for (const e of SETTINGS_INDEX) {
    const label = e.label.toLowerCase();
    const hay = `${label} ${e.keywords}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : label.split(/\s+/).some((w) => w.startsWith(words[0]!)) ? 2 : 3;
    scored.push({ e, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 8).map((x) => x.e);
}
