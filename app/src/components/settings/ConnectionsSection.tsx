import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Loader2, Search } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { Connector, ConnectorSignIn } from "@/services";
import { useVyrse } from "@/lib/vyrse/store";
import { Section, Toggle } from "./controls";

/**
 * Connections: outside services VYRSE can look things up in and act on (Notion, Linear, Todoist, Dropbox…).
 * These are Hermes' own connectors (MCP); each one signs in on the service's own page, and Hermes keeps the
 * sign-in. VYRSE only adds, removes and switches them.
 */
export function ConnectionsSection({ open }: { open: boolean }) {
  const { agent, notify } = useVyrse();
  const api = getVyrseApi().connections;
  const [all, setAll] = useState<Connector[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const [signIn, setSignIn] = useState<ConnectorSignIn | null>(null);
  const [tools, setTools] = useState<Record<string, number>>({});
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setAll(await api.list());
    } catch (err) {
      setProblem({ id: "", text: `Couldn't read the connections: ${(err as Error).message}` });
    }
  }, [api]);
  useEffect(() => {
    if (open && agent) void refresh();
  }, [open, agent !== null, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (id: string, err: unknown) => setProblem({ id, text: (err as Error).message.replace(/^\/api\S*:\s*/, "") });

  /** Add it, then either sign in (the service's page opens) or check it answers. */
  const connect = async (c: Connector) => {
    if (!api || busy) return;
    setBusy(c.id);
    setProblem(null);
    try {
      if (!c.added) await api.add(c.id);
      if (c.signIn) {
        const session = await api.startSignIn(c.id);
        setSignIn(session);
        window.open(session.url, "_blank"); // the desktop shell hands this to the real browser
      } else {
        const res = await api.check(c.id);
        if (!res.ok) throw new Error(res.message || "It didn't answer.");
        setTools((t) => ({ ...t, [c.id]: res.tools }));
        notify(`${c.label} is connected. It works in your next conversation.`);
      }
    } catch (err) {
      fail(c.id, err);
    }
    await refresh();
    setBusy(null);
  };

  useEffect(() => {
    if (!signIn || !api) return;
    let stop = false;
    let timer = 0;
    const tick = async () => {
      const res = await api.pollSignIn(signIn);
      if (stop) return;
      if (res.state === "waiting") {
        timer = window.setTimeout(tick, 2000);
        return;
      }
      setSignIn(null);
      if (res.state === "done") {
        const label = all?.find((c) => c.id === signIn.id)?.label ?? "It";
        notify(`${label} is connected. It works in your next conversation.`);
        void api.check(signIn.id).then((r) => r.ok && setTools((t) => ({ ...t, [signIn.id]: r.tools }))).catch(() => undefined);
      } else setProblem({ id: signIn.id, text: res.message ?? "The sign-in didn't finish." });
      void refresh();
    };
    timer = window.setTimeout(tick, 2000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [signIn, api]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open || !signIn) return;
    void api?.cancelSignIn(signIn);
    setSignIn(null);
  }, [open, signIn, api]);

  const act = async (c: Connector, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(c.id);
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      fail(c.id, err);
    }
    await refresh();
    setBusy(null);
  };

  const { mine, others } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (c: Connector) => !q || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
    const list = all ?? [];
    return { mine: list.filter((c) => c.added), others: list.filter((c) => !c.added && match(c)) };
  }, [all, filter]);

  if (!api) {
    return (
      <Section title="Connections">
        <p className="text-[11px] text-muted-foreground">Add connections from VYRSE on your PC.</p>
      </Section>
    );
  }

  const row = (c: Connector) => {
    const waiting = signIn?.id === c.id;
    return (
      <li key={c.id} data-connector={c.id} className="rounded-2xl border border-border/70 bg-surface/40 px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[13px] text-foreground">
              {c.label}
              {c.added && c.on && (
                <span className="flex items-center gap-1 rounded-full border border-primary/35 px-2 py-0.5 font-mono text-[9px] text-primary">
                  <Check className="size-2.5" strokeWidth={2.4} /> added
                </span>
              )}
            </p>
            <p className="pt-1 text-[10.5px] leading-relaxed text-muted-foreground">{c.description}</p>
            <p className="pt-1 font-mono text-[9.5px] text-muted-foreground/80">
              {c.host}
              {c.signIn ? " · sign-in" : " · no account needed"}
              {tools[c.id] !== undefined ? ` · ${tools[c.id]} tools` : ""}
            </p>
          </div>
          {c.added ? (
            <div className="flex shrink-0 items-center gap-2">
              <Toggle checked={c.on} onChange={(v) => void act(c, () => api.setOn(c.id, v))} label={`${c.label} on`} />
            </div>
          ) : (
            <button type="button" disabled={busy !== null || signIn !== null} onClick={() => void connect(c)} className="liquid relative shrink-0 rounded-full px-3.5 py-1.5 text-[11.5px] text-primary disabled:opacity-50">
              {busy === c.id ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
        {c.added && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-[11px]">
            {c.signIn && !waiting && (
              <button type="button" disabled={busy !== null || signIn !== null} onClick={() => void connect(c)} className="text-primary hover:underline disabled:opacity-50">
                {busy === c.id ? "Opening…" : "Sign in again"}
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void act(c, async () => {
                  const res = await api.check(c.id);
                  if (!res.ok) throw new Error(res.message || "It didn't answer.");
                  setTools((t) => ({ ...t, [c.id]: res.tools }));
                })
              }
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Check it works
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act(c, () => api.remove(c.id))} className="text-muted-foreground hover:text-destructive disabled:opacity-50">
              Remove
            </button>
          </div>
        )}
        {waiting && signIn && (
          <div className="flex items-center justify-between gap-3 pt-2">
            <p className="flex min-w-0 items-center gap-2 text-[10.5px] text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" /> Finish signing in on the page that opened.
              <a href={signIn.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">Open it again <ExternalLink className="size-3" /></a>
            </p>
            <button
              type="button"
              onClick={() => {
                void api.cancelSignIn(signIn);
                setSignIn(null);
              }}
              className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
        {problem?.id === c.id && <p role="alert" className="pt-2 text-[11px] leading-relaxed text-destructive">{problem.text}</p>}
      </li>
    );
  };

  const visible = showAll || filter.trim() ? others : others.slice(0, 8);
  return (
    <>
      <Section title="Connections">
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          Let VYRSE look things up in, and act on, the services you use. Each one signs in on its own page; VYRSE never sees your
          password. A connection can read and change what your account can, so add only the ones you want VYRSE to use.
        </p>
        {problem?.id === "" && <p role="alert" className="text-[11px] text-destructive">{problem.text}</p>}
        {!all ? (
          <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>
        ) : mine.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border/80 px-3 py-2.5 text-[11px] text-muted-foreground">Nothing connected yet.</p>
        ) : (
          <ul className="space-y-2">{mine.map(row)}</ul>
        )}
      </Section>
      {all && (
        <Section title="Add a connection">
          <label className="liquid relative flex items-center gap-2 rounded-full px-3.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.6} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${all.length} services`} aria-label="Search connections" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
          </label>
          {visible.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Nothing matches “{filter.trim()}”.</p>
          ) : (
            <ul className="space-y-2">{visible.map(row)}</ul>
          )}
          {!showAll && !filter.trim() && others.length > visible.length && (
            <button type="button" onClick={() => setShowAll(true)} className="text-[11px] text-muted-foreground hover:text-foreground">
              Show all {others.length}
            </button>
          )}
        </Section>
      )}
    </>
  );
}
