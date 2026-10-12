import { describe, expect, it } from "vitest";
import { parseStyleCommand } from "../talk-styles";

describe("parseStyleCommand", () => {
  it("switches styles from natural phrasing", () => {
    expect(parseStyleCommand("switch to fam mode")).toEqual({ kind: "style", style: "fam" });
    expect(parseStyleCommand("Yo, go into vibe mode")).toEqual({ kind: "style", style: "vibe" });
    expect(parseStyleCommand("Vyse, hype mode on")).toEqual({ kind: "style", style: "hype" });
    expect(parseStyleCommand("talk professional")).toEqual({ kind: "style", style: "pro" });
    expect(parseStyleCommand("chill mode")).toEqual({ kind: "style", style: "chill" });
  });

  it("turns styles off back to normal", () => {
    expect(parseStyleCommand("vibe mode off")).toEqual({ kind: "style", style: "normal" });
    expect(parseStyleCommand("turn off fam mode")).toEqual({ kind: "style", style: "normal" });
    expect(parseStyleCommand("back to normal")).toEqual({ kind: "style", style: "normal" });
    expect(parseStyleCommand("talk normally")).toEqual({ kind: "style", style: "normal" });
  });

  it("routes the existing modes", () => {
    expect(parseStyleCommand("switch to gaming mode")).toEqual({ kind: "mode", mode: "gaming" });
    expect(parseStyleCommand("private mode on")).toEqual({ kind: "mode", mode: "private" });
  });

  it("leaves real requests alone", () => {
    expect(parseStyleCommand("what's the best mode for battery life on my laptop")).toBeNull();
    expect(parseStyleCommand("switch to dark mode")).toBeNull();
    expect(parseStyleCommand("open chrome")).toBeNull();
  });
});

describe("savage mode", () => {
  it("switches on from the usual phrasings and 'roast me'", () => {
    for (const t of ["savage mode", "switch to savage mode", "roast mode on", "roast me", "yo roast me alive", "cook me"])
      expect(parseStyleCommand(t), t).toEqual({ kind: "style", style: "savage" });
  });
  it("doesn't treat a real request as a switch", () => {
    expect(parseStyleCommand("roast me for losing my ranked game and then tell me the weather")).toBeNull();
  });
});
