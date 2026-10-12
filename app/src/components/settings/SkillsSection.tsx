import { useMemo, useState } from "react";
import { ChevronDown, Loader2, Search, Trash2 } from "lucide-react";
import { useSkills } from "@/lib/vyrse/skills";
import { cn } from "@/lib/utils";
import { Markdown } from "../conversation/Markdown";
import { Section, Toggle } from "./controls";

const TRUST_STYLE: Record<string, string> = {
  builtin: "border-primary/40 text-primary",
  trusted: "border-primary/30 text-primary/90",
  community: "border-border-strong text-muted-foreground",
};

/** Hermes skills: what's installed (toggle, read, remove) and the Skills Hub (search, install). */
export function SkillsSection({ open }: { open: boolean }) {
  const skills = useSkills(open);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // Enabled skills first (the ones Hermes actually uses), then the switched-off ones.
    const list = (skills.installed ?? [])
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled));
    return showAll || q ? list : list.slice(0, 8);
  }, [skills.installed, filter, showAll]);

  if (!skills.available) return null;
  const enabledCount = skills.installed?.filter((s) => s.enabled).length ?? 0;

  const inspect = async (name: string) => {
    if (expanded === name) return setExpanded(null);
    setExpanded(name);
    if (preview?.name !== name) {
      try {
        setPreview({ name, text: await skills.content(name) });
      } catch {
        setPreview({ name, text: "_Couldn't read this skill._" });
      }
    }
  };

  return (
    <Section title="Skills">
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Skills are Hermes' own add-on know-how. {skills.installed ? `${enabledCount} of ${skills.installed.length} enabled.` : "Loading…"}
        {" "}Hermes can also install skills itself when a task needs one.
      </p>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter installed skills"
        className="w-full rounded-xl border border-border bg-background/50 px-3 py-2 text-[12px] text-foreground outline-none focus:border-primary/40"
      />

      <div className="space-y-1.5">
        {visible.map((skill) => (
          <div key={skill.name} className="cv-row rounded-xl border border-border/60 bg-surface/35 px-3 py-2">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <button type="button" onClick={() => void inspect(skill.name)} className="min-w-0 text-left">
                <span className="flex items-center gap-1.5">
                  <ChevronDown
                    className={cn("size-3 shrink-0 text-muted-foreground transition-transform", expanded === skill.name && "rotate-180")}
                  />
                  <span className="truncate text-[12px] text-foreground">{skill.name}</span>
                  {skill.category && <span className="shrink-0 font-mono text-[8.5px] uppercase text-muted-foreground">{skill.category}</span>}
                </span>
                <span className="mt-0.5 line-clamp-2 block pl-[18px] text-[10px] leading-relaxed text-muted-foreground">{skill.description}</span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {skill.provenance && skill.provenance !== "bundled" && (
                  <button
                    type="button"
                    aria-label={`Remove ${skill.name}`}
                    onClick={() => void skills.uninstall(skill.name)}
                    className="grid size-7 place-items-center rounded-full text-muted-foreground hover:text-destructive"
                  >
                    {skills.busy === skill.name ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </button>
                )}
                <Toggle checked={skill.enabled} onChange={(v) => skills.toggle(skill.name, v)} label={`${skill.name} enabled`} />
              </div>
            </div>
            {expanded === skill.name && (
              <div className="field-scroll mt-2 max-h-64 overflow-auto rounded-lg bg-background/50 p-3 text-[12px]">
                {preview?.name === skill.name ? <Markdown text={preview.text} /> : <p className="text-muted-foreground">Loading…</p>}
              </div>
            )}
          </div>
        ))}
        {!filter && (skills.installed?.length ?? 0) > 8 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="px-1 text-[10.5px] text-muted-foreground hover:text-foreground">
            {showAll ? "Show fewer" : `Show all ${skills.installed!.length}`}
          </button>
        )}
      </div>

      <div className="pt-2">
        <p className="mb-2 text-[12.5px] text-foreground">Find new skills</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void skills.search(query);
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. weather, spreadsheets, git"
            className="min-w-0 flex-1 rounded-xl border border-border bg-background/50 px-3 py-2 text-[12px] text-foreground outline-none focus:border-primary/40"
          />
          <button
            type="submit"
            aria-label="Search the Skills Hub"
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-border-strong text-muted-foreground hover:text-foreground"
          >
            {skills.busy === "search" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          </button>
        </form>
        {skills.results && (
          <div className="mt-2 space-y-1.5">
            {skills.results.length === 0 && <p className="text-[11px] text-muted-foreground">No skills found.</p>}
            {skills.results.map((hit) => (
              <div key={hit.identifier} className="cv-row rounded-xl border border-border/60 bg-surface/35 px-3 py-2">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] text-foreground">{hit.name}</span>
                      <span className={cn("shrink-0 rounded-full border px-1.5 font-mono text-[8.5px] uppercase", TRUST_STYLE[hit.trust] ?? TRUST_STYLE["community"])}>
                        {hit.trust}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{hit.description}</p>
                    <p className="font-mono text-[9px] text-muted-foreground/70">{hit.source} · {hit.identifier}</p>
                  </div>
                  <button
                    type="button"
                    disabled={hit.installed || skills.busy !== null}
                    onClick={() => void skills.install(hit)}
                    className="shrink-0 rounded-full border border-primary/35 px-3 py-1 text-[11px] text-primary transition-opacity disabled:opacity-40"
                  >
                    {skills.busy === hit.identifier ? "Installing…" : hit.installed ? "Installed" : "Install"}
                  </button>
                </div>
              </div>
            ))}
            <p className="text-[9.5px] leading-relaxed text-muted-foreground">
              Hermes scans every downloaded skill before installing it. Community skills come from third parties — install the ones you trust.
            </p>
          </div>
        )}
      </div>

      {skills.error && <p className="text-[11px] text-destructive">{skills.error}</p>}
    </Section>
  );
}
