import type { Artifact, Conversation, Message } from "./types";

/**
 * Mock intelligence layer.
 *
 * `respond()` is the single seam where a real AI service gets connected:
 * return an async iterable of text chunks plus an optional artifact and the
 * rest of the app keeps working unchanged.
 */

export interface ResponsePlan {
  /** how long Vyrse appears to deliberate before speaking */
  thinkMs: number;
  /** whether the reply involves substantial work */
  working: boolean;
  text: string;
  artifact?: Artifact;
  meta: string;
}

const CANNED: { match: RegExp; plan: () => ResponsePlan }[] = [
  {
    match: /latency|performance|benchmark|slow|profile/i,
    plan: () => ({
      thinkMs: 900,
      working: true,
      meta: "traced 4 services · 2.1s",
      text: `## Where the time actually goes

I traced the request path end to end. The bottleneck is **not** the database — it's the serialization step between the gateway and the worker pool.

- Gateway hop is stable at ~18ms
- Worker queue wait dominates under load
- Response encoding grows non-linearly past 400 items

\`\`\`ts
// the offending path
const payload = items.map((i) => deepClone(serialize(i)));
\`\`\`

Dropping the redundant clone should recover most of the tail latency.`,
      artifact: {
        kind: "series",
        title: "p95 latency by stage",
        caption: "milliseconds · last 24h sample",
        series: [
          { label: "gateway", value: 18 },
          { label: "auth", value: 24 },
          { label: "queue", value: 186 },
          { label: "compute", value: 91 },
          { label: "encode", value: 143 },
          { label: "egress", value: 22 },
        ],
      },
    }),
  },
  {
    match: /compare|versus| vs |difference between/i,
    plan: () => ({
      thinkMs: 700,
      working: false,
      meta: "structured comparison",
      text: `Here's the shape of the tradeoff, reduced to what actually changes your decision.

The short version: pick the first if you care about predictable cost, the second if you care about peak throughput.`,
      artifact: {
        kind: "compare",
        title: "Option analysis",
        compare: {
          columns: ["", "Approach A", "Approach B"],
          rows: [
            ["Setup cost", "Low", "Moderate"],
            ["Throughput", "~4k rps", "~11k rps"],
            ["Failure mode", "Graceful", "Cliff-edge"],
            ["Operational load", "Minimal", "Ongoing"],
          ],
        },
      },
    }),
  },
  {
    match: /plan|schedule|roadmap|timeline|steps/i,
    plan: () => ({
      thinkMs: 800,
      working: true,
      meta: "sequenced 4 phases",
      text: `I sequenced this so each phase produces something usable on its own — no phase depends on a future phase to have value.

Start with the narrowest slice that proves the idea. Everything after that is refinement.`,
      artifact: {
        kind: "timeline",
        title: "Suggested sequence",
        timeline: [
          { at: "Phase 1", label: "Narrow slice", detail: "One path, working end to end" },
          { at: "Phase 2", label: "Harden", detail: "Failure states, retries, observability" },
          { at: "Phase 3", label: "Widen", detail: "Second and third path reuse the core" },
          { at: "Phase 4", label: "Polish", detail: "Latency, ergonomics, defaults" },
        ],
      },
    }),
  },
  {
    match: /architecture|design|structure|flow|pipeline/i,
    plan: () => ({
      thinkMs: 1000,
      working: true,
      meta: "resolved 6 nodes",
      text: `### Proposed structure

Keep the boundaries thin and the middle replaceable. Each stage should be understandable without reading the one before it.

The important constraint: state lives in exactly one place, and everything else derives from it.`,
      artifact: {
        kind: "flow",
        title: "Signal path",
        flow: [
          { id: "in", label: "Intent", note: "voice or text" },
          { id: "res", label: "Resolve", note: "context assembly" },
          { id: "exec", label: "Execute", note: "tools and reasoning" },
          { id: "out", label: "Present", note: "stream + artifact" },
        ],
      },
    }),
  },
  {
    match: /error|bug|crash|fail|debug|exception/i,
    plan: () => ({
      thinkMs: 850,
      working: false,
      meta: "narrowed to 1 cause",
      text: `The message is misleading — the crash surfaces at the read, but the corruption happens at the write.

1. The writer assumes the buffer is owned
2. The buffer is actually pooled and recycled
3. The next read sees a partially overwritten header

\`\`\`cpp
// take a copy before handing it off
auto owned = std::vector<std::byte>(view.begin(), view.end());
\`\`\`

Once ownership is explicit the symptom disappears entirely.`,
    }),
  },
];

const FALLBACKS: string[] = [
  `I'm here. Give me something concrete and I'll take it apart — a problem, a decision, a piece of code, or a half-formed idea you want pressure-tested.

You can speak instead of typing; I react to your voice as you talk.`,
  `Noted. Here's my read on it:

The core question is narrower than it looks. Most of what surrounds it is preference, not constraint. If you strip out the preferences, one option is clearly better on the two axes that actually matter to you.

Tell me which axis you weight higher and I'll commit to a recommendation.`,
  `### Summary

I looked at this from three angles and they converge on the same answer.

- The obvious approach works, but only up to about ten times your current scale
- The alternative is more work now and less work forever
- The hybrid is the worst of both — I'd skip it

If you want, I can lay out the migration path for the second option.`,
];

let fbIndex = 0;

export function planResponse(prompt: string): ResponsePlan {
  for (const c of CANNED) if (c.match.test(prompt)) return c.plan();
  const text = FALLBACKS[fbIndex % FALLBACKS.length]!;
  fbIndex++;
  return { thinkMs: 600, working: false, text, meta: "response" };
}

/** Chunk a response into speech-paced tokens. */
export function* tokenize(text: string): Generator<string> {
  const parts = text.match(/\s*\S+/g) ?? [];
  for (const p of parts) yield p;
}

export function titleFor(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (clean.length <= 42) return clean || "New conversation";
  return clean.slice(0, 40).replace(/\s\S*$/, "") + "…";
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptyConversation(): Conversation {
  return { id: newId(), title: "New conversation", updatedAt: Date.now(), messages: [] };
}

export function makeMessage(role: Message["role"], text: string): Message {
  return { id: newId(), role, text, createdAt: Date.now() };
}
