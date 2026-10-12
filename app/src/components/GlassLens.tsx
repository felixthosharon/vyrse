import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { IS_PHONE } from "@/services/phone";

/**
 * A liquid-glass lens that slides to the selected option of a group (segmented controls, tabs) instead of
 * each option jumping between styles. Render it as the first child of a `relative` group; options sit
 * above it. `selector` finds the selected element in the group; `active` re-measures when it changes.
 *
 * The group is the lens's own parent element: a parent's ref isn't attached yet when a child's layout
 * effect first runs, so going through one left every lens unmeasured until the selection changed.
 */
/*
 * All lenses measure in one shared pass per frame: first every read (one layout for the whole page), then
 * every state update (one render). Measuring each lens as it mounts forced a fresh layout per lens - the
 * Appearance page has a dozen - which was the stall when a settings page opened on the phone.
 */
type Job = () => (() => void) | void;
const jobs = new Set<Job>();
let frame = 0;
function schedule(job: Job): void {
  jobs.add(job);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const run = [...jobs];
    jobs.clear();
    const applies = run.map((j) => j());
    applies.forEach((apply) => apply?.());
  });
}

export function GlassLens({ selector, active, className }: { selector: string; active: string; className?: string }) {
  const lens = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const moved = useRef(false);

  useLayoutEffect(() => {
    const root = lens.current?.parentElement;
    if (!root) return;
    let watched: HTMLElement | null = null;
    let tries = 0;
    let alive = true;
    const ro = new ResizeObserver(() => schedule(measure));
    // Groups often mount while hidden (closed settings panel): the observer on the selected option
    // re-measures when it gets a size; a few frames of retry cover late renders.
    const measure: Job = () => {
      if (!alive) return;
      const el = root.querySelector<HTMLElement>(selector);
      if (el !== watched) {
        if (watched) ro.unobserve(watched);
        if (el) ro.observe(el);
        watched = el;
      }
      if (!el || !el.offsetWidth) {
        if (tries++ < 30) schedule(measure);
        return;
      }
      const next = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      return () => {
        if (alive)
          setBox((prev) =>
            prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next,
          );
      };
    };
    ro.observe(root);
    schedule(measure);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [selector, active]);

  // The first placement doesn't animate (no slide in from the corner); every change after does.
  useLayoutEffect(() => {
    if (!box) return;
    const id = requestAnimationFrame(() => {
      moved.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [box]);

  return (
    <span
      ref={lens}
      aria-hidden="true"
      className={cn("liquid pointer-events-none absolute top-0 left-0 z-0", className)}
      style={{
        visibility: box ? "inherit" : "hidden",
        width: box?.w ?? 0,
        height: box?.h ?? 0,
        transform: `translate(${box?.x ?? 0}px, ${box?.y ?? 0}px)`,
        // Phone: only the slide animates (compositor); width/height animation would re-lay out every frame.
        transition: !moved.current
          ? "none"
          : IS_PHONE
            ? "transform 380ms cubic-bezier(0.34, 1.32, 0.52, 1)"
            : "transform 460ms cubic-bezier(0.34, 1.32, 0.52, 1), width 460ms cubic-bezier(0.34, 1.32, 0.52, 1), height 360ms ease",
      }}
    />
  );
}
