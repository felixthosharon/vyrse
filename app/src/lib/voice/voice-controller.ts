import type { SpeechStream, VoiceBackend } from "@/services";
import { encodeWav, MicCapture, normalizeFrames, toInt16 } from "./mic";
import { PcmPlayer } from "./player";
import { IS_PHONE } from "@/services/phone";
import { SpeechFilter, SpokenBrief } from "./speech-text";
import { DEFAULT_ENDPOINTER, Endpointer, rmsDb } from "./vad";

/**
 * VYRSE voice: one state machine around Hermes' voice services.
 *
 *   off → wake ("wairz" detection runs in Hermes on streamed mic frames)
 *       → capturing (endpointing) → transcribing (Hermes STT) → waiting (Hermes reply)
 *       → speaking (Hermes TTS; saying the wake word interrupts) → follow-up (listen without wake word) → wake
 *
 * Voice is only another input to the same Hermes session: transcripts are handed to the app,
 * which sends them like typed messages. No second assistant lives here.
 */
export type VoicePhase = "off" | "idle" | "wake" | "capturing" | "transcribing" | "waiting" | "speaking" | "followup";

export interface VoiceSettings {
  wakeWord: boolean;
  deviceId: string;
  sensitivity: number;
  volume: number;
  followUpMs: number;
  autoGain: boolean;
  /** speaker for VYRSE's voice (audiooutput deviceId); "default" = system default */
  outputDeviceId?: string;
  /** speak whole replies (Vibe/Fam talk styles) instead of a short brief with the rest on screen */
  chatty?: boolean;
  /** open the mic only for a request and close it after (tap-to-talk on the phone) */
  releaseMicWhenIdle?: boolean;
}

export interface MicTestResult {
  peakDb: number;
  transcript: string;
  wakeMaxProb: number;
  wakeThreshold: number;
  wakeTriggered: boolean;
  savedTo: string;
}

export interface VoiceCallbacks {
  onPhase(phase: VoicePhase): void;
  /** Also called mid-task (the wake word interrupts); the receiver decides how to stop the running request. */
  onTranscript(text: string): void;
  /** Dictation finished: the words to type into whatever app is focused (never sent to Hermes). */
  onDictation?(text: string): void;
  /** Dictation started (true) or ended (false). */
  onDictating?(active: boolean): void;
  onError(message: string): void;
}

/** Dictation allows pauses to think and long messages; a quick tap of the shortcut finishes it early. */
const DICTATION_ENDPOINTER = { ...DEFAULT_ENDPOINTER, endSilenceMs: 1600, noSpeechTimeoutMs: 8000, maxUtteranceMs: 60000 };

export interface ReplySpeaker {
  push(delta: string): void;
  /** speak a short line now, outside the reply text (progress updates) */
  say(text: string): void;
  /** true once any of the reply itself has been spoken */
  readonly started: boolean;
  end(): void;
  cancel(): void;
}

const PRE_ROLL_FRAMES = 3; // 300 ms kept from before capture starts

export class VoiceController {
  readonly player = new PcmPlayer();
  private readonly mic = new MicCapture();
  private phase: VoicePhase = "off";
  private settings: VoiceSettings = { wakeWord: true, deviceId: "auto", sensitivity: 0.6, volume: 1, followUpMs: 6000, autoGain: true };
  private followUpAfterSpeech = true;
  private dictating = false;
  private endpointer: Endpointer | null = null;
  private frames: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private noiseFloorDb = -60;
  /** the reply being spoken says VYRSE's own name, which would trigger the wake word through a headset */
  private replySaysName = false;
  /** the current capture is the follow-up window (no wake word was said) */
  private captureIsFollowUp = false;
  /** the current capture began right after the wake word */
  private captureAfterWake = false;
  /** phase the wake word interrupted ("speaking"/"waiting"); VYRSE's voice is ducked meanwhile */
  private interruptedPhase: VoicePhase | null = null;
  /** what VYRSE said recently, to tell an echo of its own voice from a real request */
  private spokenRecently = "";
  private speech: SpeechStream | null = null;
  private unsubscribers: (() => void)[] = [];
  private enabled = false;

