/**
 * Live captions: hears what's PLAYING on the PC (system audio loopback, never the mic), cuts it into phrases at
 * pauses, and hands each phrase to the vyrse plugin, which recognises it locally and translates it if needed.
 * Each line goes to the on-screen captions bar.
 */
export type CaptionLine = { text: string; original?: string; lang?: string };

const FRAME_S = 0.1; // the worklet posts 100 ms frames
const MIN_S = 1.6; // a phrase is at least this long…
const MAX_S = 7; // …and at most this long (whole sentences translate far better than fragments)
const PAUSE_FRAMES = 5; // 500 ms of quiet ends a phrase

export class LiveCaptions {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private frames: Float32Array[] = [];
  private quiet = 0;
  private queue: Promise<void> = Promise.resolve();
  private on = false;
  private pending = 0;
  private session = "";
  private target = "";
  private lastError = 0;

  constructor(
    private readonly transcribe: (pcm: Int16Array, to: string, session: string) => Promise<CaptionLine>,
    private readonly show: (line: CaptionLine) => void,
  ) {}

  get running(): boolean {
    return this.on;
  }

  /** the language the captions are shown in */
  get language(): string {
    return this.target;
  }

  async start(to: string): Promise<void> {
    this.stop();
    this.on = true;
    this.target = to;
    const session = (this.session = `cc-${Date.now()}`);
    // Electron answers this with the screen + the PC's sound (loopback); the picture isn't used.
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!this.on || this.session !== session) {
      // stopped (or restarted) while the capture was being set up
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!stream.getAudioTracks().length) {
      this.on = false;
      throw new Error("No PC audio to listen to.");
    }
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    await context.audioWorklet.addModule(new URL("./vyrse-capture-worklet.js", document.baseURI).href);
    const node = new AudioWorkletNode(context, "vyrse-capture");
    const mute = context.createGain();
    mute.gain.value = 0; // listen, don't play it twice
    context.createMediaStreamSource(stream).connect(node).connect(mute).connect(context.destination);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.frame(e.data, to);
    this.show({ text: "Listening…" });
  }

  stop(): void {
    this.on = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.frames = [];
    this.quiet = 0;
  }

  private frame(f: Float32Array, to: string): void {
    if (!this.on) return;
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
    const loud = Math.sqrt(sum / f.length) > 0.006;
    if (!loud && !this.frames.length) return; // waiting for sound
    this.frames.push(f);
    this.quiet = loud ? 0 : this.quiet + 1;
    const secs = this.frames.length * FRAME_S;
    if ((secs >= MIN_S && this.quiet >= PAUSE_FRAMES) || secs >= MAX_S) this.flush(to);
  }

  private flush(to: string): void {
    const frames = this.frames;
    this.frames = [];
    this.quiet = 0;
    const pcm = new Int16Array(frames.length * 1600);
    frames.forEach((f, k) => {
      for (let i = 0; i < f.length; i++) pcm[k * 1600 + i] = Math.max(-32768, Math.min(32767, Math.round(f[i]! * 32767)));
    });
    // in order, one at a time; a phrase that's waiting behind two others is dropped (captions must stay live)
    if (this.pending >= 2) return;
    this.pending++;
    this.queue = this.queue.then(async () => {
      this.pending--;
      if (!this.on) return;
      try {
        const line = await this.transcribe(pcm, to, this.session);
        if (this.on && line.text) this.show(line);
      } catch (err) {
        // say it (at most every 10 s) instead of showing nothing at all
        if (this.on && Date.now() - this.lastError > 10_000) {
          this.lastError = Date.now();
          this.show({ text: `Captions hit a problem: ${err instanceof Error ? err.message : String(err)}`.slice(0, 140) });
        }
      }
    });
  }
}
