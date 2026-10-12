import { describe, expect, it } from "vitest";
import { findConversation } from "@/lib/vyrse/state";
import type { Conversation } from "@/lib/vyrse/types";
import { parseUiCommand } from "../ui-control";

describe("parseUiCommand", () => {
  it("accepts well-formed commands", () => {
    expect(parseUiCommand({ action: "open", panel: "settings" })).toEqual({ action: "open", panel: "settings" });
    expect(parseUiCommand({ action: "mode", mode: "gaming" })).toEqual({ action: "mode", mode: "gaming" });
    expect(parseUiCommand({ action: "prefs", prefs: { theme: "light" } })).toEqual({ action: "prefs", prefs: { theme: "light" } });
    expect(parseUiCommand({ action: "model", model: "gemma-3-12b-q4_k_m" })).toEqual({ action: "model", model: "gemma-3-12b-q4_k_m", provider: "" });
  });

  it("rejects malformed or unknown commands", () => {
    expect(parseUiCommand(null)).toBeNull();
    expect(parseUiCommand({ action: "open", panel: "kitchen" })).toBeNull();
    expect(parseUiCommand({ action: "mode", mode: "turbo" })).toBeNull();
    expect(parseUiCommand({ action: "eval", code: "alert(1)" })).toBeNull();
    expect(parseUiCommand({ action: "notify", text: "" })).toBeNull();
  });
});

describe("findConversation", () => {
  const conv = (id: string, title: string, updatedAt: number): Conversation => ({ id, title, updatedAt, messages: [] });
  const list = [conv("a", "History of the telescope", 1), conv("b", "Telescope buying guide", 2), conv("c", "Grocery list", 3)];

  it("picks the title sharing the most words, newest on ties", () => {
    expect(findConversation(list, "the telescope history one")?.id).toBe("a");
    expect(findConversation(list, "telescope")?.id).toBe("b");
  });

  it("returns null without a meaningful match", () => {
    expect(findConversation(list, "weather")).toBeNull();
    expect(findConversation(list, "a")).toBeNull();
  });
});

