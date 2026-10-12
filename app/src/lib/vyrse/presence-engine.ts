import type { PresenceState } from "./types";

/**
 * VYRSE presence renderer — orbital core.
 *
 * A framework-agnostic canvas renderer: a luminous, slowly rotating wireframe
 * sphere at the centre, surrounded by genuinely three-dimensional orbital rings
 * that revolve around it at different radii, inclinations, speeds and
 * directions, with nodes travelling along the orbital paths.
 *
 * Texture pass (2026-10): the sphere carries a lit dot-matrix surface (an even Fibonacci lattice
 * with a fixed noise "landmass", turning with the sphere), a thin atmosphere rim and an inner
 * nucleus; some rings are dotted data rings, the brightest get a soft near-side glow, comets of
 * light travel along several rings, and the larger nodes carry a halo. Everything is precomputed or
 * batched (dots are filled in 5 alpha buckets, not one call per dot).
 *
 * Architecture rules preserved from the previous engine:
 *  - Nothing is painted as a full-canvas rectangle; the canvas is cleared with
 *    clearRect and every glow is a radial gradient scaled from unit space, so
 *    no rectangular halo can appear in either theme.
 *  - No gradient, array or object is allocated inside the animation frame.
 *  - Render resolution is bucketed and decoupled from layout size, so resizing
 *    never reallocates per frame and never resets orbital phase.
 *  - Motion is time-based (seconds), so it is identical at any refresh rate.
 *  - Idle is never frozen; state and audio only modulate a living system.
 */

export interface PresenceParams {
  state: PresenceState;
  /** 0..1 live audio amplitude */
  level: number;
  intensity: number;
  reactivity: number;
  idleActivity: number;
  /** 0 = frozen, 1 = full motion */
  motion: number;
  /** 0..1 entrance progress */
  boot: number;
  /** page background rgb — kept for API compatibility */
  bg: [number, number, number];
  contrast: number;
  /** 0..1 how much geometry to render */
  detail: number;
  theme: "dark" | "light";
  /** 0..1 pointer proximity */
  attention: number;
  /** phone: lower buffer resolution, less geometry, at most ~60 frames a second */
  lite?: boolean;
  /** skip drawing (the presence is covered, e.g. by a full-screen panel, or the app is in the background) */
  paused?: boolean;
  /** device pixel ratio, when the engine runs in a worker (no window there) */
  dpr?: number;
}

export interface PresenceHandle {
  params: PresenceParams;
  /** Report the element's CSS box. Cheap: only changes the render buffer when a
   *  quantised resolution bucket is crossed, never per animation frame. */
  setSize: (cssW: number, cssH: number) => void;
  /** Back-compat alias — re-measures from the DOM. */
  resize: () => void;
  destroy: () => void;
}

type RGB = [number, number, number];

interface Palette {
  primary: RGB;
  secondary: RGB;
  highlight: RGB;
  /** specular light on glass (rim crescent, ring shine, the bright heart): white-ish in both themes */
  spec: RGB;
  warm: RGB;
  alert: RGB;
  /** vivid attentive cyan (listening) */
  vivid: RGB;
  /** restrained success accent */
  verdant: RGB;
  /** warm city lights on the globe's night side */
  ember: RGB;
  /** global stroke alpha multiplier */
  alpha: number;
  /** 'lighter' on dark, 'source-over' on light */
  blend: GlobalCompositeOperation;
  coreAlpha: number;
  /** extra circular atmosphere behind the field (0 = none) */
  atmosphere: number;
  /** stroke weight multiplier */
  weight: number;
  /** how much the far side of an orbit fades (0..1) */
  depthFade: number;
  /** multiplier for the sphere's interior wireframe — light needs far more */
  wire: number;
  /** multiplier for the sphere body fill */
  body: number;
}

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    primary: [116, 218, 236],
    secondary: [92, 146, 240],
    highlight: [234, 245, 255],
    spec: [234, 245, 255],
    warm: [154, 132, 240],
    alert: [232, 138, 120],
    vivid: [86, 214, 255],
    verdant: [126, 236, 206],
    ember: [255, 196, 128],
    alpha: 1,
    blend: "lighter",
    coreAlpha: 0.36,
    atmosphere: 0,
    weight: 0.85,
    depthFade: 0.62,
    wire: 1,
    body: 1,
  },
  /**
   * Light is its own interpretation of the same identity: glacier cyan, cool
   * blue and a restrained violet, saturated and weighted enough to hold
   * contrast against a bright stone background. Never an inverted dark theme.
   */
  light: {
    // Daylight glass: the orb is lit from inside like coloured glass in sunlight (luminous cyan, blue and
    // violet with white specular light), not drawn on the page in ink.
    primary: [0, 146, 190],
    secondary: [72, 104, 224],
    highlight: [40, 92, 140],
    spec: [255, 255, 255],
    warm: [138, 98, 232],
    alert: [196, 72, 56],
    vivid: [0, 140, 210],
    verdant: [0, 150, 130],
    ember: [232, 128, 40],
    alpha: 1.45,
    blend: "source-over",
    coreAlpha: 0.62,
    atmosphere: 1,
    weight: 1,
    depthFade: 0.7,
    wire: 1.15,
    body: 1.75,
  },
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp01(a)})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/* ------------------------------------------------------------------ noise */

