import type { AiAccount, AiAccountsApi, SignInSession, SignInStatus } from "../vyrse-api";
import type { HermesGateway } from "./gateway";

/**
 * The online AI accounts VYRSE offers to connect, in the order shown. Each is either an API key that Hermes
 * keeps in its own `.env`, or a sign-in Hermes runs itself (the provider's device-code page in the browser).
 * VYRSE never stores a key or a token: it hands them to Hermes and only ever reads back "connected".
 */
interface Offer {
  id: string;
  label: string;
  blurb: string;
  /** API key: the variable Hermes reads it from, and where the user gets one */
  envKey?: string;
  keyUrl?: string;
  keyHint?: string;
  /** what a key from this provider starts with (catches a paste of the wrong thing) */
  keyPrefix?: string;
  /** sign-in: Hermes' OAuth provider id */
  signIn?: string;
  /** another Hermes sign-in that also counts as connected (set up in a terminal) */
  alsoSignedInAs?: string;
}

const OFFERS: Offer[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    blurb: "Use your ChatGPT Plus or Pro subscription. Sign in with your OpenAI account; no key needed.",
    signIn: "openai-codex",
  },
  {
    id: "claude",
    label: "Claude",
    blurb: "Anthropic's models, with an API key (billed per use). Anthropic doesn't let other apps use a Claude Pro or Max subscription.",
    envKey: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    keyPrefix: "sk-ant-",
    alsoSignedInAs: "anthropic",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Google's models, with an API key from AI Studio. There is a free tier.",
    envKey: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
  },
  {
    id: "openai",
    label: "OpenAI API",
    blurb: "GPT models with an OpenAI API key (billed per use, separate from a ChatGPT subscription).",
    envKey: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key for hundreds of models from every major lab, some of them free.",
    envKey: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-…",
    keyPrefix: "sk-or-",
  },
  {
    id: "xai",
    label: "xAI Grok",
    blurb: "Grok models, with an xAI API key.",
    envKey: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    keyHint: "xai-…",
    keyPrefix: "xai-",
  },
];

interface EnvRow {
  is_set?: boolean;
  redacted_value?: string | null;
}
interface OAuthRow {
  id: string;
  flow: string;
  status?: { logged_in?: boolean };
}

const json = (body: unknown) => JSON.stringify(body);

export class HermesProviders implements AiAccountsApi {
  constructor(private readonly gateway: HermesGateway) {}

  async list(): Promise<AiAccount[]> {
    const [env, oauth] = await Promise.all([
      this.gateway.rest<Record<string, EnvRow>>("/api/env"),
      this.gateway.rest<{ providers?: OAuthRow[] }>("/api/providers/oauth").catch(() => ({ providers: [] as OAuthRow[] })),
    ]);
    const signIns = new Map((oauth.providers ?? []).map((p) => [p.id, p]));
    const out: AiAccount[] = [];
    for (const o of OFFERS) {
      if (o.signIn) {
        const row = signIns.get(o.signIn);
        // Only offered when this Hermes can run the sign-in itself.
        if (!row || row.flow !== "device_code") continue;
        out.push({ id: o.id, label: o.label, blurb: o.blurb, kind: "signin", connected: Boolean(row.status?.logged_in) });
        continue;
      }
      const row = o.envKey ? env[o.envKey] : undefined;
      if (!row) continue; // this Hermes doesn't know the provider
      const viaSignIn = Boolean(o.alsoSignedInAs && signIns.get(o.alsoSignedInAs)?.status?.logged_in);
      out.push({
        id: o.id,
        label: o.label,
        blurb: o.blurb,
        kind: "key",
        connected: Boolean(row.is_set) || viaSignIn,
        keyUrl: o.keyUrl,
        keyHint: o.keyHint,
        keyPreview: row.is_set ? (row.redacted_value ?? undefined) : undefined,
        // signed in from a terminal: nothing here to remove
        managedElsewhere: !row.is_set && viaSignIn,
      });
    }
    return out;
  }

  /** Check the key with the provider, then hand it to Hermes. A key the provider rejects is not saved. */
  async saveKey(id: string, key: string): Promise<{ ok: boolean; message?: string }> {
    const offer = OFFERS.find((o) => o.id === id);
    const value = key.trim();
    if (!offer?.envKey) return { ok: false, message: "This account doesn't use a key." };
    if (!value) return { ok: false, message: "Paste your key first." };
    if (/\s/.test(value)) return { ok: false, message: "A key has no spaces or line breaks. Copy just the key." };
    if (offer.keyPrefix && !value.startsWith(offer.keyPrefix)) return { ok: false, message: `That doesn't look like a ${offer.label} key: they start with ${offer.keyPrefix}` };
    try {
      const check = await this.gateway.rest<{ ok: boolean; reachable: boolean; message?: string }>("/api/providers/validate", {
        method: "POST",
        body: json({ key: offer.envKey, value }),
      });
      if (!check.ok && check.reachable) return { ok: false, message: check.message || "That key was rejected. Check it and try again." };
    } catch {
      // The check couldn't run (offline, older Hermes): save anyway, the first message will tell.
    }
    try {
      await this.gateway.rest("/api/env", { method: "PUT", body: json({ key: offer.envKey, value, provider_setup: true }) });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: `Hermes couldn't save the key: ${(err as Error).message}` };
    }
  }

  async disconnect(id: string): Promise<void> {
    const offer = OFFERS.find((o) => o.id === id);
    if (!offer) return;
    if (offer.signIn) await this.gateway.rest(`/api/providers/oauth/${offer.signIn}`, { method: "DELETE" });
    else if (offer.envKey) await this.gateway.rest("/api/env", { method: "DELETE", body: json({ key: offer.envKey }) });
  }

  async startSignIn(id: string): Promise<SignInSession> {
    const offer = OFFERS.find((o) => o.id === id);
    if (!offer?.signIn) throw new Error("This account doesn't use a sign-in.");
    const res = await this.gateway.rest<{ session_id: string; user_code: string; verification_url: string; expires_in: number; poll_interval?: number }>(
      `/api/providers/oauth/${offer.signIn}/start`,
      { method: "POST", body: "{}" },
    );
    return {
      id,
      session: res.session_id,
      code: res.user_code,
      url: res.verification_url,
      expiresAt: Date.now() + res.expires_in * 1000,
      pollMs: Math.max(2, res.poll_interval ?? 3) * 1000,
    };
  }

  async pollSignIn(session: SignInSession): Promise<SignInStatus> {
    const offer = OFFERS.find((o) => o.id === session.id);
    if (!offer?.signIn) return { state: "failed", message: "Unknown account." };
    try {
      const res = await this.gateway.rest<{ status: string; error_message?: string | null }>(`/api/providers/oauth/${offer.signIn}/poll/${session.session}`);
      if (res.status === "approved") return { state: "done" };
      if (res.status === "pending") return Date.now() > session.expiresAt ? { state: "failed", message: "The code expired. Start again." } : { state: "waiting" };
      return { state: "failed", message: res.error_message || (res.status === "denied" ? "The sign-in was declined." : "The sign-in didn't finish.") };
    } catch (err) {
      return { state: "failed", message: (err as Error).message };
    }
  }

  async cancelSignIn(session: SignInSession): Promise<void> {
    await this.gateway.rest(`/api/providers/oauth/sessions/${session.session}`, { method: "DELETE" }).catch(() => undefined);
  }
}
