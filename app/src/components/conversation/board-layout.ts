import { useCallback, useEffect, useState } from "react";
import type { Artifact } from "@/lib/vyrse/types";

/**
 * How the user arranged a conversation's workspace: their order (drag), pinned cards (kept on top and kept when the
 * board is cleared), sizes, and chart-type overrides. It's a view preference, so it lives in this browser only
 * (per conversation), never in what VYRSE built.
 */
export type CardSize = "s" | "m" | "l";
export type ChartStyle = "line" | "bar" | "donut";
export type BoardLayout = { order: string[]; pinned: string[]; size: Record<string, CardSize>; chart: Record<string, ChartStyle> };

const EMPTY: BoardLayout = { order: [], pinned: [], size: {}, chart: {} };
const key = (conversation: string) => `vyrse.board.${conversation}`;

function read(conversation: string | null): BoardLayout {
  if (!conversation) return EMPTY;
  try {
    const raw = localStorage.getItem(key(conversation));
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<BoardLayout>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function useBoardLayout(conversation: string | null) {
  const [layout, setLayout] = useState<BoardLayout>(() => read(conversation));
  useEffect(() => setLayout(read(conversation)), [conversation]);
  const update = useCallback(
    (fn: (l: BoardLayout) => BoardLayout) =>
      setLayout((prev) => {
        const next = fn(prev);
        if (conversation) {
          try {
            localStorage.setItem(key(conversation), JSON.stringify(next));
          } catch {
            // private window or full storage: the arrangement just won't be remembered
          }
        }
        return next;
      }),
    [conversation],
  );
  return { layout, update };
}

/** The items in display order: pinned first, then the user's order; anything new (not yet placed) on top. */
export function arrange(items: Artifact[], layout: BoardLayout): Artifact[] {
  const byId = new Map(items.map((a) => [a.id ?? "", a]));
  const pinned = layout.pinned.map((id) => byId.get(id)).filter((a): a is Artifact => !!a);
  const placed = new Set([...layout.pinned, ...layout.order]);
  const fresh = items.filter((a) => !placed.has(a.id ?? ""));
  const ordered = layout.order.map((id) => byId.get(id)).filter((a): a is Artifact => !!a && !layout.pinned.includes(a.id ?? ""));
  return [...pinned, ...fresh, ...ordered];
}

/** Move `id` to where `target` is (dropping a card on another). */
export function moved(list: string[], id: string, target: string): string[] {
  const out = list.filter((x) => x !== id);
  const i = out.indexOf(target);
  out.splice(i < 0 ? out.length : i, 0, id);
  return out;
}
