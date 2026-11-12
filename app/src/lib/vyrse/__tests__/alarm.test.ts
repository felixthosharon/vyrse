import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAlarm, isDecline } from "../alarm";

describe("isAlarm", () => {
  it("knows an alarm from a reminder by its name", () => {
    expect(isAlarm("Alarm · 7:00 AM")).toBe(true);
    expect(isAlarm("Alarm")).toBe(true);
    expect(isAlarm("Call mom")).toBe(false);
    expect(isAlarm("Alarming news digest")).toBe(false);
  });
});

describe("isDecline", () => {
  it("hears a no", () => {
    for (const no of [null, "", "No", "cancel", "Not now", "deny"]) expect(isDecline(no)).toBe(true);
    for (const yes of ["Yes", "Sort it", "Nothing else", "Notify me"]) expect(isDecline(yes)).toBe(false);
  });
});

// A "\b" that reached a file as a real backspace made the alarm pattern match nothing: alarms never rang.
describe("source files", () => {
  it("contain no stray control characters", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|tsx|css)$/.test(name) && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(readFileSync(path, "utf8"))) bad.push(path);
      }
    };
    walk(join(__dirname, "..", "..", ".."));
    expect(bad).toEqual([]);
  });
});