describe("workspace commands", () => {
  it("accepts typed artifacts and opens a layout", () => {
    const cmd = parseUiCommand({
      action: "workspace", op: "show", layout: "focus",
      artifact: { id: "cpu", title: "CPU", kind: "series", series: [{ label: "0s", value: 12.5 }], chart: { style: "bar", unit: "%" } },
    });
    expect(cmd).toEqual({
      action: "workspace", op: "show", layout: "focus",
      artifact: { id: "cpu", title: "CPU", kind: "series", series: [{ label: "0s", value: 12.5 }], chart: { style: "bar", unit: "%" } },
    });
  });

  it("accepts the study kinds and drops bad parts", () => {
    const show = (artifact: Record<string, unknown>) => {
      const cmd = parseUiCommand({ action: "workspace", op: "show", artifact: { id: "x", title: "X", ...artifact } });
      return cmd && cmd.action === "workspace" && cmd.op === "show" ? cmd.artifact : null;
    };
    expect(show({ kind: "rings", rings: [{ label: "Study", value: 95, max: 120, unit: "min" }, { label: "bad", value: 1, max: 0 }] })?.rings).toEqual([
      { label: "Study", value: 95, max: 120, unit: "min" },
    ]);
    expect(show({ kind: "quiz", quiz: { subject: "Physics", questions: [{ question: "F?", answer: "ma", correct: true }, { question: "u?", correct: "yes" }, { answer: "no q" }] } })?.quiz).toEqual({
      subject: "Physics",
      questions: [{ question: "F?", answer: "ma", correct: true }, { question: "u?" }],
    });
    expect(show({ kind: "scorecard", scorecard: { score: 2, total: 3, verdict: "Solid", topics: [{ label: "Motion", value: 7, weak: true }] } })?.scorecard).toEqual({
      score: 2, total: 3, verdict: "Solid", topics: [{ label: "Motion", value: 1, weak: true }],
    });
    expect(show({ kind: "scorecard", scorecard: { score: 2, total: 0, topics: [] } })).toBeNull();
    expect(show({ kind: "flashcards", flashcards: [{ front: "a" }] })).toBeNull();
    expect(show({ kind: "series", series: [{ label: "a", value: 1 }], chart: { style: "donut" } })?.chart).toEqual({ style: "donut" });
  });

  it("accepts the dashboard kinds and drops bad parts", () => {
    const show = (artifact: Record<string, unknown>) => {
      const cmd = parseUiCommand({ action: "workspace", op: "show", artifact: { id: "x", title: "X", ...artifact } });
      return cmd && cmd.action === "workspace" && cmd.op === "show" ? cmd.artifact : null;
    };
    expect(show({ kind: "series", series: [{ label: "Sat", value: 78 }], chart: { style: "bar", highlight: "Sat", threshold: 80 } })?.chart).toEqual({ style: "bar", highlight: "Sat", threshold: 80 });
    expect(show({ kind: "series", series: [{ label: "Sat", value: 78 }], chart: { style: "bar", highlight: "Sun" } })?.chart).toEqual({ style: "bar" });
    expect(show({ kind: "table", table: { columns: ["a"], rows: [["x"], ["y"]], highlight: 5 } })?.table).toEqual({ columns: ["a"], rows: [["x"], ["y"]] });
    expect(show({ kind: "gauges", gauges: [{ label: "GPU", value: 81, max: 100, unit: "°C", warn: 80 }, { label: "bad" }] })?.gauges).toEqual([
      { label: "GPU", value: 81, max: 100, unit: "°C", warn: 80 },
    ]);
    expect(show({ kind: "cards", cards: [{ label: "Weather", detail: "Sunny", icon: "sun" }, {}] })?.cards).toEqual([{ label: "Weather", detail: "Sunny", icon: "sun" }]);
    expect(show({ kind: "weather", weather: { location: "London", condition: "Overcast", temp: 13 } })?.weather).toEqual({ location: "London", condition: "Overcast", temp: 13, unit: "°" });
    expect(show({ kind: "timer", timer: { label: "Focus", ends_at: 1, seconds: 0 } })).toBeNull();
    expect(show({ kind: "board", board: [{ name: "To do", cards: [{ label: "Ship" }, { note: "no label" }] }] })?.board).toEqual([{ name: "To do", cards: [{ label: "Ship" }] }]);
    expect(show({ kind: "heatmap", heatmap: { cells: [{ label: "2026-10-11", value: 40 }, { label: "x", value: "NaN" }] } })?.heatmap).toEqual({ cells: [{ label: "2026-10-11", value: 40 }] });
    expect(show({ kind: "log", log: { name: "Study", unit: "min", today: 95, days: [], entries: [{ at: "Sat 21:00", label: "chemistry", value: 20 }], fresh: true } })?.log).toMatchObject({ today: 95, fresh: true, week: 0 });
    expect(show({ kind: "app", app: { html: "<p>hi</p>" } })?.app).toEqual({ html: "<p>hi</p>" });
    expect(show({ kind: "code", code: { code: "a", highlight: [2, -1, "x"] } })?.code).toEqual({ code: "a", language: "", highlight: [2] });
  });

  it("accepts pickers and mind maps", () => {
    const show = (artifact: Record<string, unknown>) => {
      const cmd = parseUiCommand({ action: "workspace", op: "show", artifact: { id: "x", title: "Dinner", ...artifact } });
      return cmd && cmd.action === "workspace" && cmd.op === "show" ? cmd.artifact : null;
    };
    expect(show({ kind: "picker", picker: { options: ["Pizza", "", "Tacos", 3] } })?.picker).toEqual({ options: ["Pizza", "Tacos", "3"] });
    expect(show({ kind: "picker", picker: { options: ["Only"] } })).toBeNull();
    expect(show({ kind: "mindmap", mindmap: { center: "Photosynthesis", branches: [{ label: "Stages", leaves: [{ label: "Calvin cycle" }, {}] }, { leaves: [] }] } })?.mindmap).toEqual({
      center: "Photosynthesis",
      branches: [{ label: "Stages", leaves: [{ label: "Calvin cycle" }] }],
    });
  });

  it("lets Hermes focus one item", () => {
    expect(parseUiCommand({ action: "workspace", op: "focus", id: "pc-gauges" })).toEqual({ action: "workspace", op: "focus", id: "pc-gauges" });
    expect(parseUiCommand({ action: "workspace", op: "focus" })).toEqual({ action: "workspace", op: "focus", id: "" });
    const cmd = parseUiCommand({ action: "workspace", op: "show", focus: true, artifact: { id: "t", title: "T", kind: "markdown", markdown: "x" } });
    expect(cmd && "focus" in cmd && cmd.focus).toBe(true);
  });

  it("rejects unsafe or malformed content", () => {
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(parseUiCommand({ action: "workspace", op: "show", artifact: { id: "x", title: "x", kind: "image", image: { dataUrl: svg } } })).toBeNull();
    expect(parseUiCommand({ action: "workspace", op: "show", artifact: { id: "x", title: "x", kind: "html", html: "<script>" } })).toBeNull();
    expect(parseUiCommand({ action: "workspace", op: "show", artifact: { id: "x", title: "x", kind: "series", series: [{ label: "a", value: "NaN" }] } })).toBeNull();
  });
});

describe("desktop calls", () => {
  it("accepts Alexa calls and trims their arguments", () => {
    expect(parseUiCommand({ action: "desktop_call", id: "abc", target: "alexa", op: "command", args: { text: "turn off the lights", extra: 1 } })).toEqual({
      action: "desktop_call",
      id: "abc",
      target: "alexa",
      op: "command",
      args: { text: "turn off the lights" },
    });
  });

  it("rejects other targets and unknown operations", () => {
    expect(parseUiCommand({ action: "desktop_call", id: "a", target: "shell", op: "command", args: {} })).toBeNull();
    expect(parseUiCommand({ action: "desktop_call", id: "a", target: "alexa", op: "disconnect", args: {} })).toBeNull();
  });
});
