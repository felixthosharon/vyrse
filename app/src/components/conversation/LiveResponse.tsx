import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Maximize2 } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { Markdown } from "./Markdown";
import { ArtifactView } from "./ArtifactView";
import { ToolStrip } from "./ToolStrip";
import { ReplyActions } from "./ReplyActions";
import { cn } from "@/lib/utils";

/**
 * The compact response surface that sits directly beneath the presence.
 *
 * It shows only the current exchange — the presence, not the transcript, is
 * the subject of the screen. It auto-follows the stream at a fixed maximum
 * height; scrolling up hands control back to the reader until they choose to
 * return to the newest content.
 */
export function LiveResponse() {
  const { active, expanded, setExpanded, busy, presenceState, notice } = useVyrse();
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const messages = active?.messages ?? [];
  // Only the reply to the *latest* question belongs here — never an older answer.
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const lastVyrse = messages.slice(lastUserIndex + 1).find((m) => m.role === "vyrse");
  const text = lastVyrse?.text ?? "";
  const tools = lastVyrse?.tools ?? [];

  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: "end" });
  }, [text, pinned]);

  const jump = useCallback(() => {
    setPinned(true);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  if (!lastUser) return null;

  const older = messages.length > 0;
  const waiting = busy && !text && tools.length === 0;
  const reasoning = (lastVyrse?.reasoningChars ?? 0) > 0;

  return (
    <div className="w-full">
      <div className="mb-2 flex items-baseline justify-between gap-4 px-1">
        <p className="eyebrow truncate">{lastUser.text}</p>
        <div className="flex shrink-0 items-center gap-2">
        {!busy && text.trim() && !lastVyrse?.streaming && <ReplyActions text={text} retry className="-my-1" />}
        {older && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Maximize2 className="size-3" strokeWidth={1.6} />
            Full transcript
          </button>
        )}
        </div>
      </div>

      <div className={cn("liquid relative rounded-2xl transition-opacity duration-500", expanded && "pointer-events-none opacity-0")}>
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
          className={cn(
            // Deliberately capped: the compact preview scrolls internally so a
            // long stream never grows the footer or squeezes the presence.
            "field-scroll max-h-[26vh] overflow-y-auto rounded-2xl px-4 py-3.5 sm:max-h-[32vh] sm:px-5 sm:py-4",
          )}
        >
          {waiting ? (
            <p className="text-[13px] text-muted-foreground">
              {notice ?? (presenceState === "working" ? "Working through it…" : reasoning ? "Reasoning…" : "Thinking…")}
            </p>
          ) : (
            <>
              {lastVyrse?.meta && (
                <p className="mb-2 font-mono text-[10.5px] text-muted-foreground/70">
                  {lastVyrse.meta}
                </p>
              )}
              <ToolStrip tools={tools} />
              {busy && !text && (
                <p className="text-[13px] text-muted-foreground">
                  {notice ?? (presenceState === "working" ? "Working through it…" : "Thinking…")}
                </p>
              )}
              <Markdown text={text} reveal={lastVyrse?.streaming} />
              {lastVyrse?.interrupted && (
                <p className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">{text ? "stopped" : "Stopped."}</p>
              )}
              {lastVyrse?.streaming && (
                <span
                  className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-primary"
                  style={{ animation: "vyr-caret 1s steps(1) infinite" }}
                />
              )}
              {lastVyrse?.artifact && <ArtifactView artifact={lastVyrse.artifact} />}
            </>
          )}
          <div ref={endRef} />
        </div>

        <button
          type="button"
          onClick={jump}
          tabIndex={pinned ? -1 : 0}
          aria-hidden={pinned}
          className={cn(
            "absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full liquid px-3 py-1.5 text-[11px] text-foreground transition-all duration-300",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            pinned || expanded
              ? "pointer-events-none translate-y-1 opacity-0"
              : "pointer-events-auto opacity-100",
          )}
        >
          <ArrowDown className="size-3" strokeWidth={1.8} />
          Jump to latest
        </button>
      </div>
    </div>
  );
}
