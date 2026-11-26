/**
 * How the orb gets onto the screen. The presence engine works out every ring, dot and glow; a painter draws
 * them. Two painters draw the same picture:
 *
 *  - `create2dPainter`: the original Canvas 2D drawing, call for call (the phone, and any PC without WebGL2).
 *  - `createGlPainter`: the same shapes drawn by the graphics card with WebGL2 (desktop). It reproduces what the
 *    canvas does: round line caps, anti-aliased edges, dashed rings, radial glows, additive light on dark and
 *    normal blending on light, and one stroke or fill drawing each pixel once even where its own pieces overlap.
 *    Checked against the 2D painter pixel by pixel (2026-11-26).
 *
 * The engine talks to a painter like it used to talk to the canvas: build a path, then stroke or fill it.
 * Coordinates are in CSS pixels; the painter scales them by the device pixel ratio given to `begin`.
 */

export type RGB = [number, number, number];
export type Blend = "lighter" | "source-over";
export type Stops = readonly (readonly [number, number])[];
/** dashed stroke, in CSS pixels: `on` drawn, `off` gap, pattern shifted by `offset` (canvas lineDashOffset) */
export interface Dash {
  on: number;
  off: number;
  offset: number;
}

export interface Painter {
  readonly kind: "2d" | "webgl";
  /** the render buffer is now `px` x `px` device pixels */
  resize(px: number): void;
  /** start a frame: clear everything and blend the following shapes with `blend` */
  begin(dpr: number, blend: Blend): void;
  /**
   * A disc of radius `r` at (x, y) filled with one colour whose alpha follows `stops` from `inner` (centre side)
   * to 1 (edge) of the radius, times `alpha`. Cached per `kind` and colour (rounded) like the original gradients:
   * the first colour seen for a key is kept until the buffer is resized.
   */
  radial(
    kind: string,
    color: RGB,
    stops: Stops,
    inner: number,
    x: number,
    y: number,
    r: number,
    alpha: number,
  ): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  /** an arc (canvas `arc`, clockwise on screen); a full circle when filled */
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  /** stroke the current path with round caps */
  stroke(color: RGB, alpha: number, width: number, dash?: Dash | null): void;
  /** fill the circles in the current path as one shape */
  fill(color: RGB, alpha: number): void;
  end(): void;
  /** clear the picture (the orb is going away) */
  clear(): void;
  destroy(): void;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp01(a)})`;
/** the gradient cache key: colour rounded to steps of 8, as the original engine did */
const qc = (c: RGB) => `${Math.round(c[0] / 8)},${Math.round(c[1] / 8)},${Math.round(c[2] / 8)}`;

/* -------------------------------------------------------------------------------------------- Canvas 2D */

export function create2dPainter(canvas: HTMLCanvasElement | OffscreenCanvas): Painter | null {
  // The two 2D contexts share the drawing API used here.
  const ctx = canvas.getContext("2d", { alpha: true }) as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const cache = new Map<string, CanvasGradient>();
  /** the stroke colour string, kept while the colour doesn't change (most strokes reuse the previous one) */
  let lastColor: RGB | null = null;
  let lastColorStr = "";
  const colorStr = (c: RGB) => {
    if (
      lastColor !== c ||
      lastColor[0] !== c[0] ||
      lastColor[1] !== c[1] ||
      lastColor[2] !== c[2]
    ) {
      lastColor = c;
      lastColorStr = rgba(c, 1);
    }
    return lastColorStr;
  };
  let dashed = false;

  return {
    kind: "2d",
    resize(px) {
      canvas.width = px;
      canvas.height = px;
      cache.clear();
    },
    begin(dpr, blend) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      ctx.globalCompositeOperation = blend;
      ctx.lineCap = "round";
    },
    radial(kind, color, stops, inner, x, y, r, alpha) {
      const key = `${kind}|${qc(color)}`;
      let g = cache.get(key);
      if (!g) {
        g = ctx.createRadialGradient(0, 0, inner, 0, 0, 1);
        for (const [at, a] of stops) g.addColorStop(at, rgba(color, a));
        cache.set(key, g);
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(r, r);
      ctx.fillStyle = g;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    },
    beginPath: () => ctx.beginPath(),
    moveTo: (x, y) => ctx.moveTo(x, y),
    lineTo: (x, y) => ctx.lineTo(x, y),
    arc: (x, y, r, a0, a1) => ctx.arc(x, y, r, a0, a1),
    stroke(color, alpha, width, dash) {
      if (dash) {
        ctx.setLineDash([dash.on, dash.off]);
        ctx.lineDashOffset = dash.offset;
        dashed = true;
      } else if (dashed) {
        ctx.setLineDash([]);
        dashed = false;
      }
      ctx.strokeStyle = colorStr(color);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.stroke();
    },
    fill(color, alpha) {
      ctx.fillStyle = rgba(color, 1);
      ctx.globalAlpha = alpha;
      ctx.fill();
    },
    end() {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (dashed) {
        ctx.setLineDash([]);
        dashed = false;
      }
    },
    clear() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    destroy() {
      cache.clear();
    },
  };
}

/* ------------------------------------------------------------------------------------------------ WebGL2 */

/*
 * Every shape is one instance of a screen-aligned quad (its bounding box); the fragment shader works out how much
 * of each pixel the shape covers, from its exact distance to the shape. All shapes of a frame go in one instanced
 * draw, in the order the engine painted them, so blending matches the canvas.
 *
 * One stroke or fill can be several instances (a long line in pieces, a fill of many dots). The canvas draws such
 * a path as one shape: a pixel covered by two of its pieces is painted once. Here each stroke/fill gets its own
 * depth value and the depth test lets only the first piece paint a pixel.
 *
 * Instance layout: 9 x vec4 (36 floats)
 *  i0: kind, depth, alpha, width (device px)      kinds: 0 circle, 1 radial, 2 polyline, 3 arc
 *  i1: r, g, b (0..1), dash on (device px, 0 = solid)
 *  i2: bounding box min x, min y, max x, max y (device px)
 *  i3: dash off, dash phase at this piece's start, point count, gradient inner
 *  i4..i8: shape data. circle/arc/radial: centre x, y, radius, (radial: unused) | arc: i5 = start, end angle
 *          radial: i5, i6, i7.xy = up to 5 stops (position, alpha), point count = stop count
 *          polyline: up to 10 points (x, y)
 */
const FLOATS = 36;
const MAX_POINTS = 10;

const VERT = `#version 300 es
layout(location=0) in vec4 i0;
layout(location=1) in vec4 i1;
layout(location=2) in vec4 i2;
layout(location=3) in vec4 i3;
layout(location=4) in vec4 i4;
layout(location=5) in vec4 i5;
layout(location=6) in vec4 i6;
layout(location=7) in vec4 i7;
layout(location=8) in vec4 i8;
uniform vec2 uSize;
out vec2 vPos;
flat out vec4 f0; flat out vec4 f1; flat out vec4 f3;
flat out vec4 f4; flat out vec4 f5; flat out vec4 f6; flat out vec4 f7; flat out vec4 f8;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = mix(i2.xy, i2.zw, corner);
  vPos = p;
  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, i0.y * 2.0 - 1.0, 1.0);
  f0 = i0; f1 = i1; f3 = i3; f4 = i4; f5 = i5; f6 = i6; f7 = i7; f8 = i8;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vPos;
