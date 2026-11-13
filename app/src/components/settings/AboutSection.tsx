import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { getDesktopBridge, type AppInfo } from "@/services/hermes/bridge";
import { useVyrse } from "@/lib/vyrse/store";
import { IS_PHONE } from "@/services/phone";
import { Row, Section, SwitchRow } from "./controls";

const REPO = "https://github.com/felixthosharon/vyrse";
const SEEN_KEY = "vyrse.update.seen";

/** Once after start (when allowed): tell the user, one time per release, that a newer VYRSE is out. */
export function useUpdateNotice(): void {
  const { settings, notify } = useVyrse();
  const allowed = settings.updateCheck !== false;
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!allowed || !desktop?.appInfo) return;
    const t = window.setTimeout(async () => {
      const info = await desktop.appInfo!(true).catch(() => null);
      if (!info?.newer || !info.latest) return;
      try {
        if (localStorage.getItem(SEEN_KEY) === info.latest) return;
        localStorage.setItem(SEEN_KEY, info.latest);
      } catch {
        // no storage: the notice may repeat next start
      }
      notify(`VYRSE ${info.latest} is out. Settings → About has the download.`);
    }, 25_000);
    return () => window.clearTimeout(t);
  }, [allowed, notify]);
}

/** About: which version this is, whether a newer one exists, and where the project lives. */
export function AboutSection({ open }: { open: boolean }) {
  const { settings, setSettings, link } = useVyrse();
  const desktop = getDesktopBridge()?.desktop;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open && !info) void desktop?.appInfo?.().then((i) => i && setInfo(i));
  }, [open, info, desktop]);

  const check = async () => {
    if (!desktop?.appInfo || checking) return;
    setChecking(true);
    const next = await desktop.appInfo(true).catch(() => null);
    if (next) setInfo(next);
    setChecking(false);
  };

  const status = !info
    ? ""
    : info.error
      ? `Couldn't check: ${info.error}.`
      : info.latest === undefined
        ? ""
        : info.newer
          ? `Version ${info.latest} is out.`
          : "You have the newest version.";

  return (
    <Section title="About">
      <Row label="VYRSE" hint={info ? `version ${info.version}` : IS_PHONE ? "phone app" : undefined}>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          A voice-first AI assistant that runs on your own PC. Free and open source (MIT).
          {link.hermesVersion ? ` Running on Hermes Agent ${link.hermesVersion}.` : ""}
        </p>
      </Row>
      {desktop?.appInfo && (
        <>
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-surface/40 px-3 py-2.5">
            <span data-update-status className="min-w-0 text-[11.5px] text-foreground">{status || "See if a newer VYRSE is out."}</span>
            {info?.newer ? (
              <a href={info.releasesUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-full bg-primary px-3.5 py-1.5 text-[11.5px] text-primary-foreground">
                Download
              </a>
            ) : (
              <button type="button" onClick={() => void check()} disabled={checking} className="liquid-hover relative flex shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60">
                {checking && <Loader2 className="size-3 animate-spin" />}
                Check for updates
              </button>
            )}
          </div>
          <SwitchRow
            label="Tell me about new versions"
            hint="asks GitHub for the latest release when VYRSE starts · nothing about you is sent"
            checked={settings.updateCheck !== false}
            onChange={(v) => setSettings({ updateCheck: v })}
          />
        </>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1 text-[11.5px]">
        {[
          ["Source code", REPO],
          ["Report a problem", `${REPO}/issues`],
          ["What's new", `${REPO}/releases`],
        ].map(([label, href]) => (
          <a key={href} href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            {label} <ExternalLink className="size-3" />
          </a>
        ))}
      </div>
    </Section>
  );
}
