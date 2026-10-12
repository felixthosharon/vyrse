import { AlarmCard } from "./AlarmCard";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Minimize2, X } from "lucide-react";
import { Environment } from "./Environment";
import { TopChrome } from "./TopChrome";
import { Composer } from "./Composer";
import { HistoryDrawer } from "./HistoryDrawer";
import { SettingsPanel, settingsBack } from "./SettingsPanel";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { LinkBanner } from "./LinkBanner";
import { ClarifyCard } from "./ClarifyCard";
import { Toast } from "./Toast";
import { Onboarding } from "./Onboarding";
import { VyrsePresence } from "./presence/VyrsePresence";
import { VoiceControl } from "./presence/VoiceControl";
import { Conversation } from "./conversation/Conversation";
import { LiveResponse } from "./conversation/LiveResponse";
import { Workspace } from "./conversation/Workspace";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";
import { IS_PHONE } from "@/services/phone";

const EASE = "cubic-bezier(0.16,0.84,0.24,1)";
const SIDE_MS = 700;

/**
 * Sizes the presence to the largest circle that fits the space its grid cell
 * actually grants it — at any viewport from 320px to 4K, without ever
 * overlapping the transcript, the voice control or the composer.
 *
 * The measured size is written straight to the target element's style. No React
 * state is involved, so a layout animation cannot produce a render-per-frame
 * feedback loop, and the presence tracks the layout exactly (never lagging).
 */
function useLargestFit<T extends HTMLElement, U extends HTMLElement>() {
  const ref = useRef<T>(null);
  const targetRef = useRef<U>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      const target = targetRef.current;
      if (!r || !target) return;
      // Largest circle the granted cell allows; a small floor keeps the
      // presence readable in the tightest vertical composition.
      // (A phone's transcript/workspace view leaves a short cell; there the orb just shrinks to fit.)
      const floor = window.innerWidth < 640 ? 64 : 168;
      const size = Math.max(floor, Math.floor(Math.min(r.width, r.height)));
      const px = `${size}px`;
      if (target.style.width !== px) {
        target.style.width = px;
        target.style.height = px;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, targetRef };
}

