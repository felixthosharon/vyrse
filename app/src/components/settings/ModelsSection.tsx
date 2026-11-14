import { useCallback, useEffect, useState } from "react";
import { Check, Cloud, ExternalLink, Loader2 } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { AiAccount, ModelChoice, SignInSession } from "@/services";
import { useVyrse } from "@/lib/vyrse/store";
import { copyText } from "@/lib/clipboard";
import { Dropdown, Row, Section } from "./controls";
import { LocalModels } from "./LocalModels";

const key = (m: { provider: string; model: string }) => `${m.provider}::${m.model}`;

/**
 * AI models: which model answers, and the online accounts you can plug in. A ChatGPT subscription is a
 * sign-in on OpenAI's own page; Claude, Gemini, OpenAI and the rest take an API key. Hermes keeps the key
 * or token; VYRSE only shows "connected".
 */
export function ModelsSection({ open }: { open: boolean }) {
  const { agent, setModel, refreshAgent, settings, setMode, notify } = useVyrse();
  const api = getVyrseApi().accounts;
  const [accounts, setAccounts] = useState<AiAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<SignInSession | null>(null);
  const [copied, setCopied] = useState(false);
  const isPrivate = settings.mode === "private";

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setAccounts(await api.list());
      setError(null);
    } catch (err) {
      setError(`Couldn't read your AI accounts: ${(err as Error).message}`);
    }
  }, [api]);
  useEffect(() => {
    if (open && agent) void refresh();
  }, [open, agent !== null, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  /** After an account connects: re-read the models so its models show up in the picker. */
  const afterConnect = useCallback(
    async (label: string) => {
      await refresh();
      await refreshAgent();
      notify(`${label} is connected. Pick one of its models below.`);
    },
    [refresh, refreshAgent, notify],
  );
  const saveKey = async (a: AiAccount) => {
    if (!api || busy) return;
    setBusy(a.id);
    setProblem(null);
    const res = await api.saveKey(a.id, draft);
    setBusy(null);
    if (!res.ok) return setProblem(res.message ?? "That didn't work.");
    setDraft("");
    setExpanded(null);
    await afterConnect(a.label);
  };

  const disconnect = async (a: AiAccount) => {
    if (!api || busy) return;
    setBusy(a.id);
    setProblem(null);
    try {
      await api.disconnect(a.id);
      await refresh();
      await refreshAgent();
      notify(`${a.label} disconnected.`);
    } catch (err) {
      setProblem(`Couldn't disconnect: ${(err as Error).message}`);
    }
    setBusy(null);
  };

  const beginSignIn = async (a: AiAccount) => {
    if (!api || busy) return;
    setBusy(a.id);
    setProblem(null);
    try {
      const session = await api.startSignIn(a.id);
      setSignIn(session);
      setExpanded(a.id);
      window.open(session.url, "_blank"); // the desktop shell hands this to the real browser
    } catch (err) {
      setProblem((err as Error).message.replace(/^\/api\S*:\s*/, ""));
      setExpanded(a.id);
    }
    setBusy(null);
  };

  // Wait for the sign-in to finish on the provider's page.
  useEffect(() => {
    if (!signIn || !api) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const status = await api.pollSignIn(signIn);
      if (stop) return;
      if (status.state === "waiting") {
        timer = window.setTimeout(tick, signIn.pollMs);
        return;
      }
      setSignIn(null);
      if (status.state === "done") {
        setExpanded(null);
        void afterConnect(accounts?.find((a) => a.id === signIn.id)?.label ?? "Your account");
      } else setProblem(status.message);
    };
    let timer = window.setTimeout(tick, signIn.pollMs);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [signIn, api, afterConnect]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page abandons a half-done sign-in.
  useEffect(() => {
    if (open || !signIn) return;
    void api?.cancelSignIn(signIn);
    setSignIn(null);
  }, [open, signIn, api]);

  if (!agent) {
    return (
      <Section title="AI models">
        <p className="text-[11px] text-muted-foreground">Waiting for Hermes…</p>
      </Section>
    );
  }

  const local = agent.models.filter((m) => m.local);
  const online = isPrivate ? [] : agent.models.filter((m) => !m.local);
  const current = key(agent);
  const known = agent.models.some((m) => key(m) === current);
  const choose = (v: string) => {
    const m: ModelChoice | undefined = agent.models.find((x) => key(x) === v);
    if (m) setModel(m);
  };

  return (
    <>
      <Section title="AI models">
        <Row label="Answering now" hint={online.some((m) => key(m) === current) ? "online" : "on your PC"}>
          <Dropdown
            value={current}
            onChange={choose}
            label="Model"
            options={[
              ...(known ? [] : [{ value: current, label: agent.model || "No model yet", hint: agent.provider }]),
              ...local.map((m) => ({ value: key(m), label: m.model, hint: "on your PC · private · free" })),
              ...online.map((m) => ({ value: key(m), label: m.model, hint: `${m.providerLabel} · online` })),
            ]}
          />
        </Row>
        <LocalModels open={open} />
      </Section>

      <Section title="Your AI accounts">
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          Already pay for an AI, or have an API key? Connect it and VYRSE answers with that model instead of the one on your PC.
          Your messages then go to that company; everything else stays here.
        </p>
        {isPrivate && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border/80 px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground">Private mode keeps VYRSE on your PC only, so online models are off.</p>
            <button type="button" onClick={() => setMode("assistant")} className="liquid-hover relative shrink-0 rounded-full border border-border-strong px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              Leave Private mode
            </button>
          </div>
        )}
        {!api ? (
          <p className="text-[11px] text-muted-foreground">Connect accounts from VYRSE on your PC.</p>
        ) : error ? (
          <p className="text-[11px] text-destructive">{error}</p>
        ) : !accounts ? (
          <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => {
              const isOpen = expanded === a.id;
              const waiting = signIn?.id === a.id;
              return (
                <li key={a.id} data-account={a.id} className="rounded-2xl border border-border/70 bg-surface/40 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[13px] text-foreground">
                        {a.label}
                        {a.connected && (
                          <span className="flex items-center gap-1 rounded-full border border-primary/35 px-2 py-0.5 font-mono text-[9px] text-primary">
                            <Check className="size-2.5" strokeWidth={2.4} /> connected
                          </span>
                        )}
                      </p>
                      <p className="pt-1 text-[10.5px] leading-relaxed text-muted-foreground">{a.blurb}</p>
                    </div>
                    {a.connected ? (
                      a.managedElsewhere ? null : (
                        <button type="button" disabled={busy === a.id} onClick={() => void disconnect(a)} className="liquid-hover relative shrink-0 rounded-full border border-border-strong px-3 py-1.5 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50">
                          {busy === a.id ? "…" : "Disconnect"}
                        </button>
                      )
                    ) : a.kind === "signin" ? (
                      <button type="button" disabled={busy === a.id || waiting} onClick={() => void beginSignIn(a)} className="liquid relative shrink-0 rounded-full px-3.5 py-1.5 text-[11.5px] text-primary disabled:opacity-60">
                        {busy === a.id ? "Starting…" : waiting ? "Waiting…" : "Sign in"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setExpanded(isOpen ? null : a.id);
                          setDraft("");
                          setProblem(null);
                        }}
                        className="liquid relative shrink-0 rounded-full px-3.5 py-1.5 text-[11.5px] text-primary"
                      >
                        {isOpen ? "Cancel" : "Connect"}
                      </button>
                    )}
                  </div>

                  {a.connected && a.keyPreview && <p className="pt-2 font-mono text-[10px] text-muted-foreground">key {a.keyPreview}</p>}

                  {isOpen && a.kind === "key" && !a.connected && (
                    <div className="space-y-2 pt-3">
                      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                        1. Get a key from{" "}
                        <a href={a.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          {a.keyUrl?.replace(/^https:\/\//, "")} <ExternalLink className="size-3" />
                        </a>
                        <br />
                        2. Paste it here. VYRSE checks it, then Hermes keeps it on this PC.
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void saveKey(a)}
                          placeholder={a.keyHint ?? "API key"}
                          aria-label={`${a.label} API key`}
                          autoComplete="off"
                          spellCheck={false}
                          className="liquid relative min-w-0 flex-1 rounded-2xl px-3.5 py-2.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <button type="button" disabled={!draft.trim() || busy === a.id} onClick={() => void saveKey(a)} className="shrink-0 rounded-full bg-primary px-4 py-2 text-[12px] text-primary-foreground disabled:opacity-40">
                          {busy === a.id ? "Checking…" : "Save"}
                        </button>
                      </div>
                    </div>
                  )}

                  {waiting && signIn && (
                    <div className="space-y-2 pt-3">
                      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                        A sign-in page opened in your browser. Sign in there and enter this code:
                      </p>
                      <div className="flex items-center gap-2">
                        <span data-signin-code className="liquid relative rounded-2xl px-4 py-2 font-mono text-[16px] tracking-[0.18em] text-foreground">{signIn.code}</span>
                        <button
                          type="button"
                          onClick={async () => {
                            if (await copyText(signIn.code)) {
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1200);
                            }
                          }}
                          className="liquid-hover relative rounded-full border border-border-strong px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <a href={signIn.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                          Open the page again <ExternalLink className="size-3" />
                        </a>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="flex items-center gap-2 text-[10.5px] text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Waiting for you to finish signing in…</p>
                        <button
                          type="button"
                          onClick={() => {
                            void api.cancelSignIn(signIn);
                            setSignIn(null);
                            setExpanded(null);
                          }}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {isOpen && problem && <p role="alert" className="pt-2 text-[11px] leading-relaxed text-destructive">{problem}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {!isPrivate && online.length > 0 && (
          <p className="flex items-start gap-2 text-[10.5px] leading-relaxed text-muted-foreground">
            <Cloud className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.6} />
            {online.length} online model{online.length === 1 ? "" : "s"} ready in “Answering now” above. Switch back to a model on your PC any time; say “private mode” to stay offline.
          </p>
        )}
      </Section>
    </>
  );
}
