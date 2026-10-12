/**
 * VYRSE's interface sounds: the reels' sleek set (soft attacks, no bright notes, short dark tails), quiet
 * enough to sit under the voice. Each sound only plays for something that actually happened in front of the
 * user (a card built, a step ticked, a timer done) and never repeats faster than its own cooldown, so a
 * live chart updating every second or a board re-rendering stays silent.
 *
 *   arrive  a new card built in the workspace      tick / tick-soft  something ticked or logged
 *   spin    the picker wheel starting              land              the wheel landing
 *   wrong   a quiz answer that missed              result            a quiz's scorecard
 *   done    a timer finishing (a resolved low bell)
 *   ask     VYRSE asking first (a permission or a question card)      deny  a "no" to that
 *   flip    a flashcard turning over            learned   VYRSE saving a new skill
 *   alert   a watch crossing its line           reminder  a reminder or routine firing
 *   alarm   an alarm: loops (swelling gently) until stopped, see startAlarm()
 * Alerts, reminders and the alarm also play while VYRSE is minimised: that's when they matter.
 */

export type UiSound =
  | "arrive" | "spin" | "land" | "tick" | "tick-soft" | "wrong" | "result" | "done"
  | "ask" | "deny" | "flip" | "learned" | "alert" | "reminder" | "alarm";
const BACKGROUND = new Set<UiSound>(["alert", "reminder", "alarm"]);

// Relative levels (the files are loudness-matched): the bell carries furthest, so it's the quietest.
const LEVEL: Record<UiSound, number> = {
  arrive: 0.5, spin: 0.35, land: 0.55, tick: 0.5, "tick-soft": 0.45, wrong: 0.45, result: 0.6, done: 0.45,
  ask: 0.5, deny: 0.45, flip: 0.4, learned: 0.55, alert: 0.7, reminder: 0.65, alarm: 0.8,
};
// Shortest gap between two plays of the same sound, and between any two sounds.
const COOLDOWN_MS: Record<UiSound, number> = {
  arrive: 1800, spin: 800, land: 800, tick: 250, "tick-soft": 250, wrong: 600, result: 2000, done: 3000,
  ask: 1500, deny: 800, flip: 150, learned: 3000, alert: 4000, reminder: 3000, alarm: 0,
};
const ANY_GAP_MS = 120;

let enabled = true;
let volume = 0.9;
let sinkId = "";
let context: AudioContext | null = null;
const buffers = new Map<UiSound, Promise<AudioBuffer | null>>();
const lastPlayed = new Map<UiSound, number>();
let lastAny = 0;

/** Follow Settings: the interface-sounds switch, VYRSE's volume and its output device. */
export function configureUiSounds(options: { enabled: boolean; volume: number; outputDevice?: string }): void {
  enabled = options.enabled;
  volume = Math.max(0, Math.min(1, options.volume));
  const next = !options.outputDevice || options.outputDevice === "default" ? "" : options.outputDevice;
  if (next !== sinkId) {
    sinkId = next;
    if (context) void applySink(context);
  }
}

async function applySink(ctx: AudioContext): Promise<void> {
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  try {
    await c.setSinkId?.(sinkId);
  } catch {
    await c.setSinkId?.("").catch(() => {});
  }
}

function ctx(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  if (!context) {
    context = new AudioContext();
    if (sinkId) void applySink(context);
  }
  return context;
}

function load(name: UiSound): Promise<AudioBuffer | null> {
  let pending = buffers.get(name);
  if (!pending) {
    const audio = ctx();
    pending = audio
      ? fetch(`sounds/${name}.ogg`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((data) => audio.decodeAudioData(data))
          .catch(() => null)
      : Promise.resolve(null);
    buffers.set(name, pending);
  }
  return pending;
}

/** Play one interface sound, unless sounds are off, it's too soon, or the window is hidden. */
export function playUiSound(name: UiSound): void {
  if (!enabled || volume <= 0) return;
  if (typeof document !== "undefined" && document.hidden && !BACKGROUND.has(name)) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < COOLDOWN_MS[name] || now - lastAny < ANY_GAP_MS) return;
  lastPlayed.set(name, now);
  lastAny = now;
  void load(name).then((buffer) => {
    const audio = context;
    if (!buffer || !audio) return;
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    gain.gain.value = LEVEL[name] * volume * 0.6;
    source.buffer = buffer;
    source.connect(gain).connect(audio.destination);
    source.start();
  });
}

let alarm: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

/**
 * Ring an alarm: the alarm pattern looping, starting soft and swelling over ~20 s, until stopAlarm().
 * It rings even with interface sounds switched off (an alarm that stays silent is worse than none).
 */
export function startAlarm(): void {
  if (alarm) return;
  void load("alarm").then((buffer) => {
    const audio = ctx();
    if (!buffer || !audio || alarm) return;
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const top = LEVEL.alarm * Math.max(volume, 0.5);
    gain.gain.setValueAtTime(top * 0.35, audio.currentTime);
    gain.gain.linearRampToValueAtTime(top, audio.currentTime + 20);
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain).connect(audio.destination);
    source.start();
    alarm = { source, gain };
  });
}

export function stopAlarm(): void {
  if (!alarm || !context) return;
  const { source, gain } = alarm;
  alarm = null;
  gain.gain.cancelScheduledValues(context.currentTime);
  gain.gain.setTargetAtTime(0, context.currentTime, 0.08);
  window.setTimeout(() => {
    try {
      source.stop();
    } catch {
      // already stopped
    }
  }, 400);
}

/** Warm the decoder so the first sound isn't late (called once the app is up). */
export function preloadUiSounds(): void {
  (["arrive", "tick", "land", "done"] as UiSound[]).forEach((n) => void load(n));
}