const PERM = new Uint8Array(512);
(() => {
  let seed = 1337;
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!;
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const grad = (h: number, x: number, y: number) => {
  const u = (h & 1) === 0 ? x : -x;
  const v = (h & 2) === 0 ? y : -y;
  return u + v;
};

/** 2D value/perlin-ish noise, ~-1..1 */
function noise2(x: number, y: number) {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = PERM[PERM[xi]! + yi]!;
  const ab = PERM[PERM[xi]! + yi + 1]!;
  const ba = PERM[PERM[xi + 1]! + yi]!;
  const bb = PERM[PERM[xi + 1]! + yi + 1]!;
  const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
  const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

/* ------------------------------------------------------------- structures */

const MAX_STEPS = 128;
/** segments per stroked chunk — depth sorting granularity vs. stroke count */
const CHUNK = 8;

interface Orbit {
  /** 0..1 radius in field units */
  r: number;
  /** slight ellipticity of the orbit itself */
  ecc: number;
  /** local spin of the ring along its own circumference (turns/sec, signed) */
  rate: number;
  phase: number;
  /* --- orbital-plane revolution ------------------------------------------
   * The plane itself is not static. Its inclination sweeps through a full
   * quarter-turn (horizontal -> diagonal -> vertical -> diagonal -> horizontal)
   * while its ascending node revolves around the vertical axis, so the entire
   * orbital plane physically revolves around the core.                     */
  /** centre of the inclination sweep, rad */
  incBase: number;
  /** amplitude of the inclination sweep, rad (large: up to ~pi/2) */
  incSweep: number;
  /** inclination sweep rate, rad/s (signed) */
  incRate: number;
  /** phase offset of the sweep */
  incPhase: number;
  /** node revolution around the vertical axis, rad/s (signed = direction) */
  nodeRate: number;
  node: number;
  /** in-screen-plane rotation, so orbits read as diagonals, not stacked bands */
  tiltZ: number;
  /** slow drift of the screen-plane tilt, rad/s */
  tiltRate: number;
  /** small secondary wobble of the plane — controlled chaos */
  nod: number;
  nodRate: number;
  weight: number;
  opacity: number;
  tone: number;
  /** organic deformation */
  freq: number;
  amp: number;
  /** travelling nodes on this orbit */
  particles: { at: number; drift: number; size: number; tone: number }[];
  /** scratch projected geometry: x, y, z per sample */
  buf: Float32Array;
}

function build(count: number) {
  let s = 20260815;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const orbits: Orbit[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const dir = rnd() > 0.45 ? 1 : -1;
    const pc = 2 + Math.floor(rnd() * 7);
    const particles: Orbit["particles"] = [];
    for (let k = 0; k < pc; k++) {
      particles.push({
        at: rnd(),
        drift: (0.6 + rnd() * 0.9) * (rnd() > 0.2 ? 1 : -1),
        size: 0.9 + rnd() * 1.8,
        tone: rnd(),
      });
    }
    orbits.push({
      r: 0.4 + t * 0.58 + (rnd() - 0.5) * 0.05,
      ecc: 0.88 + rnd() * 0.14,
      rate: (0.05 + rnd() * 0.16) * dir,
      phase: rnd() * Math.PI * 2,
      // The sweep is centred so the plane genuinely passes through horizontal
      // and near-vertical each cycle, at a period between ~14s and ~46s.
      incBase: (rnd() - 0.5) * 0.5,
      incSweep: 1.05 + rnd() * 0.62,
      incRate: (0.135 + rnd() * 0.31) * (rnd() > 0.5 ? 1 : -1),
      incPhase: rnd() * Math.PI * 2,
      // Node revolution: the whole tilted plane swings around the core.
      nodeRate: (0.09 + rnd() * 0.3) * (rnd() > 0.48 ? 1 : -1),
      node: rnd() * Math.PI * 2,
      tiltZ: (rnd() - 0.5) * 2.4,
      tiltRate: (0.015 + rnd() * 0.075) * (rnd() > 0.5 ? 1 : -1),
      nod: 0.06 + rnd() * 0.16,
      nodRate: 0.19 + rnd() * 0.63,
      weight: 0.45 + rnd() * 1.25,
      opacity: 0.45 + rnd() * 0.75,
      tone: rnd(),
      freq: 2 + Math.floor(rnd() * 4),
      amp: 0.002 + rnd() * 0.007,
      particles,
      buf: new Float32Array((MAX_STEPS + 1) * 3),
    });
  }

  /* Surface lattice: an even Fibonacci sphere with a fixed, seam-free "landmass" value per point
   * (2D noise sampled on 3D coordinates), so the globe reads as a textured world, not a ball. */
  const SURFACE = 900;
  const surface = new Float32Array(SURFACE * 3);
  const land = new Float32Array(SURFACE);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SURFACE; i++) {
    const y = 1 - (i / (SURFACE - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = golden * i;
    const x = Math.cos(th) * rad;
    const z = Math.sin(th) * rad;
    surface[i * 3] = x;
    surface[i * 3 + 1] = y;
    surface[i * 3 + 2] = z;
    const n =
      noise2(x * 1.9 + 11, y * 1.9 + z * 0.7) * 0.6 +
      noise2(z * 3.7 - 5, x * 3.1 + y * 1.3) * 0.3 +
      noise2(y * 7.3 + 2, z * 6.1 - x * 2.2) * 0.1;
    land[i] = clamp01(0.5 + n * 1.25);
  }

  /** free-floating dust that is not bound to an orbit */
  const dust: { r: number; a: number; b: number; rate: number; size: number; tone: number }[] = [];
  for (let i = 0; i < 90; i++) {
    dust.push({
      r: 0.36 + Math.pow(rnd(), 0.7) * 0.66,
      a: rnd() * Math.PI * 2,
      b: (rnd() - 0.5) * 1.6,
      rate: (0.01 + rnd() * 0.05) * (rnd() > 0.4 ? 1 : -1),
      size: 0.5 + rnd() * 1.3,
      tone: rnd(),
    });
  }

  return { orbits, dust, surface, land };
}

/* ---------------------------------------------------------------- profile */

interface Profile {
  spin: number;
  turbulence: number;
  expansion: number;
  energy: number;
  warmth: number;
  alertness: number;
  /** attentive cyan shift */
  vivid: number;
  /** success accent */
  verdant: number;
}

function profileFor(state: PresenceState): Profile {
  /**
   * State is expressed through colour, orbital speed, complexity and energy —
   * never through scaling the presence. `expansion` stays within ±2%.
   */
  switch (state) {
    case "listening":
      return {
        spin: 1.3,
        turbulence: 1.2,
        expansion: 1.01,
        energy: 1.32,
        warmth: 0,
        alertness: 0,
        vivid: 1,
        verdant: 0,
      };
    case "thinking":
      return {
        spin: 1.95,
        turbulence: 1.05,
        expansion: 1,
        energy: 1.22,
        warmth: 0.92,
        alertness: 0,
        vivid: 0.1,
        verdant: 0,
      };
    case "working":
      return {
        spin: 2.2,
        turbulence: 0.55,
        expansion: 1,
        energy: 1.25,
        warmth: 0.55,
        alertness: 0,
        vivid: 0.35,
        verdant: 0,
      };
    case "speaking":
      return {
        spin: 1.12,
        turbulence: 1.1,
        expansion: 1.01,
        energy: 1.45,
        warmth: 0.34,
        alertness: 0,
        vivid: 0.7,
        verdant: 0,
      };
    case "success":
      return {
        spin: 0.85,
        turbulence: 0.8,
        expansion: 1.01,
        energy: 1.2,
        warmth: 0,
        alertness: 0,
        vivid: 0.3,
        verdant: 0.75,
      };
    case "error":
      return {
        spin: 0.55,
        turbulence: 1.4,
        expansion: 0.99,
        energy: 0.9,
        warmth: 0,
        alertness: 1,
        vivid: 0,
        verdant: 0,
      };
    default:
      return {
        spin: 1,
        turbulence: 1,
        expansion: 1,
        energy: 1,
        warmth: 0,
        alertness: 0,
        vivid: 0,
        verdant: 0,
      };
  }
}

/* ----------------------------------------------------------------- engine */

/** Draws on a page canvas, or on an OffscreenCanvas inside a worker (the phone app renders it off the UI thread). */
export function createPresence(canvas: HTMLCanvasElement | OffscreenCanvas, initial: PresenceParams): PresenceHandle {
  const params: PresenceParams = { ...initial };
  // The two 2D contexts share the drawing API used here.
  const ctx = canvas.getContext("2d", { alpha: true }) as CanvasRenderingContext2D | null;
  const { orbits, dust, surface, land } = build(initial.lite ? 9 : 11);
  const SURFACE_N = land.length;
  /** per-frame scratch for the surface pass: projected x, y, radius and alpha bucket per dot */
  const dotX = new Float32Array(SURFACE_N);
  const dotY = new Float32Array(SURFACE_N);
  const dotR = new Float32Array(SURFACE_N);
  const dotB = new Int8Array(SURFACE_N);
  const DOT_BUCKETS = 5;
  // Night-side city lights: a fixed sparse subset of land points, gathered per frame.
  const CITY_MAX = 260;
  const cityX = new Float32Array(CITY_MAX);
  const cityY = new Float32Array(CITY_MAX);
  const cityR = new Float32Array(CITY_MAX);
  const cityA = new Float32Array(CITY_MAX);
  const citySeed = new Float32Array(SURFACE_N);
  for (let i = 0; i < SURFACE_N; i++) citySeed[i] = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  /** dotted "data" rings and rings that carry a comet of light */
  const dotted = (i: number) => i % 4 === 1;
  const hasComet = (i: number) => i % 3 === 0;
  /** optional cost meter: set window.__presenceProfile = true to collect ms/frame */
  const meter = (globalThis as unknown as { __presenceProfile?: boolean; __presenceCost?: number[] });

  let raf = 0;
  let w = 0;
  let h = 0;
  let cx = 0;
  let cy = 0;
  let dpr = 1;
  let destroyed = false;
  const hasDocument = typeof document !== "undefined";
  let hidden = hasDocument && document.visibilityState === "hidden";

  // smoothed drivers — continuous across every React render, resize and state
  let time = 0;
  let level = 0;
  let pulse = 0;
  let spin = 1;
  let turb = 1;
  let expand = 1;
  let energy = 1;
  let warmth = 0;
  let alert = 0;
  let vivid = 0;
  let verdant = 0;
  /** accumulated orbital revolution phase (turns); never reset */
  let phase = 0;
  /** orbital clock in seconds of subjective time; drives plane revolution */
  let orbT = 0;
  /** sphere's own rotation, independent of the orbits */
  let sphereSpin = 0;

  /** perspective: camera distance in field-radius units */
  const FOCAL = 3.4;

  /**
   * Render-buffer sizing is deliberately decoupled from layout sizing. The
   * bitmap is stretched to the (square) element by CSS, so the field scales
   * visually with the layout at zero cost; the bitmap is only reallocated when
   * a quantised bucket is crossed. Growth is immediate, shrinking waits for the
   * layout to settle. Animation state is untouched by a reallocation.
   */
  const STEP = 128;
  const MIN_BUFFER = 256;
  const MAX_BUFFER = 2048;
  let bucket = 0;
  let shrinkTimer: ReturnType<typeof setTimeout> | undefined;

  const applyBucket = (next: number) => {
    if (next === bucket) return;
    bucket = next;
    canvas.width = bucket;
    canvas.height = bucket;
    w = bucket / dpr;
    h = w;
    cx = w / 2;
    cy = h / 2;
    radialCache.clear();
  };

  /* -------------------------------------------------------- gradient cache */
  const radialCache = new Map<string, CanvasGradient>();
  const qc = (c: RGB) => `${Math.round(c[0] / 8)},${Math.round(c[1] / 8)},${Math.round(c[2] / 8)}`;

  /** Unit-space radial gradient (centre 0,0 radius 1), scaled by the transform. */
  const unitRadial = (kind: string, c: RGB, stops: [number, number][], inner = 0) => {
    const key = `${kind}|${qc(c)}`;
    let g = radialCache.get(key);
    if (!g) {
      g = ctx!.createRadialGradient(0, 0, inner, 0, 0, 1);
      for (const [at, a] of stops) g.addColorStop(at, rgba(c, a));
      radialCache.set(key, g);
    }
    return g;
  };

  const setSize = (cssW: number, cssH: number) => {
    dpr = Math.min(params.lite ? 1.5 : 2, params.dpr ?? (globalThis.devicePixelRatio || 1));
    const side = Math.max(1, Math.max(cssW, cssH)) * dpr;
    const target = Math.max(MIN_BUFFER, Math.min(MAX_BUFFER, Math.ceil(side / STEP) * STEP));
    if (shrinkTimer) {
      clearTimeout(shrinkTimer);
      shrinkTimer = undefined;
    }
    if (target > bucket) applyBucket(target);
    else if (target < bucket) shrinkTimer = setTimeout(() => applyBucket(target), 260);
  };

  const resize = () => {
    if (!("getBoundingClientRect" in canvas)) return; // a worker gets its size from setSize
    const rect = canvas.getBoundingClientRect();
    setSize(rect.width, rect.height);
  };
  resize();

  const onVisibility = () => {
    hidden = document.visibilityState === "hidden";
  };
  if (hasDocument) document.addEventListener("visibilitychange", onVisibility);

  let last = performance.now();

  /* --------------------------------------------------------- frame locals */
  // Preallocated so the loop allocates nothing.
  const U: [number, number, number] = [0, 0, 0];
  const V: [number, number, number] = [0, 0, 0];
  const AX: [number, number, number] = [0, 0, 0];
  const E1: [number, number, number] = [0, 0, 0];
  const E2: [number, number, number] = [0, 0, 0];

  /**
   * Orthonormal basis (U, V) of an orbital plane, built from real orbital
   * geometry rather than a screen-space rotation.
   *
   *   start:  a horizontal ring in the XZ plane      (U = x, V = z)
   *   inc:    rotate about X — horizontal -> vertical
   *   node:   rotate about Y — the whole tilted plane revolves around the core
   *   tilt:   rotate about Z — screen-plane orientation of the revolution axis
   *
   * Because `inc` sweeps and `node` advances continuously and independently,
   * the plane is never merely spinning in place: it revolves.
   */
  const basis = (inc: number, node: number, tilt: number) => {
    const ci = Math.cos(inc);
    const si = Math.sin(inc);
    // U0 = (1,0,0), V0 = (0,0,1) rotated about X by inc
    let ux = 1,
      uy = 0,
      uz = 0;
    let vx = 0,
      vy = -si,
      vz = ci;
    // rotate about Y by the ascending node
    const cn = Math.cos(node);
    const sn = Math.sin(node);
    let t = ux * cn + uz * sn;
    uz = -ux * sn + uz * cn;
    ux = t;
    t = vx * cn + vz * sn;
    vz = -vx * sn + vz * cn;
    vx = t;
    // rotate about Z (screen plane)
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    t = ux * ct - uy * st;
    uy = ux * st + uy * ct;
    ux = t;
    t = vx * ct - vy * st;
    vy = vx * st + vy * ct;
    vx = t;
    U[0] = ux;
    U[1] = uy;
    U[2] = uz;
    V[0] = vx;
    V[1] = vy;
    V[2] = vz;
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (destroyed || !ctx) return;
    // Phones often refresh at 90-120 Hz; the presence doesn't need more than ~60 there.
    if (params.lite && now - last < 15) return;
    const dtRaw = (now - last) / 1000;
    last = now;
    if (hidden || params.paused) return;
    const dt = Math.min(0.05, Math.max(0.001, dtRaw));
    const t0 = meter.__presenceProfile ? performance.now() : 0;

    const motion = clamp01(params.motion);
    const pal = PALETTES[params.theme];
    const p = profileFor(params.state);
    const react = params.reactivity;

    // Smooth every driver so a state change never snaps.
    const k = 1 - Math.pow(0.001, dt);
    const targetLevel =
      params.state === "listening"
        ? clamp01(params.level) * react
        : params.state === "speaking"
          ? clamp01(params.level) > 0.01
            ? clamp01(params.level) * react
            : 0.32 + Math.sin(now / 210) * 0.13 + Math.sin(now / 97) * 0.07
          : 0;
    // asymmetric attack/release — reacts quickly, releases gently
    level += (targetLevel - level) * (targetLevel > level ? k * 2.4 : k * 0.7);
    spin += (p.spin - spin) * k;
    turb += (p.turbulence - turb) * k;
    expand += (p.expansion - expand) * k;
    energy += (p.energy - energy) * k;
    warmth += (p.warmth - warmth) * k;
    alert += (p.alertness - alert) * k;
    vivid += (p.vivid - vivid) * k;
    verdant += (p.verdant - verdant) * k;

    const idle = params.idleActivity;
    time += dt * motion * (0.22 + idle * 0.16);
    phase += dt * motion * spin * (0.5 + idle * 0.5);
    sphereSpin += dt * motion * (0.055 + idle * 0.05) * (0.8 + spin * 0.35);

    const breath = Math.sin(time * 1.35) * 0.013 + Math.sin(time * 0.61) * 0.007;
    pulse += (level - pulse) * (level > pulse ? k * 3 : k * 1.1);
    const drive = Math.min(1.3, Math.pow(pulse, 0.8) * (1 + react * 0.3) * motion);

    // Orbital-plane revolution clock. Heavily smoothed audio only nudges the
    // rate — it never scales geometry, so voice reads as energy, not bounce.
    orbT += dt * motion * (0.55 + idle * 0.45) * spin * (1 + drive * 0.22);

    const boot = clamp01(params.boot);
    const attention = clamp01(params.attention);
    const intensity = params.intensity * params.contrast;
    const detail = Math.max(0.3, Math.min(1, params.detail) * (params.lite ? 0.6 : 1));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // The field never touches the element edge — glow stays inside.
    const R = Math.min(w, h) * 0.45;
    // Size is identity: only a breath and a whisper of audio ever touch it.
    const scale =
      (0.9 + boot * 0.1) *
      (expand + breath + drive * 0.014 + attention * 0.008) *
      (0.97 + boot * 0.03);

    // Colour is the primary carrier of state.
    const base = mix(pal.primary, pal.secondary, 0.35 - vivid * 0.22);
    const attentive = mix(base, pal.vivid, vivid * 0.62);
    const hot = mix(attentive, pal.warm, warmth * 0.82);
    const good = verdant > 0.02 ? mix(hot, pal.verdant, verdant * 0.6) : hot;
    const field = alert > 0.02 ? mix(good, pal.alert, alert * 0.8) : good;

    const prevBlend = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = pal.blend;

    const A = boot * intensity * pal.alpha;
    const steps = Math.max(48, Math.round(MAX_STEPS * (0.55 + detail * 0.45)) & ~1);
    const sphereR = R * 0.33 * scale * (1 + drive * 0.012);

    /* ------------------------------------------- ambient glow (circular) */
    const ga = pal.coreAlpha * boot * (0.5 + energy * 0.3) * intensity;
    if (pal.atmosphere > 0) {
      // stays inside the canvas: a glow cut off by the canvas edge shows as a faint rectangle on light
      const atmR = R * (0.98 + drive * 0.06);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(atmR, atmR);
      ctx.fillStyle = unitRadial("atm", field, [
        [0, 0.3],
        [0.45, 0.2],
        [0.75, 0.08],
        [1, 0],
      ]);
      ctx.globalAlpha = clamp01(pal.atmosphere * ga * (0.8 + drive * 0.4));
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const glowR = R * (0.86 + drive * 0.2);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(glowR, glowR);
    ctx.fillStyle = unitRadial(
      "glow",
      field,
      [
        [0, 0.2],
        [0.3, 0.16],
        [0.55, 0.1],
        [0.8, 0.04],
        [1, 0],
      ],
      0.02,
    );
    ctx.globalAlpha = clamp01(ga * (1 + drive * 0.3));
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    /* -------------------------------------------------- orbital geometry */
    // Compute projected geometry once per orbit, then paint it in two depth
    // passes so the sphere occludes the far side of every orbit correctly.
    for (let i = 0; i < orbits.length; i++) {
      const o = orbits[i]!;
      /* --- true orbital-plane revolution ---------------------------------
       * inc sweeps the plane horizontal -> diagonal -> vertical -> diagonal
       * -> horizontal, while node carries that tilted plane all the way
       * around the core. Both are per-ring in rate, direction and phase, so
       * no two rings are ever synchronised.                                */
      const inc =
        o.incBase +
        o.incSweep * Math.sin(orbT * o.incRate + o.incPhase) +
        // controlled irregularity: a small second harmonic, never noise
        o.nod * 0.5 * Math.sin(orbT * o.nodRate * 1.7 + i) * (0.6 + turb * 0.5);
      const node =
        o.node + orbT * o.nodeRate + o.nod * Math.sin(orbT * o.nodRate + i * 1.7) * turb;
      const tilt = o.tiltZ + orbT * o.tiltRate + Math.sin(orbT * 0.11 + i) * 0.06;
      basis(inc, node, tilt);
      const rr = R * o.r * scale * (1 + drive * 0.012 * (0.35 + o.r));
      // the ring's own rotation along its circumference, independent of the
      // revolution of its plane
      const spinA = o.phase + orbT * o.rate * 6.283;
      const wob = o.amp * (0.6 + turb * 0.7) * (1 + drive * 1.6);
      const buf = o.buf;
      for (let s = 0; s <= steps; s++) {
        const a = (s / steps) * Math.PI * 2 + spinA;
        const n = noise2(Math.cos(a) * o.freq + time * 0.4, Math.sin(a) * o.freq + i * 3.1);
        const rad = rr * (1 + n * wob);
        const ca = Math.cos(a) * rad;
        const sa = Math.sin(a) * rad * o.ecc;
        const x = U[0] * ca + V[0] * sa;
        const y = U[1] * ca + V[1] * sa;
        const z = U[2] * ca + V[2] * sa;
        const zr = z / R;
        const persp = FOCAL / (FOCAL - zr);
        const j = s * 3;
        buf[j] = cx + x * persp;
        buf[j + 1] = cy + y * persp;
        buf[j + 2] = zr;
      }
    }

    const paintOrbits = (front: boolean) => {
      ctx.lineCap = "round";
      for (let i = 0; i < orbits.length; i++) {
        const o = orbits[i]!;
        const buf = o.buf;
        const tone = mix(
          field,
          o.tone > 0.72 ? (params.theme === "light" ? pal.secondary : pal.highlight) : o.tone > 0.42 ? pal.warm : pal.primary,
          0.35 + o.tone * 0.5,
        );
        const stroke = rgba(tone, 1);
        const baseA =
          A * o.opacity * (1.0 + energy * 0.7) * (1 + drive * 0.45) * (0.8 + attention * 0.15);
        const isDotted = dotted(i);
        // Solid rings are glass tubes: a soft body (additive/dark theme only: on light it reads as blur),
        // the core line, and a thin specular line offset toward the key light (upper left).
        const tube = !isDotted && detail > 0.45;
        const glows = tube && pal.blend === "lighter";
        const shine = rgba(mix(tone, pal.spec, 0.7), 1);
        if (isDotted) {
          // data ring: fine evenly spaced dashes; the offset makes them flow along the ring
          ctx.setLineDash([0.9 * pal.weight, 5 * pal.weight]);
          ctx.lineDashOffset = -orbT * 9 * Math.sign(o.rate);
        }
        for (let c0 = 0; c0 < steps; c0 += CHUNK) {
          const c1 = Math.min(steps, c0 + CHUNK);
          const zm = (buf[c0 * 3 + 2]! + buf[c1 * 3 + 2]!) * 0.5;
          if (zm >= 0 !== front) continue;
          // depth: the far side dims and thins, the near side reads crisply
          const d = (zm + 1) * 0.5;
          const depth = 1 - pal.depthFade * (1 - d);
          ctx.beginPath();
          ctx.moveTo(buf[c0 * 3]!, buf[c0 * 3 + 1]!);
          for (let s = c0 + 1; s <= c1; s++) ctx.lineTo(buf[s * 3]!, buf[s * 3 + 1]!);
          ctx.strokeStyle = stroke;
          if (glows) {
            ctx.globalAlpha = clamp01(baseA * depth * (front ? 0.11 : 0.06));
            ctx.lineWidth = o.weight * pal.weight * depth * 3.6;
            ctx.stroke();
          }
          ctx.globalAlpha = clamp01(baseA * depth * (front ? 1.15 : 0.85) * (isDotted ? 1.1 : 1));
          ctx.lineWidth = o.weight * pal.weight * depth * (1 + drive * 0.3) * (isDotted ? 0.9 : 1);
          ctx.stroke();
          if (tube) {
            const off = 0.42 * depth * pal.weight;
            ctx.beginPath();
            ctx.moveTo(buf[c0 * 3]! - off, buf[c0 * 3 + 1]! - off);
            for (let s = c0 + 1; s <= c1; s++) ctx.lineTo(buf[s * 3]! - off, buf[s * 3 + 1]! - off);
            ctx.strokeStyle = shine;
            ctx.globalAlpha = clamp01(baseA * depth * (front ? 0.55 : 0.22));
            ctx.lineWidth = Math.max(0.4, o.weight * pal.weight * depth * 0.28);
            ctx.stroke();
          }
        }
        if (isDotted) ctx.setLineDash([]);

        // Comet: a brighter streak of light running along the ring, with a fading tail.
        if (hasComet(i)) {
          let head = o.phase * 0.159 + orbT * (0.07 + Math.abs(o.rate) * 0.6) * Math.sign(o.rate || 1);
          head -= Math.floor(head);
          const hs = Math.floor(head * steps);
          const tail = Math.max(10, Math.round(steps * 0.22));
          const dir = o.rate >= 0 ? -1 : 1; // the tail trails behind the direction of travel
          const SEGS = 8;
          for (let g = 0; g < SEGS; g++) {
            const from = hs + dir * Math.round((tail * g) / SEGS);
            const to = hs + dir * Math.round((tail * (g + 1)) / SEGS);
            const mid = ((Math.round((from + to) / 2) % steps) + steps) % steps;
            const zc = buf[mid * 3 + 2]!;
            if (zc >= 0 !== front) continue;
            const depth = 1 - pal.depthFade * (1 - (zc + 1) * 0.5);
            ctx.beginPath();
            for (let s = from, n = 0; dir < 0 ? s >= to : s <= to; s += dir, n++) {
              const si = ((s % steps) + steps) % steps;
              if (n === 0) ctx.moveTo(buf[si * 3]!, buf[si * 3 + 1]!);
              else ctx.lineTo(buf[si * 3]!, buf[si * 3 + 1]!);
            }
            ctx.strokeStyle = rgba(mix(tone, params.theme === "light" ? pal.vivid : pal.highlight, 0.55), 1);
            const fade = Math.pow(1 - g / SEGS, 1.7);
            ctx.globalAlpha = clamp01(baseA * depth * 1.7 * fade * (0.8 + drive * 0.6));
            ctx.lineWidth = o.weight * pal.weight * depth * (1.8 - (g / SEGS) * 1.3);
            ctx.stroke();
          }
          // The head: a small bright glow (dark theme; additive light).
          const hz = buf[hs * 3 + 2]!;
          if (hz >= 0 === front && pal.blend === "lighter") {
            const hd = 1 - pal.depthFade * (1 - (hz + 1) * 0.5);
            const hr = o.weight * pal.weight * 4.5 * hd * (1 + drive * 0.4);
            ctx.save();
            ctx.translate(buf[hs * 3]!, buf[hs * 3 + 1]!);
            ctx.scale(hr, hr);
            ctx.fillStyle = unitRadial("comet", mix(tone, pal.highlight, 0.7), [
              [0, 0.9],
              [0.35, 0.25],
              [1, 0],
            ]);
            ctx.globalAlpha = clamp01(baseA * hd * (0.8 + drive * 0.5));
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }

        // Travelling nodes ride the orbit itself, so they always sit on the path.
        for (let q = 0; q < o.particles.length; q++) {
          const pt = o.particles[q]!;
          // Nodes travel along the circumference; voice accelerates the
          // travel rather than displacing the geometry.
          let u = pt.at + orbT * o.rate * pt.drift * (0.55 + drive * 0.5);
          u -= Math.floor(u);
          const s = Math.min(steps - 1, Math.floor(u * steps));
          const z = buf[s * 3 + 2]!;
          if (z >= 0 !== front) continue;
          const d = (z + 1) * 0.5;
          const persp = FOCAL / (FOCAL - z);
          const tw = 0.6 + 0.4 * Math.sin(time * 2.1 + q * 1.3 + i);
          const ptone = mix(pal.highlight, pt.tone > 0.5 ? pal.primary : pal.secondary, 0.55);
          ctx.beginPath();
          ctx.arc(
            buf[s * 3]!,
            buf[s * 3 + 1]!,
            pt.size * pal.weight * persp * (0.75 + drive * 0.8),
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = rgba(ptone, 1);
          const na = clamp01(A * (0.3 + tw * 0.45) * (0.55 + energy * 0.45) * (0.35 + d * 0.9) * (1 + drive * 0.5));
          ctx.globalAlpha = na;
          ctx.fill();
          if (pt.size > 1.9 && front && pal.blend === "lighter") {
            const hr = pt.size * pal.weight * persp * 5.5 * (0.8 + drive * 0.5);
            ctx.save();
            ctx.translate(buf[s * 3]!, buf[s * 3 + 1]!);
            ctx.scale(hr, hr);
            ctx.fillStyle = unitRadial("halo", ptone, [
              [0, 0.45],
              [0.3, 0.12],
              [1, 0],
            ]);
            ctx.globalAlpha = clamp01(na * 0.7);
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    const paintDust = (front: boolean) => {
      const count = Math.round(dust.length * detail);
      for (let i = 0; i < count; i++) {
        const dp = dust[i]!;
        const a = dp.a + phase * dp.rate * 6.283 * 4;
        const cb = Math.cos(dp.b);
        const x = Math.cos(a) * cb;
        const y = Math.sin(dp.b) * 0.85;
        const z = Math.sin(a) * cb;
        if (z >= 0 !== front) continue;
        const rr = R * dp.r * scale * (1 + drive * 0.08);
        const persp = FOCAL / (FOCAL - z);
        const d = (z + 1) * 0.5;
        const tw = 0.5 + 0.5 * Math.sin(time * 1.7 + i);
        ctx.beginPath();
        ctx.arc(
          cx + x * rr * persp,
          cy + y * rr * persp,
          dp.size * pal.weight * persp * (0.7 + drive * 0.5),
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = rgba(dp.tone > 0.7 ? pal.highlight : pal.primary, 1);
        ctx.globalAlpha = clamp01(A * (0.3 + tw * 0.45) * (0.35 + d * 0.8) * (1 + drive * 0.4));
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    /* ------------------------------------------------------- far side */
    paintOrbits(false);
    paintDust(false);

    /* ---------------------------------------------------- central sphere */
    // Soft body: a luminous shell with a deeper centre, strictly circular.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sphereR, sphereR);
    const bodyKey = `body|${qc(field)}`;
    let body = radialCache.get(bodyKey);
    if (!body) {
      body = ctx.createRadialGradient(0, 0, 0.1, 0, 0, 1);
      body.addColorStop(0, rgba(field, 0.12));
      body.addColorStop(0.55, rgba(field, 0.26));
      body.addColorStop(0.9, rgba(field, 0.55));
      body.addColorStop(1, rgba(field, 0));
      radialCache.set(bodyKey, body);
    }
    ctx.fillStyle = body;
    ctx.globalAlpha = clamp01(pal.coreAlpha * pal.body * boot * intensity * (0.85 + drive * 0.5));
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    // Nucleus: a small bright heart that breathes and brightens with the voice.
    const nucR = sphereR * (0.42 + breath * 2 + drive * 0.12);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(nucR, nucR);
    ctx.fillStyle = unitRadial("nucleus", mix(field, pal.spec, params.theme === "light" ? 0.7 : 0.45), [
      [0, 0.5],
      [0.35, 0.22],
      [0.7, 0.06],
      [1, 0],
    ]);
    ctx.globalAlpha = clamp01(A * (0.32 + energy * 0.1 + drive * 0.55));
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    // Wireframe interior: latitudes and meridians on a tilted, slowly turning
    // axis — the technical structure inside the presence.
    const axTilt = 0.36 + Math.sin(time * 0.12) * 0.05;
    AX[0] = Math.sin(axTilt) * 0.35;
    AX[1] = Math.cos(axTilt);
    AX[2] = Math.sin(axTilt) * 0.5;
    const axLen = Math.hypot(AX[0], AX[1], AX[2]);
    AX[0] /= axLen;
    AX[1] /= axLen;
    AX[2] /= axLen;
    // any vector perpendicular to AX
    E1[0] = -AX[1];
    E1[1] = AX[0];
    E1[2] = 0;
    const e1Len = Math.hypot(E1[0], E1[1], E1[2]) || 1;
    E1[0] /= e1Len;
    E1[1] /= e1Len;
    E1[2] /= e1Len;
    E2[0] = AX[1] * E1[2] - AX[2] * E1[1];
    E2[1] = AX[2] * E1[0] - AX[0] * E1[2];
    E2[2] = AX[0] * E1[1] - AX[1] * E1[0];

    /* ------------------------------------------- lit dot-matrix surface
     * Every lattice point turns with the sphere about its tilted axis (Rodrigues), is lit by a
     * key light from the upper left and textured by its fixed landmass value. Only the near
     * hemisphere is drawn; dots are bucketed by brightness and filled in DOT_BUCKETS passes. */
    {
      const cosS = Math.cos(sphereSpin * 1.15);
      const sinS = Math.sin(sphereSpin * 1.15);
      const kx = AX[0];
      const ky = AX[1];
      const kz = AX[2];
      // key light direction (screen space, toward the viewer from the upper left), normalised
      // (moved toward the side so a day/night terminator crosses the visible face)
      const lx = -0.83;
      const ly = -0.38;
      const lz = 0.41;
      let cities = 0;
      const count = Math.round(SURFACE_N * (0.55 + detail * 0.45));
      const dotBase = sphereR * 0.019 * pal.weight;
      const sR = sphereR / R;
      for (let i = 0; i < count; i++) {
        const px = surface[i * 3]!;
        const py = surface[i * 3 + 1]!;
        const pz = surface[i * 3 + 2]!;
        // v' = v cosθ + (k × v) sinθ + k (k·v)(1 − cosθ)
        const kd = kx * px + ky * py + kz * pz;
        const x = px * cosS + (ky * pz - kz * py) * sinS + kx * kd * (1 - cosS);
        const y = py * cosS + (kz * px - kx * pz) * sinS + ky * kd * (1 - cosS);
        const z = pz * cosS + (kx * py - ky * px) * sinS + kz * kd * (1 - cosS);
        if (z < 0.04) {
          dotB[i] = -1;
          continue;
        }
        const ndl = x * lx + y * ly + z * lz;
        const lit = Math.max(0, ndl);
        // Day/night: a soft terminator; the night side keeps only a faint glow.
        const day = clamp01((ndl + 0.1) / 0.32);
        const v = land[i]!;
        // land reads as dense bright dots, ocean as sparse faint ones; the rim thins out
        const landness = clamp01((v - 0.42) * 2.4);
        const shade = (0.08 + 0.92 * day * (0.35 + 0.65 * lit)) * (0.12 + landness * 1.05) * (0.4 + z * 0.6) * 1.35;
        // A few warm city lights on night-side land.
        if (day < 0.55 && landness > 0.35 && Math.abs(citySeed[i]!) < 0.32 && cities < CITY_MAX) {
          const cp = FOCAL / (FOCAL - z * sR);
          cityX[cities] = cx + x * sphereR * 0.985 * cp;
          cityY[cities] = cy + y * sphereR * 0.985 * cp;
          cityR[cities] = dotBase * (0.7 + Math.abs(citySeed[i]!) * 1.6) * (0.7 + z * 0.3);
          cityA[cities] = (1 - day / 0.55) * (0.75 + 0.25 * Math.sin(time * 2.3 + i));
          cities++;
        }
        const twinkle = v > 0.72 ? 0.85 + 0.15 * Math.sin(time * 3.1 + i * 1.7) : 1;
        const b = Math.min(DOT_BUCKETS - 1, Math.floor(shade * twinkle * DOT_BUCKETS * 0.95));
        const persp = FOCAL / (FOCAL - z * sR);
        dotX[i] = cx + x * sphereR * 0.985 * persp;
        dotY[i] = cy + y * sphereR * 0.985 * persp;
        dotR[i] = dotBase * (0.45 + clamp01((v - 0.42) * 2.4) * 0.75) * (0.6 + z * 0.4) * (1 + drive * 0.25);
        dotB[i] = b;
      }
      const dotTone = params.theme === "light" ? mix(field, pal.vivid, 0.3) : mix(field, pal.highlight, 0.38);
      ctx.fillStyle = rgba(dotTone, 1);
      for (let b = 0; b < DOT_BUCKETS; b++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < count; i++) {
          if (dotB[i] !== b) continue;
          const r = dotR[i]!;
          ctx.moveTo(dotX[i]! + r, dotY[i]!);
          ctx.arc(dotX[i]!, dotY[i]!, r, 0, Math.PI * 2);
          any = true;
        }
        if (!any) continue;
        ctx.globalAlpha = clamp01(A * pal.wire * (0.1 + ((b + 1) / DOT_BUCKETS) * 0.9) * (0.85 + energy * 0.2 + drive * 0.35));
        ctx.fill();
      }
      // City lights, in two brightness passes.
      ctx.fillStyle = rgba(pal.ember, 1);
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let c = 0; c < cities; c++) {
          if ((cityA[c]! > 0.6 ? 1 : 0) !== pass) continue;
          const cr = cityR[c]!;
          ctx.moveTo(cityX[c]! + cr, cityY[c]!);
          ctx.arc(cityX[c]!, cityY[c]!, cr, 0, Math.PI * 2);
        }
        ctx.globalAlpha = clamp01(A * pal.wire * (pass ? 0.95 : 0.55) * (0.85 + drive * 0.3));
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const wireTone = mix(pal.highlight, pal.primary, params.theme === "light" ? 0.7 : 0.5);
    const wireStroke = rgba(wireTone, 1);
    // The grid is now a fine overlay; the dot surface carries the body.
    const wireA = A * pal.wire * (0.2 + energy * 0.12) * (1 + drive * 0.5);
    const wireSteps = Math.max(28, Math.round(56 * detail));
    ctx.lineWidth = 0.5 * pal.weight * (params.theme === "light" ? 1.25 : 1);
    ctx.strokeStyle = wireStroke;

    const lat = 4;
    for (let li = -lat; li <= lat; li++) {
      const f = (li / (lat + 0.6)) * (Math.PI / 2);
      const cr = Math.cos(f);
      const cz = Math.sin(f);
      ctx.beginPath();
      let started = false;
      for (let s = 0; s <= wireSteps; s++) {
        const a = (s / wireSteps) * Math.PI * 2 + sphereSpin;
        const ux = E1[0] * Math.cos(a) * cr + E2[0] * Math.sin(a) * cr + AX[0] * cz;
        const uy = E1[1] * Math.cos(a) * cr + E2[1] * Math.sin(a) * cr + AX[1] * cz;
        const uz = E1[2] * Math.cos(a) * cr + E2[2] * Math.sin(a) * cr + AX[2] * cz;
        if (uz < -0.02) {
          started = false;
          continue;
        }
        const persp = FOCAL / (FOCAL - uz * (sphereR / R));
        const x = cx + ux * sphereR * persp;
        const y = cy + uy * sphereR * persp;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = clamp01(wireA * (0.55 + 0.45 * cr));
      ctx.stroke();
    }

    const meridians = 7;
    for (let mi = 0; mi < meridians; mi++) {
      const rot = (mi / meridians) * Math.PI + sphereSpin * 0.9;
      const mx = Math.cos(rot);
      const my = Math.sin(rot);
      ctx.beginPath();
      let started = false;
      for (let s = 0; s <= wireSteps; s++) {
        const a = (s / wireSteps) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const bx = E1[0] * mx + E2[0] * my;
        const by = E1[1] * mx + E2[1] * my;
        const bz = E1[2] * mx + E2[2] * my;
        const ux = bx * ca + AX[0] * sa;
        const uy = by * ca + AX[1] * sa;
        const uz = bz * ca + AX[2] * sa;
        if (uz < -0.02) {
          started = false;
          continue;
        }
        const persp = FOCAL / (FOCAL - uz * (sphereR / R));
        const x = cx + ux * sphereR * persp;
        const y = cy + uy * sphereR * persp;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = clamp01(wireA * 0.8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Limb: a crisp circular edge that gives the sphere its object-ness.
    ctx.beginPath();
    ctx.arc(cx, cy, sphereR, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(pal.highlight, 1);
    ctx.globalAlpha = clamp01(A * (0.34 + drive * 0.5));
    ctx.lineWidth = 0.9 * pal.weight;
    ctx.stroke();

    // Day-side crescent: the atmosphere catching the key light (upper left), fading toward the sides.
    {
      const la = Math.atan2(-0.38, -0.83);
      const cres = mix(field, pal.spec, params.theme === "light" ? 0.85 : 0.45);
      ctx.strokeStyle = rgba(cres, 1);
      ctx.lineCap = "round";
      for (let k = 0; k < 3; k++) {
        const span = [1.55, 1.0, 0.5][k]!;
        ctx.beginPath();
        ctx.arc(cx, cy, sphereR * 1.035, la - span, la + span);
        ctx.globalAlpha = clamp01(A * [0.1, 0.16, 0.24][k]! * (pal.blend === "lighter" ? 1 : 0.8) * (0.85 + energy * 0.2 + drive * 0.3));
        ctx.lineWidth = [2.6, 1.9, 1.3][k]! * pal.weight;
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      ctx.globalAlpha = 1;
    }

    // Atmosphere: a thin luminous band hugging the limb, brighter toward the key light.
    const atmoR = sphereR * 1.16;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(atmoR, atmoR);
    ctx.fillStyle = unitRadial(
      "atmo",
      mix(field, pal.highlight, 0.25),
      [
        [0, 0],
        [0.8, 0],
        [0.86, 0.32],
        [0.9, 0.14],
        [1, 0],
      ],
      0,
    );
    ctx.globalAlpha = clamp01(A * (0.55 + energy * 0.15 + drive * 0.4));
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    // Specular: an off-centre highlight so the sphere reads as lit, not flat.
    const specR = sphereR * (0.6 + drive * 0.1);
    ctx.save();
    ctx.translate(cx - sphereR * 0.26, cy - sphereR * 0.3);
    ctx.scale(specR, specR);
    ctx.fillStyle = unitRadial("spec", pal.highlight, [
      [0, 0.5],
      [0.5, 0.16],
      [1, 0],
    ]);
    ctx.globalAlpha = clamp01(A * 0.28 * (0.7 + drive * 0.6));
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    /* ------------------------------------------------------ near side */
    paintOrbits(true);
    paintDust(true);

    ctx.globalCompositeOperation = prevBlend;
    if (t0) (meter.__presenceCost ??= []).push(performance.now() - t0);
  };

  raf = requestAnimationFrame(frame);

  return {
    params,
    setSize,
    resize,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      if (shrinkTimer) clearTimeout(shrinkTimer);
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
      radialCache.clear();
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
