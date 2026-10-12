/**
 * On-device "VYRSE" wake word for the phone app: a TypeScript port of the plugin's numpy detector
 * (hermes-plugin/vyrse/wake/heed_numpy.py), which itself mirrors Heed's streaming detector. Same steps:
 * causal high-pass + mains notches, 1 s rolling window, energy / voice-band gate, peak normalisation,
 * log-mel with per-clip mean removed, the TinyWakeWordNet CNN, then N consecutive frames over the
 * threshold with a refractory period. Weights: app/public/wake/vyrse.json (scripts/export_wake_json.py).
 *
 * Runs on the phone, so the microphone never streams to the PC just to listen for the wake word.
 * Equivalence with the Python detector is checked by __tests__/heed.test.ts.
 */

const SR = 16000;
const HOP = 160;
const WIN = 400;
const N_FFT = 512;
const N_MELS = 40;
const BN_EPS = 1e-5;

interface Tensor {
  shape: number[];
  data: number[];
}
export interface WakeModel {
  meta: { phrase: string; threshold: number; n_sos: number };
  weights: Record<string, Tensor>;
  sos: number[][];
  zi: number[][];
}

/* ------------------------------------------------------------------ FFT */

/** In-place radix-2 FFT (n a power of two). */
function fft2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/* ------------------------------------------------------------- features */

const WINDOW = (() => {
  const w = new Float64Array(N_FFT);
  const off = (N_FFT - WIN) / 2;
  for (let i = 0; i < WIN; i++) w[off + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  return w;
})();

const FILTERBANK = (() => {
  const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const lo = hzToMel(0);
  const hi = hzToMel(SR / 2);
  const hz: number[] = [];
  for (let i = 0; i < N_MELS + 2; i++) hz.push(melToHz(Math.fround(lo + ((hi - lo) * i) / (N_MELS + 1))));
  const bins = N_FFT / 2 + 1;
  const fb: Float64Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const row = new Float64Array(bins);
    const [l, c, r] = [Math.fround(hz[m]!), Math.fround(hz[m + 1]!), Math.fround(hz[m + 2]!)];
    for (let b = 0; b < bins; b++) {
      const f = Math.fround(((SR / 2) * b) / (bins - 1));
      row[b] = Math.max(0, Math.min((f - l) / (c - l + 1e-9), (r - f) / (r - c + 1e-9)));
    }
    fb.push(row);
  }
  return fb;
})();

/** (T,) → [N_MELS][frames] log-mel with the per-clip mean removed (CMN). */
export function logMel(audio: Float32Array): Float64Array[] {
  const pad = N_FFT / 2;
  const n = audio.length;
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i++) padded[pad + i] = audio[i]!;
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = audio[i + 1]!; // numpy "reflect": the edge sample isn't repeated
    padded[pad + n + i] = audio[n - 2 - i]!;
  }
  const frames = Math.floor((padded.length - N_FFT) / HOP) + 1;
  const out = Array.from({ length: N_MELS }, () => new Float64Array(frames));
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(N_FFT / 2 + 1);
  for (let t = 0; t < frames; t++) {
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[t * HOP + i]! * WINDOW[i]!;
      im[i] = 0;
    }
    fft2(re, im);
    for (let b = 0; b <= N_FFT / 2; b++) power[b] = Math.fround(re[b]! * re[b]! + im[b]! * im[b]!);
    for (let m = 0; m < N_MELS; m++) {
      const row = FILTERBANK[m]!;
      let s = 0;
      for (let b = 0; b <= N_FFT / 2; b++) s += row[b]! * power[b]!;
      out[m]![t] = Math.log(Math.max(s, 1e-9));
    }
  }
  for (const row of out) {
    let mean = 0;
    for (let t = 0; t < frames; t++) mean += row[t]!;
    mean /= frames;
    for (let t = 0; t < frames; t++) row[t]! -= mean;
  }
  return out;
}

/**
 * Power spectrum of a non-power-of-two length via Bluestein's chirp-z (two radix-2 FFTs of 2^k ≥ 2n):
 * the 1 s gate window is 16000 samples. Only magnitudes are needed, so the output chirp is skipped.
 */
