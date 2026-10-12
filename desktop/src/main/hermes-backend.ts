import { spawn, execFile, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'

import type { BackendConnection, BackendStatus } from '../shared/backend-types'
import { LogTail, parseReadyPort, RestartPolicy } from './backend-policy'
import { locateHermes, type HermesInstall } from './hermes-locator'

const READY_TIMEOUT_MS = 90_000
const HEALTH_TIMEOUT_MS = 20_000
const STOP_GRACE_MS = 5_000

interface HermesBackendEvents {
  status: [BackendStatus]
}

/**
 * Owns the `hermes serve` child process: spawn → wait for the READY sentinel →
 * health check → WebSocket probe → publish connection. Restarts on unexpected exit
 * (bounded by RestartPolicy) and kills the whole process tree on stop, so the
 * managed llama-server never outlives VYRSE.
 *
 * Hermes does the real work; this class only supervises the process.
 */
export class HermesBackend extends EventEmitter<HermesBackendEvents> {
  private child: ChildProcess | null = null
  /**
   * On Windows the venv `python.exe` is a launcher stub that runs the real interpreter as a
   * child process. We track that real server PID too: if only the launcher died, the server
   * (and its llama-server) would survive and block every restart.
   */
  private serverPid: number | undefined
  private connection: BackendConnection | null = null
  private status: BackendStatus = { phase: 'stopped', message: 'Not started' }
  private readonly policy = new RestartPolicy()
  private readonly logTail = new LogTail()
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private install: HermesInstall | null = null

  constructor(private readonly logFile?: string) {
    super()
  }

  getStatus(): BackendStatus {
    return this.status
  }

  /** PIDs of the launcher and the real `hermes serve` process, for diagnostics and smoke tests. */
  get pids(): { launcher?: number; server?: number } {
    return { launcher: this.child?.pid, server: this.serverPid }
  }

  getConnection(): BackendConnection | null {
    return this.status.phase === 'ready' ? this.connection : null
  }

  async start(): Promise<void> {
    this.stopping = false
    this.setStatus({ phase: 'locating', message: 'Looking for Hermes' })
    this.install = locateHermes()
    if (!this.install) {
      this.setStatus({
        phase: 'not-installed',
        message: 'Hermes Agent is not installed',
        detail: 'Install Hermes Agent (https://hermes-agent.nousresearch.com), then restart VYRSE.',
      })
      return
    }
    await this.spawnOnce()
  }

  /** User-initiated restart: resets the crash budget. */
  async restart(): Promise<void> {
    await this.stop()
    this.policy.reset()
    await this.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null
      killPidTree(this.serverPid)
      this.serverPid = undefined
      this.setStatus({ phase: 'stopped', message: 'Hermes stopped' })
      return
    }
    this.setStatus({ phase: 'stopping', message: 'Stopping Hermes' })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    killPidTree(child.pid)
    killPidTree(this.serverPid)
    await Promise.race([exited, delay(STOP_GRACE_MS)])
    this.serverPid = undefined
    this.child = null
    this.connection = null
    this.setStatus({ phase: 'stopped', message: 'Hermes stopped' })
  }

  private async spawnOnce(): Promise<void> {
    const install = this.install!
    const token = crypto.randomBytes(32).toString('base64url')
    this.connection = null
    this.setStatus({ phase: 'starting', message: 'Starting Hermes', attempt: this.policy.attemptCount })

    const child = spawn(
      install.python,
      // --isolated: never attach to (or be blocked by) another host backend; VYRSE owns this one.
      ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0', '--isolated'],
      {
        cwd: os.homedir(),
        env: {
          ...process.env,
          HERMES_HOME: install.hermesHome,
          HERMES_DASHBOARD_SESSION_TOKEN: token,
          // Hermes' parent-death watchdog: the backend exits if VYRSE dies without cleanup.
          HERMES_PARENT_PID: String(process.pid),
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    this.serverPid = undefined

    const readyPort = new Promise<number>((resolve, reject) => {
      let buffered = ''
      let announced = false
      const timer = setTimeout(
        () => reject(new Error(`Hermes did not report ready within ${READY_TIMEOUT_MS / 1000}s`)),
        READY_TIMEOUT_MS,
      )
      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        this.log(text)
        if (announced) return
        buffered += text
        const port = parseReadyPort(buffered)
        if (port) {
          announced = true
          clearTimeout(timer)
          resolve(port)
        }
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`Hermes exited during startup (code ${code})`))
      })
      child.once('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
    child.stderr!.on('data', (data: Buffer) => this.log(data.toString('utf8')))
    child.once('exit', (code, signal) => this.onExit(child, code, signal))

    try {
      const port = await readyPort
      this.serverPid = await findServerPid(child.pid)
      const baseUrl = `http://127.0.0.1:${port}`
      const version = await waitForHealth(baseUrl)
      await probeGateway(`ws://127.0.0.1:${port}/api/ws`, token)
      if (this.child !== child) return // stopped/replaced meanwhile
      this.connection = { baseUrl, wsUrl: `ws://127.0.0.1:${port}/api/ws`, token, hermesVersion: version }
      this.setStatus({ phase: 'ready', message: `Hermes ${version ?? ''} ready`.replace('  ', ' ') })
    } catch (err) {
      if (this.child !== child || this.stopping) return
      this.log(`[vyrse] startup failed: ${(err as Error).message}`)
      killPidTree(child.pid) // onExit decides whether to retry
      killPidTree(this.serverPid)
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    this.log(`[vyrse] hermes serve exited (code=${code}, signal=${signal})`)
    if (this.child !== child) return
    this.child = null
    this.connection = null
    // The launcher may die while the real server lives on (and holds the port, llama-server and
    // the host-backend record). Clear it out before deciding anything else.
    killPidTree(this.serverPid)
    this.serverPid = undefined
    if (this.stopping) return

    const wait = this.policy.nextDelay()
    if (wait === null) {
      this.setStatus({
        phase: 'failed',
        message: 'Hermes keeps stopping',
        detail: 'Hermes crashed repeatedly. Check the log below, then press Retry.',
        logTail: this.logTail.last(),
      })
      return
    }
    this.setStatus({
      phase: 'restarting',
      message: 'Reconnecting to Hermes',
      attempt: this.policy.attemptCount,
      logTail: this.logTail.last(10),
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) void this.spawnOnce()
    }, wait)
  }

  private setStatus(status: BackendStatus): void {
    this.status = status
    this.emit('status', status)
  }

  private log(text: string): void {
    this.logTail.push(text)
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, text.endsWith('\n') ? text : `${text}\n`)
      } catch {
        // Logging must never take the backend down.
      }
    }
  }
}