export function VyrseApp() {
  const {
    mode,
    settings,
    booted,
    presenceState,
    busy,
    expanded,
    setExpanded,
    presentation,
    setPresentation,
    error,
    dismissError,
    settingsOpen,
    setSettingsOpen,
    historyOpen,
    setHistoryOpen,
  } = useVyrse();

  // Android back button: closes whatever is open on top, else sends VYRSE to the background (never quits).
  const back = useRef(() => {});
  back.current = () => {
    if (settingsOpen) {
      if (!settingsBack.current?.()) setSettingsOpen(false);
    }
    else if (historyOpen) setHistoryOpen(false);
    else if (expanded) setExpanded(false);
    else if (presentation !== "compact") setPresentation("compact");
    else void import("@capacitor/app").then(({ App }) => App.minimizeApp());
  };
  useEffect(() => {
    if (!IS_PHONE) return;
    let off: (() => void) | undefined;
    let gone = false;
    void import("@capacitor/app").then(({ App }) =>
      App.addListener("backButton", () => back.current()).then((h) => {
        if (gone) void h.remove();
        else off = () => void h.remove();
      }),
    );
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  const stage = useLargestFit<HTMLDivElement, HTMLDivElement>();

  useEffect(() => {
    const root = document.documentElement;
    const prefersLight =
      settings.theme === "light" ||
      (settings.theme === "system" &&
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: light)").matches);
    root.classList.toggle("light", prefersLight);
    root.dataset["density"] = settings.density;
    root.dataset["glass"] = settings.glass ?? "liquid";
    if (IS_PHONE) root.dataset["device"] = "phone";
    root.dataset["motion"] = settings.reducedMotion ? "reduced" : settings.animations;
    root.dataset["contrast"] = settings.highContrast ? "high" : "normal";
    root.style.fontSize = `${settings.textSize * 100}%`;
  }, [settings]);

  // Liquid glass: the highlight follows the pointer over whichever glass surface it's on.
  useEffect(() => {
    // (Not on the phone: there's no pointer to follow, and it would restyle glass on every touch move.)
    if (IS_PHONE || settings.glass === "off" || settings.reducedMotion) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      const e = last;
      const el = e?.target instanceof Element ? e.target.closest<HTMLElement>(".liquid, .liquid-strong, .liquid-menu, .vyr-liquid-card") : null;
      if (!e || !el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [settings.glass, settings.reducedMotion]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, setExpanded]);

  // Escape always returns to the voice-first composition, whichever secondary
  // surface is open. Never a modal — the layout simply collapses back.
  useEffect(() => {
    if (presentation === "compact") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresentation("compact");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presentation, setPresentation]);

  const conversing = mode === "conversation";
  /**
   * The side region is one of two things: the transcript the user opened, or
   * the workspace the backend semantically requested. Its share of the middle
   * band is decided here — by the frontend — never by the model.
   */
  const showWorkspace = presentation !== "compact" && !expanded;
  const sideOpen = expanded || showWorkspace;
  const side: "transcript" | "workspace" | null = expanded ? "transcript" : showWorkspace ? "workspace" : null;

  // Keep the closing panel's content on screen while its column slides shut.
  const [shownSide, setShownSide] = useState(side);
  useEffect(() => {
    if (side) {
      setShownSide(side);
      return;
    }
    const t = window.setTimeout(() => setShownSide(null), SIDE_MS);
    return () => window.clearTimeout(t);
  }, [side]);

  /*
   * Two tracks always exist, so opening and closing animate: the side track grows from 0fr while
   * the presence cell (and the orb inside it, via its size observer) glides over. Every state uses
   * the same track shapes (minmax(0, Nfr)), which is what lets the browser interpolate them.
   */
  const tracks = !sideOpen
    ? "grid-rows-[minmax(0,1fr)_minmax(0,0fr)] lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,0fr)]"
    : expanded
      ? "grid-rows-[minmax(0,0.78fr)_minmax(0,1.9fr)] sm:grid-rows-[minmax(0,1fr)_minmax(0,1.45fr)] lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,0.85fr)_minmax(0,0.95fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]"
      : presentation === "focus"
        ? "grid-rows-[minmax(0,0.6fr)_minmax(0,1.9fr)] lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,0.52fr)_minmax(0,1.6fr)] xl:grid-cols-[minmax(0,0.6fr)_minmax(0,1.7fr)]"
        : "grid-rows-[minmax(0,0.78fr)_minmax(0,1.9fr)] sm:grid-rows-[minmax(0,1fr)_minmax(0,1.45fr)] lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]";

  return (
    <div className="relative grid h-dvh w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background">
      <Environment />

      <TopChrome />

      {/* Middle band: presence, and — when expanded — the transcript beside it */}
      <main
        className={cn(
          "relative z-10 grid min-h-0 w-full px-[clamp(0.75rem,2vw,2.5rem)]",
          tracks,
          sideOpen ? "lg:gap-x-[clamp(1rem,3vw,3.5rem)]" : "lg:gap-x-0",
        )}
        style={{
          // On the phone the tracks switch at once (animating them re-lays out the whole app every frame);
          // the panel itself still glides in below, and the orb eases to its new size.
          transition: IS_PHONE
            ? undefined
            : `grid-template-columns ${SIDE_MS}ms ${EASE}, grid-template-rows ${SIDE_MS}ms ${EASE}, column-gap ${SIDE_MS}ms ${EASE}`,
        }}
      >
        {/* Presence cell — the presence grows to the largest circle that fits */}
        <section className="flex min-h-0 min-w-0 flex-col items-center justify-center">
          <div ref={stage.ref} className="flex min-h-0 w-full flex-1 items-center justify-center">
            {/* Size is written directly by the observer above; the cell itself
                animates, so the presence follows the layout frame-perfectly. */}
            <div
              ref={stage.targetRef}
              className="relative size-0"
              style={IS_PHONE ? { transition: `width 420ms ${EASE}, height 420ms ${EASE}`, contain: "strict" } : undefined}
            >
              <VyrsePresence className="absolute inset-0" />
            </div>
          </div>

          <div
            className={cn(
              "shrink-0 pt-[clamp(0.5rem,1.4vh,1.5rem)] pb-[clamp(0.25rem,1vh,1rem)] transition-opacity duration-700",
              booted ? "opacity-100" : "opacity-0",
            )}
          >
            <VoiceControl />
          </div>
        </section>

        {/* Transcript cell — an in-flow region of the same space, never a modal */}
        <section
          aria-hidden={!sideOpen}
          className={cn(
            "min-h-0 min-w-0 overflow-hidden transition-[opacity,transform] ease-[cubic-bezier(0.16,0.84,0.24,1)]",
            sideOpen
              ? "pointer-events-auto translate-x-0 translate-y-0 opacity-100 duration-[800ms] delay-100 max-lg:duration-[420ms] max-lg:delay-75"
              : "pointer-events-none translate-x-6 opacity-0 duration-300 max-lg:translate-x-0 max-lg:translate-y-6 max-lg:duration-200",
          )}
        >
          {/* A minimum width while the track is narrow: the panel is revealed, not squashed. */}
          <div className="flex h-full min-h-0 flex-col pb-2 lg:min-w-[22rem]">
          {shownSide === "transcript" ? (
            <>
              <div className="mb-2 flex shrink-0 items-center justify-between gap-3 px-1">
                <p className="eyebrow">transcript</p>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label="Collapse transcript"
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Minimize2 className="size-3" strokeWidth={1.6} />
                  Collapse
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-[1.5rem] border border-border bg-surface/60">
                <Conversation />
              </div>
            </>
          ) : (
            shownSide === "workspace" && <Workspace />
          )}
          </div>
        </section>
      </main>

      {/* Voice-first foot: current response, then the quiet text channel */}
      <footer className="relative z-20 flex w-full flex-col items-center px-[clamp(0.75rem,2vw,2.5rem)] pb-[max(1rem,2.5vh)]">
        <div
          className={cn(
            "w-full max-w-[min(52rem,90vw)] transition-all duration-700 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
            conversing && !expanded && presentation === "compact"
              ? "mb-3 translate-y-0 opacity-100"
              : "pointer-events-none mb-0 h-0 translate-y-3 overflow-hidden opacity-0",
          )}
        >
          <LiveResponse />
        </div>

        <LinkBanner />
        <ClarifyCard />

        {error && (
          <div className="mb-2 flex w-full max-w-[min(44rem,90vw)] items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2">
            <p className="text-[12.5px] text-foreground">{error}</p>
            <button
              type="button"
              onClick={dismissError}
              aria-label="Dismiss error"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" strokeWidth={1.6} />
            </button>
          </div>
        )}

        <div
          className={cn(
            "w-full transition-all duration-700 ease-[cubic-bezier(0.16,0.84,0.24,1)]",
            conversing || expanded ? "max-w-[min(52rem,92vw)]" : "max-w-[min(38rem,92vw)]",
            booted && "vyr-settle",
          )}
          style={{ animationDelay: "280ms" }}
        >
          <Composer compact={conversing || expanded} />
        </div>

        <p
          className={cn(
            "mt-3 h-4 text-center text-[11.5px] text-muted-foreground/60 transition-opacity duration-1000",
            booted && !busy && !conversing && presenceState === "idle"
              ? "opacity-100"
              : "opacity-0",
          )}
        >
          Speak, or type if you'd rather.
        </p>
      </footer>

      <HistoryDrawer />
      <SettingsPanel />
      <ConfirmationDialog />
      <Toast />
      <AlarmCard />
      <Onboarding />
    </div>
  );
}
