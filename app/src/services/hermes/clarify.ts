import type { ClarifyPrompt } from "../vyrse-api";
import type { HermesGateway } from "./gateway";
import type { HermesSessions } from "./sessions";
import type { ClarifyRequestParams, RequestCancelPayload } from "./vendor/gateway-contract.generated";
import type { ServerRequest } from "./vendor/json-rpc-channel";

/**
 * Hermes' `clarify` server requests (the agent asking the user questions mid-task),
 * surfaced as an inline card. Mirrors approvals.ts.
 */
export class HermesClarify {
  private pending = new Map<string, ServerRequest>();
  private requestListeners = new Set<(prompt: ClarifyPrompt) => void>();
  private cancelListeners = new Set<(id: string) => void>();

  constructor(gateway: HermesGateway, private readonly sessions: HermesSessions) {
    gateway.onRequest((request) => {
      if (request.method !== "clarify") return false;
      this.receive(request);
      return true;
    });
    gateway.on("request.cancel", (event) => {
      const payload = event.payload as RequestCancelPayload | undefined;
      if (payload?.id) this.cancel(payload.id);
    });
    gateway.onBackendChanged(() => {
      for (const id of [...this.pending.keys()]) this.cancel(id);
    });
  }

  onRequest(callback: (prompt: ClarifyPrompt) => void): () => void {
    this.requestListeners.add(callback);
    return () => this.requestListeners.delete(callback);
  }

  onCancel(callback: (id: string) => void): () => void {
    this.cancelListeners.add(callback);
    return () => this.cancelListeners.delete(callback);
  }

  respond(id: string, answers: Record<string, string> | null): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.respond(answers ? { answers } : {});
  }

  private receive(request: ServerRequest): void {
    const params = request.params as unknown as ClarifyRequestParams;
    this.pending.set(request.id, request);
    const prompt: ClarifyPrompt = {
      id: request.id,
      conversationId: this.sessions.storedIdFor(String(params.session_id ?? "")),
      questions: (params.questions ?? []).map((q) => ({
        qid: q.qid,
        question: q.question,
        choices: q.choices ?? undefined,
        multiSelect: q.multi_select ?? undefined,
      })),
    };
    for (const listener of this.requestListeners) listener(prompt);
  }

  private cancel(id: string): void {
    if (!this.pending.delete(id)) return;
    for (const listener of this.cancelListeners) listener(id);
  }
}
