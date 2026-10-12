import { useEffect, useRef } from "react";
import { createPresence, type PresenceHandle, type PresenceParams } from "@/lib/vyrse/presence-engine";
import { useVyrse } from "@/lib/vyrse/store";
import { IS_PHONE } from "@/services/phone";

const INTENSITY = { subtle: 0.72, balanced: 1, expressive: 1.35 } as const;
const REACTIVITY = { low: 0.5, medium: 1, high: 1.6 } as const;
const IDLE = { minimal: 0.6, normal: 1, lively: 1.45 } as const;
const DETAIL = { minimal: 0.45, reactive: 0.78, full: 1 } as const;

function readBg(el: HTMLElement): [number, number, number] {
  const raw = getComputedStyle(el).backgroundColor;
  const m = raw.match(/[\d.]+/g);
  if (!m || m.length < 3) return [14, 15, 18];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/**
 * Thin React shell around the presence renderer.
 * The renderer itself knows nothing about React and can be swapped out.
 */
export function VyrsePresence({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<PresenceHandle | null>(null);
  const seedRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const attentionRef = useRef(0);
  const { levelRef, presenceState, settings, resolvedTheme, settingsOpen, historyOpen } = useVyrse();
  // On the phone Settings and History cover the whole screen: nothing to draw behind them.
  const coveredRef = useRef(false);
  coveredRef.current = IS_PHONE && (settingsOpen || historyOpen);

  const stateRef = useRef(presenceState);
  stateRef.current = presenceState;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;

  // Pointer proximity — the presence leans very slightly toward the user.
  useEffect(() => {
    if (IS_PHONE) return; // touch has no hover to lean toward, and measuring on every move costs a layout
    const onMove = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) / Math.max(1, r.width);
      attentionRef.current = Math.max(0, Math.min(1, 1.15 - d));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let cancelled = false;
    let handle: PresenceHandle | null = null;
    let ro: ResizeObserver | null = null;

    // Phone: the orb draws in a worker on its own thread (OffscreenCanvas), so it can't make the UI stutter;
    // this side only forwards the live inputs once a frame.
    let post: ((params: PresenceParams) => void) | null = null;
    const create = (initial: PresenceParams): PresenceHandle => {
      if (!IS_PHONE || !("transferControlToOffscreen" in canvas)) return createPresence(canvas, initial);
      const worker = new Worker(new URL("../../lib/vyrse/presence-worker.ts", import.meta.url), { type: "module" });
      const offscreen = canvas.transferControlToOffscreen();
      const r = canvas.getBoundingClientRect();
      worker.postMessage(
        { type: "init", canvas: offscreen, params: { ...initial, dpr: window.devicePixelRatio || 1 }, width: r.width, height: r.height },
        [offscreen],
      );
      post = (params) => worker.postMessage({ type: "params", params });
      return {
        params: { ...initial },
        setSize: (width, height) => worker.postMessage({ type: "size", width, height }),
        resize: () => {},
        destroy: () => {
          worker.postMessage({ type: "destroy" });
          window.setTimeout(() => worker.terminate(), 200);
        },
      };
    };

    const boot = () => {
      if (cancelled) return;
      handle = create({
        state: "idle",
        level: 0,
        intensity: 1,
        reactivity: 1,
        idleActivity: 1,
        motion: 1,
        boot: 0,
        bg: readBg(document.body),
        contrast: 1,
        detail: 0.8,
        theme: themeRef.current,
        attention: 0,
        lite: IS_PHONE,
      });
      handleRef.current = handle;
      canvas.style.opacity = "1";
      if (seedRef.current) seedRef.current.style.opacity = "0";

      const start = performance.now();
      let coveredSince: number | null = null;
      const sync = () => {
        raf = requestAnimationFrame(sync);
        const s = settingsRef.current;
        const p = handle!.params;
        const elapsed = (performance.now() - start) / 1600;
        p.boot = Math.min(1, 1 - Math.pow(1 - Math.min(1, elapsed), 3));
        p.state = stateRef.current;
        p.level = levelRef.current;
        p.intensity = INTENSITY[s.presenceIntensity];
        p.reactivity = REACTIVITY[s.voiceReactivity];
        p.idleActivity = IDLE[s.idleActivity];
        p.detail = DETAIL[s.voiceVisualization];
        p.contrast = s.highContrast ? 1.25 : 1;
        p.theme = themeRef.current;
        p.attention += (attentionRef.current - p.attention) * 0.06;
        // Wait for the panel to finish sliding over before pausing, so the slide shows a live orb.
        if (coveredRef.current) {
          coveredSince ??= performance.now();
          p.paused = performance.now() - coveredSince > 600;
        } else {
          coveredSince = null;
          p.paused = false;
        }
        p.motion =
          s.animations === "off" || s.reducedMotion
            ? s.animations === "off"
              ? 0
              : 0.35
            : s.animations === "reduced"
              ? 0.55
              : 1;
        if (IS_PHONE && document.visibilityState === "hidden") p.paused = true;
        post?.(p);
      };
      raf = requestAnimationFrame(sync);

      // Layout size is reported straight to the renderer. This never touches
      // React state and only reallocates the render buffer on bucket changes,
      // so a 700ms layout animation costs two numbers per frame.
      ro = new ResizeObserver(([entry]) => {
        const r = entry?.contentRect;
        if (r) handle?.setSize(r.width, r.height);
      });
      ro.observe(canvas);
    };

    const id = requestAnimationFrame(() => requestAnimationFrame(boot));

    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      cancelAnimationFrame(raf);
      ro?.disconnect();
      handle?.destroy();
      handleRef.current = null;
    };
  }, [levelRef]);

  return (
    <div className={className} aria-hidden="true">
      <div ref={wrapRef} className="relative size-full">
        {/* Seed presence — a strictly radial, circular fade covering engine boot */}
        <div
          ref={seedRef}
          className="absolute inset-[34%] rounded-full transition-opacity duration-700"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--presence-primary) 26%, transparent) 0%, transparent 70%)",
          }}
        />
        <canvas
          ref={canvasRef}
          className="relative size-full opacity-0 transition-opacity duration-1000"
        />
      </div>
    </div>
  );
}
