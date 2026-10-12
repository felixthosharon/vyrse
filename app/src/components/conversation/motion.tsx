import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Motion for workspace items: staggered entrance slots, numbers that count up, a sparkline that draws in.
 * Everything settles instantly when animations are off (Settings) or the OS asks for reduced motion.
 */

/** Delay slot for the staggered entrance classes (vyr-rise, vyr-grow-y, vyr-pop…). */
export const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

export function motionOff(): boolean {
  if (typeof document === "undefined") return true;
  return (
    !!document.querySelector('[data-motion="off"]') ||
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** A number that counts up to `target` on arrival, and glides to each new value after that. */
export function useCountUp(target: number, ms = 1100, delay = 250): number {
  const [value, setValue] = useState(() => (motionOff() ? target : 0));
  const shown = useRef(value);
  const first = useRef(true);
  useEffect(() => {
    const initial = first.current;
    first.current = false;
    if (motionOff() || !Number.isFinite(target)) {
      shown.current = target;
      setValue(target);
      return;
    }
    const from = shown.current;
    if (from === target) return;
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t + (initial ? delay : 0);
      const k = Math.max(0, Math.min(1, (t - start) / ms));
      const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
      shown.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, delay]);
  return value;
}

const NUMBER_IN_TEXT = /^(.*?)([-+−]?\d[\d,]*(?:\.\d+)?)(.*)$/s;

/** Text like "1,240", "78°C", "+12%" or "6h 20m" with its (first) number counting up. */
export function CountUp({ value, className }: { value: string | number; className?: string }) {
  const text = String(value);
  const m = NUMBER_IN_TEXT.exec(text);
  const raw = m ? m[2]!.replace(/,/g, "").replace("−", "-") : "";
  const target = m ? Number(raw) : NaN;
  const v = useCountUp(Number.isFinite(target) ? target : 0);
  if (!m || !Number.isFinite(target)) return <span className={className}>{text}</span>;
  const decimals = raw.includes(".") ? raw.split(".")[1]!.length : 0;
  const shown = v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: m[2]!.includes(","),
  });
  return (
    <span className={cn("tabular-nums", className)}>
      {m[1]}
      {m[2]!.startsWith("+") && v >= 0 ? "+" : ""}
      {shown}
      {m[3]}
    </span>
  );
}

/** A small line for a stat tile: draws in, the latest value dotted. */
export function Sparkline({ data, hot = false }: { data: number[]; hot?: boolean }) {
  const w = 300;
  const h = 28;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map(
    (v, i) => [(i / (data.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)] as const,
  );
  const last = pts.at(-1)!;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-7 w-full overflow-visible" aria-hidden>
      <polyline
        points={pts.map((p) => p.join(",")).join(" ")}
        pathLength={1}
        fill="none"
        className={cn("vyr-draw", hot ? "stroke-accent" : "stroke-primary")}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r="3"
        className={cn("vyr-pop", hot ? "fill-accent" : "fill-primary")}
        style={stagger(18)}
      />
    </svg>
  );
}
