import type {
  Connector,
  ConnectionsApi,
  ConnectorSignIn,
  LocalModelsApi,
  LocalModelsStatus,
  MemoryApi,
  MemoryNotes,
  ModelBuild,
  ModelJob,
  ModelRepo,
  UsageApi,
  UsageSummary,
} from "../vyrse-api";
import type { HermesGateway } from "./gateway";

const json = (body: unknown) => JSON.stringify(body);
const GB = 1024 ** 3;

/* ------------------------------------------------------------------------------------------ local models */

interface StatusRow {
  runtime_installed?: boolean;
  server_running?: boolean;
  active_model_id?: string | null;
  models?: { id: string; size_bytes?: number }[];
}
interface HardwareRow {
  gpu_name?: string | null;
  vram_total_bytes?: number;
  ram_total_bytes?: number;
}
interface JobRow {
  job_id: string;
  kind: string;
  target: string;
  model_id?: string | null;
  status: "running" | "paused" | "done" | "error";
  phase?: string;
  detail?: string;
  error?: string | null;
  done_bytes?: number;
  total_bytes?: number | null;
  percent?: number;
  bytes_per_sec?: number;
  eta_seconds?: number;
  can_pause?: boolean;
  can_resume?: boolean;
}
interface FileGroup {
  label: string;
  paths: string[];
  total_bytes: number;
  fit: string;
}

/** Which build of a model to offer first: one that runs fully on the GPU, at the quality most people use. */
const PREFERRED = ["Q4_K_M", "Q5_K_M", "Q4_K_S", "Q4_0", "Q3_K_M", "Q6_K"];

export function pickBuild(builds: ModelBuild[]): ModelBuild | null {
  const usable = builds.filter((b) => !/^(BF16|F16|F32)$/i.test(b.label));
  const onGpu = usable.filter((b) => b.fit === "gpu");
  for (const want of PREFERRED) {
    const hit = onGpu.find((b) => b.label.toUpperCase() === want);
    if (hit) return hit;
  }
  if (onGpu.length) return [...onGpu].sort((a, b) => b.bytes - a.bytes)[0]!;
  // Nothing fits the GPU: a build that still runs (slowly, partly in system memory), at a quality worth having.
  const slow = usable.filter((b) => b.fit === "slow");
  for (const want of PREFERRED) {
    const hit = slow.find((b) => b.label.toUpperCase() === want);
    if (hit) return hit;
  }
  const decent = slow.filter((b) => !/^(I?Q[12]_|I?Q[12]$)/i.test(b.label));
  const pool = decent.length ? decent : slow;
  return pool.length ? [...pool].sort((a, b) => a.bytes - b.bytes)[0]! : null;
}

/**
 * Will this size run well here? Hermes' own verdict counts only the GPU memory that is free right now, which
 * calls a model "slow" just because a browser is open. For the suggestion VYRSE asks whether the file, plus
 * room for the conversation, fits in most of the card.
 */
export function fitFor(bytes: number, hermesFit: string, gpuBytes?: number): ModelBuild["fit"] {
  if (hermesFit === "too-big") return "too-big";
  if (gpuBytes && bytes + 1.5 * GB <= gpuBytes * 0.85) return "gpu";
  return hermesFit === "fits-gpu" ? "gpu" : hermesFit === "needs-ram" ? "slow" : "unknown";
}

/** Publishers of plain, faithful conversions come first; remixes ("uncensored", role-play, distilled) last. */
const TRUSTED = ["unsloth", "ggml-org", "lmstudio-community", "bartowski", "google", "Qwen", "microsoft", "meta-llama", "mistralai"];
export function rankRepos(repos: ModelRepo[]): ModelRepo[] {
  const score = (r: ModelRepo) => {
    const owner = r.repo.split("/")[0] ?? "";
    if (/uncensored|abliterat|heretic|nsfw|roleplay|[-_]rp[-_]|distill|merge|defiant/i.test(r.repo)) return 2;
    return TRUSTED.some((t) => t.toLowerCase() === owner.toLowerCase()) ? 0 : 1;
  };
  return [...repos].sort((a, b) => score(a) - score(b) || b.downloads - a.downloads);
}

