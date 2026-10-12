import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { getDesktopBridge, type EchoSkillStatus } from "@/services/hermes/bridge";
import { copyText } from "@/lib/clipboard";
import { Toggle } from "./controls";

const button =
  "rounded-full border border-border px-3 py-1.5 text-[11.5px] text-foreground transition-colors hover:border-border-strong hover:bg-secondary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const input =
  "w-full rounded-lg border border-border bg-background/50 px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:border-border-strong focus:outline-none";

const STATE_TEXT: Record<EchoSkillStatus["state"], string> = {
  off: "Off",
  starting: "Starting the tunnel…",
  running: "Listening for “Alexa, ask my pc …”",
  error: "Not running",
};

function CopyButton({ label, text }: { label: string; text: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  return (
    <button
      type="button"
      disabled={!text}
      className={`${button} inline-flex items-center gap-1.5`}
      onClick={async () => {
        setResult((await copyText(text)) ? "copied" : "failed");
        window.setTimeout(() => setResult(null), 1600);
      }}
    >
      {result === "copied" ? <Check className="size-3" /> : <Copy className="size-3" />}
      {result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : label}
    </button>
  );
}

/**
 * Echo → VYRSE: a custom Alexa skill ("Alexa, ask my pc …") whose endpoint is VYRSE's verified gateway,
 * reached through the user's ngrok domain. Setup needs the user's own (free) Amazon developer and ngrok
 * accounts, so this card walks through it.
 */
export function EchoSkillCard() {
  const desktop = getDesktopBridge()?.desktop;
  const [status, setStatus] = useState<EchoSkillStatus | null>(null);
  const [token, setToken] = useState("");
  const [domain, setDomain] = useState("");
  const [skillId, setSkillId] = useState("");
  const [saving, setSaving] = useState(false);
  // Fetched up front, so the click copies straight away (no await between the click and the copy).
  const [model, setModel] = useState("");

  useEffect(() => {
    if (!desktop?.echoSkill) return;
    void desktop.echoSkill("status").then((s) => {
      const st = s as EchoSkillStatus;
      setStatus(st);
      setDomain(st.domain);
      setSkillId(st.skillId);
    });
    void desktop.echoSkill("model").then((m) => setModel(typeof m === "string" ? m : ""));
    return desktop.onEchoSkillStatus?.(setStatus);
  }, [desktop]);

  // Saved values show up in empty fields (also when they arrive after the panel opened).
  useEffect(() => {
    if (status?.domain) setDomain((d) => d || status.domain);
    if (status?.skillId) setSkillId((v) => v || status.skillId);
  }, [status?.domain, status?.skillId]);

  if (!desktop?.echoSkill) return null;
  const call = async (op: string, args?: Record<string, unknown>) => {
    setSaving(true);
    try {
      setStatus((await desktop.echoSkill!(op, args)) as EchoSkillStatus);
    } finally {
      setSaving(false);
    }
  };

  const ready = Boolean(status?.hasToken && status.domain && status.skillId);
  return (
    <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-[12.5px] text-foreground">Echo → VYRSE</span>
          <span className="block pt-0.5 text-[10px] text-muted-foreground">
            {status?.error ?? STATE_TEXT[status?.state ?? "off"]}
            {status?.linked ? " · linked to your Amazon account" : ""}
          </span>
        </div>
        <Toggle
          checked={Boolean(status?.enabled)}
          onChange={(on) => void call(on ? "enable" : "disable")}
          label="Answer “Alexa, ask my pc …”"
        />
      </div>
      <p className="pt-1 pb-2 text-[10px] leading-relaxed text-muted-foreground">
        Say “Alexa, ask my pc what’s my CPU at”. Only requests signed by Amazon, for your skill and your Amazon
        account, get through; VYRSE’s own controls are never exposed. Takes ~10 minutes to set up once.
      </p>

      <ol className="list-decimal space-y-2.5 pl-4 text-[11px] leading-relaxed text-muted-foreground">
        <li>
          Free <span className="text-foreground">ngrok</span> account (ngrok.com): copy your authtoken, and claim your
          free static domain (Domains page).
          <div className="mt-1.5 space-y-1.5">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={status?.hasToken ? "Authtoken saved (enter a new one to replace)" : "ngrok authtoken"}
              aria-label="ngrok authtoken"
              className={input}
            />
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="your-name.ngrok-free.app" aria-label="ngrok domain" className={input} />
          </div>
        </li>
        <li>
          In the Alexa developer console (developer.amazon.com/alexa/console/ask): <em>Create skill</em> → name
          “Vyse”, language <span className="text-foreground">English (IN)</span>, <em>Custom</em> model,{" "}
          <em>Provision your own</em> backend, <em>Start from scratch</em>.
        </li>
        <li>
          <em>Interaction Model → JSON Editor</em>: paste this, Save, then <em>Build skill</em>.
          <div className="mt-1.5">
            <CopyButton label="Copy skill model" text={model} />
          </div>
        </li>
        <li>
          <em>Endpoint</em>: choose HTTPS, paste this URL, and pick “My development endpoint is a sub-domain of a domain
          that has a wildcard certificate”. Save.
          <div className="mt-1.5 flex items-center gap-2">
            {status?.endpoint ? (
              <CopyButton label="Copy endpoint URL" text={status.endpoint} />
            ) : (
              <span className="text-[10px]">Save your ngrok domain first.</span>
            )}
          </div>
        </li>
        <li>
          Copy the skill ID (Alexa Skills list → “Copy Skill ID”) here, then on the <em>Test</em> tab set testing to{" "}
          <em>Development</em>.
          <div className="mt-1.5">
            <input value={skillId} onChange={(e) => setSkillId(e.target.value)} placeholder="amzn1.ask.skill.…" aria-label="Alexa skill ID" className={input} />
          </div>
        </li>
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={button}
          disabled={saving}
          onClick={() => {
            void call("set", { authtoken: token, domain, skillId }).then(() => setToken(""));
          }}
        >
          Save
        </button>
        {ready && !status?.enabled && (
          <button type="button" className={button} disabled={saving} onClick={() => void call("enable")}>
            Turn on
          </button>
        )}
        {status?.linked && (
          <button type="button" className={button} disabled={saving} onClick={() => void call("unlink")}>
            Unlink Amazon account
          </button>
        )}
        {(status?.hasToken || status?.skillId) && (
          <button type="button" className={button} disabled={saving} onClick={() => void call("forget")}>
            Forget setup
          </button>
        )}
      </div>
    </div>
  );
}
