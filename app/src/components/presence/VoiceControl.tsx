import { useEffect, useRef } from "react";
import { Mic, Square } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";

/**
 * The voice control belongs to the presence, not to the text composer.
 *
 * Layout contract: the button and the status line occupy separate rows with
 * reserved height, so the status text can never overlap the button at any
 * viewport size.
 */
export function VoiceControl({ className }: { className?: string }) {
  const { listening, micLive, toggleListening, levelRef, presenceState } = useVyrse();
  const ringRef = useRef<HTMLSpanElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);

  // Bars move with your voice while listening, with VYRSE's voice while it speaks, and shimmer
  // gently while it thinks or works.
  const speaking = presenceState === "speaking";
  const busy = presenceState === "thinking" || presenceState === "working";
  const active = listening || speaking || busy;
  useEffect(() => {
    if (ringRef.current && !listening) {
      ringRef.current.style.transform = "scale(1)";
      ringRef.current.style.opacity = "0";
    }
    if (!active) return;
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Perceptual response: tiny ambient noise stays visually quiet while
      // actual speech still produces a clear presence reaction.
      const raw = busy ? 0.28 : Math.max(0, Math.min(1, levelRef.current));
      const l = busy ? raw : raw * raw;
      smooth += (l - smooth) * (l > smooth ? 0.28 : 0.10);
      const el = listening ? ringRef.current : null;
      if (el) {
        el.style.transform = `scale(${1 + smooth * 0.5})`;
        el.style.opacity = `${Math.min(0.9, smooth * 0.8)}`;
      }
      const bars = barsRef.current;
      if (bars) {
        const kids = bars.children;
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i] as HTMLElement;
          const f = busy
            ? 0.18 + (Math.sin(performance.now() / 380 - i * 0.7) * 0.5 + 0.5) * 0.32
            : 0.08 + Math.abs(Math.sin(performance.now() / 220 + i)) * smooth * 1.5;
          k.style.transform = `scaleY(${Math.min(1, f)})`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening, active, busy, levelRef]);

  const status = listening
    ? micLive
      ? "I'm listening"
      : "Listening"
    : presenceState === "thinking"
      ? "Thinking"
      : presenceState === "working"
        ? "Working"
        : presenceState === "speaking"
          ? "Responding"
          : "Tap to speak";

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <button
        type="button"
        onClick={toggleListening}
        aria-label={listening ? "Stop listening" : "Speak to Vyrse"}
        aria-pressed={listening}
        className={cn(
          "group relative grid size-[clamp(3.25rem,4.4vmin,4.25rem)] shrink-0 place-items-center rounded-full",
          "border transition-[transform,background-color,border-color,color,box-shadow] duration-500 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
          "hover:scale-[1.04] active:scale-[0.97]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
          listening
            ? "border-primary/45 bg-primary/12 text-primary"
            : "liquid text-muted-foreground hover:text-foreground",
        )}
        style={listening ? { boxShadow: "var(--glow-core)" } : undefined}
      >
        <span
          ref={ringRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border border-primary/70 opacity-0"
        />
        {listening ? (
          <Square className="relative size-[15px] fill-current" strokeWidth={0} />
        ) : (
          <Mic className="relative size-[clamp(1.05rem,1.6vmin,1.3rem)]" strokeWidth={1.5} />
        )}
      </button>

      {/* Reserved status row — never shares space with the button */}
      <div
        className={cn(
          "relative flex h-7 items-center justify-center gap-2 rounded-full px-3.5 transition-[background-color,box-shadow,opacity] duration-500",
          active && "liquid",
        )}
      >
        <div
          ref={barsRef}
          aria-hidden="true"
          className={cn(
            "flex h-3 items-center gap-[2px] transition-opacity duration-500",
            active ? "w-auto opacity-100" : "w-0 opacity-0",
          )}
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <span
              key={i}
              className="h-3 w-[2px] origin-center rounded-full bg-primary/70"
              style={{ transform: "scaleY(0.3)" }}
            />
          ))}
        </div>
        <p
          className={cn(
            "text-[11px] tracking-[0.16em] uppercase transition-colors duration-500",
            active ? "text-primary" : "text-muted-foreground/75",
          )}
        >
          {status}
        </p>
      </div>
    </div>
  );
}
