import { useState, type ReactNode } from "react";
import { Check, Copy, RotateCcw, Volume2 } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="liquid-hover relative grid size-7 place-items-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

/** Copy / read aloud / retry for a finished reply. Retry only on the latest one, when VYRSE is idle. */
export function ReplyActions({ text, retry, className }: { text: string; retry: boolean; className?: string }) {
  const { regenerate, readAloud } = useVyrse();
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Action
        label={copied ? "Copied" : "Copy"}
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Action>
      <Action label="Read aloud" onClick={() => readAloud(text)}>
        <Volume2 className="size-3.5" />
      </Action>
      {retry && (
        <Action label="Retry" onClick={regenerate}>
          <RotateCcw className="size-3.5" />
        </Action>
      )}
    </div>
  );
}
