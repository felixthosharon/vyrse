import { Check, ChevronUp, MessageCircleHeart } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVyrse } from "@/lib/vyrse/store";
import { TALK_STYLES, styleLabel, type TalkStyle } from "@/lib/vyrse/talk-styles";
import { cn } from "@/lib/utils";

/**
 * Talk style chip inside the composer: shows how VYRSE is talking and pulls up the list of styles.
 * The same switch works by voice or text ("switch to fam mode", "vibe mode off").
 */
export function TalkStylePicker() {
  const { settings, setTalkStyle } = useVyrse();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const style = settings.talkStyle ?? "normal";
  const custom = settings.customStyles ?? [];
  const all: { id: TalkStyle; label: string; hint: string }[] = [...TALK_STYLES, ...custom.map((c) => ({ ...c, hint: c.hint || "Your style" }))];
  const label = all.find((s) => s.id === style)?.label ?? styleLabel(style);

  // The list lives in a portal on <body> (the composer's stacking context put it behind the page),
  // fixed just above the chip.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = root.current?.getBoundingClientRect();
      if (r) setAnchor({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 10 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0 self-end">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Talk style: ${label}`}
        title="Talk style — or say “switch to fam mode”"
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          style === "normal"
            ? "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            : "border-primary/40 bg-primary/10 text-primary",
        )}
      >
        <MessageCircleHeart className="size-3.5" strokeWidth={1.7} />
        <span>{label}</span>
        <ChevronUp className={cn("size-3 transition-transform", open ? "" : "rotate-180")} strokeWidth={1.8} />
      </button>

      {open && anchor && createPortal(
        <div
          ref={list}
          role="listbox"
          aria-label="Talk style"
          style={{ left: anchor.left, bottom: anchor.bottom }}
          className="vyr-emerge fixed z-[70] w-64 liquid-menu rounded-2xl p-1.5"
        >
          <p className="eyebrow px-2.5 pt-1.5 pb-1">talk style</p>
          {all.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === style}
              onClick={() => {
                setTalkStyle(s.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                s.id === style ? "bg-primary/10" : "hover:bg-secondary/50",
              )}
            >
              <span className="min-w-0">
                <span className={cn("block text-[12.5px]", s.id === style ? "text-primary" : "text-foreground")}>{s.label}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground">{s.hint}</span>
              </span>
              {s.id === style && <Check className="size-3.5 shrink-0 text-primary" strokeWidth={2} />}
            </button>
          ))}
          <p className="px-2.5 pt-1 pb-1.5 text-[10px] text-muted-foreground/80">Or say “switch to fam mode”, or “make me a talk style that…”.</p>
        </div>,
        document.body,
      )}
    </div>
  );
}