  constructor(
    private readonly backend: VoiceBackend,
    private readonly callbacks: VoiceCallbacks,
  ) {
    this.player.onDrained(() => this.onPlaybackDrained());
    if (IS_PHONE) this.player.unlockOnGesture();
  }

  get current(): VoicePhase {
    return this.phase;
  }

  /** 0..1 for the presence orb: what VYRSE hears, or what it says. */
  level(): number {
    return this.phase === "speaking" ? this.player.level() : this.mic.running ? this.mic.level : 0;
  }

  configure(settings: Partial<VoiceSettings>): void {
    const deviceChanged = settings.deviceId !== undefined && settings.deviceId !== this.settings.deviceId;
    const wakeChanged = settings.wakeWord !== undefined && settings.wakeWord !== this.settings.wakeWord;
    const gainChanged = settings.autoGain !== undefined && settings.autoGain !== this.settings.autoGain;
    this.settings = { ...this.settings, ...settings };
    this.player.setVolume(this.settings.volume);
    this.player.setOutput(this.settings.outputDeviceId ?? "default");
    if (this.enabled && (deviceChanged || wakeChanged || gainChanged)) void this.restart();
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    try {
      await this.mic.start(this.settings.deviceId, this.settings.autoGain, !IS_PHONE);
    } catch (err) {
      this.enabled = false;
      this.setPhase("off");
      this.callbacks.onError(micError(err));
      return;
    }
    this.unsubscribers.push(
      this.mic.onFrame((frame) => this.onFrame(frame)),
      this.backend.onWake(() => this.onWake()),
    );
    void this.backend.warm(true);
    // Mic-on-demand (the phone): opened for a request, so don't arm idle — that would close it again.
    if (this.settings.releaseMicWhenIdle) this.setPhase("idle");
    else await this.armIdle();
  }

  async disable(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    this.unsubscribers.splice(0).forEach((off) => off());
    this.stopSpeaking();
    await this.backend.stopWake();
    await this.mic.stop();
    void this.backend.warm(false);
    this.setPhase("off");
  }

  /** Tap-to-talk: listen for one request now (also cancels the follow-up wait). */
  async listenNow(): Promise<void> {
    if (!this.enabled) await this.enable();
    if (!this.enabled) return;
    this.stopSpeaking();
    this.startCapture(DEFAULT_ENDPOINTER.noSpeechTimeoutMs);
  }

  /** Stop listening for the current request and go back to waiting. */
  cancelCapture(): void {
    this.setDictating(false);
    if (this.phase === "capturing" || this.phase === "followup") void this.armIdle();
  }

  get isDictating(): boolean {
    return this.dictating;
  }

  /** Dictate anywhere: listen, transcribe, and hand the words to onDictation. Called again, finishes now. */
  async dictate(): Promise<void> {
    if (this.dictating && this.phase === "capturing") {
      void this.finishCapture();
      return;
    }
    if (!this.enabled) await this.enable();
    if (!this.enabled) return;
    this.stopSpeaking();
    this.interruptedPhase = null;
    this.setDictating(true);
    void this.player.chime();
    this.endpointer = new Endpointer(DICTATION_ENDPOINTER, this.noiseFloorDb);
    this.frames = [];
    this.captureIsFollowUp = false;
    this.captureAfterWake = false;
    this.setPhase("capturing");
  }

  private setDictating(active: boolean): void {
    if (this.dictating === active) return;
    this.dictating = active;
    this.callbacks.onDictating?.(active);
  }

