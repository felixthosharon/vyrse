import type { StreamEvent } from "../vyrse-api";
import type { HermesGateway } from "./gateway";
import type { GatewayEvent } from "./vendor/gateway-events";
import type {
  MessageCompletePayload,
  MessageInterimPayload,
  PromptSubmitResult,
  StatusUpdatePayload,
  StreamDeltaPayload,
  ToolCompletePayload,
  ToolGeneratingPayload,
  ToolStartPayload,
} from "./vendor/gateway-contract.generated";

/** How long to wait for Hermes to confirm an interrupt before ending the turn locally. */
const INTERRUPT_GRACE_MS = 6_000;

/**
 * Maps one Hermes gateway event to VYRSE stream events (pure; unit-tested).
 * Returns `terminal` for the event that ends the turn.
 */
export function mapTurnEvent(event: GatewayEvent): { events: StreamEvent[]; terminal?: boolean } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "message.start":
      return { events: [{ type: "status", status: "thinking" }] };
    case "reasoning.delta":
    case "thinking.delta": {
      const text = (payload as unknown as StreamDeltaPayload).text;
      return { events: typeof text === "string" && text ? [{ type: "reasoning", delta: text }] : [] };
    }
    case "message.delta": {
      const text = (payload as unknown as StreamDeltaPayload).text;
      return { events: typeof text === "string" && text ? [{ type: "text", delta: text }] : [] };
    }
    case "message.interim": {
      // Commentary the model wrote beside its tool calls, sealed as its own segment.
      const { text, already_streamed } = payload as unknown as MessageInterimPayload;
      return { events: !already_streamed && text ? [{ type: "text", delta: `${text}\n\n` }] : [] };
    }
    case "tool.generating": {
      const { name } = payload as unknown as ToolGeneratingPayload;
      return { events: [{ type: "tool", phase: "generating", name: String(name ?? "tool") }] };
    }
    case "tool.start": {
      const p = payload as unknown as ToolStartPayload;
      return {
        events: [{ type: "tool", phase: "start", id: p.tool_id, name: p.name, label: toolLabel(p) }],
      };
    }
    case "tool.complete": {
      const p = payload as unknown as ToolCompletePayload;
      return {
        events: [
          {
            type: "tool",
            phase: "end",
            id: p.tool_id,
            name: p.name,
            durationS: typeof p.duration_s === "number" ? p.duration_s : undefined,
            summary: p.summary ?? undefined,
          },
        ],
      };
    }
    case "status.update": {
      const { text } = payload as unknown as StatusUpdatePayload;
      return { events: text ? [{ type: "notice", text }] : [] };
    }
    case "error": {
      const message = typeof payload["message"] === "string" ? (payload["message"] as string) : "Hermes reported an error.";
      return { events: [{ type: "error", message }], terminal: true };
    }
    case "message.complete": {
      const p = payload as unknown as MessageCompletePayload;
      if (p.status === "error") {
        return {
          events: [{ type: "error", message: friendlyError(p), detail: p.error ?? p.failure_reason ?? undefined }],
          terminal: true,
        };
      }
      return { events: [{ type: "done", interrupted: p.status === "interrupted" }], terminal: true };
    }
    default:
      return { events: [] };
  }
}

/**
 * Visible text for a completed turn that streamed none: the final text if Hermes has it, else the
 * closing part of the reasoning (the answer the model wrote without closing its thinking section).
 */
export function fallbackReply(payload: Record<string, unknown> | undefined): string | null {
  if (!payload || payload["status"] === "error" || payload["status"] === "interrupted") return null;
  const text = typeof payload["text"] === "string" ? payload["text"].trim() : "";
  if (text) return withoutSelfTalk(text);
  const reasoning = typeof payload["reasoning"] === "string" ? payload["reasoning"].trim() : "";
  if (!reasoning) return null;
  if (reasoning.length <= 600) return withoutSelfTalk(reasoning);
  const paragraphs = reasoning.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  return paragraphs.length ? withoutSelfTalk(paragraphs[paragraphs.length - 1]!) : null;
}

