// Pure helpers for HermesBackend, kept separate so they are unit-testable without Electron.

const READY_RE = /^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/m

/** Port announced by `hermes serve` on stdout, or null if `text` has no sentinel line. */
export function parseReadyPort(text: string): number | null {
  const match = READY_RE.exec(text)
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * Crash-restart budget: exponential backoff (1s, 2s, 4s, …), at most `maxAttempts`
 * restarts inside a sliding `windowMs`. Past the budget we stop and surface the
 * failure instead of crash-looping in the background.
 */
export class RestartPolicy {
  private attempts: number[] = []

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 120_000,
    private readonly baseDelayMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Delay before the next restart, or null when the budget is exhausted. */
  nextDelay(): number | null {
    const t = this.now()
    this.attempts = this.attempts.filter(a => t - a < this.windowMs)
    if (this.attempts.length >= this.maxAttempts) return null
    const delay = this.baseDelayMs * 2 ** this.attempts.length
    this.attempts.push(t)
    return delay
  }

  get attemptCount(): number {
    return this.attempts.length
  }

  reset(): void {
    this.attempts = []
  }
}

/** Fixed-size ring of recent log lines, shown in the UI when the backend fails. */
export class LogTail {
  private lines: string[] = []

  constructor(private readonly max = 200) {}

  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      this.lines.push(line)
    }
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max)
  }

  last(n = 40): string[] {
    return this.lines.slice(-n)
  }
}