const chirps = new Map<number, { m: number; wr: Float64Array; wi: Float64Array; br: Float64Array; bi: Float64Array }>();
function chirp(n: number) {
  let c = chirps.get(n);
  if (!c) {
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;
    const wr = new Float64Array(n);
    const wi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const ang = (-Math.PI * ((k * k) % (2 * n))) / n;
      wr[k] = Math.cos(ang);
      wi[k] = Math.sin(ang);
    }
    const br = new Float64Array(m);
    const bi = new Float64Array(m);
    for (let k = 0; k < n; k++) {
      br[k] = wr[k]!;
      bi[k] = -wi[k]!;
      if (k) {
        br[m - k] = wr[k]!;
        bi[m - k] = -wi[k]!;
      }
    }
    fft2(br, bi);
    c = { m, wr, wi, br, bi };
    chirps.set(n, c);
  }
  return c;
}
function powerSpectrum(x: Float64Array): Float64Array {
  const n = x.length;
  const { m, wr, wi, br, bi } = chirp(n);
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = x[k]! * wr[k]!;
    ai[k] = x[k]! * wi[k]!;
  }
  fft2(ar, ai);
  for (let k = 0; k < m; k++) {
    const r = ar[k]! * br[k]! - ai[k]! * bi[k]!;
    // conjugate on the way in: the inverse FFT is a forward FFT of the conjugate
    ai[k] = -(ar[k]! * bi[k]! + ai[k]! * br[k]!);
    ar[k] = r;
  }
  fft2(ar, ai);
  const out = new Float64Array(Math.floor(n / 2) + 1);
  for (let k = 0; k < out.length; k++) out[k] = (ar[k]! * ar[k]! + ai[k]! * ai[k]!) / (m * m);
  return out;
}

