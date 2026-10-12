import { describe, expect, it } from "vitest";
import { INITIAL_STATE, turnActivity, vyrseReducer, withoutRepeat, type VyrseAction, type VyrseState } from "../state";

const run = (actions: VyrseAction[], from: VyrseState = INITIAL_STATE) => actions.reduce(vyrseReducer, from);

const startTurn: VyrseAction[] = [
  { type: "conversation/upsert", summary: { id: "s1", title: "New conversation", updatedAt: 1 }, messages: [] },
  { type: "conversation/select", id: "s1" },
  {
    type: "turn/start",
    conversationId: "s1",
    userMessage: { id: "u1", role: "user", text: "list my files", createdAt: 1 },
    replyId: "r1",
    title: "list my files",
  },
];

const reply = (s: VyrseState) => s.conversations.find((c) => c.id === "s1")!.messages.find((m) => m.id === "r1");

describe("vyrseReducer turns", () => {
  it("streams text into the reply and moves presence to speaking", () => {
    const s = run([...startTurn, { type: "turn/event", event: { type: "text", delta: "Here " } }, { type: "turn/event", event: { type: "text", delta: "you go." } }]);
    expect(reply(s)?.text).toBe("Here you go.");
    expect(s.presence).toBe("speaking");
    expect(s.conversations[0]!.title).toBe("list my files");
  });

  it("tracks a tool call from preparing to done", () => {
    const s1 = run([
      ...startTurn,
      { type: "turn/event", event: { type: "tool", phase: "generating", name: "terminal" } },
      { type: "turn/event", event: { type: "tool", phase: "start", id: "t1", name: "terminal", label: "ls" } },
    ]);
    expect(reply(s1)?.tools).toEqual([expect.objectContaining({ id: "t1", status: "running", label: "ls" })]);
    expect(s1.presence).toBe("working");
    const s2 = run([{ type: "turn/event", event: { type: "tool", phase: "end", id: "t1", name: "terminal", durationS: 0.7 } }], s1);
    expect(reply(s2)?.tools).toEqual([expect.objectContaining({ id: "t1", status: "done", durationS: 0.7 })]);
    expect(s2.presence).toBe("thinking");
  });

  it("counts reasoning without storing it", () => {
    const s = run([...startTurn, { type: "turn/event", event: { type: "reasoning", delta: "hmm..." } }]);
    expect(reply(s)?.reasoningChars).toBe(6);
    expect(reply(s)?.text).toBe("");
  });

  it("ends a turn: success keeps the reply, failure drops an empty reply and shows the error", () => {
    const ok = run([...startTurn, { type: "turn/event", event: { type: "text", delta: "done" } }, { type: "turn/end", outcome: "success" }]);
    expect(ok.turn).toBeNull();
    expect(reply(ok)?.streaming).toBe(false);
    expect(ok.presence).toBe("success");

    const failed = run([...startTurn, { type: "turn/end", outcome: "error", error: "model not reachable" }]);
    expect(reply(failed)).toBeUndefined();
    expect(failed.error).toBe("model not reachable");
    expect(failed.presence).toBe("error");
  });

  it("marks interrupted replies and finishes running tools", () => {
    const s = run([
      ...startTurn,
      { type: "turn/event", event: { type: "tool", phase: "start", id: "t1", name: "terminal" } },
      { type: "turn/end", outcome: "interrupted" },
    ]);
    expect(reply(s)?.interrupted).toBe(true);
    expect(reply(s)?.tools?.[0]?.status).toBe("done");
    expect(s.presence).toBe("idle");
  });

  it("keeps an empty stopped reply so the transcript shows it was stopped", () => {
    const s = run([...startTurn, { type: "turn/end", outcome: "interrupted" }]);
    expect(reply(s)).toMatchObject({ text: "", interrupted: true, streaming: false });
  });

  it("ignores stream events when no turn is running", () => {
    const s = run([{ type: "turn/event", event: { type: "text", delta: "stray" } }]);
    expect(s).toEqual(INITIAL_STATE);
  });
});

