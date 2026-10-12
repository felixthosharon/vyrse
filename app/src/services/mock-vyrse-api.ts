import { planResponse, tokenize } from "@/lib/vyrse/mock-ai";
import type { StreamEvent, TurnRequest, VyrseApi } from "./vyrse-api";

/** Cancellable delay that rejects nothing — it simply resolves early on abort. */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Development adapter. Emits the same event sequence a real backend would,
 * chunk by chunk — nothing here delays a pre-completed string wholesale.
 */
export function createMockVyrseApi(): VyrseApi {
  return {
    id: "mock",
    live: false,
    async *stream(req: TurnRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
      const plan = planResponse(req.prompt);

      yield { type: "status", status: "thinking" };
      await wait(plan.thinkMs * 0.55, signal);
      if (signal.aborted) return;

      if (plan.working) {
        yield { type: "tool", name: "analysis", phase: "start" };
        yield { type: "status", status: "working" };
        await wait(plan.thinkMs * 0.45, signal);
        if (signal.aborted) return;
        yield { type: "tool", name: "analysis", phase: "end" };
      }

      yield { type: "status", status: "speaking", meta: plan.meta };

      for (const token of tokenize(plan.text)) {
        if (signal.aborted) return;
        yield { type: "text", delta: token };
        await wait(12 + Math.random() * 26, signal);
      }

      if (signal.aborted) return;
      if (plan.artifact) {
        yield { type: "artifact", artifact: plan.artifact };
        // Demonstrates the semantic presentation contract: the adapter asks for
        // a mode, never for dimensions. The UI decides what "split" looks like.
        yield { type: "presentation", mode: "split" };
      }
      yield { type: "done" };
    },
  };
}