/** Heed's gate: RMS above -55 dBFS and at least 15 % of the energy in 100–7000 Hz. */
export function gate(audio: Float32Array): boolean {
  const n = audio.length;
  if (n < 64) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += audio[i]! * audio[i]!;
  if (Math.sqrt(sum / n) < 10 ** (-55 / 20)) return false;
  const re = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = audio[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const power = powerSpectrum(re);
  let total = 0;
  let band = 0;
  for (let k = 0; k <= Math.floor(n / 2); k++) {
    const p = power[k]!;
    total += p;
    const f = (k * SR) / n;
    if (f >= 100 && f <= 7000) band += p;
  }
  return band / Math.max(total, 1e-12) >= 0.15;
}

/* ------------------------------------------------------------------ CNN */

type Mat = Float64Array[]; // [channels][time]

function conv1d(x: Mat, w: Tensor, stride: number, padding: number, groups: number): Mat {
  const [cOut, cInPer, k] = w.shape as [number, number, number];
  const t = x[0]!.length;
  const tOut = Math.floor((t + 2 * padding - k) / stride) + 1;
  const out: Mat = Array.from({ length: cOut }, () => new Float64Array(tOut));
  for (let o = 0; o < cOut; o++) {
    const row = out[o]!;
    const inputs = groups === 1 ? x.map((_, i) => i) : [o];
    for (let ci = 0; ci < inputs.length; ci++) {
      const xin = x[inputs[ci]!]!;
      const base = (o * cInPer + (groups === 1 ? ci : 0)) * k;
      for (let j = 0; j < tOut; j++) {
        let s = 0;
        const start = j * stride - padding;
        for (let q = 0; q < k; q++) {
          const idx = start + q;
          if (idx >= 0 && idx < t) s += xin[idx]! * w.data[base + q]!;
        }
        row[j]! += s;
      }
    }
  }
  return out;
}

function batchNorm(x: Mat, wts: Record<string, Tensor>, name: string, relu: boolean): Mat {
  const g = wts[`${name}.weight`]!.data;
  const b = wts[`${name}.bias`]!.data;
  const mean = wts[`${name}.running_mean`]!.data;
  const v = wts[`${name}.running_var`]!.data;
  return x.map((row, c) => {
    const scale = g[c]! / Math.sqrt(v[c]! + BN_EPS);
    const out = new Float64Array(row.length);
    for (let i = 0; i < row.length; i++) {
      const y = (row[i]! - mean[c]!) * scale + b[c]!;
      out[i] = relu ? Math.max(0, y) : y;
    }
    return out;
  });
}

export function logit(model: WakeModel, mel: Mat): number {
  const w = model.weights;
  let x = batchNorm(mel, w, "input_norm", false);
  x = batchNorm(conv1d(x, w["stem.0.weight"]!, 2, 2, 1), w, "stem.1", true);
  for (let i = 0; w[`blocks.${i}.depth.weight`]; i++) {
    const dw = w[`blocks.${i}.depth.weight`]!;
    x = conv1d(x, dw, i === 1 ? 2 : 1, Math.floor(dw.shape[2]! / 2), dw.shape[0]!);
    x = conv1d(x, w[`blocks.${i}.point.weight`]!, 1, 0, 1);
    x = batchNorm(x, w, `blocks.${i}.bn`, true);
  }
  const cls = w["classifier.weight"]!.data;
  let s = w["classifier.bias"]!.data[0]!;
  x.forEach((row, c) => {
    let m = 0;
    for (const v of row) m += v;
    s += (m / row.length) * cls[c]!;
  });
  return s;
}

/* ------------------------------------------------------------ streaming */

export class WakeDetector {
  readonly threshold: number;
  private readonly zi: Float64Array[];
  private primed = false;
  private buffer = new Float32Array(SR);
  private above = 0;
  private lastTrigger = -1e9;

  constructor(
    private readonly model: WakeModel,
    options: { threshold?: number; consecutive?: number; refractorySeconds?: number } = {},
  ) {
    this.threshold = options.threshold ?? model.meta.threshold;
    this.consecutive = options.consecutive ?? 2;
    this.refractory = options.refractorySeconds ?? 0.7;
    this.zi = model.zi.map((z) => new Float64Array(z.length));
  }
  private readonly consecutive: number;
  private readonly refractory: number;

  private highpass(chunk: Float32Array): Float32Array {
    let x = Float64Array.from(chunk);
    this.model.sos.forEach((sos, i) => {
      const z = this.zi[i]!;
      if (!this.primed) for (let j = 0; j < z.length; j++) z[j] = this.model.zi[i]![j]! * x[0]!;
      const y = new Float64Array(x.length);
      for (let s = 0; s < sos.length / 6; s++) {
        const [b0, b1, b2, , a1, a2] = sos.slice(s * 6, s * 6 + 6) as [number, number, number, number, number, number];
        let z0 = z[s * 2]!;
        let z1 = z[s * 2 + 1]!;
        for (let n = 0; n < x.length; n++) {
          const xn = x[n]!;
          const yn = b0 * xn + z0;
          z0 = b1 * xn - a1 * yn + z1;
          z1 = b2 * xn - a2 * yn;
          y[n] = yn;
        }
        z[s * 2] = z0;
        z[s * 2 + 1] = z1;
        x = Float64Array.from(y);
      }
    });
    this.primed = true;
    return Float32Array.from(x);
  }

  /** Feed one chunk (16 kHz mono float, normally 100 ms); returns the score and whether it fired. */
  step(chunk: Float32Array, now = performance.now() / 1000): { prob: number; triggered: boolean } {
    const filtered = this.highpass(chunk);
    const n = filtered.length;
    if (n >= SR) this.buffer = filtered.slice(n - SR);
    else {
      this.buffer.copyWithin(0, n);
      this.buffer.set(filtered, SR - n);
    }
    if (!gate(this.buffer)) {
      this.above = 0;
      return { prob: 0, triggered: false };
    }
    let peak = 0;
    for (const v of this.buffer) peak = Math.max(peak, Math.abs(v));
    const gain = peak >= 1e-6 ? 10 ** (-3 / 20) / Math.max(peak, 1e-9) : 1;
    const normalized = this.buffer.map((v) => Math.fround(v * gain));
    const prob = 1 / (1 + Math.exp(-logit(this.model, logMel(normalized))));
    this.above = prob > this.threshold ? this.above + 1 : 0;
    let triggered = false;
    if (this.above >= this.consecutive && now - this.lastTrigger > this.refractory) {
      triggered = true;
      this.lastTrigger = now;
      this.above = 0;
    }
    return { prob, triggered };
  }
}

let loaded: Promise<WakeModel> | null = null;
/** The wake-word model shipped with the app (fetched once). */
export function loadWakeModel(): Promise<WakeModel> {
  loaded ??= fetch(new URL("./wake/vyrse.json", document.baseURI).href).then((r) => {
    if (!r.ok) throw new Error(`wake model: HTTP ${r.status}`);
    return r.json() as Promise<WakeModel>;
  });
  return loaded;
}
