import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cpu, Download, FolderOpen, HardDrive, Loader2, Pause, Play, Search, Sparkles, Trash2 } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { LocalModelsStatus, ModelBuild, ModelJob, ModelRepo } from "@/services";
import { gb, pickBuild } from "@/services/hermes/extras";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";

/** Starting points for people who don't know model names; each is just a search. `minGpu`: GPU memory (GB) it needs
 *  to be the best pick. */
const PICKS = [
  // Qwen 3.5 4B, not Gemma 3 4B (2026-11-27): same family as the 9B VYRSE is tuned on, with tool calling built in.
  // Tested with VYRSE's tools: real calls for specs, the PC dashboard and a quiz, where Gemma 4B wrote them out as text.
  { label: "Small and fast", hint: "4 GB of GPU memory or less", query: "Qwen3.5-4B GGUF", repo: "unsloth/Qwen3.5-4B-GGUF", minGpu: 0 },
  { label: "Balanced", hint: "6 to 8 GB", query: "Qwen3.5-9B GGUF", repo: "unsloth/Qwen3.5-9B-GGUF", minGpu: 5.5 },
  { label: "Smarter", hint: "10 GB or more", query: "gemma-3-12b-it GGUF", repo: "unsloth/gemma-3-12b-it-GGUF", minGpu: 10 },
];

/** The biggest pick this PC's graphics card holds (2026-11-27: a friend with a 6 GB RTX 4050 took "Small and fast"
 *  because nothing said which one fits). */
export function bestPick(gpuBytes?: number): string | null {
  if (!gpuBytes) return null;
  const gb = gpuBytes / 1024 ** 3;
  return [...PICKS].reverse().find((p) => gb >= p.minGpu)?.label ?? null;
}

const FIT: Record<ModelBuild["fit"], { text: string; className: string }> = {
  gpu: { text: "runs fully on your GPU", className: "border-primary/35 text-primary" },
  slow: { text: "runs, but slowly", className: "border-border-strong text-muted-foreground" },
  "too-big": { text: "too big for this PC", className: "border-destructive/40 text-destructive" },
  unknown: { text: "size unknown", className: "border-border-strong text-muted-foreground" },
};

/** The one badge for "this suits your PC": the pick for this graphics card, and the best size of a model. */
function BestBadge({ children = "Best for this PC" }: { children?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-px text-[9px] text-primary">
      <Sparkles className="size-2.5" strokeWidth={2} /> {children}
    </span>
  );
}

const eta = (seconds?: number) => (seconds === undefined ? "" : seconds < 90 ? `${Math.max(1, Math.round(seconds))} s left` : `${Math.round(seconds / 60)} min left`);

/**
 * Models on this PC: what's installed, and a guided way to get one. Hermes does the work (search on Hugging
 * Face, the "will it fit" estimate, the download with pause and resume); VYRSE picks the build most people want.
 */
