import { playUiSound } from "@/lib/vyrse/ui-sounds";
import { BookOpen, Check, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Artifact, QuizQuestion } from "@/lib/vyrse/types";
import { cn } from "@/lib/utils";
import { CountUp, Sparkline, stagger } from "./motion";

/**
 * The richer workspace kinds: completion rings, stat tiles, checklists, quizzes, scorecards, flashcards
 * and donut charts. Each draws only the typed data it is handed; colours come from the theme tokens.
 */

// Literal class names (Tailwind only generates classes it can see in the source).
const STROKES = ["stroke-primary", "stroke-accent", "stroke-success", "stroke-trace"] as const;
const FILLS = ["bg-primary", "bg-accent", "bg-success", "bg-trace"] as const;

/** 0 on the first frame, then the real value, so rings and bars grow in. */
function useGrow(): number {
  const [on, setOn] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(1));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
}

export function Ring({
  fraction,
  size = 112,
  stroke = 9,
  tone = 0,
  children,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
  tone?: number;
  children?: ReactNode;
}) {
  const grow = useGrow();
  const r = 50 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction)) * grow;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx={50} cy={50} r={r} fill="none" className="stroke-secondary/70" strokeWidth={stroke} />
        <circle
          cx={50}
          cy={50}
          r={r}
          fill="none"
          className={cn(STROKES[tone % STROKES.length], "transition-[stroke-dasharray] duration-[1200ms] ease-[cubic-bezier(0.16,0.84,0.24,1)]")}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(c * f).toFixed(2)} ${c.toFixed(2)}`}
          style={{ filter: "drop-shadow(0 0 4px color-mix(in oklab, currentColor 40%, transparent))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

export function Rings({ data }: { data: NonNullable<Artifact["rings"]> }) {
  const single = data.length === 1;
  return (
    <div className={cn("flex flex-wrap justify-center gap-x-6 gap-y-5", single && "justify-start")}>
      {data.map((r, i) => {
        const frac = r.value / r.max;
        return (
          <div key={`${r.label}-${i}`} className={cn("vyr-rise flex items-center gap-3", !single && "w-[7.5rem] flex-col gap-2")} style={stagger(i)}>
            <Ring fraction={frac} tone={i} size={single ? 128 : 104}>
              <span>
                <CountUp value={`${Math.round(frac * 100)}%`} className="block font-display text-[22px] leading-none font-semibold text-foreground" />
                {frac >= 1 && <span className="mt-1 block font-mono text-[9px] tracking-[0.18em] text-success uppercase">done</span>}
              </span>
            </Ring>
            <div className={cn("min-w-0", !single && "text-center")}>
              <p className="truncate text-[13.5px] text-foreground">{r.label}</p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {fmt(r.value)} / {fmt(r.max)}
                {r.unit ? ` ${r.unit}` : ""}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Stats({ data }: { data: NonNullable<Artifact["stats"]> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
      {data.map((s, i) => {
        const up = s.change?.trim().startsWith("+");
        const down = /^[-−–]/.test(s.change?.trim() ?? "");
        return (
          <div key={`${s.label}-${i}`} className="vyr-flip-up rounded-xl border border-border bg-secondary/20 px-3.5 py-3" style={stagger(i)}>
            <p className="eyebrow truncate">{s.label}</p>
            <p className="mt-1.5 truncate font-display text-[26px] leading-none font-semibold tracking-tight text-foreground">
              <CountUp value={s.value} />
            </p>
            {s.trend && <Sparkline data={s.trend} />}
            {(s.change || s.note) && (
              <p className="mt-2 flex items-center gap-2 text-[11px]">
                {s.change && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-px font-mono",
                      up ? "bg-success/15 text-success" : down ? "bg-accent/15 text-accent" : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {s.change}
                  </span>
                )}
                {s.note && <span className="truncate text-muted-foreground">{s.note}</span>}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Checklist({
  data,
  onToggle,
}: {
  data: NonNullable<Artifact["checklist"]>;
  onToggle?: ((index: number, done: boolean) => void) | undefined;
}) {
  const done = data.filter((c) => c.done).length;
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Ring fraction={done / data.length} size={44} stroke={11} tone={2} />
        <div>
          <p className="text-[13.5px] text-foreground">
            {done === data.length ? "All done" : `${done} of ${data.length} done`}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">{Math.round((done / data.length) * 100)}%</p>
        </div>
      </div>
      <ul className="space-y-1">
        {data.map((c, i) => (
          <li key={i} className="vyr-rise" style={stagger(i)}>
            <button
              type="button"
              disabled={!onToggle}
              onClick={() => onToggle?.(i, !c.done)}
              className="group flex w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors enabled:hover:bg-secondary/30"
            >
              <span
                className={cn(
                  "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-md border transition-all duration-300",
                  c.done ? "border-success bg-success text-background" : "border-border-strong group-enabled:group-hover:border-primary",
                )}
              >
                {c.done && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className={cn("text-[13.5px] transition-colors", c.done ? "text-muted-foreground line-through decoration-border-strong" : "text-foreground")}>
                {c.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stamp({ q, current }: { q: QuizQuestion; current: boolean }) {
  if (q.correct === undefined)
    return (
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full border border-dashed font-mono text-[10px]",
          current ? "animate-pulse border-primary text-primary" : "border-border-strong text-muted-foreground",
        )}
      >
        ?
      </span>
    );
  return (
    <span
      className={cn(
        "vyr-stamp grid size-9 shrink-0 place-items-center rounded-full",
        q.correct ? "bg-success text-background shadow-[0_0_18px_-2px] shadow-success/60" : "bg-accent text-background shadow-[0_0_18px_-2px] shadow-accent/60",
      )}
    >
      {q.correct ? <Check className="size-5" strokeWidth={3} /> : <X className="size-5" strokeWidth={3} />}
    </span>
  );
}

export function Quiz({ data }: { data: NonNullable<Artifact["quiz"]> }) {
  const qs = data.questions;
  const current = qs.findIndex((q) => q.correct === undefined);
  const answered = qs.filter((q) => q.correct !== undefined);
  const right = answered.filter((q) => q.correct).length;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <p className="eyebrow">{data.subject ?? "quiz"}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {answered.length ? `${right} / ${answered.length} right` : `${qs.length} questions`}
        </p>
      </div>
      <div className="mb-4 flex gap-1.5">
        {qs.map((q, i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors duration-500",
              q.correct === true ? "bg-success" : q.correct === false ? "bg-accent" : i === current ? "bg-primary" : "bg-secondary/70",
            )}
          />
        ))}
      </div>
      <ol className="space-y-2.5">
        {qs.map((q, i) => (
          <li
            key={i}
            className={cn(
              "rounded-xl border bg-secondary/15 px-3.5 py-3 transition-colors",
              q.correct === true ? "border-success/35" : q.correct === false ? "border-accent/40" : i === current ? "border-primary/45" : "border-border",
            )}
          >
            <p className="font-mono text-[10px] tracking-[0.18em] text-primary uppercase">
              Question {i + 1} / {qs.length}
            </p>
            <div className="mt-1 flex items-start gap-3">
              <p className="min-w-0 flex-1 font-display text-[15px] leading-snug text-foreground">{q.question}</p>
              <Stamp q={q} current={i === current} />
            </div>
            {q.answer && (
              <p className="mt-2 text-[13px]">
                <span className="mr-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">you</span>
                <span className={q.correct === false ? "text-muted-foreground line-through decoration-accent/60" : "text-foreground/90"}>{q.answer}</span>
              </p>
            )}
            {q.correct === false && q.right_answer && (
              <p className="mt-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[13px] text-foreground">
                <span className="mr-2 font-mono text-[10px] tracking-[0.16em] text-accent uppercase">answer</span>
                {q.right_answer}
              </p>
            )}
            {q.note && q.correct !== undefined && (
              <p className={cn("mt-2 font-mono text-[11.5px]", q.correct ? "text-success" : "text-muted-foreground")}>{q.note}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Scorecard({ data }: { data: NonNullable<Artifact["scorecard"]> }) {
  const grow = useGrow();
  const frac = data.score / data.total;
  return (
    <div>
      <div className="flex items-center gap-5">
        <Ring fraction={frac} size={118} stroke={9} tone={frac >= 0.5 ? 0 : 1}>
          <span className="font-display text-[26px] leading-none font-semibold text-foreground">
            {fmt(data.score)}
            <span className="text-muted-foreground">/{fmt(data.total)}</span>
          </span>
        </Ring>
        <div className="min-w-0">
          {data.subject && <p className="eyebrow truncate">{data.subject}</p>}
          <p className="mt-1 font-display text-[22px] leading-tight font-semibold tracking-tight text-foreground">
            {data.verdict ?? `${Math.round(frac * 100)}%`}
          </p>
          {data.verdict && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{Math.round(frac * 100)}%</p>}
        </div>
      </div>
      {data.topics.length > 0 && (
        <div className="mt-5 space-y-3">
          {data.topics.map((t, i) => (
            <div key={`${t.label}-${i}`}>
              <div className="mb-1.5 flex items-center gap-2 text-[13px]">
                <span className={cn("min-w-0 truncate", t.weak ? "text-accent" : "text-foreground/90")}>{t.label}</span>
                {t.weak ? (
                  <span className="ml-auto shrink-0 rounded-full bg-accent px-2 py-px font-mono text-[9.5px] tracking-[0.14em] text-background uppercase">
                    review this
                  </span>
                ) : (
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{Math.round(t.value * 100)}%</span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary/60">
                <div
                  className={cn("h-full rounded-full transition-[width] duration-[1100ms] ease-[cubic-bezier(0.16,0.84,0.24,1)]", t.weak ? "bg-accent" : "bg-success")}
                  style={{ width: `${t.value * 100 * grow}%`, transitionDelay: `${i * 90}ms` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {data.review && (
        <p className="mt-4 flex items-start gap-2.5 rounded-xl border border-border bg-secondary/20 px-3.5 py-2.5 text-[13px] text-foreground/90">
          <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.6} />
          {data.review}
        </p>
      )}
    </div>
  );
}

export function Flashcards({ data }: { data: NonNullable<Artifact["flashcards"]> }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const card = data[Math.min(index, data.length - 1)]!;
  const go = (d: number) => {
    setFlipped(false);
    setIndex((i) => (i + d + data.length) % data.length);
  };
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          playUiSound("flip");
          setFlipped((f) => !f);
        }}
        aria-label={flipped ? "Show the question" : "Show the answer"}
        className="block w-full [perspective:1200px] focus-visible:outline-none"
      >
        <span
          className="relative grid min-h-[9.5rem] transition-transform duration-500 ease-[cubic-bezier(0.16,0.84,0.24,1)] [transform-style:preserve-3d]"
          style={{ transform: flipped ? "rotateY(180deg)" : "none" }}
        >
          <span className="col-start-1 row-start-1 grid place-items-center rounded-xl border border-border bg-secondary/25 px-5 py-6 text-center [backface-visibility:hidden]">
            <span>
              <span className="eyebrow block">question</span>
              <span className="mt-2 block font-display text-[17px] leading-snug text-foreground">{card.front}</span>
            </span>
          </span>
          <span className="col-start-1 row-start-1 grid place-items-center rounded-xl border border-primary/40 bg-primary/10 px-5 py-6 text-center [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <span>
              <span className="eyebrow block text-primary">answer</span>
              <span className="mt-2 block text-[15px] leading-relaxed whitespace-pre-line text-foreground">{card.back}</span>
            </span>
          </span>
        </span>
      </button>
      <div className="mt-3 flex items-center justify-between">
        <button type="button" onClick={() => go(-1)} aria-label="Previous card" className="liquid-hover relative grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" strokeWidth={1.6} />
        </button>
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {index + 1} / {data.length}
          <span className="text-border-strong">·</span>
          <span className="inline-flex items-center gap-1">
            <RotateCcw className="size-3" strokeWidth={1.6} /> tap to flip
          </span>
        </span>
        <button type="button" onClick={() => go(1)} aria-label="Next card" className="liquid-hover relative grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4" strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}

export function Donut({ data, unit = "" }: { data: { label: string; value: number }[]; unit?: string | undefined }) {
  const grow = useGrow();
  const parts = data.filter((d) => d.value > 0).slice(0, 8);
  const total = parts.reduce((s, d) => s + d.value, 0) || 1;
  const r = 38;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const DONUT = ["stroke-primary", "stroke-accent", "stroke-success", "stroke-trace", "stroke-primary/50", "stroke-accent/50", "stroke-success/50", "stroke-trace/50"];
  const DOTS = ["bg-primary", "bg-accent", "bg-success", "bg-trace", "bg-primary/50", "bg-accent/50", "bg-success/50", "bg-trace/50"];
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative size-[150px] shrink-0">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90">
          <circle cx={50} cy={50} r={r} fill="none" className="stroke-secondary/60" strokeWidth={13} />
          {parts.map((d, i) => {
            const len = (d.value / total) * c * grow;
            const el = (
              <circle
                key={i}
                cx={50}
                cy={50}
                r={r}
                fill="none"
                className={cn(DONUT[i], "transition-[stroke-dasharray,stroke-dashoffset] duration-[1100ms] ease-[cubic-bezier(0.16,0.84,0.24,1)]")}
                strokeWidth={13}
                strokeDasharray={`${Math.max(0, len - 1.2).toFixed(2)} ${c.toFixed(2)}`}
                strokeDashoffset={(-offset).toFixed(2)}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <span>
            <span className="block font-display text-[20px] leading-none font-semibold text-foreground">{fmt(total)}{unit}</span>
            <span className="eyebrow mt-1 block">total</span>
          </span>
        </div>
      </div>
      <ul className="min-w-[10rem] flex-1 space-y-1.5">
        {parts.map((d, i) => (
          <li key={i} className="flex items-center gap-2.5 text-[13px]">
            <span className={cn("size-2.5 shrink-0 rounded-full", DOTS[i])} />
            <span className="min-w-0 flex-1 truncate text-foreground/90">{d.label}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {fmt(d.value)}
              {unit} · {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProgressBar({ data }: { data: NonNullable<Artifact["progress"]> }) {
  const grow = useGrow();
  const v = typeof data.value === "number" ? Math.max(0, Math.min(1, data.value)) : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13.5px] text-foreground">{data.label}</p>
        {v !== null && <p className="font-display text-[20px] font-semibold text-foreground">{Math.round(v * 100)}%</p>}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary/60">
        {v !== null ? (
          <div className={cn("h-full rounded-full transition-[width] duration-700", v >= 1 ? "bg-success" : FILLS[0])} style={{ width: `${v * 100 * grow}%` }} />
        ) : (
          <div className="vyr-indeterminate h-full w-1/3 rounded-full bg-primary/80" />
        )}
      </div>
      {data.message && <p className="mt-2 text-[11.5px] text-muted-foreground">{data.message}</p>}
    </div>
  );
}

export function StatusTiles({ data }: { data: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
      {data.map((v, i) => (
        <div key={`${v.label}-${i}`} className="rounded-xl border border-border bg-secondary/15 px-3 py-2.5">
          <p className="eyebrow truncate">{v.label}</p>
          <p className="mt-1 text-[13.5px] text-foreground">{v.value}</p>
        </div>
      ))}
    </div>
  );
}

/** Plain text of an item, for the copy button (null when copying makes no sense, e.g. images). */
export function artifactText(a: Artifact): string | null {
  const t = a.table ?? a.compare;
  if (t) return [t.columns, ...t.rows].map((r) => r.join("\t")).join("\n");
  if (a.code) return a.code.code;
  if (a.markdown) return a.markdown;
  if (a.series) return a.series.map((p) => `${p.label}\t${p.value}${a.chart?.unit ?? ""}`).join("\n");
  if (a.checklist) return a.checklist.map((c) => `${c.done ? "[x]" : "[ ]"} ${c.label}`).join("\n");
  if (a.quiz)
    return a.quiz.questions
      .map((q, i) => `${i + 1}. ${q.question}${q.answer ? `\n   You: ${q.answer}${q.correct === undefined ? "" : q.correct ? " ✓" : " ✗"}` : ""}${q.right_answer ? `\n   Answer: ${q.right_answer}` : ""}`)
      .join("\n");
  if (a.flashcards) return a.flashcards.map((f) => `${f.front} — ${f.back}`).join("\n");
  if (a.timeline) return a.timeline.map((e) => `${e.at}  ${e.label}${e.detail ? ` — ${e.detail}` : ""}`).join("\n");
  if (a.flow) return a.flow.map((s, i) => `${i + 1}. ${s.label}${s.note ? ` — ${s.note}` : ""}`).join("\n");
  if (a.stats) return a.stats.map((s) => `${s.label}: ${s.value}${s.change ? ` (${s.change})` : ""}`).join("\n");
  if (a.rings) return a.rings.map((r) => `${r.label}: ${fmt(r.value)} / ${fmt(r.max)}${r.unit ? ` ${r.unit}` : ""}`).join("\n");
  if (a.system_status) return a.system_status.values.map((v) => `${v.label}: ${v.value}`).join("\n");
  if (a.gauges) return a.gauges.map((g) => `${g.label}: ${fmt(g.value)}${g.unit ?? ""}`).join("\n");
  if (a.cards) return a.cards.map((c) => `${c.label}${c.value ? `: ${c.value}` : ""}${c.detail ? `\n${c.detail}` : ""}`).join("\n\n");
  if (a.weather)
    return (
      `${a.weather.location}: ${fmt(a.weather.temp)}${a.weather.unit} ${a.weather.condition}`.trim() +
      (a.weather.forecast ? `\n${a.weather.forecast.map((f) => `${f.at} ${fmt(f.value)}° ${f.label}`).join("\n")}` : "")
    );
  if (a.board) return a.board.map((col) => `${col.name}\n${col.cards.map((c) => `- ${c.label}`).join("\n")}`).join("\n\n");
  if (a.heatmap) return a.heatmap.cells.map((c) => `${c.label}\t${fmt(c.value)}`).join("\n");
  if (a.log)
    return [
      `${a.log.name}: ${fmt(a.log.today)} ${a.log.unit} today, ${fmt(a.log.week)} this week`,
      ...a.log.entries.map((e) => `${e.at}  ${e.label}${e.value !== undefined ? `  ${fmt(e.value)} ${a.log!.unit}` : ""}`),
    ].join("\n");
  if (a.app) return a.app.html;
  if (a.picker) return a.picker.options.join("\n");
  if (a.mindmap) return [a.mindmap.center, ...a.mindmap.branches.map((b) => `- ${b.label}${b.leaves.length ? `\n${b.leaves.map((l) => `  - ${l.label}`).join("\n")}` : ""}`)].join("\n");
  if (a.scorecard)
    return [`${a.scorecard.subject ?? a.title}: ${fmt(a.scorecard.score)}/${fmt(a.scorecard.total)}${a.scorecard.verdict ? ` — ${a.scorecard.verdict}` : ""}`,
      ...a.scorecard.topics.map((t) => `${t.label}: ${Math.round(t.value * 100)}%${t.weak ? " (review)" : ""}`),
      ...(a.scorecard.review ? [a.scorecard.review] : [])].join("\n");
  return null;
}
