import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { WakeTrainStatus } from "@/services/vyrse-api";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";

const WAKE_TAKES = 8;
const OTHER_TAKES = 2;
const OTHER_LINES = [
  "Read this out loud: “I'm going to grab some food and then play a couple of games tonight.”",
  "Now talk normally for a few seconds about anything, like your day.",
];

const button =
  "liquid-hover relative rounded-full border border-border/70 px-3 py-1.5 text-[11.5px] text-foreground disabled:opacity-50 focus-visible:outline-none";

/** Settings → Voice: record your own "VYRSE" takes and train the wake word on your voice. */
export function WakeTraining() {
  const ui = getVyrseApi().ui;
  const { recordVoiceClip, restartWakeWord } = useVyrse();
  const [status, setStatus] = useState<WakeTrainStatus | null>(null);
  const [recording, setRecording] = useState<"wake" | "other" | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const announced = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ui) return;
    try {
      setStatus(await ui.wakeTrain("status"));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  }, [ui]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While training runs, follow its progress; when a new model is in, start listening with it.
  useEffect(() => {
    if (!status?.running) {
      if (status?.phase === "done" && announced.current !== status.message) {
        announced.current = status.message ?? "";
        void restartWakeWord();
      }
      return;
    }
    const id = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(id);
  }, [status?.running, status?.phase, status?.message, refresh, restartWakeWord]);

  if (!ui) return null;
  const takes = status?.takes ?? { wake: 0, other: 0 };
  const running = Boolean(status?.running);
  const nextKind: "wake" | "other" | null = takes.wake < WAKE_TAKES ? "wake" : takes.other < OTHER_TAKES ? "other" : null;

  const record = async (kind: "wake" | "other") => {
    setError(null);
    setRecording(kind);
    try {
      const pcm = await recordVoiceClip(kind === "wake" ? 2 : 5, (l) => setLevel(l));
      if (!pcm) throw new Error("The microphone isn't available.");
      const res = await ui.wakeTrainSample(kind, pcm);
      setStatus((s) => ({ ...(s ?? { takes: res.takes }), takes: res.takes }));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRecording(null);
      setLevel(0);
    }
  };

  return (
    <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
      <span className="block text-[12.5px] text-foreground">Teach it your voice</span>
      <span className="block pt-0.5 text-[10px] leading-relaxed text-muted-foreground">
        Makes the wake word yours: it catches how you say “VYRSE” and ignores look-alikes. About a minute of
        recording; training runs on this PC and nothing is uploaded.
      </span>

      <div className="mt-3 flex items-center gap-1.5" aria-label={`${takes.wake} of ${WAKE_TAKES} wake takes, ${takes.other} of ${OTHER_TAKES} speech takes`}>
        {Array.from({ length: WAKE_TAKES + OTHER_TAKES }).map((_, i) => {
          const done = i < WAKE_TAKES ? i < takes.wake : i - WAKE_TAKES < takes.other;
          return (
            <span
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                done ? (i < WAKE_TAKES ? "bg-primary/80" : "bg-primary/45") : "bg-border/70",
              )}
            />
          );
        })}
      </div>

      {nextKind && !running && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="min-w-0 text-[11.5px] leading-relaxed text-foreground">
            {nextKind === "wake"
              ? `Take ${takes.wake + 1} of ${WAKE_TAKES}: press record and say “VYRSE” once, the way you normally would.`
              : OTHER_LINES[takes.other] ?? OTHER_LINES[0]}
          </p>
          <button type="button" className={cn(button, "flex shrink-0 items-center gap-1.5")} disabled={!!recording} onClick={() => void record(nextKind)}>
            {recording ? (
              <span className="flex h-3 w-10 items-center">
                <span className="h-1.5 rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(8, level * 100)}%` }} />
              </span>
            ) : (
              <Mic className="size-3.5" strokeWidth={1.7} />
            )}
            {recording ? "Listening" : "Record"}
          </button>
        </div>
      )}

      {!nextKind && !running && status?.phase !== "done" && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-foreground">All set. Train it now (the first time also downloads the trainer, about 250 MB).</p>
          <button type="button" className={cn(button, "shrink-0")} onClick={async () => setStatus(await ui.wakeTrain("start").catch((e: Error) => (setError(e.message), status)) ?? status)}>
            Train
          </button>
        </div>
      )}

      {(running || status?.phase === "done" || status?.phase === "failed") && status?.message && (
        <p className={cn("mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed", status.phase === "failed" ? "text-destructive" : "text-foreground")}>
          {running ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : status.phase === "done" ? <Check className="mt-0.5 size-3.5 shrink-0 text-primary" /> : null}
          <span>{status.message}</span>
        </p>
      )}

      {(takes.wake > 0 || takes.other > 0) && !running && (
        <button type="button" className={cn(button, "mt-3")} onClick={async () => setStatus(await ui.wakeTrain("clear"))}>
          {status?.phase === "done" ? "Train again" : "Start over"}
        </button>
      )}
      {error && <p className="mt-2 text-[10.5px] text-destructive">{error}</p>}
    </div>
  );
}
