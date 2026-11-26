import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A simulated screen: requestAnimationFrame fires on the next refresh of a `hz` display, timers fire on time.
 * Returns how many paced frames ran and how many screen refreshes woke the page.
 */
async function simulate(hz: number, fps: number, seconds: number) {
  vi.resetModules();
  const vsync = 1000 / hz;
  let now = 0;
  let wakeups = 0;
  type Job = { at: number; fn: (t: number) => void; frame: boolean };
  const jobs: Job[] = [];
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("requestAnimationFrame", (fn: (t: number) => void) => {
    const at = (Math.floor(now / vsync + 1e-9) + 1) * vsync;
    jobs.push({ at, fn, frame: true });
    return jobs.length;
  });
  vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
    jobs.push({ at: now + Math.max(1, ms), fn: () => fn(), frame: false });
    return jobs.length;
  });
  const pace = await import("../frame-pace");
  pace.setMaxFps(fps);
  const frames: number[] = [];
  const stop = pace.onFrame((t) => frames.push(t));
  while (jobs.length) {
    jobs.sort((a, b) => a.at - b.at);
    const job = jobs.shift()!;
    if (job.at > seconds * 1000) break;
    now = job.at;
    if (job.frame) wakeups++;
    job.fn(now);
  }
  stop();
  return { frames, wakeups };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paced frame clock", () => {
  for (const [hz, fps] of [
    [179, 60],
    [179, 30],
    [144, 60],
    [60, 60],
    [60, 30],
    [240, 60],
  ] as const) {
    it(`gives ${fps} frames a second on a ${hz} Hz screen`, async () => {
      const { frames, wakeups } = await simulate(hz, fps, 10);
      const rate = frames.length / 10;
      expect(rate).toBeGreaterThan(fps * 0.97);
      expect(rate).toBeLessThanOrEqual(fps + 0.2);
      // It sleeps between frames instead of waking on every screen refresh.
      expect(wakeups / 10).toBeLessThanOrEqual(Math.min(hz, fps * 2.2));
      // No two frames closer together than one screen refresh, no long gaps.
      const gaps = frames.slice(1).map((t, i) => t - frames[i]!);
      expect(Math.max(...gaps)).toBeLessThan(1000 / fps + 1000 / hz + 0.01);
    });
  }

  it("stops waking the page once nothing is subscribed", async () => {
    vi.resetModules();
    const queued: unknown[] = [];
    vi.stubGlobal("performance", { now: () => 0 });
    vi.stubGlobal("requestAnimationFrame", (fn: unknown) => queued.push(fn));
    vi.stubGlobal("setTimeout", (fn: unknown) => queued.push(fn));
    const pace = await import("../frame-pace");
    const stop = pace.onFrame(() => {});
    stop();
    const fn = queued.pop() as (t: number) => void;
    fn(16);
    expect(queued).toHaveLength(0);
  });
});
