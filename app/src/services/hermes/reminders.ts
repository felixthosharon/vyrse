import type { FiredReminder, Reminder } from "../vyrse-api";
import type { CronJobRow, CronManageResult } from "./vendor/gateway-contract.generated";
import type { HermesGateway } from "./gateway";

/** Reminders and routines are Hermes cron jobs; VYRSE lists and manages them and shows their results. */
export class HermesReminders {
  constructor(private readonly gateway: HermesGateway) {}

  async list(): Promise<Reminder[]> {
    const res = await this.manage({ action: "list", include_disabled: true });
    return (res.jobs ?? []).map(toReminder);
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    await this.manage({ action: paused ? "pause" : "resume", name: id });
  }

  async remove(id: string): Promise<void> {
    await this.manage({ action: "remove", name: id });
  }

  async fired(since: number): Promise<{ now: number; fired: FiredReminder[] }> {
    const res = await this.gateway.rest<{ now: number; fired: { job_id: string; name: string; text: string; at: number; ok: boolean }[] }>(
      `/api/plugins/vyrse/reminders/fired?since=${encodeURIComponent(String(since))}`,
    );
    return { now: res.now, fired: res.fired.map((f) => ({ jobId: f.job_id, name: f.name, text: f.text, at: f.at, ok: f.ok })) };
  }

  private async manage(params: Record<string, unknown>): Promise<CronManageResult> {
    const res = await this.gateway.request<CronManageResult>("cron.manage", params);
    if (res?.success === false) throw new Error(res.error ?? "Hermes couldn't update that reminder.");
    return res;
  }
}

function toReminder(job: CronJobRow): Reminder {
  return {
    id: job.job_id,
    name: job.name || job.prompt_preview || "Reminder",
    schedule: job.schedule ?? "",
    nextRun: job.next_run_at ?? null,
    lastRun: job.last_run_at ?? null,
    paused: job.state !== "completed" && (job.enabled === false || job.state === "paused"),
    done: job.state === "completed",
  };
}
