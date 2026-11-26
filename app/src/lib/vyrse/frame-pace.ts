/**
 * One paced frame loop for everything in VYRSE that moves all the time: the orb, its inputs, the voice level
 * and the endless CSS animations (background drift, light sweep, blinking caret, the workspace blobs...).
 *
 * Why (measured 2026-11-26, 2560x1380 window on a 179 Hz monitor): each frame the window shows costs about the
 * same however little changes in it. A 4 px dot changing every screen refresh took ~29% of a core; the
 * background drift alone kept VYRSE showing 179 frames a second even with the orb capped. So every continuous
 * animation runs on this one clock, at most `maxFps` frames a second (60 while VYRSE has focus, 30 while it
 * doesn't), all in the same frames. Between frames it sleeps on a timer, not on the screen's refresh, so the
 * page isn't woken 179 times a second for nothing.
 *
 * Short one-off animations (a panel sliding in, a hover) stay with the browser at full smoothness.
 * Works on the page and inside a worker (the phone draws the orb in one; it gets its own copy of this module).
 */

type FrameFn = (now: number) => void;

const subscribers = new Set<FrameFn>();
let maxFps = 60;
let raf = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** when the next frame may run */
let due = 0;

/** Most frames a second for every subscriber (VYRSE: 60 focused, 30 not). */
export function setMaxFps(fps: number): void {
  maxFps = Math.max(1, Math.min(240, fps));
}

/** Run `fn` on every paced frame until the returned function is called. */
export function onFrame(fn: FrameFn): () => void {
  subscribers.add(fn);
  schedule(performance.now());
  return () => {
    subscribers.delete(fn);
  };
}

function tick(now: number): void {
  raf = 0;
  if (subscribers.size === 0) return;
  const interval = 1000 / maxFps;
  // `due` moves on by a whole frame each time, so the average rate holds even when the screen's frames don't
  // divide evenly (144 Hz still gives 60, not 48). The 1.5 ms slack takes a screen frame that lands a hair early.
  if (now >= due - 1.5) {
    due = now - due > interval ? now + interval : due + interval;
    for (const fn of subscribers) {
      try {
        fn(now);
      } catch (err) {
        console.error("frame:", err);
      }
    }
  }
  schedule(now);
}

function schedule(now: number): void {
  if (subscribers.size === 0 || raf || timer) return;
  // Sleep until just before the next frame is due, then ask for the screen frame after that.
  const wait = due - now - 4;
  if (wait > 1) {
    timer = setTimeout(() => {
      timer = null;
      if (!raf) raf = requestAnimationFrame(tick);
    }, wait);
  } else {
    raf = requestAnimationFrame(tick);
  }
}

/**
 * Put the page's endless CSS animations on the paced clock: each is paused and stepped forward only on paced
 * frames, so it looks the same (same keyframes, same easing, same speed) but no longer makes the browser show
 * a frame on every screen refresh. New ones (a caret appears, a panel opens) are picked up within a second.
 */
export function paceEndlessAnimations(root: Document = document): () => void {
  let held: { anim: Animation; offset: number }[] = [];
  /** every animation this has paused, so one it let go of (motion turned off and on again) is picked up again */
  const ours = new WeakSet<Animation>();
  let lastScan = -Infinity;
  const scan = (now: number) => {
    lastScan = now;
    const next: typeof held = [];
    for (const anim of root.getAnimations()) {
      if (anim.playState === "idle" || anim.playState === "finished") continue;
      if (anim.effect?.getTiming().iterations !== Infinity) continue;
      const known = held.find((h) => h.anim === anim);
      if (known) {
        next.push(known);
        continue;
      }
      if (anim.playState !== "running" && !ours.has(anim)) continue; // paused by someone else
      const t = Number(anim.currentTime ?? 0);
      anim.pause();
      ours.add(anim);
      next.push({ anim, offset: t - now });
    }
    held = next;
  };
  const stop = onFrame((now) => {
    if (now - lastScan > 1000) scan(now);
    for (const h of held) {
      // The page removed it (element gone, motion turned off): leave it alone; the next scan drops it.
      if (h.anim.playState === "idle") continue;
      h.anim.currentTime = now + h.offset;
    }
  });
  return () => {
    stop();
    for (const h of held) if (h.anim.playState === "paused") h.anim.play();
    held = [];
  };
}
