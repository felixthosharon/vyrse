/**
 * Energy-based endpointing for one spoken request (pure; unit-tested).
 *
 * Tracks an adaptive noise floor, decides when speech started and when the speaker has
 * finished (enough trailing silence), and gives up if nobody speaks. Frames are 100 ms.
 */
export interface EndpointerOptions {
  /** how many dB above the noise floor counts as speech */
  speechDb: number;
  /** trailing silence that ends the utterance */
  endSilenceMs: number;
  /** give up if no speech starts within this time */
  noSpeechTimeoutMs: number;
  /** hard cap on one utterance */
  maxUtteranceMs: number;
  frameMs: number;
}

export const DEFAULT_ENDPOINTER: EndpointerOptions = {
  speechDb: 12,
  endSilenceMs: 800,
  noSpeechTimeoutMs: 6000,
  maxUtteranceMs: 15000,
  frameMs: 100,
};

export type EndpointEvent = "none" | "speech-start" | "speech-end" | "no-speech" | "max-length";

export function rmsDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return 10 * Math.log10(sum / Math.max(1, frame.length) + 1e-12);
}

export class Endpointer {
  private floorDb: number;
  private elapsed = 0;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private finished = false;

  constructor(private readonly opts: EndpointerOptions = DEFAULT_ENDPOINTER, initialFloorDb = -60) {
    this.floorDb = initialFloorDb;
  }

  get noiseFloorDb(): number {
    return this.floorDb;
  }

  /** Feed one frame; returns what happened on this frame. */
  push(frame: Float32Array, sensitivity = 1): EndpointEvent {
    if (this.finished) return "none";
    const db = rmsDb(frame);
    this.elapsed += this.opts.frameMs;
    const threshold = this.floorDb + this.opts.speechDb / Math.max(0.25, sensitivity);
    const loud = db > threshold;

    if (!loud) {
      // Floor adapts quickly downwards, slowly upwards (so speech doesn't raise it).
      this.floorDb = db < this.floorDb ? 0.7 * this.floorDb + 0.3 * db : 0.97 * this.floorDb + 0.03 * db;
    }

    if (!this.speaking) {
      if (loud) {
        this.speechMs += this.opts.frameMs;
        if (this.speechMs >= 200) {
          this.speaking = true;
          this.silenceMs = 0;
          return "speech-start";
        }
      } else this.speechMs = 0;
      if (this.elapsed >= this.opts.noSpeechTimeoutMs) return this.finish("no-speech");
      return "none";
    }

    if (this.elapsed >= this.opts.maxUtteranceMs) return this.finish("max-length");
    this.silenceMs = loud ? 0 : this.silenceMs + this.opts.frameMs;
    return this.silenceMs >= this.opts.endSilenceMs ? this.finish("speech-end") : "none";
  }

  private finish(event: EndpointEvent): EndpointEvent {
    this.finished = true;
    return event;
  }
}
