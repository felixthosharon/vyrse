import type { Message } from "@/lib/vyrse/types";
import type { ConversationSummary } from "../vyrse-api";
import type { HermesGateway } from "./gateway";
import type {
  SessionCreateResult,
  SessionListResult,
  SessionListRow,
  SessionResumeResult,
  TranscriptMessage,
} from "./vendor/gateway-contract.generated";

/** Sessions VYRSE creates are tagged so Hermes resolves `platform_toolsets.vyrse`. */
export const VYRSE_SOURCE = "vyrse";

/**
 * Hermes sessions are VYRSE conversations.
 *
 * A conversation id is Hermes' *stored* session id (the row in state.db, stable across
 * restarts). Sending a prompt needs a *live* session in the running backend; we resume the
 * stored session on demand and cache the live id until Hermes restarts.
 */
export class HermesSessions {
  private live = new Map<string, string>();
  /** reasoning level last applied to each live session (session-scoped override) */
  private reasoning = new Map<string, string>();
  /** model applied per live session ("provider::model") */
  private models = new Map<string, string>();
  private opening = new Map<string, Promise<string>>();

  constructor(private readonly gateway: HermesGateway) {
    gateway.onBackendChanged(() => {
      this.live.clear();
      this.reasoning.clear();
      this.opening.clear();
    });
  }

  async list(): Promise<ConversationSummary[]> {
    const result = await this.gateway.request<SessionListResult>("session.list", { limit: 200 });
    return (result.sessions ?? []).map(toSummary);
  }

  /** the model picked in VYRSE, if known (set by the API facade); new conversations start on it */
  selectedModel: () => { model: string; provider: string } | null = () => null;

  async create(): Promise<ConversationSummary> {
    const selected = this.selectedModel();
    const result = await this.gateway.request<SessionCreateResult>("session.create", {
      source: VYRSE_SOURCE,
      ...(selected ? { model: selected.model, provider: selected.provider } : {}),
    });
    this.live.set(result.stored_session_id, result.session_id);
    if (selected) this.models.set(result.session_id, `${selected.provider}::${selected.model}`);
    return { id: result.stored_session_id, title: "New conversation", updatedAt: Date.now(), messageCount: 0 };
  }

  async open(storedId: string): Promise<{ summary: ConversationSummary; messages: Message[] }> {
    const result = await this.resume(storedId);
    const messages = mapTranscript(result.messages ?? []);
    const title = typeof result.info?.title === "string" && result.info.title ? result.info.title : undefined;
    return {
      summary: {
        id: storedId,
        title: title ?? deriveTitle(messages),
        updatedAt: messages.at(-1)?.createdAt ?? Date.now(),
        messageCount: messages.length,
      },
      messages,
    };
  }

  /** Live session id for a stored conversation, resuming it if needed. */
  async liveId(storedId: string): Promise<string> {
    const cached = this.live.get(storedId);
    if (cached) return cached;
    let pending = this.opening.get(storedId);
    if (!pending) {
      pending = this.resume(storedId, true).then((r) => r.session_id);
      this.opening.set(storedId, pending);
      pending.finally(() => this.opening.delete(storedId)).catch(() => {});
    }
    return pending;
  }

  /**
   * Keep a conversation on the model picked in VYRSE. Hermes resumes an older conversation on the model
   * it last used, and a switch made before a new conversation's first message could be lost, so the
   * menu and the model actually answering could disagree. Applied once per conversation and model.
   */
  async applyModel(liveId: string, selected: { model: string; provider: string }): Promise<void> {
    const key = `${selected.provider}::${selected.model}`;
    if (this.models.get(liveId) === key) return;
    await this.gateway.request("config.set", {
      key: "model",
      value: `${selected.model} --provider ${selected.provider}`,
      session_id: liveId,
    });
    this.models.set(liveId, key);
  }

  /** Per-turn reasoning: set the live session's level only when it differs from the last one set. */
  async applyReasoning(liveId: string, level: string): Promise<void> {
    if (this.reasoning.get(liveId) === level) return;
    await this.gateway.request("config.set", { key: "reasoning", value: level, session_id: liveId, scope: "session" });
    this.reasoning.set(liveId, level);
  }

