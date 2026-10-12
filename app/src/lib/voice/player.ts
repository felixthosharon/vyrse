/** Voice level while ducked (the user may be talking over VYRSE). */
const DUCK_LEVEL = 0.15;

/**
 * Gapless playback of streamed int16 PCM (Hermes speak-stream) with volume and instant stop.
 * Also reports a 0..1 output level so the presence orb can "speak".
 */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private drainListeners = new Set<() => void>();
  private volume = 1;
  private sinkId = "";
  private ducked = false;

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = this.ducked ? this.volume * DUCK_LEVEL : this.volume;
  }

  /**
   * Play VYRSE's voice on a specific output (e.g. an Echo paired over Bluetooth); "" or "default" = the
   * system default. Only VYRSE's audio moves; the rest of the PC keeps its output.
   */
  setOutput(deviceId: string): void {
    const next = deviceId === "default" ? "" : deviceId;
    if (next === this.sinkId) return;
    this.sinkId = next;
    if (this.context) void this.applySink(this.context);
  }

  private async applySink(context: AudioContext): Promise<void> {
    const ctx = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    try {
      await ctx.setSinkId?.(this.sinkId);
    } catch (err) {
      // The device went away (Echo disconnected): fall back to the default output.
      console.warn("[vyrse] voice output device unavailable, using the default:", err);
      if (this.sinkId) await ctx.setSinkId?.("").catch(() => {});
    }
  }

  /** Lower the voice while the user may be talking over it (after the chime), or restore it. */
  duck(on: boolean): void {
    if (this.ducked === on) return;
    this.ducked = on;
    if (!this.gain || !this.context) return;
    const now = this.context.currentTime;
    const param = this.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    // Let the wake chime play at full volume first.
    if (on) param.setTargetAtTime(this.volume * DUCK_LEVEL, now + 0.25, 0.08);
    else param.setTargetAtTime(this.volume, now, 0.12);
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Current output level (0..1). */
  level(): number {
    if (!this.analyser || this.sources.size === 0) return 0;
    // read every animation frame: reuse one buffer instead of allocating 60 a second
    const data = (this.levelBuf ??= new Uint8Array(this.analyser.fftSize));
    this.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
    return Math.min(1, peak * 1.6);
  }

  enqueue(pcm: Int16Array, sampleRate: number): void {
    const context = this.ensure();
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    const startAt = Math.max(context.currentTime + 0.03, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) for (const l of this.drainListeners) l();
    };
  }

  /** Fires each time all queued audio has finished playing. */
  onDrained(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // not started yet
      }
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  private listenSound: Promise<AudioBuffer | null> | null = null;

  async chime(): Promise<void> {
    // The acknowledgement when the wake word is heard: the reels' soft breath of air with a warm low under
    // it (sounds/listen.ogg); the old two-tone only if that file can't be loaded.
    const context = this.ensure();
    this.listenSound ??= fetch("sounds/listen.ogg")
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((data) => context.decodeAudioData(data))
      .catch(() => null);
    const buffer = await this.listenSound;
    if (buffer) {
      const source = context.createBufferSource();
      const env = context.createGain();
      env.gain.value = 0.55;
      source.buffer = buffer;
      source.connect(env).connect(this.gain!);
      source.start();
      return;
    }
    const now = context.currentTime;
    for (const [freq, at] of [[660, 0], [880, 0.09]] as const) {
      const osc = context.createOscillator();
      const env = context.createGain();
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, now + at);
      env.gain.linearRampToValueAtTime(0.12, now + at + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
      osc.connect(env).connect(this.gain!);
      osc.start(now + at);
      osc.stop(now + at + 0.2);
    }
  }

  /** Android allows audio to start only inside a tap: warm the output up on the first one. */
  unlockOnGesture(): void {
    const unlock = () => {
      const ctx = this.ensure();
      if (ctx.state === "running") window.removeEventListener("pointerdown", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
  }

  private ensure(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.gain.connect(this.analyser);
      this.gain.connect(this.context.destination);
      if (this.sinkId) void this.applySink(this.context);
    }
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }
}