/** Kill a process and everything it spawned (llama-server, tool subprocesses). Missing PIDs are ignored. */
function killPidTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

/** The real interpreter PID behind the Windows venv launcher (its only python child). */
function findServerPid(launcherPid: number | undefined): Promise<number | undefined> {
  if (process.platform !== 'win32' || launcherPid === undefined) return Promise.resolve(launcherPid)
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${launcherPid} AND Name LIKE 'python%'" | Select-Object -First 1).ProcessId`,
      ],
      { windowsHide: true, timeout: 10_000 },
      (err, stdout) => {
        const pid = Number(String(stdout).trim())
        // No python child means the interpreter is running in-process (non-venv launch).
        resolve(!err && Number.isInteger(pid) && pid > 0 ? pid : launcherPid)
      },
    )
  })
}

async function waitForHealth(baseUrl: string): Promise<string | undefined> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })
      const body = (await res.json()) as { ok?: boolean; displayVersion?: string; version?: string }
      if (res.ok && body.ok) return body.displayVersion ?? body.version
    } catch (err) {
      lastError = err
    }
    await delay(300)
  }
  throw new Error(`Hermes health check failed: ${String(lastError ?? 'timeout')}`)
}

/** Open the gateway socket once and wait for the `gateway.ready` handshake frame. */
function probeGateway(wsUrl: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Gateway handshake timed out'))
    }, 10_000)
    socket.addEventListener('message', event => {
      if (String(event.data).includes('gateway.ready')) {
        clearTimeout(timer)
        socket.close()
        resolve()
      }
    })
    socket.addEventListener('close', event => {
      clearTimeout(timer)
      if (event.code === 4401 || event.code === 4403) reject(new Error(`Gateway refused connection (${event.code})`))
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Gateway WebSocket error'))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
