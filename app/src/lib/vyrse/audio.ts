/**
 * Amplitude source for the presence renderer.
 *
 * Tries a real Web Audio analyser on the microphone; if permission is denied
 * or the API is unavailable it falls back to a synthetic speech-like signal so
 * the prototype stays fully explorable. Swap `createLevelSource` for a real
 * pipeline later — the rest of the app only reads `getLevel(): 0..1`.
 */

export interface LevelSource {
  start(): Promise<{ live: boolean }>;
  stop(): void;
  getLevel(): number;
  live: boolean;
}

export function createLevelSource(): LevelSource {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let stream: MediaStream | null = null;
  let data: Uint8Array | null = null;
  let running = false;
  let mockT = Math.random() * 100;
  let smoothed = 0;
  const src: LevelSource = {
    live: false,
    async start() {
      running = true;
      try {
        const AC: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        ctx = new AC();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        ctx.createMediaStreamSource(stream).connect(analyser);
        data = new Uint8Array(analyser.frequencyBinCount);
        src.live = true;
      } catch {
        src.live = false;
      }
      return { live: src.live };
    },
    stop() {
      running = false;
      smoothed = 0;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      analyser = null;
      void ctx?.close();
      ctx = null;
      src.live = false;
    },
    getLevel() {
      if (!running) {
        smoothed *= 0.9;
        return smoothed;
      }
      let raw: number;
      if (analyser && data) {
        analyser.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        raw = Math.min(1, Math.sqrt(sum / data.length) * 3.4);
      } else {
        // Synthetic speech envelope: syllabic bursts with pauses.
        mockT += 0.016;
        const syll = Math.max(0, Math.sin(mockT * 9.3) * 0.5 + 0.5) ** 2;
        const phrase = Math.max(0, Math.sin(mockT * 0.7 + 1.2) * 0.5 + 0.55);
        const grain = Math.abs(Math.sin(mockT * 31.7)) * 0.18;
        raw = Math.min(1, (syll * 0.75 + grain) * phrase);
      }
      smoothed += (raw - smoothed) * (raw > smoothed ? 0.55 : 0.12);
      return smoothed;
    },
  };
  return src;
}
