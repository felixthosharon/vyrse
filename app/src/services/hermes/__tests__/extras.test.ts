import { describe, expect, it } from "vitest";
import { connectorLabel, fitFor, pickBuild, rankRepos, summarizeUsage, wouldHaveCost } from "../extras";
import type { ModelBuild } from "../../vyrse-api";

const build = (label: string, gbs: number, fit: ModelBuild["fit"]): ModelBuild => ({ label, paths: [`m-${label}.gguf`], bytes: gbs * 1024 ** 3, fit });

describe("choosing a model size", () => {
  it("prefers the usual quality when it fits the GPU", () => {
    const builds = [build("BF16", 16, "too-big"), build("Q8_0", 9, "slow"), build("Q6_K", 7, "gpu"), build("Q4_K_M", 5, "gpu"), build("Q2_K", 3, "gpu")];
    expect(pickBuild(builds)?.label).toBe("Q4_K_M");
  });

  it("takes the biggest that fits when the usual ones aren't offered", () => {
    expect(pickBuild([build("IQ3_XS", 3, "gpu"), build("IQ4_XS", 4, "gpu"), build("Q8_0", 9, "slow")])?.label).toBe("IQ4_XS");
  });

  it("still suggests a decent quality when nothing fits the GPU", () => {
    expect(pickBuild([build("Q8_0", 9, "slow"), build("Q4_K_M", 6, "slow"), build("IQ2_M", 4, "slow")])?.label).toBe("Q4_K_M");
    expect(pickBuild([build("Q8_0", 9, "slow"), build("IQ3_M", 5, "slow"), build("IQ2_M", 4, "slow")])?.label).toBe("IQ3_M");
    expect(pickBuild([build("IQ2_M", 4, "slow")])?.label).toBe("IQ2_M");
  });

  it("judges fit by the size of the card, not by what is free this minute", () => {
    const G = 1024 ** 3;
    expect(fitFor(5.2 * G, "needs-ram", 8 * G)).toBe("gpu");
    expect(fitFor(6.5 * G, "needs-ram", 8 * G)).toBe("slow");
    expect(fitFor(3 * G, "fits-gpu")).toBe("gpu");
    expect(fitFor(3 * G, "too-big", 24 * G)).toBe("too-big");
    expect(fitFor(3 * G, "unknown")).toBe("unknown");
  });

  it("lists plain conversions before remixes", () => {
    const ranked = rankRepos([
      { repo: "someone/Qwen-9B-Uncensored-Heretic-GGUF", downloads: 9_000_000 },
      { repo: "stranger/Qwen-9B-GGUF", downloads: 500 },
      { repo: "unsloth/Qwen-9B-GGUF", downloads: 2_000_000 },
    ]);
    expect(ranked.map((r) => r.repo.split("/")[0])).toEqual(["unsloth", "stranger", "someone"]);
  });

  it("offers nothing when nothing runs", () => {
    expect(pickBuild([build("Q4_K_M", 60, "too-big")])).toBeNull();
    expect(pickBuild([build("F16", 4, "gpu")])).toBeNull(); // unquantised builds are never suggested
  });
});

describe("usage and savings", () => {
  it("prices the same words at the reference rate", () => {
    expect(wouldHaveCost(1_000_000, 1_000_000)).toBeCloseTo(18);
    expect(wouldHaveCost(0, 0)).toBe(0);
  });

  it("counts local use as saved and online use as charged", () => {
    const s = summarizeUsage(
      [
        { model: "qwen", provider: "custom", input_tokens: 2_000_000, output_tokens: 100_000, api_calls: 40 },
        { model: "qwen", provider: "", input_tokens: 1_000_000, output_tokens: 0, api_calls: 10 },
        { model: "gpt-x", provider: "openai", input_tokens: 500_000, output_tokens: 50_000, estimated_cost: 2.5, api_calls: 5 },
        { model: "idle", provider: "custom" },
      ],
      30,
    );
    expect(s.models.map((m) => m.model)).toEqual(["qwen", "gpt-x"]);
    expect(s.models[0]).toMatchObject({ local: true, inputTokens: 3_000_000, messages: 50, paid: 0 });
    expect(s.saved).toBeCloseTo(3 * 3 + 0.1 * 15);
    expect(s.paid).toBeCloseTo(2.5);
    expect(s.tokens).toBe(3_650_000);
  });

  it("is empty without use", () => {
    expect(summarizeUsage([], 7)).toMatchObject({ tokens: 0, saved: 0, paid: 0, models: [] });
  });
});

describe("connection names", () => {
  it("reads like a product name", () => {
    expect(connectorLabel("microsoft-learn")).toBe("Microsoft Learn");
    expect(connectorLabel("notion")).toBe("Notion");
    expect(connectorLabel("hugging_face")).toBe("Hugging Face");
    expect(connectorLabel("clickup")).toBe("ClickUp");
  });
});
