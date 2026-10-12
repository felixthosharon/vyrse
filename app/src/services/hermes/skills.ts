import type { HubSkill, InstalledSkill } from "../vyrse-api";
import type { HermesGateway } from "./gateway";

interface ActionStatus {
  running?: boolean;
  exit_code?: number | null;
  lines?: string[];
}

/**
 * Hermes' own skill system (installed skills, enable/disable, Skills Hub). VYRSE adds no
 * skill runtime of its own; install/uninstall run Hermes' `hermes skills …` actions,
 * including Hermes' security scan of downloaded skills.
 */
export class HermesSkills {
  constructor(private readonly gateway: HermesGateway) {}

  list(): Promise<InstalledSkill[]> {
    return this.gateway.rest<InstalledSkill[]>("/api/skills");
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.gateway.rest("/api/skills/toggle", { method: "PUT", body: JSON.stringify({ name, enabled }) });
    await this.reload();
  }

  async content(name: string): Promise<string> {
    const res = await this.gateway.rest<{ content?: string }>(`/api/skills/content?name=${encodeURIComponent(name)}`);
    return res.content ?? "";
  }

  async search(query: string): Promise<HubSkill[]> {
    const res = await this.gateway.rest<{ results?: Record<string, unknown>[]; installed?: Record<string, unknown> }>(
      `/api/skills/hub/search?q=${encodeURIComponent(query)}&limit=12`,
    );
    const installed = new Set(Object.keys(res.installed ?? {}));
    return (res.results ?? []).map((r) => ({
      name: String(r["name"] ?? ""),
      description: String(r["description"] ?? ""),
      source: String(r["source"] ?? ""),
      identifier: String(r["identifier"] ?? ""),
      trust: String(r["trust_level"] ?? "community"),
      installed: installed.has(String(r["identifier"] ?? "")) || installed.has(String(r["name"] ?? "")),
    }));
  }

  install(identifier: string): Promise<void> {
    return this.runAction("/api/skills/hub/install", { identifier });
  }

  uninstall(name: string): Promise<void> {
    return this.runAction("/api/skills/hub/uninstall", { name });
  }

  /** Live sessions pick up skill changes. */
  private async reload(): Promise<void> {
    await this.gateway.request("skills.reload", {}).catch(() => {});
  }

  private async runAction(path: string, body: Record<string, string>): Promise<void> {
    const started = await this.gateway.rest<{ name: string }>(path, { method: "POST", body: JSON.stringify(body) });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await this.gateway.rest<ActionStatus>(`/api/actions/${encodeURIComponent(started.name)}/status?lines=12`);
      if (status.running) continue;
      if (status.exit_code === 0) {
        await this.reload();
        return;
      }
      const reason = (status.lines ?? []).filter((l) => l.trim()).slice(-2).join(" ").slice(0, 240);
      throw new Error(reason || `Hermes reported exit code ${status.exit_code}`);
    }
    throw new Error("Timed out waiting for Hermes");
  }
}