/** Sentences the model wrote to itself ("I should mention this gently.") in thinking that became the reply. */
const SELF_TALK =
  /^(?:I should|I need to|I must|I'll (?:now )?(?:respond|reply|answer|mention|keep|make sure|provide|give)|Let me (?:respond|reply|answer|think|check|keep|provide|give)|The user (?:is|wants|asked|said|has)|Felix (?:is asking|wants|asked|said)|Now I|My (?:reply|response|answer) (?:should|will))/i;

/**
 * A rescued reply (the answer the model left inside its thinking) can carry its notes to itself. Drop
 * those sentences; when there were any, the last paragraph is the actual answer, so keep only that.
 */
export function withoutSelfTalk(text: string): string {
  let found = false;
  const kept = text
    .split(/\n\s*\n/)
    .map((p) =>
      (p.match(/[^.!?\n]+[.!?]*\s*/g) ?? [p])
        .filter((s) => {
          const self = SELF_TALK.test(s.trim());
          if (self) found = true;
          return !self;
        })
        .join("")
        .trim(),
    )
    .filter(Boolean);
  if (!kept.length) return text.trim();
  return found && kept.length > 1 ? kept[kept.length - 1]! : kept.join("\n\n");
}

function toolLabel(p: ToolStartPayload): string | undefined {
  const raw = p.preview || p.context || p.args_text || argsSummary(p.args);
  if (!raw) return undefined;
  const oneLine = String(raw).replace(/\s+/g, " ").trim();
  return oneLine.length > 96 ? `${oneLine.slice(0, 93)}…` : oneLine;
}

/** Fallback label from a tool's arguments, e.g. `set · theme light` (plugin tools send no preview). */
function argsSummary(args: Record<string, unknown> | null | undefined): string | undefined {
  if (!args) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v !== "object") parts.push(`${k} ${String(v)}`);
      }
    } else if (typeof value === "boolean") {
      if (value) parts.push(key.replace(/_/g, " "));
    } else parts.push(key === "action" ? String(value).replace(/_/g, " ") : String(value));
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(" · ") : undefined;
}

export function friendlyError(p: MessageCompletePayload): string {
  const code = p.error_surface?.code ?? "";
  const detail = String(p.error ?? "");
  // A local model whose built-in chat template can't take this conversation (tools, tool results,
  // or a history started on another model). Gemma 3 has a fixed template; other dropped-in GGUFs may not.
  if (/Unable to generate parser|roles must alternate|chat template|Jinja Exception/i.test(detail))
    return "This model's chat format can't handle VYRSE's tools or this conversation. Switch back to Qwen in Settings → Assistant → Model, or start a new conversation.";
  if (/model .*not found|unknown model|no such model|failed to load model/i.test(detail))
    return "That model isn't available anymore (was its file moved or deleted?). Pick another one in Settings → Assistant → Model.";
  if (/context/i.test(code)) return "That conversation got too long for the model. Start a new one or try again.";
  if (/rate|quota|429/i.test(code)) return "The model provider is rate-limiting requests. Try again shortly.";
  if (/auth|401|403|key/i.test(code)) return "The model provider rejected the credentials. Check the model settings.";
  if (/connect|unreachable|refused|server/i.test(`${code} ${p.error ?? ""}`))
    return "The model isn't reachable. It may still be loading — try again in a moment.";
  return p.error ? `Hermes couldn't finish that: ${String(p.error).slice(0, 160)}` : "Hermes couldn't finish that request.";
}

/**
 * Runs one turn on a live Hermes session and yields VYRSE stream events until the turn ends.
 * Aborting the signal interrupts the agent (`session.interrupt`) and ends with `done{interrupted}`.
 */
export async function* streamTurn(
  gateway: HermesGateway,
  sessionId: string,
  text: string,
  signal: AbortSignal,
  options: { voice?: boolean } = {},
): AsyncGenerator<StreamEvent> {
  const queue: StreamEvent[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const push = (events: StreamEvent[], terminal = false) => {
    if (ended) return;
    queue.push(...events);
    if (terminal) ended = true;
    wake?.();
  };

  let sawText = false;
  const unsubscribe = gateway.onAny((event) => {
    if (event.session_id !== sessionId) return;
    const mapped = mapTurnEvent(event);
    if (mapped.events.some((e) => e.type === "text")) sawText = true;
    // A local model sometimes leaves its thinking section open, so the whole answer arrives as
    // reasoning and the reply would be silent. Show the answer instead of nothing.
    if (event.type === "message.complete" && !sawText) {
      const rescued = fallbackReply(event.payload as Record<string, unknown> | undefined);
      if (rescued) mapped.events.unshift({ type: "text", delta: rescued });
    }
    push(mapped.events, mapped.terminal);
  });
  const unsubscribeRestart = gateway.onBackendChanged(() =>
    push([{ type: "error", message: "Hermes restarted during this reply. Please try again." }], true),
  );

  let interruptTimer: number | null = null;
  const onAbort = () => {
    void gateway.request("session.interrupt", { session_id: sessionId }).catch(() => {});
    // If Hermes never confirms, end locally so the UI cannot get stuck.
    interruptTimer = window.setTimeout(() => push([{ type: "done", interrupted: true }], true), INTERRUPT_GRACE_MS);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    try {
      const result = await gateway.request<PromptSubmitResult>("prompt.submit", {
        session_id: sessionId,
        text,
        ...(options.voice ? { surface: "voice" } : {}),
      });
      if (result?.status === "queued") push([{ type: "notice", text: "Queued behind the current task" }]);
    } catch (err) {
      push([{ type: "error", message: "Couldn't reach Hermes to send that.", detail: String(err) }], true);
    }

    while (true) {
      while (queue.length) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  } finally {
    unsubscribe();
    unsubscribeRestart();
    signal.removeEventListener("abort", onAbort);
    if (interruptTimer !== null) window.clearTimeout(interruptTimer);
  }
}