describe("vyrseReducer history and approvals", () => {
  it("merges Hermes' list without losing loaded transcripts", () => {
    const s1 = run(startTurn);
    const s2 = run([{ type: "conversations/listed", rows: [{ id: "s1", title: "Files", updatedAt: 5 }, { id: "s0", title: "Older", updatedAt: 0 }] }], s1);
    expect(s2.conversations.map((c) => c.id)).toEqual(["s1", "s0"]);
    expect(s2.conversations[0]!.title).toBe("Files");
    expect(s2.conversations[0]!.messages).toHaveLength(2);
    expect(s2.conversations[1]!.loaded).toBe(false);
  });

  it("queues approvals once and removes them by id", () => {
    const prompt = { id: "a1", conversationId: "s1", command: "rm -rf x", description: "delete", choices: ["once", "deny"] as const };
    const s1 = run([{ type: "approval/add", prompt: { ...prompt, choices: [...prompt.choices] } }, { type: "approval/add", prompt: { ...prompt, choices: [...prompt.choices] } }]);
    expect(s1.approvals).toHaveLength(1);
    expect(run([{ type: "approval/remove", id: "a1" }], s1).approvals).toHaveLength(0);
  });

  it("accepts only known presentation modes", () => {
    const s = run([{ type: "ui/presentation", mode: "split" }, { type: "ui/presentation", mode: "huge" as never }]);
    expect(s.ui.presentation).toBe("split");
  });
});

describe("workspace", () => {
  const chart = (id: string, title: string, unit: string) => ({
    id, title, kind: "series" as const, series: [{ label: "chrome", value: 1084 }], chart: { style: "bar" as const, unit },
  });

  it("updates in place by id and merges the same data shown twice", () => {
    let s = vyrseReducer(INITIAL_STATE, { type: "workspace/show", artifact: chart("top-memory", "Top apps by memory", " MB") });
    s = vyrseReducer(s, { type: "workspace/show", artifact: chart("top-6", "Top 6 Memory-Hungry Apps", "MB") });
    expect(s.workspace).toHaveLength(1);
    s = vyrseReducer(s, { type: "workspace/show", artifact: { id: "notes", title: "Notes", kind: "markdown", markdown: "# Hi" } });
    expect(s.workspace.map((a) => a.id)).toEqual(["notes", "top-6"]);
    s = vyrseReducer(s, { type: "workspace/remove", id: "notes" });
    expect(s.workspace.map((a) => a.id)).toEqual(["top-6"]);
  });

  it("badges only new items that arrive while hidden, and clears once the workspace is opened", () => {
    let s = vyrseReducer(INITIAL_STATE, { type: "workspace/show", artifact: chart("cpu", "CPU", "%") });
    expect(s.workspaceUnseen).toEqual(["cpu"]);
    // A live chart updating in place is not news.
    s = vyrseReducer(s, { type: "ui/presentation", mode: "split" });
    expect(s.workspaceUnseen).toEqual([]);
    s = vyrseReducer(s, { type: "ui/presentation", mode: "compact" });
    s = vyrseReducer(s, { type: "workspace/show", artifact: { ...chart("cpu", "CPU", "%"), series: [{ label: "1s", value: 3 }] } });
    expect(s.workspaceUnseen).toEqual([]);
    // Shown while the panel is open: seen right away.
    s = vyrseReducer(s, { type: "ui/presentation", mode: "focus" });
    s = vyrseReducer(s, { type: "workspace/show", artifact: { id: "n", title: "N", kind: "markdown", markdown: "x" } });
    expect(s.workspaceUnseen).toEqual([]);
    // The transcript covers the workspace: hidden again.
    s = vyrseReducer(s, { type: "ui/expanded", expanded: true });
    s = vyrseReducer(s, { type: "workspace/show", artifact: { id: "m", title: "M", kind: "markdown", markdown: "y" } });
    expect(s.workspaceUnseen).toEqual(["m"]);
    s = vyrseReducer(s, { type: "ui/expanded", expanded: false });
    expect(s.workspaceUnseen).toEqual([]);
  });

  it("ticks a checklist line", () => {
    let s = vyrseReducer(INITIAL_STATE, {
      type: "workspace/show",
      artifact: { id: "todo", title: "Today", kind: "checklist", checklist: [{ label: "a", done: false }, { label: "b", done: false }] },
    });
    s = vyrseReducer(s, { type: "workspace/check", id: "todo", index: 1, done: true });
    expect(s.workspace[0]!.checklist).toEqual([{ label: "a", done: false }, { label: "b", done: true }]);
  });
});