  /**
   * Record a few seconds through the live pipeline and report level, wake-word score and
   * transcript (Settings → Voice → Test microphone). The recording is saved by Hermes for diagnosis.
   */
  /** Record `seconds` of 16 kHz mono int16 audio from the mic (Teach it my voice). */
  async recordClip(seconds: number, onLevel?: (level: number) => void): Promise<Int16Array> {
    const startedHere = !this.mic.running;
    if (startedHere) await this.mic.start(this.settings.deviceId, this.settings.autoGain, !IS_PHONE);
    const frames: Float32Array[] = [];
    await new Promise<void>((resolve) => {
      const off = this.mic.onFrame((frame) => {
        frames.push(frame);
        onLevel?.(this.mic.level);
        if (frames.length >= Math.round(seconds * 10)) {
          off();
          resolve();
        }
      });
    });
    if (startedHere && !this.enabled) await this.mic.stop();
    const pcm = new Int16Array(frames.length * 1600);
    frames.forEach((f, i) => pcm.set(toInt16(f), i * 1600));
    return pcm;
  }

  async testMic(seconds = 5): Promise<MicTestResult> {
    const startedHere = !this.mic.running;
    if (startedHere) await this.mic.start(this.settings.deviceId, this.settings.autoGain, !IS_PHONE);
    const frames: Float32Array[] = [];
    await new Promise<void>((resolve) => {
      const off = this.mic.onFrame((frame) => {
        frames.push(frame);
        if (frames.length >= seconds * 10) {
          off();
          resolve();
        }
      });
    });
    if (startedHere && !this.enabled) await this.mic.stop();
    let peak = 0;
    for (const f of frames) for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]!));
    const pcm = new Int16Array(frames.length * 1600);
    frames.forEach((f, i) => pcm.set(toInt16(f), i * 1600));
    const [score, transcript] = await Promise.all([
      this.backend.micTest(pcm),
      this.backend.transcribe(encodeWav(normalizeFrames(frames))).catch(() => ""),
    ]);
    return {
      peakDb: Math.round(20 * Math.log10(Math.max(peak, 1e-9)) * 10) / 10,
      transcript,
      wakeMaxProb: score.wakeMaxProb,
      wakeThreshold: score.wakeThreshold,
      wakeTriggered: score.wakeTriggered,
      savedTo: score.savedTo,
    };
  }

  /** Stop talking now (Esc, mic button). */
  stopSpeakingNow(): void {
    if (this.phase !== "speaking" && !this.speech) return;
    this.stopSpeaking();
    if (this.enabled) void this.armIdle();
    else this.setPhase("off");
  }

  /** Start speaking a reply as it streams in; `followUp` listens afterwards (spoken requests only). */
  /** `full` reads the whole reply (the read-aloud button) instead of the spoken brief. */
  speakReply(options: { followUp: boolean; full?: boolean } = { followUp: true }): ReplySpeaker {
    this.stopSpeaking();
    this.followUpAfterSpeech = options.followUp;
    this.replySaysName = false;
    const filter = new SpeechFilter();
    // Vibe/Fam are for chatting: the whole reply is spoken (capped only for runaway answers).
    const brief = options.full
      ? new SpokenBrief(Infinity, Infinity)
      : this.settings.chatty
        ? new SpokenBrief(40, 3000, true)
        : new SpokenBrief();
    let replyStarted = false;
    let fullText = "";
    let speech: SpeechStream;
    try {
      speech = this.backend.speak();
    } catch (err) {
      this.callbacks.onError("VYRSE couldn't start speaking.");
      return { push: () => {}, say: () => {}, started: false, end: () => this.replyFinished(), cancel: () => {} };
    }
    this.speech = speech;
    let spoke = false;
    speech.onAudio((pcm, rate) => {
      if (this.speech !== speech) return;
      if (!spoke) {
        spoke = true;
        // While the user is being heard after the wake word, keep playing (ducked) without
        // taking the phase back from the capture.
        if (this.interruptedPhase) this.interruptedPhase = "speaking";
        else this.setPhase("speaking");
      }
      this.player.enqueue(pcm, rate);
    });
    speech.onEnd((reason) => {
      if (this.speech !== speech) return;
      this.speech = null;
      if (reason !== "end") this.callbacks.onError("VYRSE's voice isn't available right now; the reply is on screen.");
      if (!this.player.playing) this.onPlaybackDrained();
    });
    return {
      push: (delta) => {
        fullText += delta;
        const text = brief.push(filter.push(delta));
        if (text) {
          if (NAME_RE.test(text)) this.replySaysName = true;
          replyStarted = true;
          this.remember(text);
          speech.push(text);
        }
      },
      say: (text) => {
        this.remember(text);
        speech.push(` ${text} `);
      },
      get started() {
        return replyStarted;
      },
      end: () => {
        const tail = brief.push(filter.flush()) + brief.flush(fullText);
        this.remember(tail);
        speech.push(tail);
        speech.finish();
      },
      cancel: () => this.stopSpeaking(),
    };
  }

  /** A voice request finished without speech output (voice replies off, or error). */
  replyFinished(): void {
    if (this.phase === "waiting" || this.phase === "transcribing") this.startFollowUp();
  }

  private async restart(): Promise<void> {
    await this.disable();
    await this.enable();
  }

  private async armIdle(): Promise<void> {
    this.endpointer = null;
    this.frames = [];
    if (this.settings.wakeWord) {
      try {
        const res = await this.backend.startWake();
        if (!res.available) this.callbacks.onError(res.hint || "The wake word isn't available in Hermes.");
        this.setPhase(res.available ? "wake" : "idle");
      } catch {
        this.setPhase("idle");
        this.callbacks.onError("Couldn't start the wake word in Hermes.");
      }
    } else if (this.settings.releaseMicWhenIdle) {
      // Nothing to listen for between requests: give the mic back (Android shows it as in use).
      await this.disable();
    } else {
      await this.backend.stopWake();
      this.setPhase("idle");
    }
  }

  private onFrame(frame: Float32Array): void {
    switch (this.phase) {
      case "wake":
        this.backend.feedWake(toInt16(frame));
        this.keepPreRoll(frame);
        this.trackNoise(frame);
        return;
      case "idle":
        this.keepPreRoll(frame);
        this.trackNoise(frame);
        return;
      case "capturing":
      case "followup":
        this.capture(frame);
        return;
      case "waiting":
      case "speaking":
        // Keep listening for the wake word while VYRSE works or talks: saying it interrupts.
        this.backend.feedWake(toInt16(frame));
        this.keepPreRoll(frame);
        return;
      default:
        return;
    }
  }

  private onWake(): void {
    if (this.phase === "speaking" && this.replySaysName) return; // probably its own voice saying its name
    if (this.phase !== "wake" && this.phase !== "waiting" && this.phase !== "speaking") return;
    // Interrupting: lower VYRSE's voice and listen. Speech stops (and a running request is replaced)
    // only once a real request is heard; a noise just brings the voice back up.
    if (this.phase !== "wake") {
      this.interruptedPhase = this.phase;
      this.player.duck(true);
    }
    void this.player.chime();
    this.startCapture(DEFAULT_ENDPOINTER.noSpeechTimeoutMs, "capturing", true);
  }

  private startCapture(noSpeechTimeoutMs: number, phase: "capturing" | "followup" = "capturing", afterWake = false): void {
    this.endpointer = new Endpointer({ ...DEFAULT_ENDPOINTER, noSpeechTimeoutMs }, this.noiseFloorDb);
    // After the wake word the pre-roll holds the end of the name itself; Whisper turned it into "Wise."
    this.frames = afterWake ? [] : [...this.preRoll];
    this.captureIsFollowUp = phase === "followup";
    this.captureAfterWake = afterWake;
    this.setPhase(phase);
  }

  private capture(frame: Float32Array): void {
    const endpointer = this.endpointer;
    if (!endpointer) return;
    this.frames.push(frame);
    const event = endpointer.push(frame, Math.max(0.2, this.settings.sensitivity * 1.6));
    if (event === "speech-start" && this.phase === "followup") this.setPhase("capturing");
    if (event === "speech-end" || event === "max-length") void this.finishCapture();
    else if (event === "no-speech") void this.noRequest();
  }

  private async finishCapture(): Promise<void> {
    const frames = this.frames;
    this.frames = [];
    this.endpointer = null;
    this.setPhase("transcribing");
    if (this.dictating) {
      try {
        const heard = (await this.backend.transcribe(encodeWav(normalizeFrames(frames)))).trim();
        if (heard && !isNoise(heard)) this.callbacks.onDictation?.(heard);
        else this.callbacks.onError("Didn't catch anything to type.");
      } catch (err) {
        console.warn("[vyrse] dictation transcription failed:", err);
        this.callbacks.onError("Dictation failed — speech recognition didn't respond.");
      }
      this.setDictating(false);
      await this.armIdle();
      return;
    }
    try {
      const heard = await this.backend.transcribe(encodeWav(normalizeFrames(frames)));
      const text = this.captureAfterWake ? stripWakeEcho(heard) : heard;
      const interrupting = this.interruptedPhase !== null;
      if (
        !text ||
        isNoise(text) ||
        (this.captureIsFollowUp && isStrayWord(text)) ||
        (interrupting && !isStopWord(text) && (wordCount(text) < 2 || isEcho(text, this.spokenRecently)))
      ) {
        if (text) console.info(`[vyrse:voice] ignored "${text}"`);
        await this.noRequest();
        return;
      }
      if (interrupting) {
        this.interruptedPhase = null;
        this.stopSpeaking();
        this.player.duck(false);
      }
      this.setPhase("waiting");
      this.callbacks.onTranscript(text);
    } catch (err) {
      this.callbacks.onError("VYRSE couldn't understand that — speech recognition failed.");
      console.warn("[vyrse] transcription failed:", err);
      await this.noRequest();
    }
  }

  /** A capture ended without a request: resume what the wake word interrupted, else go idle. */
  private async noRequest(): Promise<void> {
    if (this.dictating) this.callbacks.onError("Didn't hear anything to type.");
    this.setDictating(false);
    const resumed = this.interruptedPhase;
    this.interruptedPhase = null;
    this.player.duck(false);
    this.endpointer = null;
    this.frames = [];
    if (resumed === "speaking" && (this.speech || this.player.playing)) this.setPhase("speaking");
    // "waiting" only follows a spoken request, whose reply (or replyFinished) moves things on.
    else if (resumed === "waiting") this.setPhase("waiting");
    else if (resumed && this.followUpAfterSpeech) this.startFollowUp();
    else await this.armIdle();
  }

  private remember(text: string): void {
    this.spokenRecently = (this.spokenRecently + " " + text).slice(-600);
  }

  private onPlaybackDrained(): void {
    if (this.phase !== "speaking" || this.speech) return;
    if (!this.enabled) this.setPhase("off");
    else if (this.followUpAfterSpeech) this.startFollowUp();
    else void this.armIdle();
  }

  private startFollowUp(): void {
    if (!this.enabled) return;
    if (this.settings.followUpMs > 0) this.startCapture(this.settings.followUpMs, "followup");
    else void this.armIdle();
  }

  private stopSpeaking(): void {
    this.spokenRecently = "";
    const speech = this.speech;
    this.speech = null;
    speech?.stop();
    this.player.stop();
  }

  private keepPreRoll(frame: Float32Array): void {
    this.preRoll.push(frame);
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
  }

  private trackNoise(frame: Float32Array): void {
    const db = rmsDb(frame);
    this.noiseFloorDb = db < this.noiseFloorDb ? 0.8 * this.noiseFloorDb + 0.2 * db : 0.98 * this.noiseFloorDb + 0.02 * db;
  }

  private setPhase(phase: VoicePhase): void {
    if (this.phase === phase) return;
    // While capturing a request, Hermes' wake detector is paused (frames aren't fed).
    this.phase = phase;
    console.info(`[vyrse:voice] ${phase} @${Math.round(performance.now())}`);
    this.callbacks.onPhase(phase);
  }
}

