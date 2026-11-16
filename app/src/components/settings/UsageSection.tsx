import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { UsageSummary } from "@/services";
import { REFERENCE_PRICE } from "@/services/hermes/extras";
import { useVyrse } from "@/lib/vyrse/store";
import { Section, Segmented } from "./controls";

type Period = "7" | "30" | "365";

const money = (n: number) => (n > 0 && n < 0.01 ? "under $0.01" : `$${n.toFixed(n >= 100 ? 0 : 2)}`);
const count = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} million` : n >= 10_000 ? `${Math.round(n / 1000)} thousand` : n.toLocaleString("en-US"));
/** Token counts as people read them: 9,412 · 163.1K · 1.25M. */
const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : n.toLocaleString("en-US");
/** Tokens are word pieces; about three quarters of a word each. */
const read = (u: UsageSummary) => u.models.reduce((n, m) => n + m.inputTokens, 0);
const written = (u: UsageSummary) => u.models.reduce((n, m) => n + m.outputTokens, 0);
const words = (tokens: number) => count(Math.round((tokens * 0.75) / 100) * 100 || Math.round(tokens * 0.75));

/**
 * Usage: how much VYRSE was used, what online models charged, and what answering on this PC saved compared with
 * paying a typical AI API for the same words.
 */
export function UsageSection({ open }: { open: boolean }) {
  const { agent } = useVyrse();
  const api = getVyrseApi().usage;
  const [period, setPeriod] = useState<Period>("30");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setData(await api.summary(Number(period)));
      setProblem(null);
    } catch (err) {
      setProblem(`Couldn't read your usage: ${(err as Error).message.replace(/^\/api\S*:\s*/, "")}`);
    }
  }, [api, period]);
  useEffect(() => {
    if (open && agent) void load();
  }, [open, agent !== null, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api) return null;
  const current = data?.days === Number(period) ? data : null;
  const label = period === "7" ? "the last 7 days" : period === "30" ? "the last 30 days" : "the last year";

  return (
    <Section title="Usage and savings">
      <Segmented value={period} onChange={setPeriod} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "365", label: "Year" }]} />
      {problem ? (
        <p className="text-[11px] text-destructive">{problem}</p>
      ) : !current ? (
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Adding it up…</p>
      ) : current.tokens === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/80 px-3 py-2.5 text-[11px] text-muted-foreground">No conversations in {label} yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div data-usage="saved" className="rounded-2xl border border-primary/30 bg-primary/[0.05] px-3.5 py-3">
              <p className="font-display text-[26px] leading-none text-primary">{money(current.saved)}</p>
              <p className="pt-1.5 text-[11px] leading-snug text-muted-foreground">saved by answering on your PC</p>
            </div>
            <div data-usage="paid" className="rounded-2xl border border-border/70 bg-surface/40 px-3.5 py-3">
              <p className="font-display text-[26px] leading-none text-foreground">{money(current.paid)}</p>
              <p className="pt-1.5 text-[11px] leading-snug text-muted-foreground">charged by online models</p>
            </div>
          </div>
          <div data-usage="tokens" className="rounded-2xl border border-border/70 bg-surface/40 px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-display text-[22px] leading-none text-foreground">{tokens(current.tokens)}</p>
              <p className="text-[11px] text-muted-foreground">tokens used</p>
            </div>
            <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-border/60" aria-hidden>
              {/* replies are tiny next to what's read; keep a visible sliver for them */}
              <div className="min-w-0 flex-1 bg-primary" />
              {written(current) > 0 && <div className="shrink-0 bg-foreground/50" style={{ width: `max(4px, ${(100 * written(current)) / Math.max(1, current.tokens)}%)` }} />}
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span><span className="mr-1 inline-block size-2 rounded-full bg-primary align-middle" />{tokens(read(current))} read</span>
              <span><span className="mr-1 inline-block size-2 rounded-full bg-foreground/50 align-middle" />{tokens(written(current))} written</span>
            </div>
          </div>
          <p className="text-[11.5px] leading-relaxed text-foreground/90">
            In {label} that's about {words(current.tokens)} words{current.messages ? ` across ${count(current.messages)} model calls` : ""}.
          </p>
          <ul className="space-y-1.5">
            {current.models.map((m) => (
              <li key={`${m.local}-${m.model}`} className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-surface/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] text-foreground">{m.model}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{m.local ? "on your PC" : "online"} · {tokens(m.inputTokens + m.outputTokens)} tokens ({tokens(m.inputTokens)} read, {tokens(m.outputTokens)} written)</p>
                </div>
                <p className="shrink-0 text-right text-[12px]">
                  {m.local ? <span className="text-primary">{money(m.saved)} saved</span> : <span className="text-foreground">{m.paid > 0 ? `${money(m.paid)} charged` : "no charge found"}</span>}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            “Saved” is an estimate: the same words at ${REFERENCE_PRICE.inPerMillion} per million tokens read and ${REFERENCE_PRICE.outPerMillion} per million written,
            a typical price for a paid AI API. “Charged” is Hermes' estimate from list prices; your provider's bill is the real number, and a subscription
            such as ChatGPT Plus shows no charge. Deleted conversations aren't counted.
          </p>
        </>
      )}
    </Section>
  );
}