function toJob(j: JobRow): ModelJob {
  return {
    id: j.job_id,
    kind: j.kind === "runtime-install" ? "engine" : j.kind === "model-activate" ? "activate" : "download",
    name: j.target,
    modelId: j.model_id ?? undefined,
    state: j.status,
    detail: j.status === "error" ? (j.error ?? j.detail ?? "It didn't finish.") : (j.detail ?? ""),
    doneBytes: j.done_bytes ?? 0,
    totalBytes: j.total_bytes ?? undefined,
    percent: j.percent,
    bytesPerSec: j.bytes_per_sec,
    etaSeconds: j.eta_seconds,
    canPause: Boolean(j.can_pause),
    canResume: Boolean(j.can_resume),
  };
}

export class HermesLocalModels implements LocalModelsApi {
  constructor(private readonly gateway: HermesGateway) {}

  async status(): Promise<LocalModelsStatus> {
    const [s, h, jobs] = await Promise.all([
      this.gateway.rest<StatusRow>("/api/local-models/status"),
      this.gateway.rest<HardwareRow>("/api/local-models/hardware").catch(() => ({}) as HardwareRow),
      this.jobs().catch(() => [] as ModelJob[]),
    ]);
    return {
      engineInstalled: Boolean(s.runtime_installed),
      active: s.active_model_id ?? undefined,
      models: (s.models ?? []).map((m) => ({ id: m.id, bytes: m.size_bytes ?? 0 })),
      gpu: h.gpu_name ?? undefined,
      gpuBytes: h.vram_total_bytes || undefined,
      ramBytes: h.ram_total_bytes || undefined,
      jobs,
    };
  }

  async jobs(): Promise<ModelJob[]> {
    const res = await this.gateway.rest<{ jobs?: JobRow[] }>("/api/local-models/jobs");
    return (res.jobs ?? []).map(toJob);
  }

  async search(query: string): Promise<ModelRepo[]> {
    const res = await this.gateway.rest<{ hits?: { repo: string; downloads?: number; gated?: boolean }[] }>(
      `/api/local-models/search?limit=12&q=${encodeURIComponent(query)}`,
    );
    return rankRepos((res.hits ?? []).filter((h) => !h.gated).map((h) => ({ repo: h.repo, downloads: h.downloads ?? 0 })));
  }

  async builds(repo: string): Promise<ModelBuild[]> {
    const [res, hardware] = await Promise.all([
      this.gateway.rest<{ files?: FileGroup[] }>(`/api/local-models/search/files?repo=${encodeURIComponent(repo)}`),
      this.gateway.rest<HardwareRow>("/api/local-models/hardware").catch(() => ({}) as HardwareRow),
    ]);
    return (res.files ?? [])
      .filter((f) => f.paths.length > 0 && !/mmproj/i.test(f.paths[0]!))
      .map((f) => ({ label: f.label, paths: f.paths, bytes: f.total_bytes, fit: fitFor(f.total_bytes, f.fit, hardware.vram_total_bytes || undefined) }));
  }

  async download(repo: string, build: ModelBuild): Promise<{ jobId?: string; already?: boolean }> {
    const res = await this.gateway.rest<{ job_id: string | null; already_downloaded?: boolean }>("/api/local-models/download-browsed", {
      method: "POST",
      body: json({ repo, paths: build.paths }),
    });
    return { jobId: res.job_id ?? undefined, already: Boolean(res.already_downloaded) };
  }

  async installEngine(): Promise<string> {
    const res = await this.gateway.rest<{ job_id: string }>("/api/local-models/runtime/install", { method: "POST", body: "{}" });
    return res.job_id;
  }

  async pause(jobId: string): Promise<void> {
    await this.gateway.rest("/api/local-models/download/pause", { method: "POST", body: json({ job_id: jobId }) });
  }

  async resume(jobId: string): Promise<void> {
    await this.gateway.rest("/api/local-models/download/resume", { method: "POST", body: json({ job_id: jobId }) });
  }

  /** Make a downloaded model the one that answers (starts the local engine if it was off). */
  async use(modelId: string): Promise<string> {
    const res = await this.gateway.rest<{ job_id: string }>("/api/local-models/activate", { method: "POST", body: json({ model_id: modelId }) });
    return res.job_id;
  }