export function LocalModels({ open, firstRun = false }: { open: boolean; firstRun?: boolean }) {
  const { agent, refreshAgent, notify } = useVyrse();
  // With no model answering yet, a finished download is switched on right away: one less step on a new PC.
  const noModel = useRef(!agent?.model);
  noModel.current = !agent?.model;
  const api = getVyrseApi().localModels;
  const [status, setStatus] = useState<LocalModelsStatus | null>(null);
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<ModelRepo[] | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [builds, setBuilds] = useState<ModelBuild[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setStatus(await api.status());
    } catch (err) {
      setProblem(`Couldn't read your models: ${(err as Error).message}`);
    }
  }, [api]);
  useEffect(() => {
    if (open && agent) void refresh();
  }, [open, agent !== null, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // While something is downloading or installing, follow it; when it finishes, the new model shows up.
  const bestForPc = bestPick(status?.gpuBytes);
  const active = status?.jobs.filter((j) => j.state === "running" || j.state === "paused") ?? [];
  const following = open && active.some((j) => j.state === "running");
  const finished = useRef(new Set<string>());
  useEffect(() => {
    if (!following || !api) return;
    const t = window.setInterval(async () => {
      const jobs = await api.jobs().catch(() => null);
      if (!jobs) return;
      setStatus((s) => (s ? { ...s, jobs } : s));
      const done = jobs.filter((j) => j.state === "done" && !finished.current.has(j.id));
      if (done.length && jobs.every((j) => j.state !== "running")) {
        done.forEach((j) => finished.current.add(j.id));
        await refresh();
        await refreshAgent();
        const dl = done.find((j) => j.kind === "download");
        const name = dl?.name.replace(/ \(from .*\)$/, "");
        if (dl?.modelId && (noModel.current || firstRun)) {
          try {
            await api.use(dl.modelId);
            await refresh();
            await refreshAgent();
            notify(`${name} is ready. VYRSE answers with it now.`);
          } catch {
            notify(`${name} is downloaded. Press "Use" to switch to it.`);
          }
        } else if (dl) notify(`${name} is downloaded. Press "Use" to switch to it.`);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [following, api, refresh, refreshAgent, notify, firstRun]);
  useEffect(() => {
    // jobs that were already done when the page opened aren't news
    status?.jobs.filter((j) => j.state === "done").forEach((j) => finished.current.add(j.id));
  }, [status === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<unknown>, failure: string) => {
    if (busy) return;
    setBusy(key);
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      setProblem(`${failure}: ${(err as Error).message.replace(/^\/api\S*:\s*/, "")}`);
    }
    setBusy(null);
  };

  const search = (q: string) =>
    run("search", async () => {
      setQuery(q);
      setRepo(null);
      setBuilds(null);
      const found = await api!.search(q);
      setRepos(found);
      // One clear winner (or a starting-point search): open the most downloaded straight away.
      if (found[0]) await openRepo(found[0].repo);
    }, "The search didn't work");

  /** A starting point: straight to a known, plain conversion of that model (a search if it has moved). */
  const pick = (p: (typeof PICKS)[number]) =>
    run("search", async () => {
      setQuery(p.query);
      setRepos(null);
      try {
        await openRepo(p.repo);
      } catch {
        const found = await api!.search(p.query);
        setRepos(found);
        if (found[0]) await openRepo(found[0].repo);
        else setRepo(null);
      }
    }, "Couldn't look that up");

  const openRepo = async (name: string) => {
    setRepo(name);
    setBuilds(null);
    setShowAll(false);
    setBuilds(await api!.builds(name));
  };

  const download = (build: ModelBuild) =>
    run(`dl-${build.label}`, async () => {
      if (status && !status.engineInstalled) await api!.installEngine();
      const res = await api!.download(repo!, build);
      if (res.already) notify("That one is already on your PC.");
      await refresh();
    }, "The download didn't start");

  const use = (id: string) =>
    run(`use-${id}`, async () => {
      await api!.use(id);
      // Switching is quick (a setting, and the engine starting if it was off).
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => window.setTimeout(r, 700));
        const jobs = await api!.jobs();
        const job = jobs.find((j) => j.kind === "activate" && j.name === id);
        if (job?.state === "error") throw new Error(job.detail);
        if (!job || job.state === "done") break;
      }
      await refresh();
      await refreshAgent();
      notify(`VYRSE now answers with ${id}.`);
    }, "Couldn't switch");

  const openFolder = () =>
    run("folder", async () => {
      const err = await api!.openFolder!();
      if (err) throw new Error(err);
    }, "Couldn't open the folder");

  const remove = (id: string) =>
    run(`rm-${id}`, async () => {
      await api!.remove(id);
      setConfirmDelete(null);
      await refresh();
      await refreshAgent();
    }, "Couldn't delete it");

  if (!api) return null;
  const best = builds ? pickBuild(builds) : null;
  const shown = builds ? (showAll ? builds.filter((b) => !/^(BF16|F16|F32)$/i.test(b.label)) : best ? [best] : []) : [];
  const machine = status ? [status.gpu, status.gpuBytes ? `${gb(status.gpuBytes)} GPU memory` : null].filter(Boolean).join(" · ") : "";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-foreground">On your PC</span>
          {machine && <span className="min-w-0 truncate text-right font-mono text-[10px] text-muted-foreground">{machine}</span>}
        </div>
        {status?.gpu && (
          // 2026-11-27: on a friend's laptop Task Manager's default "3D" graph moved on the Intel graphics (that's
          // VYRSE's window) while the RTX looked idle: the model's work is CUDA/compute, which "3D" doesn't show.
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            The AI runs on your {status.gpu.replace(/^NVIDIA GeForce /, "")}. In Task Manager its work shows under “Cuda” or “Compute”, not “3D”; on a laptop, the 3D graph on built-in graphics is just VYRSE's window.
          </p>
        )}
        {!status ? (
          <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>
        ) : status.models.length === 0 ? (
          <div className="liquid relative flex items-center gap-3 rounded-2xl px-3.5 py-3">
            <HardDrive className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">No model on this PC yet. Pick one below and VYRSE downloads it for you.</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {status.models.map((m) => {
              const current = agent?.model === m.id;
              return (
                <li key={m.id} data-local-model={m.id} className={cn("liquid relative flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5", current && "ring-1 ring-primary/35")}>
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] text-foreground">{m.id}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{gb(m.bytes)}{current ? " · answering now" : ""}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {current ? (
                      <span className="flex items-center gap-1 rounded-full border border-primary/35 px-2 py-0.5 font-mono text-[9px] text-primary"><Check className="size-2.5" strokeWidth={2.4} /> in use</span>
                    ) : (
                      <button type="button" disabled={busy !== null} onClick={() => void use(m.id)} className="liquid relative rounded-full px-3 py-1 text-[11px] text-primary disabled:opacity-50">
                        {busy === `use-${m.id}` ? "Switching…" : "Use"}
                      </button>
                    )}
                    {!current &&
                      (confirmDelete === m.id ? (
                        <button type="button" disabled={busy !== null} onClick={() => void remove(m.id)} className="rounded-full border border-destructive/50 px-3 py-1 text-[11px] text-destructive disabled:opacity-50">
                          {busy === `rm-${m.id}` ? "Deleting…" : "Delete for good"}
                        </button>
                      ) : (
                        <button type="button" aria-label={`Delete ${m.id}`} title="Delete from this PC" onClick={() => setConfirmDelete(m.id)} className="liquid-hover relative grid size-7 place-items-center rounded-lg text-muted-foreground hover:text-destructive">
                          <Trash2 className="size-3.5" strokeWidth={1.5} />
                        </button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {active.map((j) => (
        <JobRow key={j.id} job={j} onPause={() => void run("pause", async () => { await api.pause(j.id); await refresh(); }, "Couldn't pause")} onResume={() => void run("resume", async () => { await api.resume(j.id); await refresh(); }, "Couldn't resume")} />
      ))}
      {status?.jobs.filter((j) => j.state === "error" && j.kind !== "activate").slice(0, 1).map((j) => (
        <p key={j.id} className="text-[11px] leading-relaxed text-destructive">{j.name}: {j.detail}</p>
      ))}

      <div className="space-y-2.5">
        <span className="block text-[13px] text-foreground">Get a model</span>
        <div className="grid grid-cols-3 gap-1.5">
          {PICKS.map((p) => (
            <button key={p.label} type="button" data-pick={p.label} aria-pressed={query === p.query} disabled={busy !== null} onClick={() => void pick(p)} className={cn("liquid relative flex flex-col items-start rounded-2xl px-3 py-2.5 text-left transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60", query === p.query && "ring-1 ring-primary/45")}>
              <span className={cn("block text-[12px]", query === p.query ? "text-primary" : "text-foreground")}>{p.label}</span>
              <span className="block pt-0.5 text-[9.5px] leading-snug text-muted-foreground">{p.hint}</span>
              {bestForPc === p.label && <span className="mt-1.5"><BestBadge /></span>}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) void search(query.trim());
          }}
          className="liquid relative flex items-center gap-2 rounded-full px-3.5 py-2"
        >
          <Search className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.6} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="or search any model by name" aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
          {busy === "search" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </form>

        {repos && repos.length === 0 && <p className="text-[11px] text-muted-foreground">Nothing found. Try a shorter name.</p>}
        {repos && repos.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {repos.slice(0, 6).map((r) => (
              <button key={r.repo} type="button" onClick={() => void run("repo", () => openRepo(r.repo), "Couldn't open it")} className={cn("liquid-hover relative rounded-full border px-2.5 py-1 text-[10.5px]", repo === r.repo ? "border-primary/45 text-primary" : "border-border-strong text-muted-foreground hover:text-foreground")}>
                {r.repo.split("/")[1]?.replace(/-GGUF$/i, "") ?? r.repo}
                <span className="pl-1 opacity-60">{r.repo.split("/")[0]}</span>
              </button>
            ))}
          </div>
        )}

        {repo && (
          <div data-model-builds className="liquid relative space-y-2 rounded-2xl px-3.5 py-3">
            <p className="truncate text-[12.5px] text-foreground">{repo.split("/")[1]?.replace(/-GGUF$/i, "") ?? repo}</p>
            {!builds ? (
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Checking what fits your PC…</p>
            ) : shown.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No size of this model runs on this PC. Try a smaller one.</p>
            ) : (
              <ul className="space-y-1.5">
                {shown.map((b) => {
                  const have = status?.models.some((m) => b.paths.some((p) => p.replace(/\.gguf$/i, "").endsWith(m.id)));
                  return (
                    <li key={b.label} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11.5px] text-foreground">
                          {gb(b.bytes)} <span className="font-mono text-[10px] text-muted-foreground">{b.label}</span>
                        </p>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className={cn("inline-block rounded-full border px-2 py-0.5 text-[9.5px]", FIT[b.fit].className)}>{FIT[b.fit].text}</span>
                          {b === best && <BestBadge>Best size</BestBadge>}
                        </span>
                      </div>
                      {have ? (
                        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground"><Check className="size-3" strokeWidth={2} /> on your PC</span>
                      ) : (
                        <button type="button" disabled={busy !== null || b.fit === "too-big" || active.some((j) => j.kind === "download")} onClick={() => void download(b)} className="liquid relative flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11.5px] text-primary disabled:opacity-40">
                          <Download className="size-3.5" strokeWidth={1.8} /> {busy === `dl-${b.label}` ? "Starting…" : "Download"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {builds && builds.length > 1 && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="liquid-hover relative rounded-full border border-border-strong px-2.5 py-1 text-[10.5px] text-muted-foreground hover:text-foreground">
                {showAll ? "Show only the best one" : "Other sizes"}
              </button>
            )}
          </div>
        )}
        {problem && <p role="alert" className="text-[11px] leading-relaxed text-destructive">{problem}</p>}
        <div className="liquid relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl px-3.5 py-3">
          <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-[10.5px] leading-relaxed text-muted-foreground">
            <Cpu className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.6} />
            {/* one text block: as direct flex children, the words and code pieces were laid out as separate columns */}
            <span className="min-w-0">
              Already have a <span className="font-mono">.gguf</span> file? Paste it into your models folder
              {agent?.modelsDir ? <> (<span className="break-all font-mono">{agent.modelsDir}</span>)</> : null} and it shows up here.
              Downloads come from Hugging Face, 2 to 8 GB.
            </span>
          </p>
          {api.openFolder && (
            <button type="button" disabled={busy !== null} onClick={() => void openFolder()} className="liquid-hover relative flex shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-3 py-1.5 text-[11px] text-foreground disabled:opacity-60">
              <FolderOpen className="size-3.5" strokeWidth={1.6} /> Open models folder
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function JobRow({ job, onPause, onResume }: { job: ModelJob; onPause: () => void; onResume: () => void }) {
  const percent = job.percent ?? (job.totalBytes ? Math.round((job.doneBytes / job.totalBytes) * 100) : undefined);
  const name = job.kind === "engine" ? "Local AI engine" : job.name.replace(/ \(from .*\)$/, "");
  return (
    <div data-job={job.kind} className="liquid relative space-y-2 rounded-2xl px-3.5 py-3 ring-1 ring-primary/30">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[12px] text-foreground">
          {job.state === "paused" ? "Paused: " : job.kind === "engine" ? "Installing: " : "Downloading: "}
          {name}
        </p>
        {job.canPause && (
          <button type="button" aria-label="Pause" onClick={onPause} className="liquid-hover relative grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:text-foreground"><Pause className="size-3.5" /></button>
        )}
        {job.canResume && (
          <button type="button" aria-label="Resume" onClick={onResume} className="liquid-hover relative grid size-7 shrink-0 place-items-center rounded-lg text-primary"><Play className="size-3.5" /></button>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary/60">
        <div className={cn("h-full rounded-full bg-primary transition-[width] duration-700", percent === undefined && "w-1/3 animate-pulse")} style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
        {[
          percent !== undefined ? `${percent}%` : null,
          job.totalBytes ? `${gb(job.doneBytes)} of ${gb(job.totalBytes)}` : null,
          job.bytesPerSec ? `${(job.bytesPerSec / 1024 / 1024).toFixed(1)} MB/s` : null,
          eta(job.etaSeconds),
        ].filter(Boolean).join(" · ") || job.detail}
      </p>
    </div>
  );
}
