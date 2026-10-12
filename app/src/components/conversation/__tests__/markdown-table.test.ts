import { describe, expect, it } from "vitest";
import { unflattenTables } from "../Markdown";

describe("tables a small model wrote on one line", () => {
  it("splits the rows back out", () => {
    const flat =
      "| Feature | RTX 3070 | RTX 4060 | |---------|----------|----------| | **VRAM** | 8 GB GDDR6 | 8 GB GDDR6 | | Power | ~220W | ~115W |";
    expect(unflattenTables(flat).split("\n")).toEqual([
      "| Feature | RTX 3070 | RTX 4060 |",
      "|---------|----------|----------|",
      "| **VRAM** | 8 GB GDDR6 | 8 GB GDDR6 |",
      "| Power | ~220W | ~115W |",
    ]);
  });

  it("moves lead-in text off the table", () => {
    expect(unflattenTables("Here you go: | a | b | | --- | --- | | 1 | 2 |").split("\n")).toEqual([
      "Here you go:",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ]);
  });

  it("leaves proper tables, plain text and code alone", () => {
    const proper = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(unflattenTables(proper)).toBe(proper);
    expect(unflattenTables("no pipes here")).toBe("no pipes here");
    const code = "```\n| a | b | | --- | --- |\n```";
    expect(unflattenTables(code)).toBe(code);
  });
});