  async remove(modelId: string): Promise<void> {
    await this.gateway.rest(`/api/local-models/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
  }
}

export const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;

/* ------------------------------------------------------------------------------------------ connections */

interface CatalogRow {
  name: string;
  description: string;
  source?: string;
  auth_type: string;
  url?: string | null;
  needs_install?: boolean;
  installed: boolean;
  enabled: boolean;
  required_env?: { name: string }[];
}

/** "microsoft-learn" -> "Microsoft Learn" */
export function connectorLabel(name: string): string {
  const special: Record<string, string> = { "aws-knowledge": "AWS Knowledge", "n8n-official": "n8n", "wordpress-com": "WordPress.com", clickup: "ClickUp", gitlab: "GitLab", paypal: "PayPal", deepwiki: "DeepWiki", alltrails: "AllTrails", motherduck: "MotherDuck", betterstack: "Better Stack", circleci: "CircleCI", hugging_face: "Hugging Face" };
  return special[name] ?? name.split(/[-_]/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

export class HermesConnections implements ConnectionsApi {
  constructor(private readonly gateway: HermesGateway) {}

  async list(): Promise<Connector[]> {
    const res = await this.gateway.rest<{ entries?: CatalogRow[] }>("/api/mcp/catalog");
    return (res.entries ?? [])
      // Only the kinds VYRSE can set up with a click: a web address, with a sign-in or nothing at all.
      .filter((e) => e.url && !e.needs_install && !(e.required_env ?? []).length && (e.auth_type === "oauth" || e.auth_type === "none"))
      .map((e) => ({
        id: e.name,
        label: connectorLabel(e.name),
        description: e.description,
        signIn: e.auth_type === "oauth",
        added: e.installed,
        on: e.installed && e.enabled,
        host: hostOf(e.url ?? ""),
      }))
      .sort((a, b) => Number(b.added) - Number(a.added) || a.label.localeCompare(b.label));
  }

  async add(id: string): Promise<void> {
    await this.gateway.rest("/api/mcp/catalog/install", { method: "POST", body: json({ name: id, env: {}, enable: true }) });
  }

  async remove(id: string): Promise<void> {
    await this.gateway.rest(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async setOn(id: string, on: boolean): Promise<void> {
    await this.gateway.rest(`/api/mcp/servers/${encodeURIComponent(id)}/enabled`, { method: "PUT", body: json({ enabled: on }) });
  }

  /** Connect to it and count what it offers (also tells a sign-in is still needed). */
  async check(id: string): Promise<{ ok: boolean; tools: number; message?: string }> {
    const res = await this.gateway.rest<{ ok: boolean; error?: string; tools?: unknown[] }>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" });
    return { ok: res.ok, tools: res.tools?.length ?? 0, message: res.ok ? undefined : friendlyConnectorError(res.error ?? "") };
  }

  async startSignIn(id: string): Promise<ConnectorSignIn> {
    const res = await this.gateway.rest<{ flow_id: string; status: string; authorization_url?: string | null; error?: string | null }>(
      `/api/mcp/servers/${encodeURIComponent(id)}/auth`,
      { method: "POST", body: "{}" },
    );
    if (!res.authorization_url) throw new Error(friendlyConnectorError(res.error ?? "") || "The sign-in page didn't open.");
    return { id, flow: res.flow_id, url: res.authorization_url };
  }

  async pollSignIn(signIn: ConnectorSignIn): Promise<{ state: "waiting" | "done" | "failed"; message?: string }> {
    try {
      const res = await this.gateway.rest<{ status: string; error?: string | null }>(`/api/mcp/oauth/flows/${signIn.flow}`);
      if (res.status === "approved") return { state: "done" };
      if (res.error || res.status === "error") return { state: "failed", message: friendlyConnectorError(res.error ?? "") || "The sign-in didn't finish." };
      return { state: "waiting" };
    } catch (err) {
      return { state: "failed", message: (err as Error).message.replace(/^\/api\S*:\s*/, "") };
    }
  }

  async cancelSignIn(signIn: ConnectorSignIn): Promise<void> {
    await this.gateway.rest(`/api/mcp/oauth/flows/${signIn.flow}`, { method: "DELETE" }).catch(() => undefined);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function friendlyConnectorError(error: string): string {
  if (!error) return "";
  if (/oauth authentication required|no token/i.test(error)) return "Sign in to finish connecting.";
  if (/timed? ?out|timeout/i.test(error)) return "It didn't answer in time. Try again.";
  return error.length > 160 ? `${error.slice(0, 160)}…` : error;
}

/* ------------------------------------------------------------------------------------------------ memory */

type MemoryResult = { ok: boolean; message?: string; memory: MemoryNotes };

export class HermesMemory implements MemoryApi {
  constructor(private readonly gateway: HermesGateway) {}

  list(): Promise<MemoryNotes> {
    return this.gateway.rest<MemoryNotes>("/api/plugins/vyrse/memory");
  }
  add(target: "user" | "memory", content: string): Promise<MemoryResult> {
    return this.gateway.rest<MemoryResult>("/api/plugins/vyrse/memory", { method: "POST", body: json({ target, content }) });
  }
  replace(target: "user" | "memory", entry: string, content: string): Promise<MemoryResult> {
    return this.gateway.rest<MemoryResult>("/api/plugins/vyrse/memory", { method: "PUT", body: json({ target, entry, content }) });
  }
  remove(target: "user" | "memory", entry: string): Promise<MemoryResult> {
    return this.gateway.rest<MemoryResult>("/api/plugins/vyrse/memory/remove", { method: "POST", body: json({ target, entry }) });
  }
}

/* ------------------------------------------------------------------------------------------------- usage */

interface UsageRow {
  model: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  estimated_cost?: number;
  actual_cost?: number;
  api_calls?: number;
}

/**
 * What the same words would cost on a typical paid AI API: US$3 per million tokens in, US$15 per million out
 * (the list price of a mid-range model from the big labs in 2026). An estimate for comparison, not a bill.
 */
export const REFERENCE_PRICE = { inPerMillion: 3, outPerMillion: 15 };

export function wouldHaveCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * REFERENCE_PRICE.inPerMillion + outputTokens * REFERENCE_PRICE.outPerMillion) / 1_000_000;
}

const LOCAL_PROVIDERS = new Set(["", "custom", "llamacpp", "local", "ollama", "lmstudio"]);

export function summarizeUsage(rows: UsageRow[], days: number): UsageSummary {
  const byModel = new Map<string, UsageSummary["models"][number]>();
  for (const r of rows) {
    const input = (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0);
    const output = r.output_tokens ?? 0;
    if (!input && !output) continue;
    const local = LOCAL_PROVIDERS.has((r.provider ?? "").toLowerCase());
    const key = `${local ? "local" : r.provider}::${r.model}`;
    const row = byModel.get(key) ?? { model: r.model, local, inputTokens: 0, outputTokens: 0, messages: 0, paid: 0, saved: 0 };
    row.inputTokens += input;
    row.outputTokens += output;
    row.messages += r.api_calls ?? 0;
    const paid = local ? 0 : Math.max(r.actual_cost ?? 0, r.estimated_cost ?? 0);
    row.paid += paid;
    // Local: everything a paid API would have charged. Online: nothing saved (a subscription isn't counted either way).
    if (local) row.saved += wouldHaveCost(input, output);
    byModel.set(key, row);
  }
  const models = [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return {
    days,
    models,
    tokens: models.reduce((n, m) => n + m.inputTokens + m.outputTokens, 0),
    messages: models.reduce((n, m) => n + m.messages, 0),
    paid: models.reduce((n, m) => n + m.paid, 0),
    saved: models.reduce((n, m) => n + m.saved, 0),
  };
}

export class HermesUsage implements UsageApi {
  constructor(private readonly gateway: HermesGateway) {}

  async summary(days: number): Promise<UsageSummary> {
    const res = await this.gateway.rest<{ models?: UsageRow[] }>(`/api/analytics/models?days=${days}`);
    return summarizeUsage(res.models ?? [], days);
  }
}
