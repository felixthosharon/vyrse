import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceBackend } from "@/services";

// A fake microphone: which device ids can be opened is up to each test.
const micState = { available: new Set<string>(), opened: [] as string[], fake: null as null | { onLost: (() => void) | null } };
vi.mock("../mic", () => ({
  MicCapture: class {
    onLost: (() => void) | null = null;
    level = 0;
    private open = false;
    constructor() {
      micState.fake = this;
    }
    get running() {
      return this.open;
    }
    onFrame() {
      return () => {};
    }
    async start(deviceId?: string) {
      const id = deviceId && deviceId !== "default" ? deviceId : "auto";
      if (!micState.available.has(id)) throw Object.assign(new Error("gone"), { name: id === "auto" ? "NotFoundError" : "OverconstrainedError" });
      this.open = true;
      micState.opened.push(id);
    }
    async stop() {
      this.open = false;
    }
  },
  encodeWav: () => new Blob(),
  normalizeFrames: (f: Float32Array[]) => f,
  toInt16: () => new Int16Array(),
}));

const { VoiceController } = await import("../voice-controller");

class FakeBackend {
  async startWake() {
    return { available: true };
  }
  async stopWake() {}
  feedWake() {}
  onWake() {
    return () => {};
  }
  async warm() {}
  async transcribe() {
    return "";
  }
  speak() {
    return {} as ReturnType<VoiceBackend["speak"]>;
  }
  async micTest() {
    return { wakeMaxProb: 0, wakeThreshold: 0, wakeTriggered: false, savedTo: "" };
  }
}

const deviceListeners = new Set<() => void>();
const plugIn = async (...ids: string[]) => {
  ids.forEach((id) => micState.available.add(id));
  deviceListeners.forEach((l) => l());
  await vi.advanceTimersByTimeAsync(1000);
};

function make(deviceId = "auto") {
  const errors: string[] = [];
  const phases: string[] = [];
  const voice = new VoiceController(new FakeBackend() as unknown as VoiceBackend, {
    onPhase: (p) => phases.push(p),
    onTranscript: () => {},
    onError: (m) => errors.push(m),
  });
  voice.configure({ deviceId });
  return { voice, errors, phases };
}

describe("microphone recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    micState.available.clear();
    micState.opened = [];
    deviceListeners.clear();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: (_: string, l: () => void) => deviceListeners.add(l),
        removeEventListener: (_: string, l: () => void) => deviceListeners.delete(l),
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts by itself when a mic is connected after VYRSE started without one", async () => {
    const { voice, errors, phases } = make();
    await voice.enable();
    expect(errors).toEqual(["No microphone was found. VYRSE will start listening as soon as one is connected."]);
    expect(voice.current).toBe("off");
    await plugIn("auto");
    expect(micState.opened).toEqual(["auto"]);
    expect(phases.at(-1)).toBe("wake");
    expect(errors).toHaveLength(1);
    expect(deviceListeners.size).toBe(0); // nothing left watching once it's running
  });

  it("uses the default mic when the chosen one's id is gone, and moves back when it returns", async () => {
    micState.available.add("auto");
    const { voice, errors } = make("saved-mic-id");
    await voice.enable();
    expect(micState.opened).toEqual(["auto"]);
    expect(errors).toEqual([]);
    await plugIn("saved-mic-id");
    expect(micState.opened.at(-1)).toBe("saved-mic-id");
    expect(deviceListeners.size).toBe(0);
  });

  it("notices a mic that goes away mid-session and resumes when it's back", async () => {
    micState.available.add("auto");
    const { voice, errors, phases } = make();
    await voice.enable();
    micState.available.clear();
    micState.fake!.onLost!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual(["The microphone was disconnected. VYRSE will listen again when it's back."]);
    expect(phases.at(-1)).toBe("off");
    await plugIn("auto");
    expect(phases.at(-1)).toBe("wake");
    expect(micState.opened).toEqual(["auto", "auto"]);
    expect(errors).toHaveLength(1);
  });

  it("stops waiting when voice is switched off", async () => {
    const { voice } = make();
    await voice.enable();
    expect(deviceListeners.size).toBe(1);
    await voice.disable();
    expect(deviceListeners.size).toBe(0);
    micState.available.add("auto");
    await vi.advanceTimersByTimeAsync(1000);
    expect(micState.opened).toEqual([]);
  });

  it("tells the user when they press talk and there's still no mic", async () => {
    const { voice, errors } = make();
    await voice.enable();
    await voice.listenNow();
    expect(errors.at(-1)).toBe("No microphone is connected yet.");
  });
});