describe("workspace focus", () => {
  it("shows one item on its own until it is removed or the board changes", () => {
    let s = vyrseReducer(INITIAL_STATE, { type: "workspace/show", artifact: { id: "a", title: "A", kind: "markdown", markdown: "a" } });
    s = vyrseReducer(s, { type: "workspace/show", artifact: { id: "b", title: "B", kind: "markdown", markdown: "b" } });
    s = vyrseReducer(s, { type: "workspace/focus", id: "missing" });
    expect(s.workspaceFocus).toBeNull();
    s = vyrseReducer(s, { type: "workspace/focus", id: "a" });
    expect(s.workspaceFocus).toBe("a");
    s = vyrseReducer(s, { type: "workspace/remove", id: "a" });
    expect(s.workspaceFocus).toBeNull();
    s = vyrseReducer(s, { type: "workspace/focus", id: "b" });
    s = vyrseReducer(s, { type: "workspace/clear" });
    expect(s.workspaceFocus).toBeNull();
  });
});

describe("turn activity", () => {
  it("is working while a tool runs, thinking otherwise", () => {
    expect(turnActivity(INITIAL_STATE)).toBe("thinking");
    const reply = { id: "r", role: "vyrse" as const, text: "", createdAt: 0, tools: [{ id: "t", name: "vyrse_system", status: "running" as const, startedAt: 0 }] };
    const s = { ...INITIAL_STATE, turn: { conversationId: "c", replyId: "r" } as VyrseState["turn"], conversations: [{ id: "c", title: "", updatedAt: 0, messages: [reply] }] };
    expect(turnActivity(s)).toBe("working");
    const done = { ...s, conversations: [{ id: "c", title: "", updatedAt: 0, messages: [{ ...reply, tools: [{ ...reply.tools[0]!, status: "done" as const }] }] }] };
    expect(turnActivity(done)).toBe("thinking");
  });
});

describe("retry and edit", () => {
  const msg = (id: string, role: "user" | "vyrse", text: string) => ({ id, role, text, createdAt: 0 });
  const withChat = () =>
    vyrseReducer(INITIAL_STATE, {
      type: "conversation/upsert",
      summary: { id: "c1", title: "Chat", updatedAt: 0, messageCount: 4 },
      messages: [msg("1", "user", "hi"), msg("2", "vyrse", "hey"), msg("3", "user", "2+2"), msg("4", "vyrse", "5")],
    });

  it("drops only the last exchange", () => {
    const next = vyrseReducer(withChat(), { type: "conversation/dropLastTurn", id: "c1" });
    expect(next.conversations[0]?.messages.map((m) => m.text)).toEqual(["hi", "hey"]);
  });

  it("renames locally", () => {
    const next = vyrseReducer(withChat(), { type: "conversation/renamed", id: "c1", title: "Math" });
    expect(next.conversations[0]?.title).toBe("Math");
  });
});

describe("withoutRepeat", () => {
  it("collapses a reply written twice", () => {
    const once = "15% of 80 is **12**.\n\nTo calculate: 0.15 × 80 = 12.";
    expect(withoutRepeat(`${once}\n${once}`)).toBe(once);
    expect(withoutRepeat("Done. Done.")).toBe("Done. Done.");
    expect(withoutRepeat("Ha ha")).toBe("Ha ha");
  });
});
