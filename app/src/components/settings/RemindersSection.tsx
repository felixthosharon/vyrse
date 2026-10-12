import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { Reminder } from "@/services/vyrse-api";
import { Section, Toggle } from "./controls";

/**
 * Reminders and routines are Hermes cron jobs. They're created by asking VYRSE ("remind me at 6 to…",
 * "every weekday at 8 give me the weather"); this list only shows, pauses and deletes them.
 */
export function RemindersSection({ open }: { open: boolean }) {
  const api = getVyrseApi().reminders;
  const [items, setItems] = useState<Reminder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setItems(await api.list());
      setError(null);
    } catch (err) {
      setError(`Couldn't load reminders: ${(err as Error).message}`);
    }
  }, [api]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!api) return null;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Reminders & routines">
      {items === null ? (
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Nothing scheduled. Ask VYRSE, for example "remind me at 6 to call mum" or "every weekday at 8, tell me the weather".
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-surface/35 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[12px] text-foreground">{r.name}</p>
                <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                  {r.schedule}
                  {r.done ? " · done" : r.paused ? " · paused" : r.nextRun ? ` · next ${formatWhen(r.nextRun)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {busy === r.id ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    {!r.done && <Toggle checked={!r.paused} onChange={(on) => void run(r.id, () => api.setPaused(r.id, !on))} label={`${r.name} active`} />}
                    <button
                      type="button"
                      aria-label={`Delete ${r.name}`}
                      onClick={() => void run(r.id, () => api.remove(r.id))}
                      className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-[10.5px] text-destructive">{error}</p>}
      <p className="text-[10px] leading-relaxed text-muted-foreground">Reminders fire while VYRSE is open; VYRSE shows and says them.</p>
    </Section>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}
