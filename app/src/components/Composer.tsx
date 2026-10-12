import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useVyrse } from "@/lib/vyrse/store";
import { IS_PHONE } from "@/services/phone";
import { getDesktopBridge } from "@/services/hermes/bridge";
import { TalkStylePicker } from "./TalkStylePicker";
import { cn } from "@/lib/utils";

/**
 * Text is the secondary channel in Vyrse: the microphone lives with the
 * presence, not in this box. The composer stays deliberately quiet.
 */
export function Composer({ compact = false }: { compact?: boolean }) {
  const { send, cancel, busy, listening, micLive, settings, notify } = useVyrse();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(compact ? 132 : 168, el.scrollHeight)}px`;
  }, [value, compact]);

  // Files dropped anywhere on the window are attached to the next message (desktop app only:
  // Hermes reads them from disk, so it needs their real paths).
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [dragging, setDragging] = useState(false);

  // Dictation while VYRSE is the focused window lands here instead of another app.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (!text) return;
      setValue((v) => (v.trim() ? `${v.trimEnd()} ${text}` : text));
      window.setTimeout(() => ref.current?.focus(), 0);
    };
    window.addEventListener("vyrse:insert-text", onInsert);
    return () => window.removeEventListener("vyrse:insert-text", onInsert);
  }, []);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const desktop = getDesktopBridge()?.desktop;
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (!desktop) {
        notify("Attaching files works in the VYRSE desktop app.");
        return;
      }
      const added = dropped.map((f) => ({ path: desktop.pathForFile(f), name: f.name })).filter((f) => f.path);
      setFiles((prev) => [...prev, ...added.filter((a) => !prev.some((p) => p.path === a.path))].slice(0, 8));
      ref.current?.focus();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [notify]);

  const submit = () => {
    if (busy) {
      cancel();
      return;
    }
    if (!value.trim() && files.length === 0) return;
    send(value, { attachments: files });
    setValue("");
    setFiles([]);
  };

  const canSend = busy || value.trim().length > 0 || files.length > 0;

  return (
    <div className="w-full">
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-primary/60 bg-background/70 backdrop-blur-sm">
          <p className="text-sm tracking-wide text-foreground/85">Drop files for VYRSE to read</p>
        </div>
      )}
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5 px-1" aria-label="Attached files">
          {files.map((f) => (
            <li
              key={f.path}
              title={f.path}
              className="flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-surface/80 py-1 pr-1 pl-2.5 text-[12px] text-foreground/85"
            >
              <Paperclip className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((p) => p.path !== f.path))}
                className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          "liquid group relative flex items-end gap-1.5 rounded-[1.6rem] py-1.5 pr-1.5 pl-1.5 transition-[box-shadow] duration-500",
        )}
        style={focused ? { boxShadow: "inset 0 1px 0 0 var(--lg-inner), var(--glow-core), var(--lg-shadow)" } : undefined}
      >
        {/* light theme: a reflection gliding over the glass now and then (styles.css, desktop only) */}
        <span aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
          <span className="vyr-sheen-band" />
        </span>
        <TalkStylePicker />
        <textarea
          data-composer
          ref={ref}
          rows={1}
          value={value}
          disabled={busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => { setValue(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            listening
              ? micLive
                ? "Listening…"
                : "Listening (simulated input)…"
              : busy
                ? "Vyrse is responding…"
                : files.length
                  ? "Add a message, or just send"
                  : IS_PHONE
                    ? "Message VYRSE"
                    : "Type instead · drop files to attach"
          }
          className="max-h-[132px] min-h-[2rem] flex-1 resize-none self-center bg-transparent py-[0.4rem] text-[14.5px] leading-relaxed text-foreground [mask-image:linear-gradient(to_bottom,transparent,#000_0.4rem,#000_calc(100%-0.4rem),transparent)] placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-60"
        />

        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={busy ? "Stop response" : "Send message"}
          className={cn(
            "grid size-8 shrink-0 place-items-center self-end rounded-full transition-all duration-300",
            canSend
              ? "bg-primary text-primary-foreground hover:scale-[1.05]"
              : "text-muted-foreground/40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {busy ? (
            <Square className="size-3 fill-current" strokeWidth={0} />
          ) : (
            <ArrowUp className="size-[17px]" strokeWidth={2} />
          )}
        </button>
      </div>

      <p
        className={cn(
          "mt-2 h-4 px-1 text-center text-[10.5px] tracking-wide text-muted-foreground/55 transition-opacity duration-500",
          focused || listening ? "opacity-100" : "opacity-0",
        )}
      >
        {listening
          ? micLive
            ? "Speak — VYRSE will process your voice directly"
            : "Listening — waiting for speech"
          : "Enter to send · Shift + Enter for a new line"}
      </p>
    </div>
  );
}

