import { describe, expect, it } from "vitest";
import { fallbackReply, friendlyError, mapTurnEvent, withoutSelfTalk } from "../turns";
import { mapTranscript } from "../sessions";
import type { GatewayEvent } from "../vendor/gateway-events";

const ev = (type: string, payload?: unknown): GatewayEvent => ({ type, payload, session_id: "live1" }) as GatewayEvent;

describe("mapTurnEvent", () => {
  it("maps streaming text and reasoning", () => {
    expect(mapTurnEvent(ev("message.delta", { text: "Hi" })).events).toEqual([{ type: "text", delta: "Hi" }]);
    expect(mapTurnEvent(ev("reasoning.delta", { text: "think" })).events).toEqual([{ type: "reasoning", delta: "think" }]);
    expect(mapTurnEvent(ev("message.delta", { text: "" })).events).toEqual([]);
  });

  it("maps tool lifecycle with a one-line label", () => {
    const start = mapTurnEvent(ev("tool.start", { tool_id: "t1", name: "terminal", preview: "echo   hello\nworld" }));
    expect(start.events).toEqual([{ type: "tool", phase: "start", id: "t1", name: "terminal", label: "echo hello world" }]);
    const end = mapTurnEvent(ev("tool.complete", { tool_id: "t1", name: "terminal", duration_s: 0.69, summary: "ok" }));
    expect(end.events).toEqual([{ type: "tool", phase: "end", id: "t1", name: "terminal", durationS: 0.69, summary: "ok" }]);
  });

  it("labels argument-only tools from their args", () => {
    const start = mapTurnEvent(ev("tool.start", { tool_id: "t2", name: "vyrse_ui", args: { action: "set", preferences: { theme: "light" } } }));
    expect(start.events[0]).toMatchObject({ label: "set · theme light" });
  });

  it("ends the turn on message.complete", () => {
    expect(mapTurnEvent(ev("message.complete", { status: "complete", text: "x" }))).toEqual({ events: [{ type: "done", interrupted: false }], terminal: true });
    expect(mapTurnEvent(ev("message.complete", { status: "interrupted" })).events).toEqual([{ type: "done", interrupted: true }]);
    const failed = mapTurnEvent(ev("message.complete", { status: "error", error: "connection refused", error_surface: { layer: "provider", code: "server_error", retryable: true } }));
    expect(failed.terminal).toBe(true);
    expect(failed.events[0]).toMatchObject({ type: "error" });
    expect((failed.events[0] as { message: string }).message).toMatch(/isn't reachable/);
  });

  it("keeps interim commentary only when it was not already streamed", () => {
    expect(mapTurnEvent(ev("message.interim", { text: "Checking…", already_streamed: false })).events).toEqual([{ type: "text", delta: "Checking…\n\n" }]);
    expect(mapTurnEvent(ev("message.interim", { text: "Checking…", already_streamed: true })).events).toEqual([]);
  });

  it("ignores unrelated events", () => {
    expect(mapTurnEvent(ev("session.usage", { total: 1 })).events).toEqual([]);
  });
});

describe("mapTranscript", () => {
  it("keeps user/assistant text, drops tool rows and empties", () => {
    const messages = mapTranscript([
      { role: "user", text: "hello", timestamp: 1700000000, row_id: 1 },
      { role: "tool", text: "ls output", row_id: 2 },
      { role: "assistant", content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }], row_id: 3 },
      { role: "assistant", text: "   ", row_id: 4 },
    ]);
    expect(messages).toEqual([
      { id: "row-1", role: "user", text: "hello", createdAt: 1700000000000 },
      expect.objectContaining({ id: "row-3", role: "vyrse", text: "Hi there" }),
    ]);
  });
});

describe("fallbackReply", () => {
  it("uses the final text when nothing streamed", () => {
    expect(fallbackReply({ status: "complete", text: "It's 81." })).toBe("It's 81.");
  });

  it("rescues an answer left inside an unclosed thinking section", () => {
    expect(fallbackReply({ status: "complete", text: "", reasoning: "Done, the result is 81." })).toBe("Done, the result is 81.");
    const long = `${"Thinking it through. ".repeat(40)}\n\nThe answer is 81.`;
    expect(fallbackReply({ status: "complete", reasoning: long })).toBe("The answer is 81.");
  });

  it("stays silent for errors and interruptions", () => {
    expect(fallbackReply({ status: "interrupted", reasoning: "x" })).toBeNull();
    expect(fallbackReply({ status: "error", text: "x" })).toBeNull();
    expect(fallbackReply({ status: "complete" })).toBeNull();
  });
});

describe("friendlyError", () => {
  it("explains template failures and missing models", () => {
    expect(friendlyError({ status: "error", error: "HTTP 400: Unable to generate parser for this template." } as never)).toMatch(/chat format/);
    expect(friendlyError({ status: "error", error: "Conversation roles must alternate user/assistant" } as never)).toMatch(/Switch back to Qwen/);
    expect(friendlyError({ status: "error", error: "model gemma not found" } as never)).toMatch(/isn't available/);
  });
});

describe("withoutSelfTalk", () => {
  it("drops the model's notes to itself from a rescued reply", () => {
    const leaked =
      "The chart shows 6, 5, and 7 hours over three nights. Average is about 6 hours. I should mention this gently.\n\nThe average is about 6 hours, a bit below the 7-9 adults need.";
    expect(withoutSelfTalk(leaked)).toBe("The average is about 6 hours, a bit below the 7-9 adults need.");
    expect(withoutSelfTalk("Felix made me. He built VYRSE.")).toBe("Felix made me. He built VYRSE.");
    expect(withoutSelfTalk("The user wants a joke. Why did the GPU blush? It saw the RAM.")).toBe("Why did the GPU blush? It saw the RAM.");
  });
});
