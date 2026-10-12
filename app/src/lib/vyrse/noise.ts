/**
 * Tiny deterministic 3D gradient noise + 2D curl helper.
 * Used only by the presence renderer.
 */

const PERM = new Uint8Array(512);
const GRAD = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
];

(() => {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!;
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function dot(g: number[], x: number, y: number, z: number) {
  return g[0]! * x + g[1]! * y + g[2]! * z;
}

export function noise3(x: number, y: number, z: number): number {
  const P = (i: number) => PERM[i]!;
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);

  const A = (P(X) + Y) & 255;
  const B = (P(X + 1) + Y) & 255;
  const AA = (P(A) + Z) & 255;
  const AB = (P(A + 1) + Z) & 255;
  const BA = (P(B) + Z) & 255;
  const BB = (P(B + 1) + Z) & 255;

  const g = (h: number) => GRAD[h % 12]!;

  return lerp(
    lerp(
      lerp(dot(g(P(AA)), x, y, z), dot(g(P(BA)), x - 1, y, z), u),
      lerp(dot(g(P(AB)), x, y - 1, z), dot(g(P(BB)), x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(dot(g(P(AA + 1)), x, y, z - 1), dot(g(P(BA + 1)), x - 1, y, z - 1), u),
      lerp(
        dot(g(P(AB + 1)), x, y - 1, z - 1),
        dot(g(P(BB + 1)), x - 1, y - 1, z - 1),
        u,
      ),
      v,
    ),
    w,
  );
}

/** Divergence-free 2D flow vector derived from a scalar noise field. */
export function curl2(x: number, y: number, t: number, eps = 0.12): [number, number] {
  const n1 = noise3(x, y + eps, t);
  const n2 = noise3(x, y - eps, t);
  const n3 = noise3(x + eps, y, t);
  const n4 = noise3(x - eps, y, t);
  return [(n1 - n2) / (2 * eps), -(n3 - n4) / (2 * eps)];
}
