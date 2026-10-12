import type { ApprovalChoice, ApprovalPrompt } from "../vyrse-api";
import type { HermesGateway } from "./gateway";
import type { HermesSessions } from "./sessions";
import type { ApprovalCancelledPayload, ApprovalRequestParams, RequestCancelPayload } from "./vendor/gateway-contract.generated";
import type { ServerRequest } from "./vendor/json-rpc-channel";

const ALL_CHOICES: ApprovalChoice[] = ["once", "session", "always", "deny"];

interface Pending {
  request: ServerRequest;
  liveSessionId: string;
  requestId: string;
}

/**
 * Hermes' own approval system, surfaced in the VYRSE UI.
 *
 * Hermes decides *what* needs approval (approvals.mode, danger patterns, allowlist) and
 * pauses the agent with an `approval` server→client request. We only render it and send
 * the user's choice back. Requests re-delivered after a reconnect reuse the same id.
 */
export class HermesApprovals {
  private pending = new Map<string, Pending>();
  private requestListeners = new Set<(prompt: ApprovalPrompt) => void>();
  private cancelListeners = new Set<(id: string) => void>();

  constructor(
    private readonly gateway: HermesGateway,
    private readonly sessions: HermesSessions,
  ) {
    gateway.onRequest((request) => {
      if (request.method !== "approval") return false;
      this.receive(request);
      return true;
    });
    gateway.on("approval.cancelled", (event) => {
      const payload = event.payload as ApprovalCancelledPayload | undefined;
      for (const requestId of payload?.request_ids ?? []) {
        for (const [id, p] of this.pending) if (p.requestId === requestId) this.cancel(id);
      }
    });
    gateway.on("request.cancel", (event) => {
      const payload = event.payload as RequestCancelPayload | undefined;
      if (payload?.id && this.pending.has(payload.id)) this.cancel(payload.id);
    });
    gateway.onBackendChanged(() => {
      for (const id of [...this.pending.keys()]) this.cancel(id);
    });
  }

  onRequest(callback: (prompt: ApprovalPrompt) => void): () => void {
    this.requestListeners.add(callback);
    return () => this.requestListeners.delete(callback);
  }

  onCancel(callback: (id: string) => void): () => void {
    this.cancelListeners.add(callback);
    return () => this.cancelListeners.delete(callback);
  }

  respond(id: string, choice: ApprovalChoice): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    try {
      p.request.respond({ choice });
    } catch {
      // The socket generation that delivered the request is gone: answer by RPC instead.
      void this.gateway
        .request("approval.respond", { session_id: p.liveSessionId, request_id: p.requestId, choice })
        .catch(() => {});
    }
  }

  private receive(request: ServerRequest): void {
    const params = request.params as unknown as ApprovalRequestParams;
    const liveSessionId = String(params.session_id ?? "");
    this.pending.set(request.id, { request, liveSessionId, requestId: String(params.request_id ?? "") });
    void this.gateway.request("approval.received", { session_id: liveSessionId, request_id: params.request_id }).catch(() => {});

    const choices = (params.choices?.length ? params.choices : ALL_CHOICES).filter(
      (c) => (c !== "always" || params.allow_permanent !== false) && (c !== "session" || params.allow_session !== false),
    );
    const prompt: ApprovalPrompt = {
      id: request.id,
      conversationId: this.sessions.storedIdFor(liveSessionId),
      command: String(params.command ?? ""),
      description: String(params.description ?? "Hermes wants to run an action that needs your approval."),
      toolName: params.tool_name ?? undefined,
      choices: choices.includes("deny") ? choices : [...choices, "deny"],
    };
    for (const listener of this.requestListeners) listener(prompt);
  }

  private cancel(id: string): void {
    if (!this.pending.delete(id)) return;
    for (const listener of this.cancelListeners) listener(id);
  }
}
