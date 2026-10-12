/**
 * The single microphone owner: one getUserMedia stream feeding a worklet that yields 16 kHz
 * mono 100 ms frames. Echo cancellation stays on so VYRSE can listen while it speaks (barge-in);
 * noise suppression is off (it smears the wake word); automatic gain is a setting (default on).
 */
export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<(frame: Float32Array) => void>();
  /** 0..1 smoothed input level for the presence orb */
  level = 0;
  private floorDb = -60;
  private peakDb = -20;

  get running(): boolean {
    return this.context !== null;
  }

  onFrame(listener: (frame: Float32Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * `echoCancellation: false` on the phone: with it on, Android puts the whole app into call audio mode,
   * which sends VYRSE's voice to the earpiece at call volume while the mic is open.
   */
  async start(deviceId?: string, autoGain = true, echoCancellation = true): Promise<void> {
    if (this.context) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation,
        noiseSuppression: false,
        // Quiet mics (e.g. a headset through a game controller) need gain; the wake model is
        // level-normalised internally, so automatic gain doesn't hurt detection.
        autoGainControl: autoGain,
        ...(deviceId && deviceId !== "default" && deviceId !== "auto" ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    const context = new AudioContext();
    // Created after an await, so outside the tap's user gesture: Android's WebView then starts it
    // suspended, and a suspended context delivers no frames (no level, no speech).
    if (context.state === "suspended") await context.resume().catch(() => {});
    await context.audioWorklet.addModule(new URL("./vyrse-capture-worklet.js", document.baseURI).href);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "vyrse-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const frame = event.data;
      let peak = 0;
      for (let i = 0; i < frame.length; i += 4) peak = Math.max(peak, Math.abs(frame[i]!));
      // Self-calibrating level for the orb and the voice bars: measured against the room's noise floor
      // and recent speech peaks, so a quiet phone mic moves them as much as a hot PC headset does.
      const db = 20 * Math.log10(peak + 1e-6);
      this.floorDb = db < this.floorDb ? db : this.floorDb + 0.15;
      this.peakDb = db > this.peakDb ? db : this.peakDb - 0.25;
      const span = Math.max(18, this.peakDb - this.floorDb);
      const target = Math.max(0, Math.min(1, (db - this.floorDb - 4) / (span - 4)));
      this.level = this.level * 0.5 + target * 0.5;
      for (const listener of this.listeners) listener(frame);
    };
    source.connect(node);
    const track = stream.getAudioTracks()[0];
    console.info(
      `[vyrse:mic] open ${context.sampleRate} Hz, context ${context.state}, ${track?.label ?? "?"} ${JSON.stringify(track?.getSettings?.() ?? {})}`,
    );
    this.context = context;
    this.stream = stream;
    this.node = node;
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.context?.close().catch(() => {});
    this.context = null;
    this.stream = null;
    this.node = null;
    this.level = 0;
  }
}

/** 16 kHz mono float frames → 16-bit WAV blob for Hermes' transcription endpoint. */
export function encodeWav(frames: Float32Array[], sampleRate = 16000): Blob {
  const length = frames.reduce((n, f) => n + f.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++, offset += 2) view.setInt16(offset, Math.max(-1, Math.min(1, frame[i]!)) * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Bring a recording to a usable level for speech recognition (≤ +30 dB, peak at -3 dBFS). */
export function normalizeFrames(frames: Float32Array[]): Float32Array[] {
  let peak = 0;
  for (const f of frames) for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]!));
  if (peak <= 0) return frames;
  const gain = Math.min(31.6, 0.708 / peak);
  if (gain <= 1.05) return frames;
  return frames.map((f) => f.map((v) => v * gain));
}

export function toInt16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = Math.max(-1, Math.min(1, frame[i]!)) * 0x7fff;
  return out;
}
