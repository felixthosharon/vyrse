import { describe, expect, it } from "vitest";
import { applyUpdate, formMessage } from "../workspace-interact";
import { parseArtifact } from "../workspace-artifact";
import type { Artifact } from "@/lib/vyrse/types";

const timer: Artifact = { id: "t", title: "Focus", kind: "timer", timer: { label: "Focus", ends_at: 100_000, seconds: 100 } };

describe("workspace interactions", () => {
  it("pauses, resumes, adds time and stops a timer", () => {
    const paused = applyUpdate(timer, { op: "timer", args: { action: "pause" } }, 40_000)!;
    expect(paused.timer!.paused_left).toBe(60_000);
    expect(applyUpdate(paused, { op: "timer", args: { action: "pause" } }, 50_000)).toBeNull();
    const resumed = applyUpdate(paused, { op: "timer", args: { action: "resume" } }, 90_000)!;
    expect(resumed.timer!.ends_at).toBe(150_000);
    expect(resumed.timer!.paused_left).toBeUndefined();
    const more = applyUpdate(resumed, { op: "timer", args: { action: "add", minutes: 5 } }, 90_000)!;
    expect(more.timer!.ends_at).toBe(450_000);
    expect(more.timer!.seconds).toBe(400);
    const stopped = applyUpdate(more, { op: "timer", args: { action: "stop" } }, 91_000)!;
    expect(stopped.timer).toMatchObject({ ends_at: 91_000, stopped: true });
  });

  it("moves a card between board columns", () => {
    const board: Artifact = {
      id: "b", title: "Tasks", kind: "board",
      board: [{ name: "To do", cards: [{ label: "Essay" }, { label: "Maths" }] }, { name: "Done", cards: [] }],
    };
    const moved = applyUpdate(board, { op: "board_move", args: { from: 0, to: 1, label: "Maths" } })!;
    expect(moved.board![0]!.cards.map((c) => c.label)).toEqual(["Essay"]);
    expect(moved.board![1]!.cards.map((c) => c.label)).toEqual(["Maths"]);
    expect(applyUpdate(board, { op: "board_move", args: { from: 0, to: 5, label: "Maths" } })).toBeNull();
  });

  it("parses buttons, forms and quiz options, and words a sent form", () => {
    const form = parseArtifact({
      id: "f", title: "Trip", kind: "form",
      actions: [{ label: "Cheaper", prompt: "Make it cheaper" }, { label: "", prompt: "x" }],
      form: { fields: [{ label: "Where", type: "text" }, { label: "Budget", type: "select", options: ["Low", "High"] }, { label: "Bad", type: "select", options: ["One"] }], submit: "Plan it" },
    })!;
    expect(form.actions).toEqual([{ label: "Cheaper", prompt: "Make it cheaper" }]);
    expect(form.form!.fields.map((f) => f.type)).toEqual(["text", "select", "text"]);
    expect(formMessage("Trip", form.form!.fields, { Where: "Goa" })).toBe("Trip\nWhere: Goa\nBudget: (left blank)\nBad: (left blank)");
    const quiz = parseArtifact({ id: "q", title: "Quiz", kind: "quiz", quiz: { questions: [{ question: "H2O?", choices: ["Salt", "Water"] }] } })!;
    expect(quiz.quiz!.questions[0]!.choices).toEqual(["Salt", "Water"]);
  });
});
