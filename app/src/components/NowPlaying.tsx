import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { MediaCommand, NowPlayingInfo } from "@/services/vyrse-api";
import { cn } from "@/lib/utils";
import { useVyrse } from "@/lib/vyrse/store";
import { MEDIA_CHANGED } from "@/lib/vyrse/media-events";
import { IS_PHONE } from "@/services/phone";

/** How often each VYRSE window asks whether VYRSE's music changed (a tiny file read on the PC, no PowerShell). */
const STATE_MS = 3_000;
/** While the pill shows, how often it re-reads the song itself (next song, pause from the keyboard). */
const REFRESH_MS = 10_000;

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
 * The music VYRSE started or controlled, with previous / play-pause / next. It is the same in every chat and on
 * every device: the PC keeps one shared state, every window asks for its version every few seconds and re-reads
 * the song when it moved. Closing it closes it everywhere; music VYRSE didn't start never shows here.
 *
 * It sits in the layout above the orb (not over it), and grows with the window.
 */
export function NowPlaying({ className }: { className?: string }) {
  const api = getVyrseApi().media;
  const online = useVyrse().link.phase === "online";
  const [info, setInfo] = useState<NowPlayingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(-1);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.now();
      if (typeof next.version === "number") version.current = next.version;
      setInfo(next);
    } catch {
      /* the controls helper isn't reachable right now: keep what is shown */
    }
  }, [api]);

  // Live across chats and devices: a cheap look at the shared version every few seconds.
  useEffect(() => {
    if (!api || !online) return;
    let stopped = false;
    const look = async () => {
      try {
        const s = await api.state();
        if (stopped) return;
        if (!s.owned) {
          version.current = s.version;
          setInfo((i) => (i?.owned ? { ...i, owned: false } : i));
        } else if (s.version !== version.current) {
          await refresh();
        }
      } catch {
        /* offline for a moment */
      }
    };
    void look();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void look();
    }, STATE_MS);
    const onMedia = () => window.setTimeout(() => void refresh(), 700);
    const onVisible = () => document.visibilityState === "visible" && void look();
    window.addEventListener(MEDIA_CHANGED, onMedia);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener(MEDIA_CHANGED, onMedia);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, online, refresh]);

  const visible = !!info?.owned && !!info.title;

  // The song itself changes without VYRSE knowing (Spotify moves on, a key on the keyboard): look while shown.
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
      if (next?.title) {
        if (typeof next.version === "number") version.current = next.version;
        setInfo(next);
      }
      if (command !== "play_pause") window.setTimeout(() => void refresh(), 1200);
    } catch {
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const hide = () => {
    setInfo((i) => (i ? { ...i, owned: false } : i));
    void api?.hide().catch(() => {});
  };

  if (!api) return null;
  const app = mediaAppName(info?.app);
  const button =
    "grid size-[2.2em] shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  const icon = "size-[1.15em]";

  return (
    // In the layout: the row opens to the pill's height and the orb below shrinks to fit, so they never overlap.
    <div
      className={cn(
        "grid w-full shrink-0 justify-items-center",
        IS_PHONE ? "" : "transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
        visible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
      // 13px on a phone, growing with the window to 18px on a large screen
      style={{ fontSize: "clamp(13px, calc(7px + 0.42vw + 0.42vh), 18px)" }}
    >
      <div className="min-h-0 overflow-hidden px-2">
        {info?.title ? (
          <div
            role="group"
            aria-label="Now playing"
            aria-hidden={!visible}
            className="liquid now-playing-pill pointer-events-auto mx-auto mb-[0.6em] mt-[0.15em] flex w-[min(25em,92vw)] items-center gap-[0.6em] rounded-full py-[0.35em] pl-[1em] pr-[0.45em]"
          >
            <span className="flex h-[1.15em] shrink-0 items-end gap-[0.16em]" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={cn("w-[0.2em] rounded-full bg-primary", info.playing ? "now-playing-bar" : "h-[0.25em]")}
                  style={info.playing ? { animationDelay: `${i * -0.35}s` } : undefined}
                />
              ))}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[1em] text-foreground">{info.title}</p>
              <p className="truncate text-[0.82em] text-muted-foreground">
                {[info.artist, app].filter(Boolean).join(" · ") || (info.playing ? "Playing" : "Paused")}
              </p>
            </div>
            <button type="button" className={button} disabled={busy} tabIndex={visible ? 0 : -1} aria-label="Previous track" onClick={() => void send("previous")}>
              <SkipBack className={icon} strokeWidth={1.8} />
            </button>
            <button type="button" className={button} disabled={busy} tabIndex={visible ? 0 : -1} aria-label={info.playing ? "Pause" : "Play"} onClick={() => void send("play_pause")}>
              {info.playing ? <Pause className={icon} strokeWidth={1.8} /> : <Play className={icon} strokeWidth={1.8} />}
            </button>
            <button type="button" className={button} disabled={busy} tabIndex={visible ? 0 : -1} aria-label="Next track" onClick={() => void send("next")}>
              <SkipForward className={icon} strokeWidth={1.8} />
            </button>
            <button type="button" className={button} tabIndex={visible ? 0 : -1} aria-label="Hide now playing" onClick={hide}>
              <X className="size-[0.95em]" strokeWidth={1.8} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
