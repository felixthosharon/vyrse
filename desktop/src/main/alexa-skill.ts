import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'

import { IPC_CHANNELS, type EchoSkillStatus } from '../shared/backend-types'
import { echoReachable, speakOnEcho } from './alexa'
import { handleSkillRequest, interactionModel } from './alexa-skill-logic'
import { verifyAmazonRequest } from './amazon-verify'

/**
 * Echo → VYRSE ("Alexa, ask my pc …"): a custom Alexa skill whose endpoint is this gateway, reached from
 * Amazon through an ngrok tunnel. Deliberately narrow:
 *  - its own HTTP server on 127.0.0.1 (not Hermes; Hermes' API is never tunnelled), one secret path,
 *    POST only, small bodies;
 *  - every request must pass Amazon's signature + certificate-chain check and a 150 s timestamp window
 *    (Amazon's documented checks, amazon-verify.ts), carry this skill's ID, and come from the one Amazon
 *    user it was linked to (the first verified user);
 *  - all it can do is ask VYRSE a question, the same as typing it, so Hermes' approvals still apply.
 * The ngrok token, skill ID and linked user are stored encrypted (safeStorage). Off until enabled.
 */
interface SkillConfig {
  enabled: boolean
  authtoken: string
  domain: string
  skillId: string
  lockedUserId: string | null
  pathToken: string
}

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'echo-skill.bin')
// Alexa hangs up at 8 s; leave room for the network.
const QUICK_MS = 7000
const MAX_BODY = 64 * 1024

let config: SkillConfig = { enabled: false, authtoken: '', domain: '', skillId: '', lockedUserId: null, pathToken: '' }
let server: http.Server | null = null
let tunnel: { url(): string | null; close(): Promise<void> } | null = null
let state: EchoSkillStatus['state'] = 'off'
let lastError: string | undefined
let notify: () => void = () => {}
const pendingAnswers = new Map<string, (text: string) => void>()

/**
 * What happened to each Echo request (no tokens, no IDs), in VYRSE's user data, so a failed answer can be
 * diagnosed afterwards. Kept small: trimmed to the last ~200 lines.
 */
function log(line: string): void {
  try {
    const file = path.join(app.getPath('userData'), 'echo-skill.log')
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-199) : []
    lines.push(`${new Date().toISOString()} ${line.replace(/\s+/g, ' ').slice(0, 300)}`)
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
  } catch {}
}

function loadConfig(): void {
  try {
    if (fs.existsSync(CONFIG_FILE()) && safeStorage.isEncryptionAvailable())
      config = { ...config, ...JSON.parse(safeStorage.decryptString(fs.readFileSync(CONFIG_FILE()))) }
  } catch (err) {
    console.warn('[echo-skill] could not read settings:', err)
  }
  if (!config.pathToken) config.pathToken = crypto.randomBytes(18).toString('base64url')
}

function saveConfig(): void {
  if (!safeStorage.isEncryptionAvailable()) return
  fs.writeFileSync(CONFIG_FILE(), safeStorage.encryptString(JSON.stringify(config)))
}

function endpoint(): string {
  return config.domain ? `https://${config.domain}/alexa/${config.pathToken}` : ''
}

export function skillStatus(): EchoSkillStatus {
  return {
    state,
    enabled: config.enabled,
    domain: config.domain,
    skillId: config.skillId,
    hasToken: Boolean(config.authtoken),
    linked: Boolean(config.lockedUserId),
    endpoint: endpoint(),
    error: lastError,
  }
}

function setState(next: EchoSkillStatus['state'], error?: string): void {
  state = next
  lastError = error
  notify()
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' })
  res.end(JSON.stringify(body))
}

/** The name the user gave VYRSE (stored by the vyrse plugin in Hermes' home), for the Echo greeting. */
function userName(): string {
  try {
    const home = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA ?? '', 'hermes')
    const state = JSON.parse(fs.readFileSync(path.join(home, 'vyrse', 'ui_state.json'), 'utf8')) as { prefs?: { userName?: unknown } }
    const name = state.prefs?.userName
    return typeof name === 'string' ? name.slice(0, 40) : ''
  } catch {
    return ''
  }
}

/** A question to VYRSE as if it came from the Echo (after verification); also used by the smoke test. */
export function askVyrse(main: BrowserWindow, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (main.isDestroyed()) return reject(new Error('VYRSE is closed'))
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pendingAnswers.delete(id)
      reject(new Error('VYRSE took too long'))
    }, 180_000)
    pendingAnswers.set(id, answer => {
      clearTimeout(timer)
      resolve(answer)
    })
    main.webContents.send(IPC_CHANNELS.echoAsk, { id, text: text.slice(0, 500) })
  })
}