/** Whisper's usual output for non-speech (breathing, keyboard, a cough). */
export function isNoise(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return !t || WHISPER_PHANTOMS.has(t) || isLooping(t);
}

/** Whisper's other hallucination signature: one short phrase repeated ("there we are, there we are, …") making up
 * most of the transcript. */
function isLooping(t: string): boolean {
  const words = t.split(" ");
  for (let n = 1; n <= 4; n++) {
    if (words.length < n * 3) break;
    const phrase = words.slice(0, n).join(" ");
    let repeats = 0;
    for (let i = 0; i + n <= words.length; i += n) {
      if (words.slice(i, i + n).join(" ") === phrase) repeats++;
      else break;
    }
    if (repeats >= 3 && (repeats * n) / words.length >= 0.7) return true;
    // Also catch a lead-in before the loop ("okay there we are there we are there we are").
    for (let start = 1; start <= 2 && start + n * 3 <= words.length; start++) {
      const p = words.slice(start, start + n).join(" ");
      let r = 0;
      for (let i = start; i + n <= words.length && words.slice(i, i + n).join(" ") === p; i += n) r++;
      if (r >= 3 && (r * n) / words.length >= 0.7) return true;
    }
  }
  return false;
}

/** Phrases Whisper produces from silence, breathing, keyboard noise or leaked playback. */
const WHISPER_PHANTOMS = new Set([
  "you", "thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
  "bye", "bye bye", "otherwise", "so", "uh", "um", "hmm", "mm", "oh", "ah", "i", "the", "a", "and",
  "please subscribe", "subtitles by the amaraorg community", "im sorry", "sorry",
]);

