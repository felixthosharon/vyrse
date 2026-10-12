import type { AgentSettings, ModelChoice, ReasoningLevel } from "../vyrse-api";
import type { HermesGateway } from "./gateway";
import type { ConfigGetResult, ModelOptionsResult } from "./vendor/gateway-contract.generated";

/** Human names for Hermes provider slugs that VYRSE shows often. */
const PROVIDER_LABELS: Record<string, string> = { llamacpp: "Local" };

/**
 * Hermes-owned agent settings, read and written through Hermes itself
 * (`model.options`, `config.get/set`, `/api/config`). VYRSE keeps no copy of these.
 */
export class HermesSettings {
  /** the model picked in VYRSE (Hermes' global choice); every conversation is kept on it */
  selected: { model: string; provider: string } | null = null;

  constructor(private readonly gateway: HermesGateway) {}

  async load(): Promise<AgentSettings> {
    const [models, reasoning, approvals, config, memoryStatus] = await Promise.all([
      this.gateway.request<ModelOptionsResult>("model.options", { refresh: true }),
      this.gateway.request<ConfigGetResult>("config.get", { key: "reasoning" }),
      this.gateway.request<ConfigGetResult>("config.get", { key: "approvals.mode" }),
      this.gateway.rest<Record<string, unknown>>("/api/config"),
      this.gateway.rest<{ builtin_files?: Record<string, number> }>("/api/memory").catch(() => ({ builtin_files: {} })),
    ]);
    if (models.model && models.provider) this.selected = { model: models.model, provider: models.provider };
    const memory = (config["memory"] ?? {}) as Record<string, unknown>;
    const stt = (config["stt"] ?? {}) as { local?: { model?: string } };
    return {
      model: models.model ?? "",
      provider: models.provider ?? "",
      models: listModels(models),
      reasoning: normalizeReasoning(reasoning.value),
      approvalMode: (approvals.value as AgentSettings["approvalMode"]) ?? "manual",
      memoryEnabled: memory["memory_enabled"] === true,
      sttModel: stt.local?.model ?? "base.en",
      memoryBytes: Object.values(memoryStatus.builtin_files ?? {}).reduce<number>((a, b) => a + Number(b || 0), 0),
    };
  }

  /** Switch the model for new turns (persisted globally; applied to `liveSessionId` now if given). */
  async setModel(choice: ModelChoice, liveSessionId?: string): Promise<void> {
    await this.gateway.request("config.set", {
      key: "model",
      value: `${choice.model} --provider ${choice.provider} --global`,
      ...(liveSessionId ? { session_id: liveSessionId } : {}),
    });
    this.selected = { model: choice.model, provider: choice.provider };
  }

  async setReasoning(level: ReasoningLevel): Promise<void> {
    await this.gateway.request("config.set", { key: "reasoning", value: level, scope: "global" });
  }

  async setApprovalMode(mode: AgentSettings["approvalMode"]): Promise<void> {
    await this.gateway.request("config.set", { key: "approvals.mode", value: mode });
  }

  async setSttModel(model: string): Promise<void> {
    await this.gateway.rest("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: { stt: { local: { model } } } }),
    });
  }

  async setMemoryEnabled(enabled: boolean): Promise<void> {
    await this.gateway.rest("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: { memory: { memory_enabled: enabled, user_profile_enabled: enabled } } }),
    });
  }
}

function listModels(result: ModelOptionsResult): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const provider of result.providers ?? []) {
    if (provider.authenticated === false || provider.warning) continue;
    const label = PROVIDER_LABELS[provider.slug] ?? provider.name;
    for (const model of provider.models ?? []) {
      out.push({ provider: provider.slug, providerLabel: label, model, local: provider.slug === "llamacpp" });
    }
  }
  // Local models first: VYRSE is local-first.
  return out.sort((a, b) => Number(b.local) - Number(a.local));
}

function normalizeReasoning(value: unknown): ReasoningLevel {
  const v = String(value ?? "").toLowerCase();
  return (["none", "low", "medium", "high"] as const).find((l) => l === v) ?? "medium";
}
