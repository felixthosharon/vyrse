import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { MediaCommand, NowPlayingInfo } from "@/services/vyrse-api";
import { cn } from "@/lib/utils";
import { useVyrse } from "@/lib/vyrse/store";
import { MEDIA_CHANGED, TURN_DONE } from "@/lib/vyrse/media-events";


/** How often the pill re-reads what's playing while it is on screen (song changes, pause from the keyboard). */
const REFRESH_MS = 15_000;

/** "Spotify.exe" / "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" / "chrome" -> a short app name. */
export function mediaAppName(id: string | undefined): string {
  const raw = (id ?? "").split("!")[0]!.split(/[\\/]/).pop() ?? "";
  if (/spotify/i.test(raw)) return "Spotify";
  if (/chrome/i.test(raw)) return "Chrome";
  if (/msedge|edge/i.test(raw)) return "Edge";
  if (/firefox/i.test(raw)) return "Firefox";
  if (/vlc/i.test(raw)) return "VLC";
  if (/zunemusic|mediaplayer/i.test(raw)) return "Media Player";
  const name = raw.replace(/\.exe$/i, "").replace(/[_-].*$/, "");
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
}

/**
 * What is playing on the PC, with previous / play-pause / next. It appears when VYRSE starts music (or music is
 * already on when the app opens), follows the song, and can be dismissed until the next song.
 */
export function NowPlaying({ className }: { className?: string }) {
  const api = getVyrseApi().media;
  const online = useVyrse().link.phase === "online";
  const [info, setInfo] = useState<NowPlayingInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setInfo(await api.now());
    } catch {
      /* the controls helper isn't reachable right now: keep what is shown */
    }
  }, [api]);

  const visible = !!info?.title && info.title !== dismissed && (info.playing || shown.current);
  shown.current = visible;

  useEffect(() => {
    if (!api || !online) return;
    // a first look once the backend is up (music that was already playing when the app opened)
    const first = window.setTimeout(() => void refresh(), 2500);
    const onMedia = () => window.setTimeout(() => void refresh(), 700);
    const onTurn = () => {
      if (shown.current) void refresh();
    };
    window.addEventListener(MEDIA_CHANGED, onMedia);
    window.addEventListener(TURN_DONE, onTurn);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener(MEDIA_CHANGED, onMedia);
      window.removeEventListener(TURN_DONE, onTurn);
    };
  }, [api, online, refresh]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  const send = async (command: MediaCommand) => {
    if (!api || busy) return;
    setBusy(true);
    // the button answers at once; the real state follows when Windows reports it
    if (command === "play_pause") setInfo((i) => (i ? { ...i, playing: !i.playing } : i));
    try {
      const next = await api.send(command);
      if (next?.title) setInfo(next);
      if (command !== "play_pause") window.setTimeout(() => void refresh(), 1200);
    } catch {
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!api || !info?.title) return null;
  const app = mediaAppName(info.app);
  const button =
    "grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

  return (
    <div
      role="group"
      aria-label="Now playing"
      aria-hidden={!visible}
      className={cn(
        "liquid pointer-events-auto flex max-w-[min(26rem,92vw)] items-center gap-2 rounded-full py-1 pl-3 pr-1.5 transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0",
        className,
      )}
    >
      <span className="flex h-3.5 shrink-0 items-end gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn("w-[2.5px] rounded-full bg-primary", info.playing ? "now-playing-bar" : "h-[3px]")}
            style={info.playing ? { animationDelay: `${i * -0.35}s` } : undefined}
          />
        ))}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[12px] text-foreground">{info.title}</p>
        <p className="truncate text-[10.5px] text-muted-foreground">
          {[info.artist, app].filter(Boolean).join(" · ") || (info.playing ? "Playing" : "Paused")}
        </p>
      </div>
      <button type="button" className={button} disabled={busy} tabIndex={visible ? 0 : -1} aria-label="Previous track" onClick={() => void send("previous")}>
        <SkipBack className="size-3.5" strokeWidth={1.8} />
      </button>
      <button type="button" className={button} disabled={busy} tabIndex={visible ? 0 : -1} aria-label={info.playing ? "Pause" : "Play"} onClick={() => void send("play_pause")}>
        {info.playing ? <Pause className="size-3.5" strokeWidth={1.8} /> : <Play className="size-3.5" strokeWidth={1.8} />}
      </button>
      <button type="button" className={button} disabled={busy} tabIndex={visible ? 0 : -1} aria-label="Next track" onClick={() => void send("next")}>
        <SkipForward className="size-3.5" strokeWidth={1.8} />
      </button>
      <button type="button" className={button} tabIndex={visible ? 0 : -1} aria-label="Hide now playing" onClick={() => setDismissed(info.title ?? null)}>
        <X className="size-3" strokeWidth={1.8} />
      </button>
    </div>
  );
}