flat in vec4 f0; flat in vec4 f1; flat in vec4 f3;
flat in vec4 f4; flat in vec4 f5; flat in vec4 f6; flat in vec4 f7; flat in vec4 f8;
out vec4 outColor;

/*
 * Coverage follows how Chrome's GPU canvas draws (measured 2026-11-26):
 *  - lines up to 1 px wide are 1 px hairlines at width x opacity, with ends that reach only ~0.09 px past the point;
 *    wider lines have exact width and round caps;
 *  - dots are polygons (4, 8, 16... sides by size), so a tiny dot carries less ink than a true circle (the engine
 *    passes the polygon's area as the radius); small ones are measured by area, 16 samples a pixel;
 *  - gradients are dithered.
 */
const float CAP = 0.09;

// share of a 1 px pixel at distance d from a line's centre that lies within half-width hw (box filter)
float band(float d, float hw) {
  return clamp(min(hw, d + 0.5) - max(-hw, d - 0.5), 0.0, 1.0);
}
// share of the pixel [u - 0.5, u + 0.5] inside [lo, hi]
float span(float u, float lo, float hi) {
  return clamp(min(hi, u + 0.5) - max(lo, u - 0.5), 0.0, 1.0);
}
float hash(vec2 q) {
  return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453);
}

vec2 pt(int i) {
  if (i == 0) return f4.xy; if (i == 1) return f4.zw;
  if (i == 2) return f5.xy; if (i == 3) return f5.zw;
  if (i == 4) return f6.xy; if (i == 5) return f6.zw;
  if (i == 6) return f7.xy; if (i == 7) return f7.zw;
  if (i == 8) return f8.xy; return f8.zw;
}

