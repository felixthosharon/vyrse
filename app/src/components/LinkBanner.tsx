import { useState } from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";

/**
 * Explains, in plain language, when Hermes isn't available — starting, reconnecting,
 * crashed or not installed — and offers the one action that helps. Hidden when online.
 */
export function LinkBanner() {
  const { link, restartBackend, booted } = useVyrse();
  const [showLog, setShowLog] = useState(false);
  if (!booted || link.phase === "online") return null;

  const transient = link.phase === "starting" || link.phase === "connecting" || link.phase === "reconnecting";
  const failed = link.phase === "failed" || link.phase === "offline";

  return (
    <div className="pointer-events-auto mx-auto mb-2 w-full max-w-[min(44rem,90vw)] rounded-xl border border-border-strong bg-surface/80 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center gap-3">
        {transient ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" strokeWidth={1.8} />
        ) : (
          <AlertTriangle className="size-4 shrink-0 text-destructive" strokeWidth={1.8} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-foreground">
            {link.phase === "not-installed" ? "Hermes Agent isn't installed" : link.message}
          </p>
          {link.detail && <p className="pt-0.5 text-[11px] text-muted-foreground">{link.detail}</p>}
        </div>
        {failed && (
          <button
            type="button"
            onClick={restartBackend}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-3 py-1 text-[11px] text-foreground transition-colors hover:border-primary/40"
          >
            <RotateCw className="size-3" strokeWidth={1.8} />
            Retry
          </button>
        )}
      </div>
      {link.logTail && link.logTail.length > 0 && failed && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {showLog ? "Hide details" : "Show details"}
          </button>
          <pre
            className={cn(
              "field-scroll mt-1.5 max-h-40 overflow-auto rounded-lg bg-background/60 p-2 font-mono text-[10px] text-muted-foreground",
              !showLog && "hidden",
            )}
          >
            {link.logTail.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
