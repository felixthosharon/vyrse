import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getVyrseApi } from "@/services";
import { cn } from "@/lib/utils";
import { Row } from "./controls";

type IndexStatus = { files: number; built_at: number | null; building: boolean };

function ago(at: number | null): string {
  if (!at) return "not yet";
  const mins = Math.round((Date.now() / 1000 - at) / 60);
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

/** VYRSE's own index of the main folders (Desktop, Documents, Downloads, …): refreshed at startup, every 10 hours, or here. */
export function FileIndexRow() {
  const ui = getVyrseApi().ui;
  const [status, setStatus] = useState<IndexStatus | null>(null);
  useEffect(() => {
    if (!ui?.fileIndex) return;
    let alive = true;
    const poll = () => void ui.fileIndex(false).then((s) => alive && setStatus(s)).catch(() => {});
    poll();
    const id = window.setInterval(poll, status?.building ? 1500 : 15000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [ui, status?.building]);
  if (!ui?.fileIndex) return null;
  return (
    <Row label="File index" hint="main folders only · startup and every 10 h · only changes are written">
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-secondary/15 px-3.5 py-2.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {status ? (status.building ? "indexing…" : `${status.files.toLocaleString()} items · ${ago(status.built_at)}`) : "…"}
        </span>
        <button
          type="button"
          disabled={!!status?.building}
          onClick={() => void ui.fileIndex(true).then(setStatus).catch(() => {})}
          className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[12px] text-foreground/90 enabled:hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3.5", status?.building && "animate-spin")} strokeWidth={1.6} /> Re-index now
        </button>
      </div>
    </Row>
  );
}