async function onRequest(main: BrowserWindow, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== `/alexa/${config.pathToken}`) return send(res, 404, { error: 'not found' })
  let body: string
  try {
    body = await readBody(req)
  } catch {
    return send(res, 413, { error: 'too large' })
  }
  try {
    await verifyAmazonRequest(body, req.headers)
  } catch (err) {
    log(`rejected: not verified (${String((err as Error)?.message ?? err).slice(0, 120)})`)
    return send(res, 401, { error: 'unverified' })
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch {
    return send(res, 400, { error: 'bad json' })
  }
  const started = Date.now()
  const result = await handleSkillRequest(envelope as Parameters<typeof handleSkillRequest>[0], {
    userName: userName(),
    skillId: config.skillId,
    lockedUserId: config.lockedUserId,
    lockUser: userId => {
      config.lockedUserId = userId
      saveConfig()
      notify()
    },
    ask: text => askVyrse(main, text),
    quickMs: QUICK_MS,
    canSpeakLater: echoReachable(),
    late: answer => {
      log(`late answer ready after ${Math.round((Date.now() - started) / 1000)}s; speaking on the Echo`)
      void speakOnEcho(answer).then(r => log(r.ok ? `spoken on ${r.device ?? 'Echo'}` : `could not speak on the Echo: ${r.error}`))
    },
  })
  const said = (result.body as { response?: { outputSpeech?: { text?: string } } })?.response?.outputSpeech?.text
  const kind = (JSON.parse(body) as { request?: { type?: string; intent?: { name?: string } } }).request
  log(`${kind?.type ?? '?'}${kind?.intent?.name ? ` ${kind.intent.name}` : ''} -> ${result.status} in ${Date.now() - started} ms${said ? `: "${said.slice(0, 80)}"` : ` ${JSON.stringify(result.body).slice(0, 80)}`}`)
  send(res, result.status, result.body)
}

async function start(main: BrowserWindow): Promise<void> {
  await stop()
  if (!config.authtoken || !config.domain || !config.skillId) {
    setState('error', 'Fill in the ngrok token, ngrok domain and skill ID first.')
    return
  }
  setState('starting')
  try {
    const srv = http.createServer((req, res) => {
      onRequest(main, req, res).catch(err => {
        log(`request failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
        if (!res.headersSent) send(res, 500, { error: 'failed' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => resolve())
    })
    server = srv
    const port = (srv.address() as { port: number }).port
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ngrok = require('@ngrok/ngrok') as {
      forward(cfg: Record<string, unknown>): Promise<{ url(): string | null; close(): Promise<void> }>
    }
    tunnel = await ngrok.forward({ addr: `127.0.0.1:${port}`, authtoken: config.authtoken, domain: config.domain })
    setState('running')
  } catch (err) {
    await stop()
    // ngrok echoes the authtoken in some errors; it must never reach the screen.
    const raw = String((err as Error)?.message ?? err)
    const message = (config.authtoken ? raw.split(config.authtoken).join('[token]') : raw).split('\n')[0]!
    setState('error', `Couldn't start the tunnel: ${message.slice(0, 200)}`)
  }
}

async function stop(): Promise<void> {
  const t = tunnel
  tunnel = null
  await t?.close().catch(() => {})
  const s = server
  server = null
  await new Promise<void>(resolve => (s ? s.close(() => resolve()) : resolve()))
  if (state !== 'error') setState('off')
}

export function attachEchoSkill(main: BrowserWindow): void {
  loadConfig()
  notify = () => {
    if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.echoSkillStatus, skillStatus())
  }

  ipcMain.on(IPC_CHANNELS.echoAnswer, (event, payload: { id?: string; text?: string }) => {
    if (event.sender !== main.webContents || typeof payload?.id !== 'string') return
    pendingAnswers.get(payload.id)?.(String(payload.text ?? ''))
    pendingAnswers.delete(payload.id)
  })

  ipcMain.handle(IPC_CHANNELS.echoSkill, async (event, op: string, args: Record<string, unknown> = {}) => {
    if (event.sender !== main.webContents) return { error: 'not allowed' }
    switch (op) {
      case 'status':
        return skillStatus()
      case 'set': {
        // Only provided, non-empty values change; the ngrok token is write-only.
        if (typeof args['authtoken'] === 'string' && args['authtoken'].trim()) config.authtoken = args['authtoken'].trim()
        if (typeof args['domain'] === 'string') config.domain = args['domain'].trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        if (typeof args['skillId'] === 'string') config.skillId = args['skillId'].trim()
        saveConfig()
        if (config.enabled) await start(main)
        else notify()
        return skillStatus()
      }
      case 'enable':
        config.enabled = true
        saveConfig()
        await start(main)
        return skillStatus()
      case 'disable':
        config.enabled = false
        saveConfig()
        lastError = undefined
        await stop()
        return skillStatus()
      case 'unlink':
        config.lockedUserId = null
        saveConfig()
        notify()
        return skillStatus()
      case 'forget':
        await stop()
        config = { enabled: false, authtoken: '', domain: '', skillId: '', lockedUserId: null, pathToken: crypto.randomBytes(18).toString('base64url') }
        fs.rmSync(CONFIG_FILE(), { force: true })
        setState('off')
        return skillStatus()
      case 'model':
        return JSON.stringify(interactionModel(), null, 2)
      default:
        return { error: `unknown op ${op}` }
    }
  })

  if (config.enabled) void start(main)
  app.on('will-quit', () => void stop())
}
