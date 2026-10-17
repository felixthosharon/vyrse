import { useEffect, useState } from "react";
import { Square } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";

/** While a lecture or meeting is being recorded: what it is, how long so far, and Stop. */
export function RecordingPill() {
  const { recording, stopRecording } = useVyrse();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [recording]);
  if (!recording) return null;
  const secs = Math.max(0, Math.floor((now - recording.startedAt) / 1000));
  const clock = `${Math.floor(secs / 3600) ? `${Math.floor(secs / 3600)}:` : ""}${String(Math.floor((secs % 3600) / 60)).padStart(Math.floor(secs / 3600) ? 2 : 1, "0")}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div role="status" aria-label={`Recording ${recording.title}`} className="fixed inset-x-0 top-[4.5rem] z-40 flex justify-center px-4">
      <div className="vyr-emerge liquid relative flex items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-[12.5px]">
        <span className="relative flex size-2.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-destructive/70" />
          <span className="relative size-2.5 rounded-full bg-destructive" />
        </span>
        <span className="max-w-[14rem] truncate text-foreground">{recording.title}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{clock}</span>
        <button type="button" onClick={stopRecording} className="flex items-center gap-1.5 rounded-full bg-foreground/[0.08] px-3 py-1 text-foreground hover:bg-foreground/[0.14] focus-visible:outline-none">
          <Square className="size-3 fill-current" strokeWidth={0} /> Stop
        </button>
      </div>
    </div>
  );
}
