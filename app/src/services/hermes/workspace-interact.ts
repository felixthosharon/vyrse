import type { Artifact } from "@/lib/vyrse/types";

/** Something the user did to a workspace item that changes it (mirrors store_update in the vyrse plugin). */
export type WorkspaceUpdate =
  | { op: "timer"; args: { action: "pause" | "resume" | "add" | "stop"; minutes?: number } }
  | { op: "board_move"; args: { from: number; to: number; label: string; index?: number } }
  | { op: "form_sent"; args: { values: Record<string, string> } };

/** The item after the change, or null when it doesn't apply (the screen updates at once; the plugin saves it). */
export function applyUpdate(a: Artifact, u: WorkspaceUpdate, now = Date.now()): Artifact | null {
  if (u.op === "timer" && a.timer) {
    const t = { ...a.timer };
    switch (u.args.action) {
      case "pause":
        if (t.paused_left !== undefined) return null;
        t.paused_left = Math.max(0, t.ends_at - now);
        break;
      case "resume":
        if (t.paused_left === undefined) return null;
        t.ends_at = now + t.paused_left;
        delete t.paused_left;
        break;
      case "add": {
        const extra = Math.round(Math.max(1, Math.min(120, u.args.minutes ?? 5)) * 60_000);
        if (t.paused_left !== undefined) t.paused_left += extra;
        else t.ends_at = Math.max(t.ends_at, now) + extra;
        t.seconds += extra / 1000;
        delete t.stopped;
        break;
      }
      case "stop":
        delete t.paused_left;
        t.ends_at = now;
        t.stopped = true;
        break;
    }
    return { ...a, timer: t };
  }
  if (u.op === "board_move" && a.board) {
    const { from, to, label, index } = u.args;
    if (!a.board[from] || !a.board[to]) return null;
    const card = a.board[from].cards.find((c) => c.label === label);
    if (!card) return null;
    const board = a.board.map((col) => ({ ...col, cards: col.cards.filter((c) => c !== card) }));
    const dest = board[to]!.cards;
    dest.splice(index !== undefined && index >= 0 && index <= dest.length ? index : dest.length, 0, card);
    return { ...a, board };
  }
  if (u.op === "form_sent" && a.form) {
    return { ...a, form: { ...a.form, sent: u.args.values } };
  }
  return null;
}

/** What a sent form tells VYRSE, as the user's message. */
export function formMessage(title: string, fields: { label: string }[], values: Record<string, string>): string {
  const lines = fields.map((f) => `${f.label}: ${values[f.label]?.trim() || "(left blank)"}`);
  return `${title}\n${lines.join("\n")}`;
}
