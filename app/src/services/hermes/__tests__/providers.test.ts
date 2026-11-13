import { describe, expect, it } from "vitest";
import { HermesProviders } from "../providers";
import type { HermesGateway } from "../gateway";

type Call = { path: string; method: string; body?: unknown };

/** A stand-in for Hermes' REST API: fixed answers per path, and a record of what was sent. */
function fakeGateway(answers: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const gateway = {
    async rest(path: string, init: RequestInit = {}) {
      const call: Call = { path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const answer = answers[`${call.method} ${path}`];
      if (answer === undefined) throw new Error(`${path}: not found`);
      return typeof answer === "function" ? (answer as (c: Call) => unknown)(call) : answer;
    },
  } as unknown as HermesGateway;
  return { gateway, calls };
}

const ENV = {
  ANTHROPIC_API_KEY: { is_set: false },
  OPENAI_API_KEY: { is_set: true, redacted_value: "sk-…abcd" },
  GEMINI_API_KEY: { is_set: false },
};
const OAUTH = { providers: [{ id: "openai-codex", flow: "device_code", status: { logged_in: false } }, { id: "anthropic", flow: "external", status: { logged_in: true } }] };

describe("AI accounts", () => {
  it("lists only what this Hermes supports, with who is connected", async () => {
    const { gateway } = fakeGateway({ "GET /api/env": ENV, "GET /api/providers/oauth": OAUTH });
    const list = await new HermesProviders(gateway).list();
    expect(list.map((a) => a.id)).toEqual(["chatgpt", "claude", "gemini", "openai"]); // no OpenRouter / xAI rows in this env
    expect(list.find((a) => a.id === "chatgpt")).toMatchObject({ kind: "signin", connected: false });
    expect(list.find((a) => a.id === "openai")).toMatchObject({ kind: "key", connected: true, keyPreview: "sk-…abcd" });
    // signed in to Anthropic from a terminal: shown as connected, but not ours to remove
    expect(list.find((a) => a.id === "claude")).toMatchObject({ connected: true, managedElsewhere: true });
  });

  it("still lists key accounts when the sign-in list is unavailable", async () => {
    const { gateway } = fakeGateway({ "GET /api/env": ENV });
    const list = await new HermesProviders(gateway).list();
    expect(list.map((a) => a.id)).toEqual(["claude", "gemini", "openai"]);
  });

  it("never saves a key the provider rejects", async () => {
    const { gateway, calls } = fakeGateway({ "POST /api/providers/validate": { ok: false, reachable: true, message: "That API key was rejected." } });
    const res = await new HermesProviders(gateway).saveKey("openai", "sk-wrong");
    expect(res).toEqual({ ok: false, message: "That API key was rejected." });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("catches a paste of the wrong thing before anything is sent", async () => {
    const { gateway, calls } = fakeGateway({});
    const providers = new HermesProviders(gateway);
    expect((await providers.saveKey("claude", "sk-proj-123")).message).toMatch(/start with sk-ant-/);
    expect((await providers.saveKey("gemini", "two words")).message).toMatch(/no spaces/);
    expect((await providers.saveKey("gemini", "   ")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("saves a good key under the name Hermes reads it from", async () => {
    const { gateway, calls } = fakeGateway({ "POST /api/providers/validate": { ok: true, reachable: true }, "PUT /api/env": { ok: true } });
    expect(await new HermesProviders(gateway).saveKey("claude", "  sk-ant-api03-xyz  ")).toEqual({ ok: true });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/api/env", body: { key: "ANTHROPIC_API_KEY", value: "sk-ant-api03-xyz" } });
  });

  it("saves when the check itself can't run (offline)", async () => {
    const { gateway, calls } = fakeGateway({ "POST /api/providers/validate": { ok: false, reachable: false }, "PUT /api/env": { ok: true } });
    expect((await new HermesProviders(gateway).saveKey("gemini", "AIzaKey")).ok).toBe(true);
    expect(calls.at(-1)?.method).toBe("PUT");
  });

  it("walks a sign-in from code to done", async () => {
    const { gateway } = fakeGateway({
      "POST /api/providers/oauth/openai-codex/start": { session_id: "s1", user_code: "ABCD-12345", verification_url: "https://auth.openai.com/codex/device", expires_in: 900, poll_interval: 5 },
      "GET /api/providers/oauth/openai-codex/poll/s1": { status: "approved" },
    });
    const providers = new HermesProviders(gateway);
    const session = await providers.startSignIn("chatgpt");
    expect(session).toMatchObject({ code: "ABCD-12345", url: "https://auth.openai.com/codex/device", pollMs: 5000 });
    expect(await providers.pollSignIn(session)).toEqual({ state: "done" });
  });

  it("reports a declined or expired sign-in", async () => {
    const { gateway } = fakeGateway({ "GET /api/providers/oauth/openai-codex/poll/s1": { status: "denied" }, "GET /api/providers/oauth/openai-codex/poll/s2": { status: "pending" } });
    const providers = new HermesProviders(gateway);
    const base = { id: "chatgpt", code: "X", url: "", pollMs: 1000 };
    expect(await providers.pollSignIn({ ...base, session: "s1", expiresAt: Date.now() + 1000 })).toMatchObject({ state: "failed" });
    expect(await providers.pollSignIn({ ...base, session: "s2", expiresAt: Date.now() - 1 })).toMatchObject({ state: "failed", message: expect.stringMatching(/expired/) });
    expect(await providers.pollSignIn({ ...base, session: "s2", expiresAt: Date.now() + 60_000 })).toEqual({ state: "waiting" });
  });

  it("disconnects a key by removing it, and a sign-in by signing out", async () => {
    const { gateway, calls } = fakeGateway({ "DELETE /api/env": { ok: true }, "DELETE /api/providers/oauth/openai-codex": { ok: true } });
    const providers = new HermesProviders(gateway);
    await providers.disconnect("gemini");
    await providers.disconnect("chatgpt");
    expect(calls).toEqual([
      { path: "/api/env", method: "DELETE", body: { key: "GEMINI_API_KEY" } },
      { path: "/api/providers/oauth/openai-codex", method: "DELETE", body: undefined },
    ]);
  });
});
