import { useCallback, useEffect, useRef, useState } from "react";
import { playUiSound } from "@/lib/vyrse/ui-sounds";

/**
 * Reordering workspace cards by dragging their header. Pointer-based (not the browser's drag-and-drop, whose
 * full-size snapshot of a tall card floated over the whole screen and which never scrolled): a small chip
 * follows the pointer, the card it'll land in front of glows, and holding near the top or bottom edge of the
 * board scrolls it. The pointer is captured, so leaving the window mid-drag doesn't lose it. Esc cancels.
 */
export interface CardDrag {
  /** the card being dragged, and the one it would land in front of */
  dragging: string | null;
  over: string | null;
  /** where the chip is (viewport px) and what it says */
  chip: { x: number; y: number; title: string } | null;
  /** spread on each card's wrapper */
  handlers: (id: string, title: string) => { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void; "data-ws-item": string };
}

const START_PX = 6;
/** dropped below the last card: it goes to the end */
export const END = "__end__";
const EDGE_PX = 72;
const MAX_SPEED = 22; // px per frame at the very edge

export function useCardDrag(enabled: boolean, scroller: React.RefObject<HTMLElement | null>, onDrop: (id: string, before: string) => void): CardDrag {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [chip, setChip] = useState<CardDrag["chip"]>(null);
  const live = useRef<{ id: string; title: string; x0: number; y0: number; started: boolean; el: HTMLElement; pointer: number; y: number; x: number } | null>(null);
  const frame = useRef(0);
  const overRef = useRef<string | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const end = useCallback((commit: boolean) => {
    const d = live.current;
    live.current = null;
    cancelAnimationFrame(frame.current);
    if (d?.started) {
      try {
        d.el.releasePointerCapture(d.pointer);
      } catch {}
      // the click that follows a drag must not toggle the card it started on
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
      const target = overRef.current;
      if (commit && target && target !== d.id) {
        playUiSound("tick-soft");
        dropRef.current(d.id, target);
      }
    }
    overRef.current = null;
    setDragging(null);
    setOver(null);
    setChip(null);
    document.body.style.removeProperty("user-select");
    document.body.style.removeProperty("cursor");
  }, []);

  // While dragging: keep the board scrolling when the pointer rests near its edge, and track what's underneath.
  const tick = useCallback(() => {
    const d = live.current;
    const box = scroller.current;
    if (!d?.started || !box) return;
    const r = box.getBoundingClientRect();
    const top = d.y - r.top;
    const bottom = r.bottom - d.y;
    let dy = 0;
    if (top < EDGE_PX) dy = -MAX_SPEED * Math.min(1, (EDGE_PX - top) / EDGE_PX);
    else if (bottom < EDGE_PX) dy = MAX_SPEED * Math.min(1, (EDGE_PX - bottom) / EDGE_PX);
    if (dy) box.scrollTop += dy;
    const next = targetAt(box, d.x, d.y, d.id);
    if (next !== overRef.current) {
      overRef.current = next;
      setOver(next);
    }
    frame.current = requestAnimationFrame(tick);
  }, [scroller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && live.current?.started && end(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [end]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const handlers = useCallback(
    (id: string, title: string) => ({
      "data-ws-item": id,
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (!enabled || e.button !== 0) return;
        const t = e.target as HTMLElement;
        // only from the card's header, never from its buttons, fields or contents
        if (!t.closest("[data-card-head]") || t.closest("[data-card-chrome],input,textarea,select,a")) return;
        const el = e.currentTarget;
        live.current = { id, title, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, el, pointer: e.pointerId };
        const move = (ev: PointerEvent) => {
          const d = live.current;
          if (!d || ev.pointerId !== d.pointer) return;
          d.x = ev.clientX;
          d.y = ev.clientY;
          if (!d.started) {
            if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < START_PX) return;
            d.started = true;
            try {
              d.el.setPointerCapture(d.pointer);
            } catch {}
            document.body.style.userSelect = "none";
            document.body.style.cursor = "grabbing";
            setDragging(d.id);
            frame.current = requestAnimationFrame(tick);
          }
          setChip({ x: ev.clientX, y: ev.clientY, title: d.title });
        };
        const up = (ev: PointerEvent) => {
          if (live.current && ev.pointerId !== live.current.pointer) return;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          end(ev.type === "pointerup");
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      },
    }),
    [enabled, end, tick],
  );

  return { dragging, over, chip, handlers };
}

/** The card under the pointer (or the nearest one in the gaps between cards), END below the last card. */
function targetAt(box: HTMLElement, x: number, y: number, self: string): string | null {
  const cards = [...box.querySelectorAll<HTMLElement>("[data-ws-item]")].map((el) => ({ id: el.dataset["wsItem"] ?? "", r: el.getBoundingClientRect() }));
  if (!cards.length) return null;
  const inside = cards.find((c) => y >= c.r.top && y <= c.r.bottom && x >= c.r.left - 8 && x <= c.r.right + 8);
  let id: string | null = inside?.id ?? null;
  if (!id) {
    const lowest = Math.max(...cards.map((c) => c.r.bottom));
    if (y > lowest - 4) id = END;
    else {
      const near = cards.reduce((a, c) => (Math.abs(y - (c.r.top + c.r.height / 2)) < Math.abs(y - (a.r.top + a.r.height / 2)) ? c : a));
      id = near.id;
    }
  }
  return id === self ? null : id;
}
