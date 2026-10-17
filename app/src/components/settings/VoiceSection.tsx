import { useEffect, useState } from "react";
import type { MicTestResult } from "@/lib/voice/voice-controller";
import { useVyrse } from "@/lib/vyrse/store";
import { TALK_SHORTCUTS, DICTATE_SHORTCUTS, QUICK_SHORTCUTS, type DictateShortcut, type QuickShortcut, type TalkShortcut } from "@/lib/vyrse/types";
import { Dropdown, Row, Section, Segmented, Slider, SwitchRow } from "./controls";
import { TALK_STYLES } from "@/lib/vyrse/talk-styles";
import { IS_PHONE } from "@/services/phone";
import { WakeTraining } from "./WakeTraining";

/**
 * Voice settings. Wake word, recognition and speech run in Hermes ("wairz" engine,
 * faster-whisper, Kokoro); these controls set how VYRSE listens and speaks.
 */
/** A short, varied list of Kokoro's voices (they're all on this PC already). */
const STYLE_VOICES = [
  { value: "", label: "VYRSE's usual voice" },
  { value: "af_heart", label: "Heart · warm (US)" },
  { value: "af_bella", label: "Bella · bright (US)" },
  { value: "af_nicole", label: "Nicole · soft, close (US)" },
  { value: "af_sky", label: "Sky · light (US)" },
  { value: "bf_emma", label: "Emma · calm (UK)" },
  { value: "am_puck", label: "Puck · playful (US)" },
  { value: "am_michael", label: "Michael · deep (US)" },
  { value: "am_fenrir", label: "Fenrir · bold (US)" },
  { value: "bm_george", label: "George · composed (UK)" },
];

