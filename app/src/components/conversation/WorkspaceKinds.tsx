import {
  BatteryMedium,
  BookOpen,
  Check,
  Bug,
  Calendar,
  ChartColumn,
  CircleCheck,
  CircleDot,
  Clock,
  Cloud,
  CloudLightning,
  CloudRain,
  CloudSun,
  Code2,
  Cpu,
  Dumbbell,
  Flame,
  Folder,
  Gamepad2,
  GraduationCap,
  HardDrive,
  Heart,
  House,
  Lightbulb,
  Mail,
  MapPin,
  MemoryStick,
  Monitor,
  Moon,
  Music,
  Newspaper,
  Plane,
  Rocket,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Snowflake,
  Star,
  Sun,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Trophy,
  User,
  Utensils,
  Wallet,
  Wifi,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@/lib/vyrse/types";
import { formMessage, type WorkspaceUpdate } from "@/services/hermes/workspace-interact";
import { cn } from "@/lib/utils";
import { Ring } from "./ArtifactKinds";
import { CountUp, motionOff, stagger, useCountUp } from "./motion";
import { playUiSound } from "@/lib/vyrse/ui-sounds";

/**
 * Workspace kinds for dashboards: column and line charts that build themselves, gauges, sparklines, icon
 * cards, weather, a focus timer, a kanban board, a heatmap, running logs and sandboxed mini apps.
 * Entrances follow the reels: cards flip up one after another, bars grow, lines draw, numbers count up.
 */

export function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/* ------------------------------------------------------------------------------------------ charts */

/**
 * Vertical columns (the reels' "GPU temps this week"): bars grow in one after another, the called-out bar
 * (the highlight, else the peak) glows hot, a threshold draws as a dashed line.
 */
export function Columns({
  data,
  unit = "",
  highlight,
  threshold,
}: {
  data: { label: string; value: number }[];
  unit?: string | undefined;
  highlight?: string | undefined;
  threshold?: number | undefined;
}) {
  const values = data.map((d) => d.value);
  const top = Math.max(...values, threshold ?? -Infinity);
  const low = Math.min(...values);
  // Values bunched far from zero (temps 61-78) start the axis lower, so the differences show.
  const base =
    low > 0 && (top - low) / top < 0.35
      ? Math.max(0, low - (top - low) * 0.8 - top * 0.05)
      : Math.min(0, low);
  const span = Math.max(1e-9, top - base);
  const pct = (v: number) => Math.max(2, ((v - base) / span) * 100);
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]!).label;
  const hot = highlight ?? (data.length > 1 ? peak : undefined);
  const sparse = data.length <= 12;
  return (
    <div>
      <div className="relative flex h-48 items-end gap-[clamp(3px,1.8%,14px)] border-b border-border-strong">
        {threshold !== undefined && threshold > base && (
          <div
            className="vyr-fade pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-accent/70"
            style={{ bottom: `${pct(threshold) * 0.86}%` }}
          >
            <span className="absolute -top-4 right-0 font-mono text-[10px] text-accent">
              {fmt(threshold)}
              {unit}
            </span>
          </div>
        )}
        {data.map((d, i) => {
          const isHot = d.label === hot || (threshold !== undefined && d.value >= threshold);
          return (
            <div
              key={`${d.label}-${i}`}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
            >
              {(sparse || d.label === hot) && (
                <span
                  className={cn(
                    "vyr-rise truncate font-mono text-[10.5px]",
                    isHot ? "text-accent" : "text-muted-foreground",
                  )}
                  style={stagger(i + 4)}
                >
                  <CountUp value={fmt(d.value)} />
                  {unit}
                </span>
              )}
              <div
                className={cn(
                  "vyr-grow-y w-full rounded-t-[0.55rem] rounded-b-[3px] transition-[height] duration-700 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
                  isHot
                    ? "bg-gradient-to-b from-accent to-accent/25 shadow-[0_0_26px_-4px] shadow-accent/70"
                    : "bg-gradient-to-b from-primary to-primary/15",
                )}
                style={{ height: `${pct(d.value) * 0.86}%`, ...stagger(i) }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-[clamp(3px,1.8%,14px)] pt-2">
        {data.map((d, i) => (
          <span
            key={`${d.label}-${i}`}
            className={cn(
              "min-w-0 flex-1 truncate text-center font-mono text-[10.5px]",
              d.label === hot ? "text-accent" : "text-muted-foreground",
            )}
          >
            {sparse || i % Math.ceil(data.length / 8) === 0 ? d.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bars, for long category names or many categories. */
export function Bars({
  data,
  unit = "",
  highlight,
}: {
  data: { label: string; value: number }[];
  unit?: string | undefined;
  highlight?: string | undefined;
}) {
  const max = Math.max(1e-9, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => {
        const hot = d.label === highlight;
        return (
          <div
            key={`${d.label}-${i}`}
            className="vyr-rise grid grid-cols-[minmax(4rem,9rem)_1fr_auto] items-center gap-3"
            style={stagger(i)}
          >
            <span
              className={cn(
                "truncate font-mono text-[11px]",
                hot ? "text-accent" : "text-muted-foreground",
              )}
            >
              {d.label}
            </span>
            <span className="h-2.5 overflow-hidden rounded-full bg-secondary/50">
              <span
                className={cn(
                  "vyr-grow-x block h-full rounded-full transition-[width] duration-700",
                  hot ? "bg-accent shadow-[0_0_14px] shadow-accent/60" : "bg-primary/80",
                )}
                style={{ width: `${(Math.abs(d.value) / max) * 100}%`, ...stagger(i) }}
              />
            </span>
            <span className={cn("font-mono text-[11px]", hot ? "text-accent" : "text-foreground")}>
              {fmt(d.value)}
              {unit}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A line that draws itself in; dots pop along it; a threshold and a called-out point when asked. */
export function LineChart({
  data,
  unit = "",
  highlight,
  threshold,
}: {
  data: { label: string; value: number }[];
  unit?: string | undefined;
  highlight?: string | undefined;
  threshold?: number | undefined;
}) {
  const width = 760;
  const height = 260;
  const pad = { l: 44, r: 36, t: 26, b: 44 };
  const values = data.map((d) => d.value);
  const max = Math.max(1, ...values, threshold ?? 0);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const xStep = data.length > 1 ? (width - pad.l - pad.r) / (data.length - 1) : 0;
  const y = (v: number) => pad.t + (height - pad.t - pad.b) * (1 - (v - min) / span);
  const points = data.map((d, i) => ({
    x: data.length === 1 ? width / 2 : pad.l + i * xStep,
    y: y(d.value),
    label: d.label,
    value: d.value,
  }));
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const area = points.length
    ? `${path} L ${points.at(-1)!.x.toFixed(1)},${height - pad.b} L ${points[0]!.x.toFixed(1)},${height - pad.b} Z`
    : "";
  const dense = points.length > 14;
  const step = Math.ceil(points.length / 8);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Line chart"
      className="h-auto w-full overflow-visible"
    >
      <defs>
        <linearGradient id="vyr-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((r) => {
        const gy = pad.t + (height - pad.t - pad.b) * (1 - r);
        return (
          <g key={r}>
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={gy}
              y2={gy}
              className="stroke-border"
              strokeWidth="1"
            />
            <text
              x={pad.l - 8}
              y={gy + 4}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[10px]"
            >
              {fmt(min + span * r)}
              {unit}
            </text>
          </g>
        );
      })}
      <line
        x1={pad.l}
        x2={width - pad.r}
        y1={height - pad.b}
        y2={height - pad.b}
        className="stroke-border-strong"
      />
      {threshold !== undefined && (
        <g className="vyr-fade">
          <line
            x1={pad.l}
            x2={width - pad.r}
            y1={y(threshold)}
            y2={y(threshold)}
            className="stroke-accent/80"
            strokeDasharray="6 6"
            strokeWidth="1.5"
          />
          <text
            x={width - pad.r}
            y={y(threshold) - 7}
            textAnchor="end"
            className="fill-accent font-mono text-[10px]"
          >
            {fmt(threshold)}
            {unit}
          </text>
        </g>
      )}
      {area && <path d={area} fill="url(#vyr-area)" className="vyr-fade" />}
      {path && (
        <path
          d={path}
          pathLength={1}
          fill="none"
          className="vyr-draw stroke-primary"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {points.map((p, i) => {
        const hot = p.label === highlight || (threshold !== undefined && p.value >= threshold);
        const showLabel = i % step === 0 || i === points.length - 1;
        return (
          <g key={`${p.label}-${i}`}>
            {(!dense || hot) && (
              <circle
                cx={p.x}
                cy={p.y}
                r={hot ? 6.5 : 5}
                className={cn(
                  "vyr-pop",
                  hot ? "fill-accent stroke-background vyr-hot" : "fill-background stroke-primary",
                )}
                strokeWidth="3"
                style={stagger(Math.round((i / Math.max(1, points.length - 1)) * 20))}
              />
            )}
            {showLabel && (
              <text
                x={p.x}
                y={height - 18}
                textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                className="fill-muted-foreground font-mono text-[10px]"
              >
                {p.label}
              </text>
            )}
            {(!dense || p.label === highlight) && (
              <text
                x={p.x}
                y={p.y - 12}
                textAnchor="middle"
                className={cn(
                  "vyr-pop font-mono text-[10px]",
                  hot ? "fill-accent" : "fill-foreground",
                )}
                style={stagger(Math.round((i / Math.max(1, points.length - 1)) * 20) + 2)}
              >
                {fmt(p.value)}
                {unit}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------ gauges */

const ARC = "M 10 60 A 50 50 0 0 1 110 60";
const GAUGE_TONES = ["stroke-primary", "stroke-success", "stroke-trace", "stroke-primary"] as const;

function Gauge({ g, i }: { g: NonNullable<Artifact["gauges"]>[number]; i: number }) {
  const [on, setOn] = useState(motionOff() ? 1 : 0);
  useEffect(() => {
    const id = setTimeout(() => setOn(1), 120 + i * 120);
    return () => clearTimeout(id);
  }, [i]);
  const frac = clamp01(g.value / g.max);
  const hot = g.warn !== undefined && g.value >= g.warn;
  const v = useCountUp(g.value, 1200, 120 + i * 120);
  const warnAngle = g.warn !== undefined ? Math.PI * (1 - clamp01(g.warn / g.max)) : null;
  return (
    <div className="vyr-rise flex w-[9.5rem] flex-col items-center" style={stagger(i)}>
      <div className="relative w-full">
        <svg viewBox="0 0 120 66" className={cn("w-full overflow-visible", hot && "vyr-hot")}>
          <path
            d={ARC}
            pathLength={100}
            fill="none"
            className="stroke-secondary/70"
            strokeWidth={10}
            strokeLinecap="round"
          />
          <path
            d={ARC}
            pathLength={100}
            fill="none"
            className={cn(
              hot ? "stroke-accent" : GAUGE_TONES[i % GAUGE_TONES.length],
              "transition-[stroke-dasharray] duration-[1300ms] ease-[cubic-bezier(0.16,0.84,0.24,1)]",
            )}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${(frac * 100 * on).toFixed(2)} 100`}
          />
          {warnAngle !== null && (
            <line
              x1={60 + 41 * Math.cos(warnAngle)}
              y1={60 - 41 * Math.sin(warnAngle)}
              x2={60 + 58 * Math.cos(warnAngle)}
              y2={60 - 58 * Math.sin(warnAngle)}
              className="stroke-accent/80"
              strokeWidth={2}
              strokeLinecap="round"
            />
          )}
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center leading-none">
          <span
            className={cn(
              "font-display text-[26px] font-semibold tabular-nums",
              hot ? "text-accent" : "text-foreground",
            )}
          >
            {fmt(Math.round(v * 10) / 10)}
          </span>
          <span className="ml-0.5 font-mono text-[11px] text-muted-foreground">{g.unit ?? ""}</span>
        </div>
      </div>
      <p className="mt-2 truncate text-[13px] text-foreground">{g.label}</p>
      <p className={cn("font-mono text-[10.5px]", hot ? "text-accent" : "text-muted-foreground")}>
        {hot
          ? `over ${fmt(g.warn!)}${g.unit ?? ""}`
          : g.unit === "%"
            ? `of 100%`
            : `max ${fmt(g.max)}${g.unit ?? ""}`}
      </p>
    </div>
  );
}

export function Gauges({ data }: { data: NonNullable<Artifact["gauges"]> }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-5 gap-y-4">
      {data.map((g, i) => (
        <Gauge key={`${g.label}-${i}`} g={g} i={i} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- cards */

const TONE = {
  primary: "border-primary/25 bg-primary/10 text-primary",
  accent: "border-accent/25 bg-accent/10 text-accent",
  success: "border-success/25 bg-success/10 text-success",
  trace: "border-trace/25 bg-trace/10 text-trace",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
} as const;

/** The icons a card may name (the plugin offers the same list). */
export const CARD_ICONS: Record<string, { icon: LucideIcon; tone: keyof typeof TONE }> = {
  sun: { icon: Sun, tone: "accent" },
  cloud: { icon: Cloud, tone: "trace" },
  rain: { icon: CloudRain, tone: "trace" },
  snow: { icon: Snowflake, tone: "primary" },
  wind: { icon: Wind, tone: "trace" },
  storm: { icon: CloudLightning, tone: "accent" },
  calendar: { icon: Calendar, tone: "primary" },
  clock: { icon: Clock, tone: "primary" },
  news: { icon: Newspaper, tone: "trace" },
  mail: { icon: Mail, tone: "primary" },
  music: { icon: Music, tone: "success" },
  game: { icon: Gamepad2, tone: "primary" },
  cpu: { icon: Cpu, tone: "primary" },
  gpu: { icon: Monitor, tone: "primary" },
  memory: { icon: MemoryStick, tone: "primary" },
  disk: { icon: HardDrive, tone: "primary" },
  battery: { icon: BatteryMedium, tone: "success" },
  wifi: { icon: Wifi, tone: "primary" },
  shield: { icon: ShieldCheck, tone: "success" },
  check: { icon: CircleCheck, tone: "success" },
  alert: { icon: TriangleAlert, tone: "accent" },
  heart: { icon: Heart, tone: "danger" },
  fire: { icon: Flame, tone: "accent" },
  star: { icon: Star, tone: "accent" },
  book: { icon: BookOpen, tone: "primary" },
  money: { icon: Wallet, tone: "success" },
  cart: { icon: ShoppingCart, tone: "primary" },
  food: { icon: Utensils, tone: "accent" },
  phone: { icon: Smartphone, tone: "primary" },
  home: { icon: House, tone: "primary" },
  trophy: { icon: Trophy, tone: "accent" },
  rocket: { icon: Rocket, tone: "primary" },
  idea: { icon: Lightbulb, tone: "accent" },
  user: { icon: User, tone: "primary" },
  map: { icon: MapPin, tone: "danger" },
  chart: { icon: ChartColumn, tone: "primary" },
  code: { icon: Code2, tone: "primary" },
  bug: { icon: Bug, tone: "danger" },
  plane: { icon: Plane, tone: "primary" },
  gym: { icon: Dumbbell, tone: "success" },
  sleep: { icon: Moon, tone: "trace" },
  study: { icon: GraduationCap, tone: "primary" },
  up: { icon: TrendingUp, tone: "success" },
  down: { icon: TrendingDown, tone: "accent" },
};

/** Glass cards that flip up one after another (the reels' morning briefing). */
export function InfoCards({ data }: { data: NonNullable<Artifact["cards"]> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))] gap-2.5">
      {data.map((c, i) => {
        const meta = CARD_ICONS[c.icon ?? ""];
        const Icon = meta?.icon ?? CircleDot;
        return (
          <div
            key={`${c.label}-${i}`}
            className="vyr-flip-up relative overflow-hidden rounded-2xl border border-border bg-secondary/20 px-3.5 py-3"
            style={stagger(i)}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-foreground/[0.04] to-transparent"
            />
            <div className="relative flex items-center gap-2">
              <span
                className={cn(
                  "vyr-pop grid size-6 shrink-0 place-items-center rounded-md border",
                  TONE[meta?.tone ?? "primary"],
                )}
                style={stagger(i * 2 + 1)}
              >
                <Icon className="size-3.5" strokeWidth={1.8} />
              </span>
              <span className="eyebrow truncate">{c.label}</span>
            </div>
            {c.value && (
              <p className="relative mt-2 font-display text-[28px] leading-none font-semibold tracking-tight text-foreground">
                <CountUp value={c.value} />
              </p>
            )}
            {c.detail && (
              <p className="relative mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-foreground/90">
                {c.detail}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- weather */

export function weatherIcon(condition: string): { icon: LucideIcon; tone: string } {
  const c = condition.toLowerCase();
  if (/thunder|storm/.test(c)) return { icon: CloudLightning, tone: "text-accent" };
  if (/snow|sleet|ice/.test(c)) return { icon: Snowflake, tone: "text-primary" };
  if (/rain|drizzle|shower/.test(c)) return { icon: CloudRain, tone: "text-trace" };
  if (/partly|partial|sun.*cloud|cloud.*sun/.test(c))
    return { icon: CloudSun, tone: "text-accent" };
  if (/cloud|overcast|mist|fog|haze/.test(c)) return { icon: Cloud, tone: "text-muted-foreground" };
  if (/wind|breez/.test(c)) return { icon: Wind, tone: "text-trace" };
  return { icon: Sun, tone: "text-accent" };
}

export function Weather({ data }: { data: NonNullable<Artifact["weather"]> }) {
  const { icon: Icon, tone } = weatherIcon(data.condition);
  const t = useCountUp(data.temp);
  return (
    <div>
      <div className="flex items-center gap-4">
        <span className="vyr-pop" style={stagger(0)}>
          <Icon className={cn("vyr-float size-16 shrink-0", tone)} strokeWidth={1.2} />
        </span>
        <div className="min-w-0">
          <p className="eyebrow truncate">{data.location} · now</p>
          <p className="mt-0.5 truncate text-[17px] text-foreground">{data.condition || "—"}</p>
          {(data.high !== undefined || data.low !== undefined) && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {data.high !== undefined && `H ${fmt(data.high)}°`}
              {data.high !== undefined && data.low !== undefined && " · "}
              {data.low !== undefined && `L ${fmt(data.low)}°`}
            </p>
          )}
        </div>
        <p className="ml-auto shrink-0 font-display text-[60px] leading-none font-semibold tracking-[-0.05em] text-foreground tabular-nums">
          {Math.round(t)}
          <span className="text-[0.55em] text-muted-foreground">{data.unit}</span>
        </p>
      </div>
      {data.forecast && (
        <div className="mt-4 grid auto-cols-fr grid-flow-col gap-1.5 border-t border-border/70 pt-3">
          {data.forecast.map((f, i) => {
            const day = weatherIcon(f.label);
            const DayIcon = day.icon;
            return (
              <div
                key={`${f.at}-${i}`}
                className="vyr-rise flex flex-col items-center gap-1 rounded-xl py-1.5"
                style={stagger(i + 2)}
                title={f.label}
              >
                <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                  {f.at}
                </span>
                <DayIcon className={cn("size-5", day.tone)} strokeWidth={1.5} />
                <span className="text-[13px] text-foreground tabular-nums">{fmt(f.value)}°</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- timer */

/** A focus countdown that runs by itself; a low bell sounds if it finishes while on screen. */
export function Timer({ data, onUpdate }: { data: NonNullable<Artifact["timer"]>; onUpdate?: ((u: WorkspaceUpdate) => void) | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  const paused = data.paused_left !== undefined;
  const left = paused ? data.paused_left! : Math.max(0, data.ends_at - now);
  const done = !paused && left <= 0;
  const running = useRef(!done);
  useEffect(() => {
    if (done || paused) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [done, paused, data.ends_at]);
  useEffect(() => {
    if (!done) running.current = true;
    else if (running.current) {
      running.current = false;
      if (!data.stopped) playUiSound("done");
    }
  }, [done, data.stopped]);
  const secs = Math.ceil(left / 1000);
  // A countdown to a date (days away) reads as days and hours; a focus timer as minutes and seconds.
  const long = data.seconds >= 86_400;
  const clock =
    secs >= 86_400
      ? `${Math.floor(secs / 86_400)}d ${Math.floor((secs % 86_400) / 3600)}h`
      : secs >= 3600
        ? `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`
        : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const control = (label: string, action: "pause" | "resume" | "add" | "stop", primary = false) => (
    <button
      type="button"
      onClick={() => {
        playUiSound("tick-soft");
        onUpdate?.({ op: "timer", args: action === "add" ? { action, minutes: 5 } : { action } });
      }}
      className={cn(
        "rounded-full px-3 py-1 text-[12px] transition-colors focus-visible:outline-none",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "liquid-hover relative border border-border text-foreground/85 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-5">
      <Ring
        fraction={done ? 1 : left / (data.seconds * 1000)}
        size={128}
        stroke={8}
        tone={done ? 2 : 0}
      >
        <span>
          <span
            className={cn(
              "block font-display leading-none font-semibold tabular-nums transition-opacity",
              !done && clock.length > 5 ? "text-[22px]" : "text-[28px]",
              done ? "text-success" : "text-foreground",
              paused && "animate-pulse opacity-70",
            )}
          >
            {done ? "0:00" : clock}
          </span>
          <span className={cn("eyebrow mt-1 block", done && "text-success")}>
            {done ? (data.stopped ? "stopped" : "done") : paused ? "paused" : long ? "to go" : "left"}
          </span>
        </span>
      </Ring>
      <div className="min-w-0">
        <p className="truncate font-display text-[16px] text-foreground">{data.label}</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {done
            ? data.stopped ? "Stopped early." : "Time's up."
            : paused
              ? "On hold."
              : long
                ? `until ${new Date(data.ends_at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`
                : `${fmt(data.seconds / 60)} min · ends ${new Date(data.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        </p>
        {onUpdate && !long && (
          <div data-card-chrome className="mt-3 flex flex-wrap gap-1.5">
            {done ? (
              control("+5 min", "add", true)
            ) : (
              <>
                {paused ? control("Resume", "resume", true) : control("Pause", "pause", true)}
                {control("+5 min", "add")}
                {control("Stop", "stop")}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- board */

export function Board({ data, onUpdate }: { data: NonNullable<Artifact["board"]>; onUpdate?: ((u: WorkspaceUpdate) => void) | undefined }) {
  // Drag a card to another column (or tap it, then tap where it goes: works on the phone too).
  const [drag, setDrag] = useState<{ col: number; label: string } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ col: number; label: string } | null>(null);
  const move = (from: number, to: number, label: string) => {
    setPicked(null);
    if (from === to || !onUpdate) return;
    playUiSound(/\b(done|complete|completed|finished)\b/i.test(data[to]?.name ?? "") ? "tick" : "tick-soft");
    onUpdate({ op: "board_move", args: { from, to, label } });
  };
  return (
    <div className="field-scroll-x -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1">
      {data.map((col, c) => {
        const done = /\b(done|complete|completed|finished)\b/i.test(col.name);
        const target = (drag && drag.col !== c && over === c) || (picked && picked.col !== c);
        return (
          <div
            key={col.name}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              e.stopPropagation();
              setOver(c);
            }}
            onDragLeave={() => setOver((o) => (o === c ? null : o))}
            onDrop={(e) => {
              if (!drag) return;
              e.preventDefault();
              e.stopPropagation();
              move(drag.col, c, drag.label);
              setDrag(null);
              setOver(null);
            }}
            onClick={() => picked && picked.col !== c && move(picked.col, c, picked.label)}
            className={cn(
              "vyr-rise flex min-w-[9.25rem] flex-1 flex-col rounded-2xl border bg-secondary/15 p-2 transition-[border-color,background-color] duration-200",
              target ? "border-primary/55 bg-primary/[0.06]" : "border-border",
              picked && picked.col !== c && "cursor-pointer",
            )}
            style={stagger(c)}
          >
            <div className="flex items-center justify-between gap-2 px-1.5 pb-2">
              <span className={cn("eyebrow truncate", done && "text-success")}>{col.name}</span>
              <span className="rounded-full bg-secondary/70 px-1.5 font-mono text-[10.5px] text-muted-foreground">
                {col.cards.length}
              </span>
            </div>
            <div className="min-h-[2.5rem] space-y-1.5">
              {col.cards.map((k, i) => {
                const isPicked = picked?.col === c && picked.label === k.label;
                return (
                  <div
                    key={`${k.label}-${i}`}
                    draggable={!!onUpdate}
                    onDragStart={(e) => {
                      e.stopPropagation(); // a task, not the whole card
                      e.dataTransfer.effectAllowed = "move";
                      setDrag({ col: c, label: k.label });
                    }}
                    onDragEnd={(e) => {
                      e.stopPropagation();
                      setDrag(null);
                      setOver(null);
                    }}
                    onClick={(e) => {
                      if (!onUpdate) return;
                      e.stopPropagation();
                      setPicked(isPicked ? null : { col: c, label: k.label });
                    }}
                    className={cn(
                      "vyr-flip-up rounded-xl border bg-card px-2.5 py-2 transition-[border-color,box-shadow,opacity] duration-200",
                      onUpdate && "cursor-grab active:cursor-grabbing",
                      isPicked ? "border-primary/70 shadow-[0_0_0_3px] shadow-primary/15" : "border-border hover:border-border-strong",
                      drag?.col === c && drag.label === k.label && "opacity-40",
                    )}
                    style={stagger(c + i + 1)}
                  >
                    <p
                      className={cn(
                        "text-[13px] leading-snug",
                        done
                          ? "text-muted-foreground line-through decoration-border-strong"
                          : "text-foreground",
                      )}
                    >
                      {k.label}
                    </p>
                    {k.note && (
                      <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{k.note}</p>
                    )}
                    {isPicked && (
                      <p className="mt-1 font-mono text-[10px] text-primary">tap a column to move it</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- heatmap */

const HEAT = [
  "bg-secondary/55",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function Heatmap({ data }: { data: NonNullable<Artifact["heatmap"]> }) {
  const cells = data.cells;
  const max = Math.max(1e-9, ...cells.map((c) => c.value));
  const level = (v: number | undefined) =>
    !v || v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4));
  const total = cells.reduce((s, c) => s + c.value, 0);
  const best = cells.reduce((a, b) => (b.value > a.value ? b : a), cells[0]!);
  const unit = data.unit ? ` ${data.unit}` : "";
  const footer = (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] text-muted-foreground">
      <span>
        total {fmt(total)}
        {unit} · best {best.label} ({fmt(best.value)}
        {unit})
      </span>
      <span className="flex items-center gap-1">
        less
        {HEAT.map((c) => (
          <span key={c} className={cn("size-2.5 rounded-[3px]", c)} />
        ))}
        more
      </span>
    </div>
  );
  if (cells.every((c) => ISO_DAY.test(c.label))) {
    // A calendar: one column per week, Monday on top.
    const byDay = new Map(cells.map((c) => [c.label, c.value]));
    const days = [...byDay.keys()].sort();
    const first = new Date(`${days[0]}T00:00`);
    const last = new Date(`${days.at(-1)}T00:00`);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const weeks: { label: string; value?: number }[][] = [];
    for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if ((d.getDay() + 6) % 7 === 0) weeks.push([]);
      weeks.at(-1)!.push({ label: key, value: byDay.get(key) });
    }
    return (
      <div>
        <div className="field-scroll-x flex gap-1.5 overflow-x-auto pb-1">
          <div className="grid shrink-0 grid-rows-7 gap-[3px] pr-1 font-mono text-[9px] leading-[14px] text-muted-foreground">
            {["M", "", "W", "", "F", "", "S"].map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          {weeks.map((week, w) => (
            <div key={w} className="grid shrink-0 grid-rows-7 gap-[3px]">
              {week.map((c, d) => (
                <span
                  key={c.label}
                  title={c.value !== undefined ? `${c.label}: ${fmt(c.value)}${unit}` : c.label}
                  className={cn("vyr-pop size-[14px] rounded-[3px]", HEAT[level(c.value)])}
                  style={stagger(w + d)}
                />
              ))}
            </div>
          ))}
        </div>
        {footer}
      </div>
    );
  }
  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(3.4rem,1fr))] gap-1.5">
        {cells.map((c, i) => (
          <div
            key={`${c.label}-${i}`}
            title={`${c.label}: ${fmt(c.value)}${unit}`}
            className={cn(
              "vyr-pop flex aspect-square flex-col items-center justify-center rounded-lg px-1 text-center",
              HEAT[level(c.value)],
            )}
            style={stagger(i)}
          >
            <span
              className={cn(
                "font-mono text-[12px] tabular-nums",
                level(c.value) >= 3 ? "text-primary-foreground" : "text-foreground",
              )}
            >
              {fmt(c.value)}
            </span>
            <span
              className={cn(
                "w-full truncate font-mono text-[9px]",
                level(c.value) >= 3 ? "text-primary-foreground/80" : "text-muted-foreground",
              )}
            >
              {c.label}
            </span>
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- log */

/** A vyrse_log log (the reels' study log): today's total big, the week, the latest entries. */
export function LogView({ data }: { data: NonNullable<Artifact["log"]> }) {
  const today = useCountUp(data.today);
  const max = Math.max(1e-9, ...data.days.map((d) => d.value));
  const counted = data.unit === "entries";
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-baseline gap-2">
            <span className="font-display text-[52px] leading-none font-semibold tracking-[-0.04em] text-foreground tabular-nums [text-shadow:0_0_40px_color-mix(in_oklab,var(--success)_35%,transparent)]">
              {fmt(Math.round(today * 10) / 10)}
            </span>
            <span className="font-mono text-[11.5px] tracking-[0.14em] text-success uppercase">
              {data.unit ? `${data.unit} today` : "today"}
            </span>
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            {data.today_count} {data.today_count === 1 ? "entry" : "entries"} today · {data.count}{" "}
            in all
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="rounded-full border border-border bg-secondary/30 px-2.5 py-0.5 font-mono text-[11px] text-foreground/90">
            7 days · {fmt(data.week)} {data.unit}
          </span>
          {data.streak > 1 && (
            <span className="flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 font-mono text-[11px] text-accent">
              <Flame className="size-3" strokeWidth={2} /> {data.streak}-day streak
            </span>
          )}
        </div>
      </div>
      {data.days.length > 0 && (
        <div className="mt-4">
          <div className="flex h-14 items-end gap-1.5">
            {data.days.map((d, i) => {
              const isToday = i === data.days.length - 1;
              return (
                <div
                  key={`${d.label}-${i}`}
                  title={`${d.label}: ${fmt(d.value)} ${data.unit}`}
                  className={cn(
                    "vyr-grow-y flex-1 rounded-t-md rounded-b-[2px]",
                    isToday
                      ? "bg-success shadow-[0_0_18px_-4px] shadow-success/70"
                      : "bg-primary/40",
                  )}
                  style={{ height: `${Math.max(4, (d.value / max) * 100)}%`, ...stagger(i) }}
                />
              );
            })}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            {data.days.map((d, i) => (
              <span
                key={`${d.label}-${i}`}
                className={cn(
                  "flex-1 truncate text-center font-mono text-[9.5px]",
                  i === data.days.length - 1 ? "text-success" : "text-muted-foreground",
                )}
              >
                {d.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {data.entries.length > 0 && (
        <ul className="mt-4 space-y-0.5">
          {data.entries.map((e, i) => (
            <li
              key={`${e.at}-${e.label}-${i}`}
              className={cn(
                "grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-[13px]",
                i === 0 && data.fresh ? "vyr-row-new" : "vyr-rise",
              )}
              style={stagger(i + 6)}
            >
              <span className="font-mono text-[10.5px] text-muted-foreground">{e.at}</span>
              <span
                className={cn(
                  "truncate",
                  i === 0 && data.fresh ? "text-foreground" : "text-foreground/85",
                )}
              >
                {e.label || "—"}
              </span>
              {!counted && e.value !== undefined && (
                <span
                  className={cn(
                    "font-mono text-[12px] tabular-nums",
                    i === 0 && data.fresh ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {fmt(e.value)} {data.unit}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------------- mini apps */

/** Theme colours a mini app can use as CSS variables (--bg, --fg…), taken from the card it sits in. */
const APP_THEME: Record<string, string> = {
  bg: "--background",
  fg: "--foreground",
  muted: "--muted-foreground",
  primary: "--primary",
  "primary-fg": "--primary-foreground",
  accent: "--accent",
  success: "--success",
  danger: "--destructive",
  card: "--secondary",
  border: "--border-strong",
};

/**
 * A page Hermes wrote (kind=app), in a sandboxed frame: scripts run, but with an opaque origin, no network
 * (the frame's CSP), no VYRSE bridge, no navigation or popups. It reports its height so the card fits it.
 */
export function AppFrame({ html, title, onSend }: { html: string; title: string; onSend?: ((text: string) => void) | undefined }) {
  const lastSend = useRef(0);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  // The frame's colour scheme must match its page's, or the browser paints an opaque backdrop behind it.
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const d = e.data as { type?: unknown; height?: unknown } | null;
      if (
        d?.type === "vyrse-app-height" &&
        typeof d.height === "number" &&
        Number.isFinite(d.height)
      )
        setHeight(Math.max(60, Math.min(1400, Math.ceil(d.height))));
      // vyrse.send("…") from the page: a message to VYRSE as the user's (at most one every 3 s, kept short)
      const m = e.data as { type?: unknown; text?: unknown } | null;
      if (m?.type === "vyrse-app-send" && typeof m.text === "string" && m.text.trim() && sendRef.current) {
        if (Date.now() - lastSend.current < 3000) return;
        lastSend.current = Date.now();
        sendRef.current(m.text.trim().slice(0, 400));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const load = () => {
    const el = ref.current;
    if (!el?.contentWindow) return;
    const css = getComputedStyle(el);
    setDark(!el.closest(".light"));
    const theme = Object.fromEntries(
      Object.entries(APP_THEME).map(([k, v]) => [k, css.getPropertyValue(v).trim()]),
    );
    el.contentWindow.postMessage(
      { type: "vyrse-app", html, theme, dark: !el.closest(".light") },
      "*",
    );
  };
  return (
    <iframe
      ref={ref}
      key={html}
      src="app-frame.html"
      sandbox="allow-scripts"
      title={title}
      onLoad={load}
      className="block w-full rounded-xl border border-border bg-transparent transition-[height] duration-300"
      style={{ height, colorScheme: dark ? "dark" : "light" }}
    />
  );
}

/* ------------------------------------------------------------------------------------------ picker */

/** Each wheel's last spin (by item and arrival), so re-rendering a board never spins a wheel again. */
const SPINS = new Map<string, { rotation: number; picked: number; landsAt: number }>();

const WHEEL = [
  "fill-primary/80",
  "fill-accent/80",
  "fill-success/75",
  "fill-trace/80",
  "fill-primary/50",
  "fill-accent/55",
  "fill-success/45",
  "fill-trace/50",
] as const;

/** A point on a circle, angle in degrees clockwise from 12 o'clock. */
function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

/**
 * A wheel that spins and lands on one option at random ("pick for me", a coin, a die). It spins once as it
 * arrives and again on "Spin again"; the pick is made here, never by the model.
 */
export function Picker({ data, spinKey, onAsk }: { data: NonNullable<Artifact["picker"]>; spinKey: string; onAsk?: ((text: string) => void) | undefined }) {
  const options = data.options;
  const n = options.length;
  const slice = 360 / n;
  // A wheel spins once when it arrives. If the board re-renders it (another card arriving), it keeps its
  // result instead of spinning (and sounding) again.
  const memo = SPINS.get(spinKey);
  const [rotation, setRotation] = useState(memo?.rotation ?? 0);
  const [picked, setPicked] = useState<number | null>(memo && memo.landsAt <= Date.now() ? memo.picked : null);
  const [spinning, setSpinning] = useState(false);
  const spinningRef = useRef(false);
  const landTimer = useRef(0);
  const spin = () => {
    if (spinningRef.current) return;
    const index = Math.floor(Math.random() * n);
    const jitter = (Math.random() - 0.5) * slice * 0.6;
    const target = (((-(index + 0.5) * slice + jitter) % 360) + 360) % 360;
    const off = motionOff();
    const from = SPINS.get(spinKey)?.rotation ?? 0;
    const to = from + (off ? 0 : 360 * 5) + ((target - (from % 360) + 360) % 360);
    SPINS.set(spinKey, { rotation: to, picked: index, landsAt: Date.now() + (off ? 0 : 4200) });
    setPicked(null);
    setRotation(to);
    if (off) {
      setPicked(index);
      return;
    }
    spinningRef.current = true;
    setSpinning(true);
    playUiSound("spin");
    landTimer.current = window.setTimeout(() => {
      spinningRef.current = false;
      setSpinning(false);
      setPicked(index);
      playUiSound("land");
    }, 4200);
  };
  useEffect(() => {
    const seen = SPINS.get(spinKey);
    if (seen) {
      // Re-rendered mid-spin: show the landing when it lands.
      const left = seen.landsAt - Date.now();
      if (left > 0) landTimer.current = window.setTimeout(() => setPicked(seen.picked), left);
      return () => window.clearTimeout(landTimer.current);
    }
    const id = window.setTimeout(spin, 700); // spins once as it arrives
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(landTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinKey]);
  const r = 100;
  const font = n > 10 ? 7.5 : n > 6 ? 9 : 11;
  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <div className="relative size-[15rem] shrink-0">
        <svg viewBox="-110 -118 220 228" className="size-full overflow-visible" aria-label="Wheel">
          <g
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? "transform 4.1s cubic-bezier(0.12, 0.8, 0.16, 1)" : "none",
            }}
          >
            {options.map((o, i) => {
              const [x1, y1] = polar(r, i * slice);
              const [x2, y2] = polar(r, (i + 1) * slice);
              const mid = (i + 0.5) * slice;
              const [tx, ty] = polar(r * 0.6, mid);
              const won = picked === i;
              return (
                <g key={`${o}-${i}`}>
                  <path
                    d={`M0 0 L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${slice > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}Z`}
                    className={cn(
                      WHEEL[i % WHEEL.length],
                      "stroke-background transition-opacity duration-500",
                      picked !== null && !won && "opacity-35",
                    )}
                    strokeWidth={1.5}
                  />
                  <text
                    x={tx}
                    y={ty}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    transform={`rotate(${mid > 180 ? mid + 90 : mid - 90} ${tx} ${ty})`}
                    className="fill-background font-sans font-semibold"
                    style={{ fontSize: font }}
                  >
                    {o.length > 14 ? `${o.slice(0, 13)}…` : o}
                  </text>
                </g>
              );
            })}
          </g>
          <circle r={13} className="fill-card stroke-border-strong" strokeWidth={2} />
          <path d="M0 -96 L-9 -114 L9 -114 Z" className="fill-foreground" />
        </svg>
      </div>
      <div className="min-w-[10rem] text-center">
        <p className="eyebrow">{spinning ? "spinning…" : picked !== null ? "it's" : "ready"}</p>
        {picked !== null ? (
          <p
            key={`${picked}-${rotation}`}
            className="vyr-stamp mt-1 font-display text-[30px] leading-tight font-semibold tracking-tight text-foreground [text-shadow:0_0_30px_color-mix(in_oklab,var(--primary)_45%,transparent)]"
          >
            {options[picked]}
          </p>
        ) : (
          <p className="mt-1 font-display text-[30px] leading-tight font-semibold text-muted-foreground/50">
            …
          </p>
        )}
        <button
          type="button"
          onClick={spin}
          disabled={spinning}
          className="liquid-hover relative mt-4 rounded-full border border-border px-4 py-1.5 text-[12.5px] text-foreground/90 enabled:hover:text-foreground disabled:opacity-50"
        >
          Spin again
        </button>
        {onAsk && picked !== null && !spinning && (
          <button
            data-card-chrome
            type="button"
            onClick={() => onAsk(`Let's go with ${options[picked]}.`)}
            className="vyr-emerge mt-4 ml-2 rounded-full bg-primary px-4 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go with this
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- mindmap */

const BRANCH_FILL = ["fill-primary", "fill-accent", "fill-success", "fill-trace"] as const;
const BRANCH_STROKE = [
  "stroke-primary",
  "stroke-accent",
  "stroke-success",
  "stroke-trace",
] as const;
const BRANCH_TEXT = ["fill-primary", "fill-accent", "fill-success", "fill-trace"] as const;

/**
 * A topic with its branches either side (a logical map, like XMind's): each branch with its points listed
 * beside it, so long, dense maps never overlap; the map grows as tall as it needs. Lines draw out from the
 * centre, branches pop in one after another, then their points.
 */
export function MindMap({ data }: { data: NonNullable<Artifact["mindmap"]> }) {
  const W = 900;
  const cx = W / 2;
  const LEAF_W = 180;
  const leafLines = (label: string) => wrapTwo(label, 27);
  const leafH = (label: string) => (leafLines(label).length > 1 ? 40 : 26);
  const blockH = (b: { leaves: { label: string }[] }) =>
    Math.max(
      36,
      b.leaves.reduce((sum, l) => sum + leafH(l.label) + 8, -8),
    );
  // Alternate branches right, left, right… so both sides fill evenly.
  const sides: { b: (typeof data.branches)[number]; i: number }[][] = [[], []];
  data.branches.forEach((b, i) => sides[i % 2]!.push({ b, i }));
  const colH = (col: { b: (typeof data.branches)[number] }[]) =>
    col.reduce((sum, { b }) => sum + blockH(b) + 22, -22);
  const H = Math.max(300, Math.max(colH(sides[0]!), colH(sides[1]!)) + 48);
  const cy = H / 2;
  const width = (text: string, size: number) =>
    Math.min(170, Math.min(text.length, 26) * size * 0.56 + 24);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label={`Mind map: ${data.center}`}
    >
      {sides.map((col, side) => {
        const right = side === 0;
        let y = cy - colH(col) / 2;
        return col.map(({ b, i }) => {
          const tone = i % BRANCH_FILL.length;
          const h = blockH(b);
          const by = y + h / 2;
          const bx = right ? 620 : 280;
          const bw = width(b.label, 13);
          const edge = right ? bx + bw / 2 : bx - bw / 2;
          let ly = y;
          y += h + 22;
          return (
            <g key={`${b.label}-${i}`}>
              <path
                d={`M${cx} ${cy} C${(cx + bx) / 2} ${cy} ${(cx + bx) / 2} ${by} ${right ? bx - bw / 2 : bx + bw / 2} ${by}`}
                pathLength={1}
                fill="none"
                className={cn("vyr-draw", BRANCH_STROKE[tone])}
                strokeOpacity={0.55}
                strokeWidth={2.5}
                style={{ animationDelay: `${200 + i * 110}ms` }}
              />
              {b.leaves.map((leaf, j) => {
                const lines = leafLines(leaf.label);
                const lh = leafH(leaf.label);
                const top = ly;
                ly += lh + 8;
                const lx = right ? W - 8 - LEAF_W : 8;
                const mid = top + lh / 2;
                return (
                  <g key={`${leaf.label}-${j}`}>
                    <path
                      d={`M${edge} ${by} C${(edge + (right ? lx : lx + LEAF_W)) / 2} ${by} ${(edge + (right ? lx : lx + LEAF_W)) / 2} ${mid} ${right ? lx : lx + LEAF_W} ${mid}`}
                      pathLength={1}
                      fill="none"
                      className={cn("vyr-draw", BRANCH_STROKE[tone])}
                      strokeOpacity={0.35}
                      strokeWidth={1.5}
                      style={{ animationDelay: `${450 + i * 110 + j * 50}ms` }}
                    />
                    <g className="vyr-pop" style={stagger(i * 2 + j + 5)}>
                      <rect
                        x={lx}
                        y={top}
                        width={LEAF_W}
                        height={lh}
                        rx={12}
                        className="fill-card stroke-border-strong"
                      />
                      <text
                        x={lx + 12}
                        y={mid}
                        dominantBaseline="central"
                        className="fill-foreground font-sans"
                        style={{ fontSize: 11.5 }}
                      >
                        {lines.map((l, k) => (
                          <tspan
                            key={k}
                            x={lx + 12}
                            dy={lines.length > 1 ? (k === 0 ? "-0.6em" : "1.2em") : 0}
                          >
                            {l}
                          </tspan>
                        ))}
                      </text>
                      <title>{leaf.detail ?? leaf.label}</title>
                    </g>
                  </g>
                );
              })}
              <g className="vyr-pop" style={stagger(i * 2 + 2)}>
                <rect
                  x={bx - bw / 2}
                  y={by - 17}
                  width={bw}
                  height={34}
                  rx={17}
                  className={BRANCH_FILL[tone]}
                  fillOpacity={0.16}
                />
                <rect
                  x={bx - bw / 2}
                  y={by - 17}
                  width={bw}
                  height={34}
                  rx={17}
                  fill="none"
                  className={BRANCH_STROKE[tone]}
                  strokeOpacity={0.6}
                />
                <text
                  x={bx}
                  y={by}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className={cn("font-sans font-semibold", BRANCH_TEXT[tone])}
                  style={{ fontSize: 13 }}
                >
                  {b.label.length > 22 ? `${b.label.slice(0, 21)}…` : b.label}
                </text>
                <title>{b.label}</title>
              </g>
            </g>
          );
        });
      })}
      <g className="vyr-pop" style={stagger(0)}>
        <circle cx={cx} cy={cy} r={62} className="fill-card" />
        <circle cx={cx} cy={cy} r={62} className="fill-primary/15 stroke-primary" strokeWidth={2} />
        <foreignObject x={cx - 56} y={cy - 44} width={112} height={88}>
          <div className="grid h-full place-items-center text-center font-display text-[14px] leading-tight font-semibold text-foreground">
            {data.center}
          </div>
        </foreignObject>
      </g>
    </svg>
  );
}

/** Up to two lines of about `max` characters, split at a word; the rest ends in "…". */
function wrapTwo(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const cut = text.lastIndexOf(" ", max);
  const first = text.slice(0, cut > max / 2 ? cut : max).trim();
  const rest = text.slice(first.length).trim();
  return [first, rest.length > max ? `${rest.slice(0, max - 1).trim()}…` : rest];
}

/* ----------------------------------------------------------------------------------------- folders */

const FOLDER_TONE: Record<string, string> = {
  Images: "bg-trace", Documents: "bg-primary", Installers: "bg-accent", Archives: "bg-[oklch(0.72_0.09_290)]",
  Videos: "bg-[oklch(0.72_0.12_350)]", Audio: "bg-success", Code: "bg-[oklch(0.78_0.1_190)]", Other: "bg-muted-foreground",
};

/** A folder VYRSE sorted: one row per new subfolder with how many files went in (the reels' Downloads card). */
export function Folders({ data }: { data: NonNullable<Artifact["folders"]> }) {
  const max = Math.max(1, ...data.items.map((f) => f.count));
  return (
    <div>
      <div className="flex items-baseline gap-2.5">
        <span className="font-display text-3xl font-semibold tracking-tight text-foreground">
          <CountUp value={data.total.toLocaleString("en-US")} />
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
          files into {data.items.length} folders{data.sizeGb ? ` · ${data.sizeGb} GB` : ""}
        </span>
        {data.sorted && (
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-success">
            <Check className="size-3.5" /> nothing deleted
          </span>
        )}
      </div>
      <ul className="mt-3.5 space-y-2">
        {data.items.map((f, i) => (
          <li key={f.name} className="vyr-flip-up flex items-center gap-3" style={stagger(i)}>
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-secondary/30">
              <Folder className="size-4 text-muted-foreground" strokeWidth={1.7} />
            </span>
            <span className="w-24 shrink-0 truncate text-[13px] text-foreground">{f.name}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary/50">
              <span
                className={cn("vyr-grow-x block h-full rounded-full", FOLDER_TONE[f.name] ?? "bg-primary")}
                style={{ width: `${(f.count / max) * 100}%`, ...stagger(i + 2) }}
              />
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-[12px] text-foreground">
              <CountUp value={f.count} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------- form */

/** VYRSE asks for details on screen; Send hands them back as the user's message. */
export function Form({
  data,
  title,
  onSubmit,
}: {
  data: NonNullable<Artifact["form"]>;
  title: string;
  onSubmit?: ((values: Record<string, string>, message: string) => void) | undefined;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => data.sent ?? {});
  const [editing, setEditing] = useState(!data.sent);
  useEffect(() => {
    if (data.sent) {
      setValues(data.sent);
      setEditing(false);
    }
  }, [data.sent]);
  const set = (label: string, v: string) => setValues((all) => ({ ...all, [label]: v }));
  const filled = data.fields.some((f) => values[f.label]?.trim());
  const field =
    "w-full rounded-xl border border-border bg-background/40 px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none disabled:opacity-70";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!onSubmit || !filled) return;
        playUiSound("tick");
        setEditing(false);
        onSubmit(values, formMessage(title, data.fields, values));
      }}
      className="space-y-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {data.fields.map((f) => (
          <label key={f.label} className={cn("block", (f.type === "text" && data.fields.length % 2 === 1 && f === data.fields[data.fields.length - 1]) && "sm:col-span-2")}>
            <span className="eyebrow mb-1.5 block">{f.label}</span>
            {f.type === "select" ? (
              <span className="flex flex-wrap gap-1.5">
                {f.options!.map((o) => (
                  <button
                    key={o}
                    type="button"
                    disabled={!editing}
                    onClick={() => set(f.label, values[f.label] === o ? "" : o)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-[12.5px] transition-colors",
                      values[f.label] === o ? "border-primary/70 bg-primary/15 text-foreground" : "border-border text-muted-foreground enabled:hover:text-foreground",
                    )}
                  >
                    {o}
                  </button>
                ))}
              </span>
            ) : (
              <input
                type={f.type}
                value={values[f.label] ?? ""}
                disabled={!editing}
                placeholder={f.placeholder ?? ""}
                onChange={(e) => set(f.label, e.target.value)}
                className={cn(field, (f.type === "date" || f.type === "time") && "[color-scheme:inherit]")}
              />
            )}
          </label>
        ))}
      </div>
      {onSubmit && (
        <div data-card-chrome className="flex items-center gap-2 pt-1">
          {editing ? (
            <button
              type="submit"
              disabled={!filled}
              className="rounded-full bg-primary px-4 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {data.submit}
            </button>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-success">sent</span>
              <button type="button" onClick={() => setEditing(true)} className="liquid-hover relative rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground">
                Change
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
