import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import type { Message } from "@/lib/vyrse/types";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { ArtifactView } from "./ArtifactView";
import { ToolStrip } from "./ToolStrip";
import { ReplyActions } from "./ReplyActions";

/** Your last message can be edited and resent; it replaces that exchange. */
function UserTurn({ message, editable }: { message: Message; editable: boolean }) {
  const { editLast } = useVyrse();
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null) {
    const submit = () => {
      if (draft.trim() && draft.trim() !== message.text.trim()) editLast(draft);
      setDraft(null);
    };
    return (
      <article>
        <p className="eyebrow mb-1.5">you</p>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") setDraft(null);
          }}
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          aria-label="Edit your message"
          className="field-scroll w-full resize-none rounded-xl border border-border-strong bg-secondary/25 px-3 py-2 text-[15px] leading-relaxed text-foreground focus:outline-none"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={() => setDraft(null)} className="rounded-full px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button type="button" onClick={submit} className="rounded-full bg-primary px-3.5 py-1.5 text-[12px] text-primary-foreground hover:opacity-90">
            Resend
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="vyr-emerge group">
      <div className="mb-1.5 flex items-center gap-2">
        <p className="eyebrow">you</p>
        {editable && (
          <button
            type="button"
            aria-label="Edit and resend"
            title="Edit and resend"
            onClick={() => setDraft(message.text)}
            className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-3" strokeWidth={1.7} />
          </button>
        )}
      </div>
      <p className="whitespace-pre-wrap border-l-2 border-primary/50 pl-4 text-[15.5px] leading-relaxed text-foreground">
        {message.text}
      </p>
    </article>
  );
}

function Turn({ message, last, idle }: { message: Message; last: boolean; idle: boolean }) {
  if (message.role === "user") return <UserTurn message={message} editable={last && idle} />;

  const done = !message.streaming && message.text.trim();
  return (
    <article className="vyr-emerge group">
      <div className="mb-1.5 flex items-baseline gap-3">
        <p className="eyebrow">vyrse</p>
        {message.meta && (
          <p className="font-mono text-[10.5px] text-muted-foreground/70">{message.meta}</p>
        )}
      </div>
      <div className="relative">
        {message.tools && message.tools.length > 0 && <ToolStrip tools={message.tools} />}
        <Markdown text={message.text} reveal={message.streaming} />
        {message.interrupted && (
          <p className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">stopped</p>
        )}
        {message.streaming && (
          <span
            className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-primary"
            style={{ animation: "vyr-caret 1s steps(1) infinite" }}
          />
        )}
        {message.artifact && <ArtifactView artifact={message.artifact} />}
        {done && (
          <ReplyActions
            text={message.text}
            retry={last && idle}
            className={cn(
              "-ml-1.5 mt-1.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
              last ? "opacity-70" : "opacity-0",
            )}
          />
        )}
      </div>
    </article>
  );
}

export function Conversation() {
  const { active, busy } = useVyrse();
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const lastText = active?.messages.at(-1)?.text ?? "";

  useEffect(() => {
    if (!pinned.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastText, active?.messages.length]);

  if (!active) return null;
  const lastUserIndex = active.messages.map((m) => m.role).lastIndexOf("user");

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      }}
      className="field-scroll h-full overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-5 pt-6 pb-6 sm:px-8">
        {active.messages.map((m, i) => (
          <div key={m.id}>
            {i > 0 && <div className="mb-8 h-px w-full bg-border/70" />}
            <Turn
              message={m}
              idle={!busy}
              last={m.role === "user" ? i === lastUserIndex : i === active.messages.length - 1}
            />
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
