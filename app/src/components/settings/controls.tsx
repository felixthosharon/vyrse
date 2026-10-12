import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GlassLens } from "../GlassLens";

/** Shared Settings primitives (sections, rows, segmented controls, toggles, sliders). */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-t border-border/70 px-[clamp(1rem,2vw,1.35rem)] py-5 first:border-t-0"><p className="eyebrow mb-4">{title}</p><div className="space-y-4">{children}</div></section>;
}
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"><div className="flex min-w-0 items-baseline justify-between gap-x-3 gap-y-0.5"><span className="shrink-0 text-[13px] text-foreground">{label}</span>{hint && <span className="min-w-0 text-right font-mono text-[10px] text-muted-foreground">{hint}</span>}</div>{children}</div>;
}
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="relative flex flex-wrap gap-1 rounded-2xl border border-border/70 bg-secondary/15 p-1"><GlassLens selector="[data-selected=true]" active={value} className="rounded-xl" />{options.map(o => <button key={o.value} type="button" data-selected={value === o.value} onClick={() => onChange(o.value)} className={cn("relative z-[1] min-w-0 flex-1 basis-0 rounded-xl px-2.5 py-2 text-[11.5px] transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", value === o.value ? "text-primary" : "text-muted-foreground hover:bg-surface/40 hover:text-foreground")}>{o.label}</button>)}</div>;
}
export function Dropdown<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const on = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", on); return () => document.removeEventListener("mousedown", on); }, []);
  const selected = options.find(o => o.value === value) ?? options[0];
  return <div ref={ref} className="relative"><button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(v => !v)} className="liquid relative flex w-full items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5 text-left text-[12px] text-foreground transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0 truncate">{selected?.label}</span><ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180 text-primary")} strokeWidth={1.5}/></button>{open && <div className="vyr-dropdown-popover liquid-menu absolute inset-x-0 top-[calc(100%+0.4rem)] z-[80] rounded-2xl"><div role="listbox" className="max-h-64 overflow-x-auto overflow-y-auto rounded-2xl p-1.5">{options.map(o => <button key={o.value} type="button" role="option" aria-selected={o.value === value} onClick={() => { onChange(o.value); setOpen(false); }} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-primary/8", o.value === value ? "bg-primary/10 text-primary" : "text-foreground")}><span className="grid size-4 shrink-0 place-items-center">{o.value === value && <Check className="size-3.5" strokeWidth={2}/>}</span><span className="min-w-0"><span className="block text-[12px] [overflow-wrap:anywhere]">{o.label}</span>{o.hint && <span className="block pt-0.5 text-[9.5px] text-muted-foreground [overflow-wrap:anywhere]">{o.hint}</span>}</span></button>)}</div></div>}</div>;
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cn("grid h-6 w-11 shrink-0 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", checked ? "border-primary/45 bg-primary/18" : "border-border-strong bg-secondary/35")}><span className={cn("size-4 rounded-full transition-transform duration-300", checked ? "translate-x-[24px] bg-primary" : "translate-x-[4px] bg-muted-foreground/55")} /></button>;
}
export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <div className="flex min-w-0 items-center justify-between gap-4"><div className="min-w-0"><span className="block text-[13px] text-foreground">{label}</span>{hint && <span className="block pt-0.5 text-[10px] text-muted-foreground">{hint}</span>}</div><Toggle checked={checked} onChange={onChange} label={label}/></div>;
}
export function Slider({ value, onChange, min, max, step = 0.05 }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <input aria-label="Setting value" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary/60 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"/>;
}
/** A short text value, saved when you press Enter or leave the field. */
export function TextField({ value, onCommit, label, placeholder, maxLength = 40 }: { value: string; onCommit: (v: string) => void; label: string; placeholder?: string; maxLength?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    if (next !== value) onCommit(next);
  };
  return <input aria-label={label} value={draft} maxLength={maxLength} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="liquid relative w-full rounded-2xl px-3.5 py-2.5 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />;
}
