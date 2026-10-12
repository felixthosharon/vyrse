import { describe, expect, it } from "vitest";
import { handOffLine, SpeechFilter, SpokenBrief, speakableReply } from "../speech-text";
import { Endpointer, type EndpointEvent } from "../vad";
import { isEcho, isNoise, isStopWord, stripWakeEcho } from "../voice-controller";

const tone = (amp: number) => {
  const f = new Float32Array(1600);
  for (let i = 0; i < f.length; i++) f[i] = amp * Math.sin((2 * Math.PI * 220 * i) / 16000);
  return f;
};
const quiet = () => tone(0.001);
const loud = () => tone(0.2);

describe("Endpointer", () => {
  const run = (frames: Float32Array[]) => {
    const e = new Endpointer(undefined, -60);
    return frames.map((f) => e.push(f)).filter((ev): ev is Exclude<EndpointEvent, "none"> => ev !== "none");
  };

  it("detects speech then ends after trailing silence", () => {
    const events = run([quiet(), quiet(), loud(), loud(), loud(), loud(), ...Array.from({ length: 9 }, quiet)]);
    expect(events).toEqual(["speech-start", "speech-end"]);
  });

  it("ignores a single click", () => {
    expect(run([quiet(), loud(), quiet(), quiet()])).toEqual([]);
  });

  it("gives up when nobody speaks", () => {
    expect(run(Array.from({ length: 61 }, quiet))).toContain("no-speech");
  });
});

describe("SpeechFilter", () => {
  const speak = (...deltas: string[]) => {
    const f = new SpeechFilter();
    return (deltas.map((d) => f.push(d)).join("") + f.flush()).replace(/\s+/g, " ").trim();
  };

  it("speaks prose and strips markdown", () => {
    expect(speak("Here is **the** answer.\n")).toBe("Here is the answer.");
    expect(speak("See [the docs](https://x.y) for more\n")).toBe("See the docs for more.");
  });

  it("never speaks code blocks or tables", () => {
    const out = speak("Run this:\n", "```bash\nrm -rf /tmp/x\n```\n", "| a | b |\n|---|---|\n", "Done.\n");
    expect(out).toBe("Run this: Done.");
  });

  it("reads bullet lists as sentences", () => {
    expect(speak("- first item\n- second item\n")).toBe("first item. second item.");
  });
});

