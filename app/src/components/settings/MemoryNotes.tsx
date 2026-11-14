import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { MemoryNotes as Notes } from "@/services";
import { useVyrse } from "@/lib/vyrse/store";

type Target = "user" | "memory";
const GROUPS: { target: Target; title: string; hint: string; placeholder: string }[] = [
  { target: "user", title: "About you", hint: "who you are and how you like to be helped", placeholder: "e.g. I'm studying for my physics finals" },
  { target: "memory", title: "About your PC and your things", hint: "facts VYRSE picked up while working", placeholder: "e.g. My project files are on the D: drive" },
];

/** What VYRSE remembers, note by note: read them, fix one, delete one, or add your own. */
export function MemoryNotes({ open }: { open: boolean }) {
  const { agent } = useVyrse();
  const api = getVyrseApi().memory;
  const [notes, setNotes] = useState<Notes | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ target: Target; entry: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setNotes(await api.list());
      setProblem(null);
    } catch (err) {
      setProblem(`Couldn't read the notes: ${(err as Error).message.replace(/^\/api\S*:\s*/, "")}`);
    }
  }, [api]);
  useEffect(() => {
    if (open && agent) void refresh();
  }, [open, agent !== null, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (fn: () => Promise<{ ok: boolean; message?: string; memory: Notes }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      setNotes(res.memory);
      setProblem(res.ok ? null : res.message || "That didn't work.");
      if (res.ok) setEditing(null);
    } catch (err) {
      setProblem((err as Error).message.replace(/^\/api\S*:\s*/, ""));
    }
    setBusy(false);
  };

  const save = () => {
    if (!editing || !api) return;
    const text = editing.text.replace(/\s+/g, " ").trim();
    if (!text) return setEditing(null);
    void apply(() => (editing.entry === null ? api.add(editing.target, text) : api.replace(editing.target, editing.entry, text)));
  };

  if (!api || !agent?.memoryEnabled) return null;
  if (!notes) {
    return problem ? <p className="text-[11px] text-destructive">{problem}</p> : <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading what VYRSE remembers…</p>;
  }

  const editor = (
    <div className="flex items-end gap-1.5">
      <textarea
        autoFocus
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        rows={2}
        maxLength={600}
        value={editing?.text ?? ""}
        onChange={(e) => setEditing((s) => (s ? { ...s, text: e.target.value } : s))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(null);
          }
        }}
        placeholder={GROUPS.find((g) => g.target === editing?.target)?.placeholder}
        aria-label="Note"
        className="liquid relative min-w-0 flex-1 resize-none rounded-2xl px-3 py-2 text-[12px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button type="button" aria-label="Save note" disabled={busy} onClick={save} className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"><Check className="size-4" /></button>
      <button type="button" aria-label="Cancel" onClick={() => setEditing(null)} className="liquid-hover relative grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
    </div>
  );

  return (
    <div className="space-y-5">
      {GROUPS.map((g) => {
        const group = notes[g.target];
        const full = Math.round((group.used / Math.max(1, group.limit)) * 100);
        return (
          <div key={g.target} data-memory={g.target} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-foreground">{g.title}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{group.entries.length} note{group.entries.length === 1 ? "" : "s"} · {full}% full</span>
            </div>
            {group.entries.length === 0 && <p className="text-[11px] text-muted-foreground">Nothing yet: {g.hint}.</p>}
            <ul className="space-y-1.5">
              {group.entries.map((entry) =>
                editing?.target === g.target && editing.entry === entry ? (
                  <li key={entry}>{editor}</li>
                ) : (
                  <li key={entry} className="group flex items-start justify-between gap-2 rounded-2xl border border-border/70 bg-surface/40 px-3 py-2">
                    <p className="min-w-0 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{entry}</p>
                    <span className="flex shrink-0 items-center">
                      <button type="button" aria-label="Edit note" onClick={() => setEditing({ target: g.target, entry, text: entry })} className="liquid-hover relative grid size-7 place-items-center rounded-lg text-muted-foreground hover:text-foreground"><Pencil className="size-3.5" strokeWidth={1.5} /></button>
                      <button type="button" aria-label="Delete note" disabled={busy} onClick={() => void apply(() => api.remove(g.target, entry))} className="liquid-hover relative grid size-7 place-items-center rounded-lg text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" strokeWidth={1.5} /></button>
                    </span>
                  </li>
                ),
              )}
            </ul>
            {editing?.target === g.target && editing.entry === null ? (
              editor
            ) : (
              <button type="button" onClick={() => setEditing({ target: g.target, entry: null, text: "" })} className="flex items-center gap-1.5 text-[11px] text-primary hover:underline">
                <Plus className="size-3.5" strokeWidth={1.8} /> Add a note
              </button>
            )}
          </div>
        );
      })}
      {problem && <p role="alert" className="text-[11px] leading-relaxed text-destructive">{problem}</p>}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        VYRSE reads these at the start of each conversation, so a change shows up in your next one. It also adds notes itself when you tell it something worth keeping.
      </p>
    </div>
  );
}
