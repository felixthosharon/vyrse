import type { Artifact, FormField } from "@/lib/vyrse/types";

/**
 * Validates a workspace artifact sent by the vyrse plugin's `vyrse_workspace` tool. Only typed data
 * passes — strings are length-capped, numbers must be finite, images must be base64 data URLs of an
 * image type (SVG excluded: it can carry script). Anything else is dropped.
 */
export function parseArtifact(raw: unknown): Artifact | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const id = str(a["id"], 48);
  const title = str(a["title"], 120);
  if (!id || !title) return null;
  const actions = arr(a["actions"]).map(obj).filter(Boolean).slice(0, 4).flatMap((b) =>
    str(b!["label"], 40) && str(b!["prompt"], 300) ? [{ label: str(b!["label"], 40), prompt: str(b!["prompt"], 300) }] : [],
  );
  const base = {
    id,
    title,
    ...(str(a["caption"], 240) ? { caption: str(a["caption"], 240) } : {}),
    ...(actions.length ? { actions } : {}),
  };

  switch (a["kind"]) {
    case "series": {
      const series = arr(a["series"])
        .map((p) => obj(p))
        .filter((p): p is Record<string, unknown> => !!p && num(p["value"]) !== null)
        .slice(0, 400)
        .map((p) => ({ label: str(p["label"], 24), value: num(p["value"])! }));
      if (!series.length) return null;
      const chart = obj(a["chart"]);
      const highlight = str(chart?.["highlight"], 24);
      const threshold = num(chart?.["threshold"]);
      return {
        ...base,
        kind: "series",
        series,
        chart: {
          style: chart?.["style"] === "bar" || chart?.["style"] === "donut" ? chart["style"] : "line",
          ...(str(chart?.["unit"], 12) ? { unit: str(chart?.["unit"], 12) } : {}),
          ...(highlight && series.some((p) => p.label === highlight) ? { highlight } : {}),
          ...(threshold !== null ? { threshold } : {}),
        },
      };
    }
    case "table": {
      const t = obj(a["table"]);
      const columns = arr(t?.["columns"]).map((c) => str(c, 60)).slice(0, 20);
      const rows = arr(t?.["rows"]).filter(Array.isArray).slice(0, 500).map((r) => (r as unknown[]).slice(0, 20).map(cell));
      const highlight = num(t?.["highlight"]);
      return columns.length && rows.length
        ? { ...base, kind: "table", table: { columns, rows, ...(highlight !== null && highlight >= 0 && highlight < rows.length ? { highlight: Math.floor(highlight) } : {}) } }
        : null;
    }
    case "markdown": {
      const markdown = str(a["markdown"], 60_000);
      return markdown ? { ...base, kind: "markdown", markdown } : null;
    }
    case "image": {
      const image = obj(a["image"]);
      const dataUrl = typeof image?.["dataUrl"] === "string" ? (image["dataUrl"] as string) : "";
      if (!/^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 9_000_000) return null;
      return { ...base, kind: "image", image: { dataUrl, alt: str(image?.["alt"], 120) || title } };
    }
    case "code": {
      const code = obj(a["code"]);
      const text = str(code?.["code"], 60_000);
      const highlight = arr(code?.["highlight"]).map(num).filter((n): n is number => n !== null && n > 0).slice(0, 50).map(Math.floor);
      return text ? { ...base, kind: "code", code: { code: text, language: str(code?.["language"], 24), ...(highlight.length ? { highlight } : {}) } } : null;
    }
    case "timeline": {
      const timeline = arr(a["timeline"]).map(obj).filter(Boolean).slice(0, 200).map((i) => ({
        at: str(i!["at"], 40),
        label: str(i!["label"], 160),
        ...(str(i!["detail"], 300) ? { detail: str(i!["detail"], 300) } : {}),
      }));
      return timeline.length ? { ...base, kind: "timeline", timeline } : null;
    }
    case "flow": {
      const flow = arr(a["flow"]).map(obj).filter(Boolean).slice(0, 20).map((i, n) => ({
        id: str(i!["id"], 12) || String(n),
        label: str(i!["label"], 120),
        ...(str(i!["note"], 160) ? { note: str(i!["note"], 160) } : {}),
        ...(typeof i!["done"] === "boolean" ? { done: i!["done"] as boolean } : {}),
      }));
      return flow.length ? { ...base, kind: "flow", flow } : null;
    }
    case "system_status": {
      const s = obj(a["system_status"]);
      const values = arr(s?.["values"]).map(obj).filter(Boolean).slice(0, 24).map((v) => ({ label: str(v!["label"], 60), value: str(v!["value"], 120) }));
      return values.length ? { ...base, kind: "system_status", system_status: { title, values } } : null;
    }
    case "progress": {
      const p = obj(a["progress"]);
      const value = num(p?.["value"]);
      return {
        ...base,
        kind: "progress",
        progress: {
          label: str(p?.["label"], 120) || title,
          ...(value !== null ? { value: Math.max(0, Math.min(1, value)) } : {}),
          ...(str(p?.["message"], 200) ? { message: str(p?.["message"], 200) } : {}),
        },
      };
    }
    case "rings": {
      const rings = arr(a["rings"]).map(obj).filter(Boolean).slice(0, 6).flatMap((r) => {
        const value = num(r!["value"]);
        const max = num(r!["max"]);
        if (value === null || max === null || max <= 0) return [];
        return [{ label: str(r!["label"], 40), value, max, ...(str(r!["unit"], 12) ? { unit: str(r!["unit"], 12) } : {}) }];
      });
      return rings.length ? { ...base, kind: "rings", rings } : null;
    }
    case "stats": {
      const stats = arr(a["stats"]).map(obj).filter(Boolean).slice(0, 8).flatMap((v) =>
        str(v!["value"], 24)
          ? [{
              label: str(v!["label"], 40),
              value: str(v!["value"], 24),
              ...(str(v!["change"], 16) ? { change: str(v!["change"], 16) } : {}),
              ...(str(v!["note"], 80) ? { note: str(v!["note"], 80) } : {}),
              ...(numbers(v!["trend"], 60).length >= 2 ? { trend: numbers(v!["trend"], 60) } : {}),
            }]
          : [],
      );
      return stats.length ? { ...base, kind: "stats", stats } : null;
    }
    case "checklist": {
      const checklist = arr(a["checklist"]).map(obj).filter(Boolean).slice(0, 50).flatMap((c) =>
        str(c!["label"], 160) ? [{ label: str(c!["label"], 160), done: c!["done"] === true }] : [],
      );
      return checklist.length ? { ...base, kind: "checklist", checklist } : null;
    }
    case "quiz": {
      const q = obj(a["quiz"]);
      const questions = arr(q?.["questions"]).map(obj).filter(Boolean).slice(0, 30).flatMap((i) => {
        const question = str(i!["question"], 300);
        if (!question) return [];
        return [{
          question,
          ...(str(i!["answer"], 200) ? { answer: str(i!["answer"], 200) } : {}),
          ...(typeof i!["correct"] === "boolean" ? { correct: i!["correct"] as boolean } : {}),
          ...(str(i!["right_answer"], 200) ? { right_answer: str(i!["right_answer"], 200) } : {}),
          ...(str(i!["note"], 300) ? { note: str(i!["note"], 300) } : {}),
          ...(choices(i!["choices"]).length >= 2 ? { choices: choices(i!["choices"]) } : {}),
        }];
      });
      const subject = str(q?.["subject"], 60);
      return questions.length ? { ...base, kind: "quiz", quiz: { questions, ...(subject ? { subject } : {}) } } : null;
    }
    case "scorecard": {
      const c = obj(a["scorecard"]);
      const score = num(c?.["score"]);
      const total = num(c?.["total"]);
      if (score === null || total === null || total <= 0) return null;
      const topics = arr(c?.["topics"]).map(obj).filter(Boolean).slice(0, 12).flatMap((t) => {
        const value = num(t!["value"]);
        return value === null ? [] : [{ label: str(t!["label"], 60), value: Math.max(0, Math.min(1, value)), weak: t!["weak"] === true }];
      });
      const extra: { verdict?: string; subject?: string; review?: string } = {};
      for (const [k, max] of [["verdict", 60], ["subject", 60], ["review", 200]] as const) if (str(c?.[k], max)) extra[k] = str(c?.[k], max);
      return { ...base, kind: "scorecard", scorecard: { score, total, topics, ...extra } };
    }
    case "flashcards": {
      const flashcards = arr(a["flashcards"]).map(obj).filter(Boolean).slice(0, 60).flatMap((f) =>
        str(f!["front"], 300) && str(f!["back"], 600) ? [{ front: str(f!["front"], 300), back: str(f!["back"], 600) }] : [],
      );
      return flashcards.length ? { ...base, kind: "flashcards", flashcards } : null;
    }
    case "folders": {
      const items = arr(a["folders"]).map(obj).filter(Boolean).slice(0, 12).flatMap((f) => {
        const count = num(f!["count"]);
        return str(f!["name"], 40) && count !== null && count >= 0 ? [{ name: str(f!["name"], 40), count: Math.round(count) }] : [];
      });
      if (!items.length) return null;
      const total = num(a["total"]) ?? items.reduce((n, f) => n + f.count, 0);
      const sizeGb = num(a["size_gb"]);
      return { ...base, kind: "folders", folders: { items, total: Math.round(total), sorted: a["sorted"] === true, ...(sizeGb ? { sizeGb } : {}) } };
    }
    case "gauges": {
      const gauges = arr(a["gauges"]).map(obj).filter(Boolean).slice(0, 6).flatMap((g) => {
        const value = num(g!["value"]);
        const max = num(g!["max"]) ?? 100;
        const warn = num(g!["warn"]);
        if (value === null || max <= 0) return [];
        return [{ label: str(g!["label"], 40), value, max, ...(str(g!["unit"], 12) ? { unit: str(g!["unit"], 12) } : {}), ...(warn !== null ? { warn } : {}) }];
      });
      return gauges.length ? { ...base, kind: "gauges", gauges } : null;
    }
    case "cards": {
      const cards = arr(a["cards"]).map(obj).filter(Boolean).slice(0, 8).flatMap((c) => {
        const label = str(c!["label"], 60);
        const detail = str(c!["detail"], 400);
        if (!label && !detail) return [];
        return [{ label, detail, ...(str(c!["value"], 24) ? { value: str(c!["value"], 24) } : {}), ...(str(c!["icon"], 16) ? { icon: str(c!["icon"], 16) } : {}) }];
      });
      return cards.length ? { ...base, kind: "cards", cards } : null;
    }
    case "weather": {
      const w = obj(a["weather"]);
      const temp = num(w?.["temp"]);
      if (temp === null) return null;
      const forecast = arr(w?.["forecast"]).map(obj).filter(Boolean).slice(0, 7).flatMap((f) =>
        num(f!["value"]) === null ? [] : [{ at: str(f!["at"], 16), label: str(f!["label"], 40), value: num(f!["value"])! }],
      );
      const extra: { high?: number; low?: number } = {};
      for (const k of ["high", "low"] as const) if (num(w?.[k]) !== null) extra[k] = num(w?.[k])!;
      return {
        ...base,
        kind: "weather",
        weather: { location: str(w?.["location"], 60) || title, condition: str(w?.["condition"], 60), temp, unit: str(w?.["unit"], 4) || "°", ...extra, ...(forecast.length ? { forecast } : {}) },
      };
    }
    case "timer": {
      const t = obj(a["timer"]);
      const endsAt = num(t?.["ends_at"]);
      const seconds = num(t?.["seconds"]);
      if (endsAt === null || seconds === null || seconds <= 0) return null;
      const pausedLeft = num(t?.["paused_left"]);
      return {
        ...base,
        kind: "timer",
        timer: {
          label: str(t?.["label"], 120) || title,
          ends_at: endsAt,
          seconds,
          ...(pausedLeft !== null && pausedLeft >= 0 ? { paused_left: pausedLeft } : {}),
          ...(t?.["stopped"] === true ? { stopped: true } : {}),
        },
      };
    }
    case "form": {
      const f = obj(a["form"]);
      const fields = arr(f?.["fields"]).map(obj).filter(Boolean).slice(0, 10).flatMap((x): FormField[] => {
        const label = str(x!["label"], 60);
        const type = x!["type"];
        if (!label) return [];
        const kind: FormField["type"] = type === "number" || type === "date" || type === "time" || type === "select" ? type : "text";
        const options = arr(x!["options"]).map((o) => str(o, 40)).filter(Boolean).slice(0, 12);
        if (kind === "select" && options.length < 2) return [{ label, type: "text" as const }];
        return [{
          label,
          type: kind,
          ...(kind === "select" ? { options } : {}),
          ...(str(x!["placeholder"], 60) ? { placeholder: str(x!["placeholder"], 60) } : {}),
        }];
      });
      const sentRaw = obj(f?.["sent"]);
      const sent = sentRaw ? Object.fromEntries(Object.entries(sentRaw).slice(0, 10).map(([k, v]) => [k.slice(0, 60), str(v, 300)])) : null;
      return fields.length
        ? { ...base, kind: "form", form: { fields, submit: str(f?.["submit"], 30) || "Send", ...(sent ? { sent } : {}) } }
        : null;
    }
    case "board": {
      const board = arr(a["board"]).map(obj).filter(Boolean).slice(0, 6).flatMap((col) => {
        const cards = arr(col!["cards"]).map(obj).filter(Boolean).slice(0, 60).flatMap((c) =>
          str(c!["label"], 160) ? [{ label: str(c!["label"], 160), ...(str(c!["note"], 160) ? { note: str(c!["note"], 160) } : {}) }] : [],
        );
        return str(col!["name"], 30) ? [{ name: str(col!["name"], 30), cards }] : [];
      });
      return board.length ? { ...base, kind: "board", board } : null;
    }
    case "heatmap": {
      const h = obj(a["heatmap"]);
      const cells = arr(h?.["cells"]).map(obj).filter(Boolean).slice(0, 371).flatMap((c) =>
        num(c!["value"]) === null ? [] : [{ label: str(c!["label"], 24), value: num(c!["value"])! }],
      );
      return cells.length ? { ...base, kind: "heatmap", heatmap: { cells, ...(str(h?.["unit"], 12) ? { unit: str(h?.["unit"], 12) } : {}) } } : null;
    }
    case "log": {
      const l = obj(a["log"]);
      if (!l) return null;
      const days = arr(l["days"]).map(obj).filter(Boolean).slice(0, 14).map((d) => ({ label: str(d!["label"], 12), value: num(d!["value"]) ?? 0 }));
      const entries = arr(l["entries"]).map(obj).filter(Boolean).slice(0, 12).map((e) => ({
        at: str(e!["at"], 24),
        label: str(e!["label"], 80),
        ...(num(e!["value"]) !== null ? { value: num(e!["value"])! } : {}),
      }));
      const n = (k: string) => num(l[k]) ?? 0;
      return {
        ...base,
        kind: "log",
        log: { name: str(l["name"], 40) || title, unit: str(l["unit"], 12), today: n("today"), today_count: n("today_count"), week: n("week"), streak: n("streak"), count: n("count"), days, entries, fresh: l["fresh"] === true },
      };
    }
    case "picker": {
      const options = arr(obj(a["picker"])?.["options"]).map((o) => str(o, 40)).filter(Boolean).slice(0, 24);
      return options.length >= 2 ? { ...base, kind: "picker", picker: { options } } : null;
    }
    case "mindmap": {
      const m = obj(a["mindmap"]);
      const branches = arr(m?.["branches"]).map(obj).filter(Boolean).slice(0, 8).flatMap((b) => {
        const label = str(b!["label"], 40);
        if (!label) return [];
        const leaves = arr(b!["leaves"]).map(obj).filter(Boolean).slice(0, 6).flatMap((l) =>
          str(l!["label"], 60) ? [{ label: str(l!["label"], 60), ...(str(l!["detail"], 120) ? { detail: str(l!["detail"], 120) } : {}) }] : [],
        );
        return [{ label, leaves }];
      });
      return branches.length ? { ...base, kind: "mindmap", mindmap: { center: str(m?.["center"], 60) || title, branches } } : null;
    }
    case "app": {
      const html = str(obj(a["app"])?.["html"], 200_000);
      return html ? { ...base, kind: "app", app: { html } } : null;
    }
    default:
      return null;
  }
}

function choices(v: unknown): string[] {
  return arr(v).map((c) => str(c, 120)).filter(Boolean).slice(0, 6);
}

function numbers(v: unknown, max: number): number[] {
  return arr(v).map(num).filter((n): n is number => n !== null).slice(-max);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function cell(v: unknown): string | number {
  return typeof v === "number" && Number.isFinite(v) ? v : str(v, 300);
}
