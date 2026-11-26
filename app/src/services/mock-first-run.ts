import type {
  AgentSettings,
  LocalModelsApi,
  LocalModelsStatus,
  ModelBuild,
  ModelJob,
  VyrseApi,
} from "./vyrse-api";

/**
 * Demo only (the mock backend with `?firstrun` in the address): a PC with no AI model yet, so the first-run model
 * screen and Settings → AI models can be seen and checked without Hermes. A download "runs" for a few seconds.
 */
export function firstRunDemo(): Pick<VyrseApi, "agent" | "localModels"> {
  const models: { id: string; bytes: number }[] = [];
  const jobs: ModelJob[] = [];
  let agent: AgentSettings = {
    model: "",
    provider: "",
    models: [],
    reasoning: "low",
    approvalMode: "manual",
    memoryEnabled: true,
    memoryBytes: 0,
    sttModel: "base.en",
    modelsDir: "C:\\Users\\you\\VYRSE\\models",
  };
  const changed = new Set<(m: { model: string; provider: string }) => void>();
  const GB = 1024 ** 3;

  const tick = () => {
    for (const j of jobs) {
      if (j.state !== "running" || !j.totalBytes) continue;
      j.doneBytes = Math.min(j.totalBytes, j.doneBytes + j.totalBytes / 8);
      j.percent = Math.round((100 * j.doneBytes) / j.totalBytes);
      j.etaSeconds = ((j.totalBytes - j.doneBytes) / j.totalBytes) * 8;
      if (j.doneBytes >= j.totalBytes) {
        j.state = "done";
        j.canPause = false;
        models.push({ id: j.modelId!, bytes: j.totalBytes });
      }
    }
  };

  const localModels: LocalModelsApi = {
    async status(): Promise<LocalModelsStatus> {
      tick();
      return {
        engineInstalled: true,
        active: agent.model || undefined,
        models: [...models],
        gpu: "NVIDIA GeForce RTX 4050 Laptop GPU",
        gpuBytes: 6 * GB,
        ramBytes: 24 * GB,
        jobs: jobs.map((j) => ({ ...j })),
      };
    },
    async jobs() {
      tick();
      return jobs.map((j) => ({ ...j }));
    },
    async search(query) {
      return [{ repo: `unsloth/${query.replace(/\s*GGUF$/i, "")}-GGUF`, downloads: 120000 }];
    },
    async builds(): Promise<ModelBuild[]> {
      return [
        { label: "Q4_K_M", paths: ["model-Q4_K_M.gguf"], bytes: 2.7 * GB, fit: "gpu" },
        { label: "Q8_0", paths: ["model-Q8_0.gguf"], bytes: 4.5 * GB, fit: "gpu" },
        { label: "BF16", paths: ["model-BF16.gguf"], bytes: 8.4 * GB, fit: "slow" },
      ];
    },
    async download(repo, build) {
      const id = `${repo
        .split("/")[1]!
        .replace(/-GGUF$/i, "")
        .toLowerCase()}-${build.label.toLowerCase()}`;
      jobs.push({
        id: `job-${jobs.length}`,
        kind: "download",
        name: `${id} (from ${repo})`,
        modelId: id,
        state: "running",
        detail: "",
        doneBytes: 0,
        totalBytes: build.bytes,
        bytesPerSec: 38 * 1024 ** 2,
        canPause: true,
        canResume: false,
      });
      return { jobId: jobs[jobs.length - 1]!.id };
    },
    async installEngine() {
      return "";
    },
    async pause(jobId) {
      const j = jobs.find((x) => x.id === jobId);
      if (j) Object.assign(j, { state: "paused", canPause: false, canResume: true });
    },
    async resume(jobId) {
      const j = jobs.find((x) => x.id === jobId);
      if (j) Object.assign(j, { state: "running", canPause: true, canResume: false });
    },
    async use(modelId) {
      agent = {
        ...agent,
        model: modelId,
        provider: "llamacpp",
        models: [
          { provider: "llamacpp", providerLabel: "On this PC", model: modelId, local: true },
        ],
      };
      changed.forEach((cb) => cb({ model: modelId, provider: "llamacpp" }));
      return "";
    },
    async remove(modelId) {
      models.splice(
        models.findIndex((m) => m.id === modelId),
        1,
      );
    },
    async openFolder() {
      return "";
    },
  };

  return {
    localModels,
    agent: {
      load: async () => ({ ...agent }),
      setModel: async () => {},
      setReasoning: async () => {},
      setApprovalMode: async () => {},
      setMemoryEnabled: async () => {},
      setSttModel: async () => {},
      onModelChanged(cb) {
        changed.add(cb);
        return () => changed.delete(cb);
      },
    },
  };
}
