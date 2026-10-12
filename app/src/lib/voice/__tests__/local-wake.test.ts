import { describe, expect, it } from "vitest";
import type { VoiceBackend } from "@/services";
import { withLocalWake } from "../local-wake";

class FakeBackend {
  calls: string[] = [];
  async startWake() { return { available: true }; }
  async stopWake() {}
  feedWake() {}
  onWake() { return () => {}; }
  async warm() { this.calls.push("warm"); }
  async transcribe() { this.calls.push("transcribe"); return "hello"; }
  speak() { this.calls.push("speak"); return {} as ReturnType<VoiceBackend["speak"]>; }
  async micTest() { return { wakeMaxProb: 0, wakeThreshold: 0, wakeTriggered: false, savedTo: "" }; }
}

describe("withLocalWake (phone)", () => {
  it("keeps the backend's class methods: speech recognition and speech still reach the PC", async () => {
    const backend = new FakeBackend();
    const phone = withLocalWake(backend as unknown as VoiceBackend);
    expect(await phone.transcribe(new Blob())).toBe("hello");
    await phone.warm(true);
    phone.speak();
    expect(backend.calls).toEqual(["transcribe", "warm", "speak"]);
  });
});
