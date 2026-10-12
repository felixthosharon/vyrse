import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WakeDetector, type WakeModel } from "../heed";

const model = JSON.parse(readFileSync(new URL("../../../../public/wake/vyrse.json", import.meta.url), "utf8")) as WakeModel;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/heed-equivalence.json", import.meta.url), "utf8")) as {
  clips: { name: string; pcm: string; probs: number[]; triggered: boolean[] }[];
};

describe("on-device wake word (TypeScript port of the plugin's numpy detector)", () => {
  for (const clip of fixture.clips) {
    it(`matches the reference frame by frame: ${clip.name}`, () => {
      const bytes = Buffer.from(clip.pcm, "base64");
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
      const det = new WakeDetector(model);
      const probs: number[] = [];
      const fired: boolean[] = [];
      for (let j = 0; j < pcm.length; j += 1600) {
        const chunk = Float32Array.from(pcm.subarray(j, j + 1600), (v) => v / 32768);
        const r = det.step(chunk, j / 16000);
        probs.push(r.prob);
        fired.push(r.triggered);
      }
      probs.forEach((p, i) => expect(Math.abs(p - clip.probs[i]!)).toBeLessThan(2e-3));
      expect(fired).toEqual(clip.triggered);
    });
  }
});