describe("SpokenBrief", () => {
  const speak = (...parts: string[]) => {
    const b = new SpokenBrief();
    return (parts.map((p) => b.push(p)).join("") + b.flush()).replace(/\s+/g, " ").trim();
  };

  it("speaks short replies in full", () => {
    expect(speak("Sure. ", "It's 144.")).toBe("Sure. It's 144.");
  });

  it("speaks the first sentences of a long reply and points to the screen", () => {
    const long = ["Here's the gist. ", "APIs let programs talk. ", "They define requests. ", "Then responses. ", "And errors too. "];
    expect(speak(...long)).toMatch(/^Here's the gist\. APIs let programs talk\. They define requests\. (There's more|I've put the rest|The details are) on screen\.$/);
  });

  it("releases the opening clause early so speech can start before the first full stop", () => {
    const b = new SpokenBrief();
    expect(b.push("Sure, I opened Notepad")).toBe("");
    expect(b.push(" for you, and typed")).toBe("Sure, I opened Notepad for you,\n\n");
    expect(b.push(" your note. ")).toBe("and typed your note. ");
  });

  it("handles sentences split across stream chunks", () => {
    expect(speak("Hel", "lo there", ". How are", " you?")).toBe("Hello there. How are you?");
  });
});

describe("stripWakeEcho", () => {
  it("drops the tail of the wake word Whisper picks up", () => {
    expect(stripWakeEcho("Wise. Open Chrome.")).toBe("Open Chrome.");
    expect(stripWakeEcho("Vice, what time is it?")).toBe("what time is it?");
    expect(stripWakeEcho("Otherwise.")).toBe("");
  });

  it("leaves real requests alone", () => {
    expect(stripWakeEcho("Why is the sky blue?")).toBe("Why is the sky blue?");
    expect(stripWakeEcho("Wisdom teeth info")).toBe("Wisdom teeth info");
  });
});

describe("isNoise", () => {
  it("catches Whisper's looping hallucinations", () => {
    expect(isNoise("Okay, there we are, there we are, there we are, there we are.")).toBe(true);
    expect(isNoise("Thank you. Thank you. Thank you.")).toBe(true);
    expect(isNoise("Otherwise.")).toBe(true);
  });

  it("keeps real requests", () => {
    expect(isNoise("Open Chrome and play some lo-fi")).toBe(false);
    expect(isNoise("no no no, the other file")).toBe(false);
  });
});

describe("handOffLine", () => {
  it("summarises a sectioned reply by its headings", () => {
    const raw = [
      "Hey Sam! I've got quite a range of things I can do. Here's the breakdown:",
      "",
      "Computer & File Operations",
      "- Read/write files",
      "Web Tasks",
      "- Navigate websites",
      "Communication",
      "- Send email",
      "VYRSE Interface",
      "- Change settings",
      "Skills System",
      "- 30+ skills",
    ].join("\n");
    expect(handOffLine(raw)).toBe(
      "It covers computer and file operations, web tasks, communication and VYRSE interface, and more. The details are on screen.",
    );
  });

  it("fits the line to code, steps and lists", () => {
    expect(handOffLine("Here you go.\n```py\nprint(1)\n```")).toBe("I've put the code on screen.");
    expect(handOffLine("Do this:\n1. a\n2. b\n3. c")).toBe("The steps are on screen.");
    expect(handOffLine("Options:\n- a\n- b\n- c")).toBe("The full list is on screen.");
  });

  it("varies the line for plain prose", () => {
    const a = handOffLine("Just a long paragraph.");
    const b = handOffLine("Just a long paragraph.");
    expect(a).not.toBe(b);
  });
});

describe("interruption checks", () => {
  it("recognises stop words and echoes of VYRSE's own voice", () => {
    expect(isStopWord("Stop.")).toBe(true);
    expect(isStopWord("Never mind")).toBe(true);
    expect(isStopWord("Open Chrome")).toBe(false);
    expect(isEcho("the calculator shows eighty one", "Done! The calculator shows eighty one now.")).toBe(true);
    expect(isEcho("open spotify instead", "Done! The calculator shows eighty one now.")).toBe(false);
  });
});

describe("SpeechFilter symbols", () => {
  const speak = (text: string) => {
    const f = new SpeechFilter();
    return (f.push(text) + f.flush()).replace(/\s+/g, " ").trim();
  };

  it("never reads emoji, stray asterisks or quote markers aloud", () => {
    expect(speak("Rating: ⭐⭐⭐⭐\n")).toBe("Rating:");
    expect(speak("😊 Hey Sam! Done 💧\n")).toBe("Hey Sam! Done.");
    expect(speak("2 * 3 = 6\n")).toBe("2 times 3 = 6.");
    expect(speak("> quoted line\n")).toBe("quoted line.");
    expect(speak("Use #general and a | b\n")).toBe("Use general and a b.");
  });
});

describe("speakableReply (answers spoken on the Echo)", () => {
  it("keeps the gist and drops markdown, code and emoji", () => {
    const raw = "Your CPU is at **12%** and RAM at 40%. All good! 😎\n\n```js\nconsole.log(1)\n```";
    const out = speakableReply(raw);
    expect(out).toContain("Your CPU is at 12% and RAM at 40%.");
    expect(out).not.toMatch(/\*|console|😎/);
  });
});

describe("SpokenBrief with decimals", () => {
  it("never drops the text before a decimal number", () => {
    const out = speakableReply("yo gng, CPU is chillin at 12.3% and Chrome is eatin 1.59GB fr. No cap, PC runnin smooth.");
    expect(out.startsWith("yo gng, CPU is chillin at 12.3%")).toBe(true);
    expect(out).toContain("1.59GB fr.");
  });

  it("streams across a decimal split between chunks", () => {
    const brief = new SpokenBrief();
    const spoken = brief.push("RAM use is 9.") + brief.push("59 GB right now. All good. ") + brief.flush("");
    expect(spoken).toContain("RAM use is 9.59 GB right now.");
  });
});

describe("SpokenBrief, chatty (Vibe/Fam)", () => {
  const speakAll = (b: SpokenBrief, filter: SpeechFilter, reply: string) => {
    let said = "";
    for (const piece of reply.match(/[\s\S]{1,23}/g) ?? []) said += b.push(filter.push(piece));
    return said + b.push(filter.flush()) + b.flush(reply);
  };
  it("speaks a long chatty reply in full, with no 'rest on screen'", () => {
    const reply =
      "Yo, that match was wild. You clutched the last round like a pro, no cap. " +
      "Honestly the eco round play was lowkey genius. Then you held B site solo. " +
      "I'd run it back tomorrow if I were you. Get some sleep first though, it's late fr.";
    const said = speakAll(new SpokenBrief(40, 3000, true), new SpeechFilter(), reply);
    expect(said).toContain("Get some sleep first though");
    expect(said).not.toMatch(/on screen/);
  });
  it("only mentions the screen for a table or code", () => {
    const reply = "Here's how your squad did this week.\n\n| Player | K/D |\n|---|---|\n| You | 1.4 |\n| Sam | 1.1 |\n\nYou carried, gng.";
    const said = speakAll(new SpokenBrief(40, 3000, true), new SpeechFilter(), reply);
    expect(said).toContain("You carried");
    expect(said).toContain("The table's on screen.");
  });
});
