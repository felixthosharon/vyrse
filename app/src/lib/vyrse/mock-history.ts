import type { Conversation } from "./types";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Seed history so the drawer has something to show in the prototype. */
export function seedHistory(): Conversation[] {
  const now = Date.now();
  const mk = (title: string, ago: number, state?: "ok" | "error"): Conversation => ({
    id: Math.random().toString(36).slice(2, 10),
    title,
    updatedAt: now - ago,
    messages: [],
    state,
  });
  return [
    mk("Trace the request latency spike", 1.4 * HOUR),
    mk("Explain this C++ ownership error", 4 * HOUR, "error"),
    mk("Compare queue vs stream ingestion", 7 * HOUR),
    mk("Plan the study schedule for finals", DAY + 3 * HOUR),
    mk("Draft the release notes", DAY + 9 * HOUR),
    mk("Foundry architecture review", 4 * DAY),
    mk("Rewrite the ingest pipeline", 9 * DAY),
  ];
}

export function relativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < HOUR) return `${Math.floor(d / 60_000)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  const days = Math.floor(d / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function groupHistory(items: Conversation[]) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const c of items) {
    if (c.updatedAt >= startOfToday) groups[0]!.items.push(c);
    else if (c.updatedAt >= startOfToday - DAY) groups[1]!.items.push(c);
    else groups[2]!.items.push(c);
  }
  return groups.filter((g) => g.items.length > 0);
}