function wordCount(text: string): number {
  return text.toLowerCase().replace(/[^a-z' ]/g, " ").trim().split(" ").filter(Boolean).length;
}

/** Short commands that stop VYRSE even though they're one word. */
export function isStopWord(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z ]/g, "").trim();
  return ["stop", "cancel", "never mind", "nevermind", "wait", "hold on", "shut up", "quiet", "enough"].includes(t);
}

/** Most of the transcript's words are what VYRSE itself was just saying (its voice leaking into the mic). */
export function isEcho(text: string, spoken: string): boolean {
  const said = new Set(spoken.toLowerCase().replace(/[^a-z' ]/g, " ").split(" ").filter(Boolean));
  const words = text.toLowerCase().replace(/[^a-z' ]/g, " ").split(" ").filter(Boolean);
  if (!words.length || !said.size) return false;
  return words.filter((w) => said.has(w)).length / words.length >= 0.7;
}

/** Drop a leading echo of the wake word ("Wise. Open Chrome" -> "Open Chrome"). */
export function stripWakeEcho(text: string): string {
  return text.replace(WAKE_ECHO_RE, "").trim();
}

// "VYRSE" can also come out as "Why?", "vials" or "whilst" in recognition: those only count as the wake
// word when punctuation follows (so "why is the sky blue" keeps its "why").
const WAKE_ECHO_RE =
  /^\s*(?:hey\s+)?(?:(?:vyrse|vice|wice|wise|vyse|wyse|verse|otherwise)\b[\s.,!?:;-]*|(?:why|vials?|whilst|wha)[.,!?:;-]+\s*)/i;

/** In the follow-up window (no wake word), a lone word is usually an echo or noise, not a request. */
function isStrayWord(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z' ]/g, "").trim().split(/\s+/).filter(Boolean);
  return words.length < 2 && !["yes", "no", "yeah", "nope", "stop", "cancel", "sure", "thanks"].includes(words[0] ?? "");
}

const NAME_RE = /\bvyrse\b|\bwairz\b/i;

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError")
    return IS_PHONE
      ? "VYRSE can't use the microphone. Allow it in Android Settings → Apps → VYRSE → Permissions."
      : "Microphone access is blocked. Allow desktop apps to use the microphone in Windows privacy settings.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Check that one is connected.";
  return "The microphone couldn't be opened.";
}