  /**
   * Pre-fill the model's prompt cache: one tiny turn in a hidden, throwaway session so the first
   * real request doesn't pay for processing the whole system prompt (~13k tokens, ~8 s locally).
   * The session stays hidden (never in history); the vyrse plugin purges old warm-ups at startup.
   * Deleting it right away raced Hermes' title writer, which re-created an empty, titled, *visible*
   * row ("Ready") that then got resumed as the latest conversation.
   */
  async warmUp(timeoutMs = 120_000): Promise<void> {
    const created = await this.gateway.request<SessionCreateResult>("session.create", {
      source: VYRSE_SOURCE,
      hidden: true,
      close_on_disconnect: true,
    });
    const live = created.session_id;
    try {
      await this.applyReasoning(live, "none");
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(done, timeoutMs);
        const off = this.gateway.onAny((event) => {
          if (event.session_id === live && (event.type === "message.complete" || event.type === "error")) done();
        });
        function done() {
          window.clearTimeout(timer);
          off();
          resolve();
        }
        this.gateway.request("prompt.submit", { session_id: live, text: "Reply with exactly: ready" }).catch(done);
      });
    } finally {
      this.reasoning.delete(live);
      await this.gateway.request("session.close", { session_id: live }).catch(() => {});
    }
  }

  /** Live id only if the conversation is already open in Hermes (never resumes). */
  peekLiveId(storedId: string): string | undefined {
    return this.live.get(storedId);
  }

  /** Stored id for a live session id (events carry live ids). */
  storedIdFor(liveId: string): string | null {
    for (const [stored, live] of this.live) if (live === liveId) return stored;
    return null;
  }

  /** Drops the last user turn and everything after it (retry / edit). Returns how many messages went. */
  async undo(storedId: string): Promise<number> {
    const result = await this.gateway.request<{ removed: number }>("session.undo", {
      session_id: await this.liveId(storedId),
      intent: "retry",
    });
    return result.removed ?? 0;
  }

  async rename(storedId: string, title: string): Promise<void> {
    await this.gateway.request("session.title", { session_id: await this.liveId(storedId), title });
  }

  async delete(storedId: string): Promise<void> {
    const liveId = this.live.get(storedId);
    if (liveId) await this.gateway.request("session.close", { session_id: liveId }).catch(() => {});
    this.live.delete(storedId);
    await this.gateway.request("session.delete", { session_id: storedId });
  }

  private async resume(storedId: string, omitMessages = false): Promise<SessionResumeResult> {
    const result = await this.gateway.request<SessionResumeResult>("session.resume", {
      session_id: storedId,
      source: VYRSE_SOURCE,
      ...(omitMessages ? { omit_messages: true } : {}),
    });
    this.live.set(storedId, result.session_id);
    return result;
  }
}

function toSummary(row: SessionListRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title?.trim() || row.preview?.trim()?.slice(0, 60) || "Untitled conversation",
    updatedAt: toMillis(row.started_at),
    preview: row.preview,
    messageCount: row.message_count,
    source: row.source,
  };
}

function toMillis(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value < 1e12 ? Math.round(value * 1000) : value;
}

/** Hermes transcript → VYRSE messages: user/assistant text only; tool rows stay in Hermes. */
export function mapTranscript(rows: TranscriptMessage[]): Message[] {
  const out: Message[] = [];
  rows.forEach((row, index) => {
    if (row.role !== "user" && row.role !== "assistant") return;
    const text = messageText(row);
    if (!text.trim()) return;
    out.push({
      id: row.row_id != null ? `row-${row.row_id}` : `msg-${index}`,
      role: row.role === "assistant" ? "vyrse" : "user",
      text,
      createdAt: toMillis(row.timestamp),
    });
  });
  return out;
}

function messageText(row: TranscriptMessage): string {
  if (typeof row.text === "string") return row.text;
  const content = row.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function deriveTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const t = first.text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 46)}…` : t;
}
