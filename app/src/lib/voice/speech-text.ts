/**
 * What VYRSE says out loud: the conversational part of a reply, never code, tables, URLs or
 * markdown syntax. Applied incrementally to streamed text (pure; unit-tested).
 */
export class SpeechFilter {
  private inCode = false;
  private carry = "";

  /** Feed a streamed text delta; returns speakable text (may be empty). */
  push(delta: string): string {
    this.carry += delta;
    // Only process complete lines so fences and table rows are judged whole; keep the tail.
    const lastNewline = this.carry.lastIndexOf("\n");
    if (lastNewline < 0) {
      // No newline yet: speak inline text as it comes, unless it may be a fence or table.
      if (/^\s*(`|~|\|)/.test(this.carry) || this.inCode) return "";
      const out = this.carry;
      this.carry = "";
      return cleanInline(out);
    }
    const complete = this.carry.slice(0, lastNewline + 1);
    this.carry = this.carry.slice(lastNewline + 1);
    return this.processLines(complete);
  }

  /** Flush whatever is left at the end of the reply. */
  flush(): string {
    const rest = this.carry;
    this.carry = "";
    return this.inCode ? "" : this.processLines(rest);
  }

  private processLines(text: string): string {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) {
        this.inCode = !this.inCode;
        continue;
      }
      if (this.inCode) continue;
      if (/^\s*\|/.test(line)) continue; // table rows
      if (/^\s*([-*_]\s*){3,}$/.test(line)) continue; // horizontal rules
      const cleaned = cleanInline(
        line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>+\s?/, "").replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, ""),
      );
      if (cleaned.trim()) out.push(cleaned.trim().replace(/([^.!?:;])$/, "$1."));
    }
    return out.length ? `${out.join(" ")} ` : "";
  }
}

function cleanInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    // Emoji and pictographs are read aloud by name ("star", "smiling face…"): drop them.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    // A lone asterisk is maths ("2 * 3") or leftover markup: never "star".
    .replace(/(\d)\s*[*×]\s*(\d)/g, "$1 times $2")
    .replace(/[*#|]/g, "")
    .replace(/\s{2,}/g, " ");
}

/**
 * Keeps spoken replies short: passes complete sentences through until roughly `maxSentences` /
 * `maxChars`, then stops and, at the end, says the rest is on screen. Long answers are asked (in the
 * Hermes prompt) to open with a one- or two-sentence summary, so what is spoken is that brief.
 */
export class SpokenBrief {
  private pending = "";
  private sentences = 0;
  private chars = 0;
  private truncated = false;

  /**
   * `chatty` (the Vibe and Fam talk styles): the whole reply is spoken, and the screen only gets a
   * mention when there's something that can't be said, like a table or code.
   */
  constructor(
    private readonly maxSentences = 3,
    private readonly maxChars = 380,
    private readonly chatty = false,
  ) {}

  /** Feed speakable text; returns what should be spoken now. */
  push(text: string): string {
    if (this.truncated || !text) return "";
    this.pending += text;
    let out = "";
    // Sentence ends: punctuation followed by whitespace. Each sentence is everything since the last end,
    // so a "." inside a number ("1.59 GB") never cuts the text before it.
    const re = /[.!?]+["')\]]*\s+/g;
    let consumed = 0;
    while (re.exec(this.pending)) {
      const sentence = this.pending.slice(consumed, re.lastIndex);
      if (this.sentences >= this.maxSentences || this.chars + sentence.length > this.maxChars) {
        this.truncated = true;
        this.pending = "";
        return out;
      }
      out += sentence;
      this.sentences += 1;
      this.chars += sentence.length;
      consumed = re.lastIndex;
    }
    this.pending = this.pending.slice(consumed);
    // Start talking sooner: before anything has been said, release the opening clause at its first
    // comma/colon. The blank line makes Hermes' speech stream cut there instead of waiting for "."
    if (!out && this.chars === 0) {
      const clause = /^([^.!?]{18,}?[,;:])\s/.exec(this.pending);
      if (clause?.[1]) {
        out = `${clause[1]}\n\n`;
        this.chars += clause[1].length;
        this.pending = this.pending.slice(clause[0].length);
      }
    }
    return out;
  }

  /**
   * End of the reply: the last partial sentence (if it fits), or a hand-off line that fits what's on
   * screen. `raw` is the full reply markdown, used to describe what wasn't spoken.
   */
  flush(raw = ""): string {
    const rest = this.pending.trim();
    this.pending = "";
    if (this.chatty && !this.truncated) {
      const lines = raw.split("\n");
      const unsaid = /```/.test(raw)
        ? "I've put the code on screen."
        : lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 3
          ? "The table's on screen."
          : "";
      return [rest, unsaid].filter(Boolean).join(" ");
    }
    if (!this.truncated && rest && this.sentences < this.maxSentences && this.chars + rest.length <= this.maxChars) return rest;
    if (this.truncated || rest) return ` ${handOffLine(raw)}`;
    return "";
  }
}

let handOffTurn = 0;

/**
 * What to say when a long reply is cut short, based on what's on screen: its sections ("It covers
 * X, Y and Z."), code, steps, a table or a list. Plain prose gets one of a few natural phrasings.
 */
export function handOffLine(raw: string): string {
  const lines = raw.split("\n");
  const titles: string[] = [];
  lines.forEach((line, i) => {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    const boldTitle = /^\s*\*\*([^*]{2,48})\*\*:?\s*$/.exec(line)?.[1];
    const plainTitle =
      /^[A-Za-z][^.!?:|`*#-]{1,40}$/.test(line.trim()) && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i + 1] ?? "")
        ? line.trim()
        : undefined;
    const title = heading ?? boldTitle ?? plainTitle;
    if (title) titles.push(cleanTitle(title));
  });
  const named = titles.filter((t) => t && t.length <= 40);
  if (named.length >= 2) {
    const shown = named.slice(0, 4);
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
    return `It covers ${list}${named.length > 4 ? ", and more" : ""}. The details are on screen.`;
  }
  if (/```/.test(raw)) return "I've put the code on screen.";
  if (lines.filter((l) => /^\s*\d+[.)]\s+/.test(l)).length >= 3) return "The steps are on screen.";
  if (lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 3) return "The table's on screen.";
  if (lines.filter((l) => /^\s*[-*•]\s+/.test(l)).length >= 3) return "The full list is on screen.";
  const prose = ["There's more on screen.", "I've put the rest on screen.", "The details are on screen."];
  return prose[handOffTurn++ % prose.length]!;
}

function cleanTitle(title: string): string {
  const t = title
    .replace(/[*_`#]/g, "")
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}' ,/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // "Web Tasks" -> "web tasks", but keep acronyms like "VYRSE" or "PDF".
  return t
    .split(" ")
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(" ");
}

/** A finished reply as a short spoken answer (the gist, then a pointer to the screen). */
export function speakableReply(raw: string, maxSentences = 4, maxChars = 600): string {
  const filter = new SpeechFilter();
  const brief = new SpokenBrief(maxSentences, maxChars);
  const text = brief.push(filter.push(`${raw}\n`)) + brief.push(filter.flush()) + brief.flush(raw);
  return text.replace(/\s+/g, " ").trim();
}
