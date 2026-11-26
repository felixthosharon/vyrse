import { describe, expect, it } from "vitest";
import { polygonRadius } from "../presence-paint";

// Ink of a dot as the canvas draws it, relative to a true circle (measured in Chrome's GPU canvas, 2026-11-26).
const MEASURED: [number, number][] = [
  [0.4, 0.63],
  [1, 0.9],
  [1.5, 0.91],
  [2.5, 0.97],
  [4, 0.97],
];

describe("GPU orb dots carry the canvas's ink", () => {
  for (const [r, ink] of MEASURED) {
    it(`radius ${r} px`, () => {
      const area = (polygonRadius(r) / r) ** 2;
      expect(Math.abs(area - ink)).toBeLessThan(0.03);
    });
  }
  it("big dots are circles", () => {
    expect(polygonRadius(40) / 40).toBeGreaterThan(0.995);
  });
});