void main() {
  int kind = int(f0.x + 0.5);
  float alpha = f0.z;
  float w = f0.w;
  bool hair = w <= 1.0;
  float hw = hair ? 0.5 : w * 0.5;
  if (hair && kind >= 2) alpha *= w;
  vec2 p = vPos;
  float cov = 0.0;
  if (kind == 0) {
    float r = f4.z;
    if (r < 2.0) {
      float n = 0.0;
      for (int y = 0; y < 4; y++)
        for (int x = 0; x < 4; x++) {
          vec2 q = p + (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
          n += length(q - f4.xy) <= r ? 1.0 : 0.0;
        }
      cov = n / 16.0;
    } else cov = clamp(r - length(p - f4.xy) + 0.5, 0.0, 1.0);
  } else if (kind == 1) {
    // disc with a radial alpha gradient from inner to 1 of the radius
    float r = f4.z;
    float d = length(p - f4.xy);
    float edge = clamp(r - d + 0.5, 0.0, 1.0);
    float inner = f3.w;
    float t = clamp((d / r - inner) / max(1e-5, 1.0 - inner), 0.0, 1.0);
    int n = int(f3.z + 0.5);
    vec2 s[5];
    s[0] = f5.xy; s[1] = f5.zw; s[2] = f6.xy; s[3] = f6.zw; s[4] = f7.xy;
    float a = s[0].y;
    for (int i = 1; i < 5; i++) {
      if (i >= n) break;
      if (t >= s[i - 1].x) {
        float sp = s[i].x - s[i - 1].x;
        a = t >= s[i].x ? s[i].y : mix(s[i - 1].y, s[i].y, sp > 0.0 ? (t - s[i - 1].x) / sp : 1.0);
      }
    }
    cov = edge * a;
    // dither like the canvas's gradients, so dark glows don't band
    if (cov * alpha > 0.0) cov += (hash(p) - 0.5) / (255.0 * max(alpha, 1e-3));
  } else if (kind == 2) {
    // polyline: nearest segment, distance across it and position along the path
    int n = int(f3.z + 0.5);
    int ends = int(f3.w + 0.5); // 1: the first point is a path end, 2: the last one is
    float best = 1e9;
    float along = 0.0;
    float perp = 0.0;
    float endCov = 1.0;
    vec2 dir = vec2(1.0, 0.0);
    float run = 0.0;
    vec2 a = pt(0);
    for (int i = 1; i < ${MAX_POINTS}; i++) {
      if (i >= n) break;
      vec2 b = pt(i);
      vec2 ab = b - a;
      float len = length(ab);
      float hr = len > 0.0 ? dot(p - a, ab) / (len * len) : 0.0;
      float h = clamp(hr, 0.0, 1.0);
      float d = length(p - a - ab * h);
      if (d < best) {
        best = d;
        along = run + h * len;
        dir = len > 0.0 ? ab / len : vec2(1.0, 0.0);
        perp = dir.x * (p - a).y - dir.y * (p - a).x;
        endCov = 1.0;
        if (hair) {
          if (i == 1 && (ends & 1) != 0) endCov *= span(-hr * len, -1e6, CAP);
          if (i == n - 1 && (ends & 2) != 0) endCov *= span((hr - 1.0) * len, -1e6, CAP);
        }
      }
      run += len;
      a = b;
    }
    if (f1.w > 0.0) {
      float on = f1.w;
      float period = on + f3.x;
      if (hair) {
        float u = mod(along + f3.y, period);
        cov = band(abs(perp), 0.5) * min(1.0, span(u, -CAP, on + CAP) + span(u, period - CAP, period + on + CAP));
      } else {
        // dashes with round caps, measured by area (16 samples)
        float k = 0.0;
        vec2 nrm = vec2(-dir.y, dir.x);
        for (int y = 0; y < 4; y++)
          for (int x = 0; x < 4; x++) {
            vec2 o = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
            float u = mod(along + dot(o, dir) + f3.y, period);
            float gap = u <= on ? 0.0 : min(u - on, period - u);
            k += length(vec2(gap, perp + dot(o, nrm))) <= hw ? 1.0 : 0.0;
          }
        cov = k / 16.0;
      }
    } else if (hair) {
      cov = (endCov < 1.0 ? band(abs(perp), 0.5) : band(best, 0.5)) * endCov;
    } else cov = band(best, hw);
  } else {
    // arc stroke with round caps (a full circle when it spans 2 pi)
    vec2 q = p - f4.xy;
    float a0 = f5.x;
    float a1 = f5.y;
    float half_ = (a1 - a0) * 0.5;
    float d;
    if (half_ >= 3.14159) {
      d = abs(length(q) - f4.z);
    } else {
      float mid = a0 + half_;
      float ang = atan(q.y, q.x) - mid;
      ang = ang - 6.2831853 * floor((ang + 3.14159265) / 6.2831853);
      if (abs(ang) <= half_) d = abs(length(q) - f4.z);
      else {
        vec2 e0 = f4.xy + f4.z * vec2(cos(a0), sin(a0));
        vec2 e1 = f4.xy + f4.z * vec2(cos(a1), sin(a1));
        d = min(length(p - e0), length(p - e1));
      }
    }
    cov = band(d, hw);
  }
  float a = clamp(cov * alpha, 0.0, 1.0);
  if (a < 0.0015) discard;
  outColor = vec4(f1.rgb * a, a);
}`;

/**
 * The canvas fills a circle as a polygon with 4, 8, 16... sides, the fewest that stay within 1/8 px of the true
 * circle (measured: a 0.4 px dot carries 63% of a circle's ink, a 1 px dot 90%, a 4 px dot 97%). The radius of the
 * circle with that polygon's area, so small dots get the same ink.
 */
export function polygonRadius(r: number): number {
  let n = 4;
  while (n < 1024 && r * (1 - Math.cos(Math.PI / n)) > 0.125) n *= 2;
  const k = (2 * Math.PI) / n;
  return r * Math.sqrt(Math.sin(k) / k);
}

/** WebGL2 that runs in software (no usable graphics card) would cost more CPU than the canvas. */
function softwareGl(gl: WebGL2RenderingContext): boolean {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(
    info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );
  return /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(name);
}

function compile(gl: WebGL2RenderingContext): WebGLProgram | null {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("orb shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("orb shader:", gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

/** Whether the GPU painter can run here: WebGL2 on a real graphics card and the shaders compile (tested on a spare canvas). */
export function glPainterWorks(): boolean {
  try {
    const probe: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(4, 4)
        : document.createElement("canvas");
    const gl = probe.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return false;
    const ok = !softwareGl(gl) && compile(gl) !== null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export function createGlPainter(canvas: HTMLCanvasElement | OffscreenCanvas): Painter | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) return null;

  let prog: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vbo: WebGLBuffer | null = null;
  let uSize: WebGLUniformLocation | null = null;
  let lost = false;

  const setup = () => {
    prog = compile(gl);
    if (!prog) return false;
    uSize = gl.getUniformLocation(prog, "uSize");
    vao = gl.createVertexArray();
    vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    for (let i = 0; i < 9; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    return true;
  };
  if (!setup()) return null;

  // The graphics driver can reset (driver update, GPU hang elsewhere): wait for the context to come back.
  if ("addEventListener" in canvas) {
    (canvas as EventTarget).addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      lost = true;
    });
    (canvas as EventTarget).addEventListener("webglcontextrestored", () => {
      lost = !setup();
    });
  }

  let data = new Float32Array(FLOATS * 4096);
  let count = 0;
  let dpr = 1;
  /** depth of the current stroke/fill (each gets its own; see the note above) */
  let depth = 1;
  const DEPTH_STEP = 1 / (1 << 22);
  const cache = new Map<string, RGB>();

  // the current path: polylines (flat x,y in device px, with the start index of each subpath) and arcs
  let px = new Float32Array(1024);
  let pn = 0;
  const starts: number[] = [];
  const arcs: number[] = []; // x, y, r, a0, a1 (device px)

  const slot = (): number => {
    if ((count + 1) * FLOATS > data.length) {
      const next = new Float32Array(data.length * 2);
      next.set(data);
      data = next;
    }
    const o = count * FLOATS;
    data.fill(0, o, o + FLOATS);
    count++;
    return o;
  };
  const head = (o: number, kind: number, alpha: number, width: number, c: RGB) => {
    data[o] = kind;
    data[o + 1] = depth;
    data[o + 2] = alpha;
    data[o + 3] = width;
    data[o + 4] = c[0] / 255;
    data[o + 5] = c[1] / 255;
    data[o + 6] = c[2] / 255;
  };
  const box = (o: number, x0: number, y0: number, x1: number, y1: number) => {
    data[o + 8] = Math.floor(x0);
    data[o + 9] = Math.floor(y0);
    data[o + 10] = Math.ceil(x1);
    data[o + 11] = Math.ceil(y1);
  };
  const nextShape = () => {
    depth -= DEPTH_STEP;
  };

  return {
    kind: "webgl",
    resize(size) {
      canvas.width = size;
      canvas.height = size;
      cache.clear();
    },
    begin(ratio, blend) {
      dpr = ratio;
      count = 0;
      depth = 1 - DEPTH_STEP;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      if (blend === "lighter") gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
    },
    radial(kind, color, stops, inner, x, y, r, alpha) {
      const key = `${kind}|${qc(color)}`;
      let c = cache.get(key);
      if (!c) {
        c = [color[0], color[1], color[2]];
        cache.set(key, c);
      }
      const o = slot();
      head(o, 1, alpha, 0, c);
      const X = x * dpr;
      const Y = y * dpr;
      const R = Math.abs(r) * dpr;
      box(o, X - R - 1, Y - R - 1, X + R + 1, Y + R + 1);
      data[o + 14] = Math.min(5, stops.length);
      data[o + 15] = inner;
      data[o + 16] = X;
      data[o + 17] = Y;
      data[o + 18] = R;
      for (let i = 0; i < 5 && i < stops.length; i++) {
        data[o + 20 + i * 2] = stops[i]![0];
        data[o + 21 + i * 2] = stops[i]![1];
      }
      nextShape();
    },
    beginPath() {
      pn = 0;
      starts.length = 0;
      arcs.length = 0;
    },
    moveTo(x, y) {
      starts.push(pn);
      if ((pn + 1) * 2 > px.length) {
        const next = new Float32Array(px.length * 2);
        next.set(px);
        px = next;
      }
      px[pn * 2] = x * dpr;
      px[pn * 2 + 1] = y * dpr;
      pn++;
    },
    lineTo(x, y) {
      if (starts.length === 0) starts.push(pn);
      if ((pn + 1) * 2 > px.length) {
        const next = new Float32Array(px.length * 2);
        next.set(px);
        px = next;
      }
      px[pn * 2] = x * dpr;
      px[pn * 2 + 1] = y * dpr;
      pn++;
    },
    arc(x, y, r, a0, a1) {
      arcs.push(x * dpr, y * dpr, r * dpr, a0, a1);
    },
    stroke(color, alpha, width, dash) {
      const W = width * dpr;
      const hw = Math.max(W, 1) / 2;
      const on = dash ? dash.on * dpr : 0;
      const off = dash ? dash.off * dpr : 0;
      const period = on + off;
      const phase = dash && period > 0 ? (((dash.offset * dpr) % period) + period) % period : 0;
      // polylines, in pieces of up to MAX_POINTS points that share their end points
      for (let s = 0; s < starts.length; s++) {
        const from = starts[s]!;
        const to = s + 1 < starts.length ? starts[s + 1]! : pn;
        if (to - from < 2) continue;
        let run = phase; // dashes restart at each subpath, like the canvas
        for (let a = from; a < to - 1; a += MAX_POINTS - 1) {
          const b = Math.min(to, a + MAX_POINTS);
          const o = slot();
          head(o, 2, alpha, W, color);
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          let len = 0;
          for (let i = a; i < b; i++) {
            const x = px[i * 2]!;
            const y = px[i * 2 + 1]!;
            data[o + 16 + (i - a) * 2] = x;
            data[o + 17 + (i - a) * 2] = y;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
            if (i > a) len += Math.hypot(x - px[(i - 1) * 2]!, y - px[(i - 1) * 2 + 1]!);
          }
          box(o, x0 - hw - 1, y0 - hw - 1, x1 + hw + 1, y1 + hw + 1);
          data[o + 7] = on;
          data[o + 12] = off;
          data[o + 13] = run;
          data[o + 14] = b - a;
          data[o + 15] = (a === from ? 1 : 0) + (b === to ? 2 : 0); // which ends of this piece are ends of the line
          if (period > 0) run = (run + len) % period;
        }
      }
      for (let i = 0; i < arcs.length; i += 5) {
        const o = slot();
        head(o, 3, alpha, W, color);
        const X = arcs[i]!;
        const Y = arcs[i + 1]!;
        const R = arcs[i + 2]!;
        box(o, X - R - hw - 1, Y - R - hw - 1, X + R + hw + 1, Y + R + hw + 1);
        data[o + 16] = X;
        data[o + 17] = Y;
        data[o + 18] = R;
        data[o + 20] = arcs[i + 3]!;
        data[o + 21] = arcs[i + 4]!;
      }
      nextShape();
    },
    fill(color, alpha) {
      for (let i = 0; i < arcs.length; i += 5) {
        const o = slot();
        head(o, 0, alpha, 0, color);
        const X = arcs[i]!;
        const Y = arcs[i + 1]!;
        const R = arcs[i + 2]!;
        box(o, X - R - 1, Y - R - 1, X + R + 1, Y + R + 1);
        data[o + 16] = X;
        data[o + 17] = Y;
        data[o + 18] = polygonRadius(R);
      }
      nextShape();
    },
    end() {
      if (lost || !prog || count === 0) return;
      gl.useProgram(prog);
      gl.uniform2f(uSize, canvas.width, canvas.height);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * FLOATS), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(null);
    },
    clear() {
      if (lost) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    destroy() {
      cache.clear();
      if (lost) return;
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
    },
  };
}
