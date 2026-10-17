import type { Settings } from "./types";

/** How VYRSE talks. Applied by the vyrse plugin to every message, so a switch takes effect immediately. */
export const TALK_STYLES = [
  { id: "normal", label: "Normal", hint: "Clear, friendly assistant" },
  { id: "vibe", label: "Vibe", hint: "Matches your energy and slang" },
  { id: "fam", label: "Fam", hint: "Close-friend banter" },
  { id: "chill", label: "Chill", hint: "Calm and easygoing" },
  { id: "hype", label: "Hype", hint: "High energy, hype-man" },
  { id: "focus", label: "Focus", hint: "Short answers, no small talk" },
  { id: "pro", label: "Pro", hint: "Professional and precise" },
  { id: "savage", label: "Savage", hint: "Roasts you alive, still gets it done" },
] as const;

/** A built-in style, or one the user made with VYRSE (vyrse_style), "custom:<name>". */
export type TalkStyle = (typeof TALK_STYLES)[number]["id"] | `custom:${string}`;

const STYLE_WORDS: Record<string, TalkStyle> = {
  normal: "normal", default: "normal", regular: "normal", standard: "normal",
  vibe: "vibe", vibes: "vibe", vibing: "vibe",
  fam: "fam", bro: "fam", homie: "fam", friend: "fam", buddy: "fam",
  chill: "chill", calm: "chill", relaxed: "chill",
  hype: "hype", hyped: "hype", energy: "hype", energetic: "hype",
  focus: "focus", focused: "focus", brief: "focus", short: "focus", quiet: "focus",
  pro: "pro", professional: "pro", formal: "pro", work: "pro",
  savage: "savage", roast: "savage", roasting: "savage", brutal: "savage", ruthless: "savage", mean: "savage",
};
const MODE_WORDS: Record<string, Settings["mode"]> = {
  assistant: "assistant", private: "private", privacy: "private", offline: "private", gaming: "gaming", game: "gaming",
};

export type StyleCommand = { kind: "style"; style: TalkStyle } | { kind: "mode"; mode: Settings["mode"] };

/**
 * Recognise "switch to fam mode", "go into vibe mode", "fam mode on", "vibe mode off", "talk normally",
 * "back to normal" (typed or spoken) so they apply instantly instead of going to the model.
 * Only short, command-shaped messages match; anything longer is a normal request.
 */
export function parseStyleCommand(raw: string): StyleCommand | null {
  const t = raw.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(?:hey |yo |ok |okay |please |vyse |vyrse )+/, "").replace(/ (?:please|now|bro)$/, "");
  if (!t || t.split(" ").length > 7) return null;
  if (/^roast me(?: alive| mode)?$|^cook me$/.test(t)) return { kind: "style", style: "savage" };
  if (/^(?:talk|speak) (?:normally|normal)$|^(?:go )?back to normal(?: mode)?$|^(?:normal mode|default mode)(?: on)?$/.test(t))
    return { kind: "style", style: "normal" };
  const off = /^(?:turn |switch )?(?:off )?(\w+) (?:mode|style|vibe) off$|^(?:turn|switch) off (\w+) (?:mode|style)$|^(?:stop|no more) (\w+) (?:mode|style)$/.exec(t);
  if (off) {
    const word = off[1] ?? off[2] ?? off[3] ?? "";
    if (STYLE_WORDS[word]) return { kind: "style", style: "normal" };
    return null;
  }
  const on =
    /^(?:switch|change|go|get|put|turn|set)(?: (?:it|yourself|us))?(?: (?:to|into|in|on))? (?:the )?(\w+) (?:mode|style|vibe)(?: on)?$/.exec(t) ??
    /^(\w+) (?:mode|style) on$/.exec(t) ??
    /^(?:be|talk|speak) (?:in )?(\w+)(?: mode| style)?$/.exec(t) ??
    /^(\w+) mode$/.exec(t);
  if (!on) return null;
  const word = on[1] ?? "";
  if (STYLE_WORDS[word]) return { kind: "style", style: STYLE_WORDS[word] };
  if (MODE_WORDS[word]) return { kind: "mode", mode: MODE_WORDS[word] };
  return null;
}

export function styleLabel(style: TalkStyle): string {
  return TALK_STYLES.find((s) => s.id === style)?.label ?? "Normal";
}
