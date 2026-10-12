import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getVyrseApi } from "@/services";
import { getDesktopBridge, type AlexaStatus } from "@/services/hermes/bridge";
import { EchoSkillCard } from "./EchoSkillCard";
import type { VoiceMonkeyView } from "@/services/vyrse-api";
import { Section } from "./controls";

const STATE_TEXT: Record<AlexaStatus["state"], string> = {
  off: "Not connected",
  login: "Finish signing in to Amazon in the window that opened…",
  connecting: "Connecting…",
  ready: "Connected",
  error: "Couldn't connect",
};

const button =
  "rounded-full border border-border px-3 py-1.5 text-[11.5px] text-foreground transition-colors hover:border-border-strong hover:bg-secondary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const input =
  "w-full rounded-lg border border-border bg-background/50 px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:border-border-strong focus:outline-none";

/** "Name = trigger id" lines <-> routine map. */
const toLines = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => `${k} = ${v}`).join("\n");
const fromLines = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.split("="))
      .filter((p) => p.length === 2 && p[0]!.trim() && p[1]!.trim())
      .map((p) => [p[0]!.trim(), p[1]!.trim()]),
  );

/**
 * Echo / Alexa: VYRSE sends Alexa commands as text and can make the Echo speak, through the user's Amazon
 * sign-in (held by the desktop app), and/or Voice Monkey (official skill) for announcements and routines.
 */
export function AlexaSection({ open }: { open: boolean }) {
  const desktop = getDesktopBridge()?.desktop;
  const ui = getVyrseApi().ui;
  const [status, setStatus] = useState<AlexaStatus | null>(null);
  const [vm, setVm] = useState<VoiceMonkeyView | null>(null);
  const [token, setToken] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [routines, setRoutines] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop?.alexa) return;
    void desktop.alexa("status").then((s) => setStatus(s as AlexaStatus));
    return desktop.onAlexaStatus?.(setStatus);
  }, [desktop]);

  const loadVm = useCallback(async () => {
    if (!ui?.getVoiceMonkey) return;
    try {
      const view = await ui.getVoiceMonkey();
      setVm(view);
      setSpeaker(view.speaker);
      setRoutines(toLines(view.routines));
    } catch {}
  }, [ui]);

  useEffect(() => {
    if (open) void loadVm();
  }, [open, loadVm]);

  if (!desktop?.alexa) return null;

  const saveVm = async (remove = false) => {
    if (!ui?.setVoiceMonkey) return;
    setSaving(true);
    setNote(null);
    try {
      const view = await ui.setVoiceMonkey(
        remove ? { token: "" } : { ...(token.trim() ? { token: token.trim() } : {}), speaker, routines: fromLines(routines) },
      );
      setVm(view);
      setToken("");
      setNote(remove ? "Voice Monkey removed." : "Saved.");
    } catch (err) {
      setNote(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const state = status?.state ?? "off";
  return (
    <Section title="Echo / Alexa">
      <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-[12.5px] text-foreground">Amazon sign-in</span>
            <span className="block pt-0.5 text-[10px] text-muted-foreground">
              {status?.error && state !== "ready" ? status.error : STATE_TEXT[state]}
            </span>
          </div>
          {state === "ready" || state === "login" || state === "connecting" ? (
            <button type="button" className={button} onClick={() => void desktop.alexa!("disconnect")}>
              {state === "ready" ? "Disconnect" : "Cancel"}
            </button>
          ) : (
            <button type="button" className={button} onClick={() => void desktop.alexa!("connect")}>
              Connect
            </button>
          )}
        </div>
        {state === "ready" && (
          <ul className="mt-2 space-y-1">
            {(status?.devices ?? []).map((d) => (
              <li key={d.serial} className="flex items-center gap-2 text-[11.5px] text-foreground">
                <span className={`size-1.5 rounded-full ${d.online ? "bg-primary" : "bg-muted-foreground/40"}`} />
                {d.name}
                {!d.online && <span className="text-[10px] text-muted-foreground">offline</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
          Lets VYRSE send any Alexa command (“tell Alexa to turn off the lights”). You sign in on Amazon’s own page;
          VYRSE keeps only an encrypted session on this PC, never your password. Unofficial Amazon API.
        </p>
      </div>

      <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-foreground">Voice Monkey</span>
          <span className="text-[10px] text-muted-foreground">{vm?.configured ? "set up" : "optional"}</span>
        </div>
        <p className="pt-1 pb-2 text-[10px] leading-relaxed text-muted-foreground">
          Official Alexa skill for announcements and routines. Enable “Voice Monkey” in the Alexa app, then copy
          your API token and device IDs from voicemonkey.io.
        </p>
        <div className="space-y-2">
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={vm?.configured ? "API token saved (enter a new one to replace)" : "API token"}
            aria-label="Voice Monkey API token"
            className={input}
          />
          <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="Speaker device ID (for announcements)" aria-label="Voice Monkey speaker device ID" className={input} />
          <textarea
            value={routines}
            onChange={(e) => setRoutines(e.target.value)}
            rows={2}
            placeholder={"Routines, one per line:  Bedtime = trigger-device-id"}
            aria-label="Voice Monkey routines"
            className={`${input} resize-none`}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={button} disabled={saving} onClick={() => void saveVm()}>
              {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
            </button>
            {vm?.configured && (
              <button type="button" className={button} disabled={saving} onClick={() => void saveVm(true)}>
                Remove
              </button>
            )}
            {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
          </div>
        </div>
      </div>

      <EchoSkillCard />
    </Section>
  );
}