export function VoiceSection() {
  const { settings: s, setSettings, micLive, listening, agent, setSttModel, testMicrophone, phoneWake, setPhoneWake } = useVyrse();
  const styleName = TALK_STYLES.find((t) => t.id === s.talkStyle)?.label ?? s.customStyles?.find((t) => t.id === s.talkStyle)?.label ?? "this style";
  const [devices, setDevices] = useState<{ value: string; label: string }[]>([]);
  const [outputs, setOutputs] = useState<{ value: string; label: string }[]>([]);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<MicTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await testMicrophone());
    } catch (err) {
      setTestError(`Test failed: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    const load = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          setOutputs(
            list
              .filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
              .map((d) => ({ value: d.deviceId, label: d.label || "Speaker" })),
          );
          return list;
        })
        .then((list) =>
          setDevices(
            list
              .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "communications")
              .map((d) => ({ value: d.deviceId === "default" ? "default" : d.deviceId, label: d.label || "Microphone" })),
          ),
        )
        .catch(() => {});
    void load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", load);
  }, [micLive]);

  const options = devices.length ? devices : [{ value: "default", label: "System default" }];

  return (
    <Section title="Voice">
      <p className="pt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground/80">Listening</p>
      {IS_PHONE && (
        <SwitchRow
          label="Wake word “VYRSE”"
          hint={phoneWake ? "say “VYRSE” while the app is open · detected on this phone" : "tap the mic to talk"}
          checked={phoneWake}
          onChange={setPhoneWake}
        />
      )}
      {!IS_PHONE && (<>
      <SwitchRow
        label="Wake word “VYRSE”"
        hint={s.voiceActivation ? (micLive ? "say “Vyse” anytime" : "starting…") : "tap the mic or use the shortcut to talk"}
        checked={s.voiceActivation}
        onChange={(v) => setSettings({ voiceActivation: v })}
      />
      <Row label="Talk shortcut" hint="works in any app or game · press again to cancel">
        <Dropdown
          value={s.talkShortcut}
          onChange={(v) => setSettings({ talkShortcut: v })}
          label="Talk shortcut"
          options={(Object.keys(TALK_SHORTCUTS) as TalkShortcut[]).map((k) => ({ value: k, label: TALK_SHORTCUTS[k].label }))}
        />
      </Row>
      <Row label="Quick ask" hint="a small ask bar over any app or game">
        <Dropdown
          value={s.quickShortcut ?? "alt+space"}
          onChange={(v) => setSettings({ quickShortcut: v })}
          label="Quick ask"
          options={(Object.keys(QUICK_SHORTCUTS) as QuickShortcut[]).map((k) => ({ value: k, label: QUICK_SHORTCUTS[k].label }))}
        />
      </Row>
      <Row label="Dictate anywhere" hint="types what you say into any app · pause or press again to finish">
        <Dropdown
          value={s.dictateShortcut}
          onChange={(v) => setSettings({ dictateShortcut: v })}
          label="Dictate anywhere"
          options={(Object.keys(DICTATE_SHORTCUTS) as DictateShortcut[]).map((k) => ({ value: k, label: DICTATE_SHORTCUTS[k].label }))}
        />
      </Row>
      <Row label="Voice output" hint="pair your Echo over Bluetooth (“Alexa, pair”) to hear VYRSE on it">
        <Dropdown
          value={outputs.some((o) => o.value === s.outputDevice) ? s.outputDevice : "default"}
          onChange={(v) => setSettings({ outputDevice: v })}
          label="Voice output"
          options={[{ value: "default", label: "System default" }, ...outputs]}
        />
      </Row>
      <Row label="Microphone" hint={listening ? "hearing you" : micLive ? "live" : "off"}>
        <Dropdown
          value={options.some((o) => o.value === s.micDevice) ? s.micDevice : options[0]!.value}
          onChange={(v) => setSettings({ micDevice: v })}
          label="Microphone"
          options={options}
        />
      </Row>
      </>)}
      <SwitchRow
        label="Automatic mic gain"
        hint="boost quiet microphones (recommended)"
        checked={s.autoGain}
        onChange={(v) => setSettings({ autoGain: v })}
      />
      {!IS_PHONE && <WakeTraining />}
      {!IS_PHONE && (
      <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-[12.5px] text-foreground">Test microphone</span>
            <span className="block pt-0.5 text-[10px] text-muted-foreground">
              {testing ? "Recording 5 s — say “VYRSE”, pause, then a short question" : "Records 5 s and checks level, wake word and recognition"}
            </span>
          </div>
          <button
            type="button"
            disabled={testing}
            onClick={() => void runTest()}
            className="shrink-0 rounded-full border border-border-strong px-3 py-1.5 text-[11px] text-foreground transition-colors hover:border-primary/40 disabled:opacity-50"
          >
            {testing ? "Listening…" : "Start"}
          </button>
        </div>
        {test && (
          <div className="mt-2 space-y-1 font-mono text-[10.5px] text-muted-foreground">
            <p>
              Level: <span className={test.peakDb < -30 ? "text-destructive" : "text-foreground"}>{test.peakDb} dBFS peak</span>
              {test.peakDb < -30 ? " — very quiet; turn on automatic gain or raise the mic level in Windows" : ""}
            </p>
            <p>
              Wake word: <span className={test.wakeTriggered ? "text-primary" : "text-foreground"}>{test.wakeTriggered ? "detected" : "not detected"}</span> (score{" "}
              {test.wakeMaxProb.toFixed(2)}, needs {test.wakeThreshold.toFixed(2)})
            </p>
            <p>Heard: <span className="text-foreground">{test.transcript ? `“${test.transcript}”` : "nothing recognisable"}</span></p>
          </div>
        )}
        {testError && <p className="mt-2 text-[10.5px] text-destructive">{testError}</p>}
      </div>
      )}
      <Row label="Speech sensitivity" hint={s.micSensitivity.toFixed(2)}>
        <Slider value={s.micSensitivity} onChange={(v) => setSettings({ micSensitivity: v })} min={0.1} max={1.2} />
      </Row>
      {agent && (
        <Row label="Recognition" hint="Hermes · on this PC">
          <Segmented
            value={agent.sttModel === "small.en" ? "small.en" : "base.en"}
            onChange={setSttModel}
            options={[
              { value: "base.en", label: "Fast" },
              { value: "small.en", label: "Accurate" },
            ]}
          />
        </Row>
      )}
      <SwitchRow
        label="Follow-up listening"
        hint="keep listening a few seconds after VYRSE answers"
        checked={s.autoListen}
        onChange={(v) => setSettings({ autoListen: v })}
      />
      <p className="pt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground/80">Speaking</p>
      <SwitchRow
        label="Voice replies"
        hint={IS_PHONE ? "VYRSE answers out loud (tap the mic to stop it)" : "VYRSE answers out loud (Esc or the mic button stops it)"}
        checked={s.voiceResponses}
        onChange={(v) => setSettings({ voiceResponses: v })}
      />
      <SwitchRow
        label="Speak typed replies too"
        hint="also read out answers to typed messages"
        checked={s.speakTyped}
        onChange={(v) => setSettings({ speakTyped: v })}
      />
      <SwitchRow
        label="Interface sounds"
        hint="soft sounds when the workspace builds something, a step is ticked or a timer ends"
        checked={s.uiSounds}
        onChange={(v) => setSettings({ uiSounds: v })}
      />
      <Row label="Reasoning when talking" hint="Off = fastest replies">
        <Segmented
          value={s.voiceReasoning}
          onChange={(v) => setSettings({ voiceReasoning: v })}
          options={[
            { value: "none", label: "Off" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
          ]}
        />
      </Row>
      <Row label={`Voice in ${styleName}`} hint="each talk style can have its own voice">
        <Dropdown
          value={s.styleVoices?.[s.talkStyle] ?? ""}
          onChange={(v) => setSettings({ styleVoices: { ...(s.styleVoices ?? {}), [s.talkStyle]: v } })}
          label="Voice for this talk style"
          options={STYLE_VOICES}
        />
      </Row>
      <Row label="Voice volume" hint={`${Math.round(s.volume * 100)}%`}>
        <Slider value={s.volume} onChange={(v) => setSettings({ volume: v })} min={0} max={1} step={0.05} />
      </Row>
    </Section>
  );
}
