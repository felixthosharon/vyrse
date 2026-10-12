// VYRSE microphone worklet: runs on the audio thread, resamples the input to 16 kHz mono and
// posts 100 ms Float32 frames (1600 samples) to the main thread. Loaded from 'self' (CSP-safe).
class VyrseCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; // input samples per output sample
    this.pos = 0; // read position relative to the current block; may be in [-1, 0)
    this.prev = 0; // last sample of the previous block
    this.frame = new Float32Array(1600);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    // Linear interpolation between neighbouring input samples, continuous across blocks.
    while (this.pos < ch.length - 1) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const s0 = i0 < 0 ? this.prev : ch[i0];
      const s1 = ch[i0 + 1];
      this.frame[this.fill++] = s0 + (s1 - s0) * frac;
      if (this.fill === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(1600);
        this.fill = 0;
      }
      this.pos += this.step;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

registerProcessor("vyrse-capture", VyrseCaptureProcessor);
