import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import WebSocket, { WebSocketServer } from 'ws'

import { IPC_CHANNELS, type PhoneBridgeStatus } from '../shared/backend-types'
import type { HermesBackend } from './hermes-backend'
import { alexaOp } from './alexa'

/**
 * Phone bridge: VYRSE on an Android phone, on the home Wi-Fi only, with the model still on this PC.
 *
 * Hermes stays bound to 127.0.0.1. This bridge listens on the LAN, answers only private (home-network)
 * addresses, and only phones paired with a one-time code shown in Settings (2 minutes, 5 tries). Each
 * phone gets its own random key (stored here only as a SHA-256 hash, revocable). Requests are relayed
 * to Hermes with Hermes' own token swapped in, so the phone never holds it. Off until enabled.
 *
 * Traffic on the Wi-Fi is not encrypted (the user chose plain Wi-Fi over Tailscale); keys protect access.
 */
export const PHONE_PORT = 47630
const STORE = () => path.join(app.getPath('userData'), 'phones.bin')
const PAIR_MS = 120_000
const PAIR_TRIES = 5
const PHONE_ORIGINS = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost'])

interface Device {
  id: string
  name: string
  hash: string
  created: number
  lastSeen: number
}
interface Store {
  enabled: boolean
  devices: Device[]
}

let store: Store = { enabled: false, devices: [] }
let server: http.Server | null = null
let wss: WebSocketServer | null = null
let pairing: { code: string; expires: number; tries: number } | null = null
let listenError: string | undefined
let notify: () => void = () => {}

/*
 * PC → phone commands (flashlight, notifications, ring…). The phone's link service long-polls
 * /phone/commands; Hermes' vyrse_phone tool queues a command here and waits for the phone's answer.
 */
interface PhoneCommand {
  id: string
  action: string
  args: Record<string, unknown>
}
const queues = new Map<string, PhoneCommand[]>()
const pollers = new Map<string, () => void>()
const waiting = new Map<string, (result: unknown) => void>()
/** when each phone's link service last asked for commands */
const linkSeen = new Map<string, number>()
const POLL_MS = 25_000
const COMMAND_MS = 20_000

function linkedDevice(): Device | null {
  let best: Device | null = null
  for (const d of store.devices) {
    const seen = linkSeen.get(d.id) ?? 0
    if (Date.now() - seen < POLL_MS + 15_000 && (!best || seen > (linkSeen.get(best.id) ?? 0))) best = d
  }
  return best
}

/** Run something on the paired phone (its link service must be on). */
export function phoneCommand(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const device = linkedDevice()
  if (!device)
    return Promise.resolve({
      ok: false,
      error: 'Your phone isn’t reachable. Open VYRSE on it and turn on Settings → Phone → “Let my PC reach this phone”, on the home Wi-Fi.',
    })
  const cmd: PhoneCommand = { id: crypto.randomUUID(), action: action.slice(0, 40), args }
  const q = queues.get(device.id) ?? []
  q.push(cmd)
  queues.set(device.id, q.slice(-20))
  pollers.get(device.id)?.()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(cmd.id)
      resolve({ ok: false, error: 'The phone didn’t answer in time.' })
    }, COMMAND_MS)
    waiting.set(cmd.id, result => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

/*
 * What a paired phone may reach in Hermes: exactly what the VYRSE app uses, nothing more. Hermes' other
 * endpoints (files, terminal/PTY, git, console, env, plugins management...) are refused, so a phone key
 * that leaked could not be turned into general control of the PC through the bridge.
 */
const PHONE_REST: { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/status$/ },
  { method: '*', path: /^\/api\/config$/ },
  { method: 'GET', path: /^\/api\/memory$/ },
  { method: 'POST', path: /^\/api\/audio\/(transcribe|stt-lease|tts-lease)$/ },
  { method: '*', path: /^\/api\/local-models\/(status|eject)$/ },
  { method: '*', path: /^\/api\/plugins\/vyrse\/[\w./%-]+$/ },
  { method: 'GET', path: /^\/api\/skills(\/content|\/hub\/search)?$/ },
  { method: 'POST', path: /^\/api\/skills\/(toggle|hub\/install|hub\/uninstall)$/ },
  { method: 'GET', path: /^\/api\/actions\/[\w.-]+\/status$/ },
]
const PHONE_WS = new Set(['/api/ws', '/api/audio/speak-stream'])
/** JSON-RPC methods the app calls over /api/ws (requests from the phone with any other method are refused). */
const PHONE_RPC = new Set([
  'gateway.ping', 'session.events.since', 'session.create', 'session.list', 'session.resume', 'session.close',
  'session.delete', 'session.interrupt', 'session.title', 'session.undo', 'prompt.submit', 'image.attach',
  'approval.received', 'approval.respond', 'config.get', 'config.set', 'model.options', 'cron.manage', 'skills.reload',
])

export function phoneApiAllowed(method: string, pathname: string): boolean {
  if (pathname.includes('..') || /%2e|%2f|%5c/i.test(pathname)) return false
  // Wake-word training downloads a trainer and replaces the wake model: only from the PC itself.
  if (/^\/api\/plugins\/vyrse\/wake-train/i.test(pathname)) return false
  return PHONE_REST.some(r => (r.method === '*' || r.method === method) && r.path.test(pathname))
}

/** Frames from the phone to Hermes: requests for methods outside PHONE_RPC are answered here, not forwarded. */
export function filterPhoneFrames(data: string): { forward: string[]; refuse: unknown[] } {
  const forward: string[] = []
  const refuse: unknown[] = []
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    let frame: { id?: unknown; method?: unknown } | null = null
    try {
      frame = JSON.parse(line)
    } catch {
      continue // not JSON-RPC: dropped
    }
    if (frame && typeof frame.method === 'string' && !PHONE_RPC.has(frame.method)) {
      if (frame.id !== undefined) refuse.push(frame.id)
      continue
    }
    forward.push(line)
  }
  return { forward, refuse }
}

/** PC-only actions a phone may ask the PC to carry out (a Hermes request made from the phone app). */
const DESKTOP_CALLS: Record<string, Set<string>> = { alexa: new Set(['status', 'command', 'speak', 'announce']) }

/** set when phones.bin exists but couldn't be read: then it is never overwritten (that would unpair every phone) */
let unreadable = false

function load(): void {
  for (const file of [STORE(), `${STORE()}.bak`]) {
    try {
      if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) continue
      store = { ...store, ...JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) }
      unreadable = false
      return
    } catch (err) {
      unreadable = true
      console.warn(`[phone] could not read ${path.basename(file)}:`, err)
    }
  }
}
function save(): void {
  if (unreadable || !safeStorage.isEncryptionAvailable()) return
  // Keep the previous version: a bad write can't lose the paired phones.
  if (fs.existsSync(STORE())) fs.copyFileSync(STORE(), `${STORE()}.bak`)
  fs.writeFileSync(STORE(), safeStorage.encryptString(JSON.stringify(store)))
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** Home-network (RFC 1918 / link-local) and loopback sources only. */
export function isPrivateAddress(raw: string | undefined): boolean {
  const ip = (raw ?? '').replace(/^::ffff:/, '')
  if (ip === '127.0.0.1' || ip === '::1') return true
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 169 && p[1] === 254)
}

function lanAddresses(): string[] {
  const out: { address: string; rank: number }[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Loopback|Tailscale/i.test(name)) continue
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address) && !a.address.startsWith('169.254.'))
        // Wi-Fi first (that's where the phone is); VirtualBox's default host-only net (often a plain "Ethernet N") last.
        out.push({ address: a.address, rank: /wi-?fi|wlan|wireless/i.test(name) ? 0 : a.address.startsWith('192.168.56.') ? 2 : 1 })
  }
  return out.sort((a, b) => a.rank - b.rank).map((a) => a.address)
}

function deviceFor(token: string | null | undefined): Device | null {
  if (!token) return null
  const h = sha(token)
  const hb = Buffer.from(h)
  for (const d of store.devices) {
    const db = Buffer.from(d.hash)
    if (db.length === hb.length && crypto.timingSafeEqual(db, hb)) return d
  }
  return null
}

export function phoneStatus(): PhoneBridgeStatus {
  return {
    enabled: store.enabled,
    running: Boolean(server?.listening),
    port: PHONE_PORT,
    addresses: lanAddresses(),
    devices: store.devices.map(d => ({
      id: d.id,
      name: d.name,
      created: d.created,
      lastSeen: d.lastSeen,
      linked: Date.now() - (linkSeen.get(d.id) ?? 0) < POLL_MS + 15_000,
    })),
    pairing: pairing && pairing.expires > Date.now() ? { code: pairing.code, expiresIn: Math.round((pairing.expires - Date.now()) / 1000) } : null,
    error: listenError,
  }
}

function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = String(req.headers.origin ?? '')
  if (PHONE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hermes-Session-Token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: http.IncomingMessage, max = 4096): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
      if (raw.length > max) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function tokenOf(req: http.IncomingMessage, url: URL): string | null {
  return (req.headers['x-hermes-session-token'] as string | undefined) ?? url.searchParams.get('token')
}

async function onRequest(backend: HermesBackend, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isPrivateAddress(req.socket.remoteAddress)) {
    res.destroy()
    return
  }
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://bridge')

  if (url.pathname === '/phone/hello') return json(res, 200, { app: 'vyrse', pc: os.hostname() })

  if (url.pathname === '/phone/pair' && req.method === 'POST') {
    const body = await readJson(req)
    if (!pairing || pairing.expires < Date.now()) return json(res, 403, { error: 'Pairing isn’t open. On the PC: Settings → Phone → Pair a phone.' })
    if (String(body['code'] ?? '') !== pairing.code) {
      if (++pairing.tries >= PAIR_TRIES) pairing = null
      notify()
      return json(res, 403, { error: 'Wrong code.' })
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const device: Device = {
      id: crypto.randomUUID(),
      name: String(body['name'] ?? 'Android phone').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) || 'Android phone',
      hash: sha(token),
      created: Date.now(),
      lastSeen: Date.now(),
    }
    store.devices.push(device)
    pairing = null
    save()
    notify()
    return json(res, 200, { token, deviceId: device.id, pc: os.hostname() })
  }

  const device = deviceFor(tokenOf(req, url))
  if (!device) return json(res, 401, { error: 'This phone isn’t paired (or was removed). Pair it again.' })
  if (Date.now() - device.lastSeen > 60_000) {
    device.lastSeen = Date.now()
    save()
  }

  if (url.pathname === '/phone/ping') {
    const conn = backend.getConnection()
    return json(res, 200, { ok: true, hermes: Boolean(conn), hermesVersion: conn?.hermesVersion, pc: os.hostname() })
  }

  if (url.pathname === '/phone/commands' && req.method === 'GET') {
    linkSeen.set(device.id, Date.now())
    const take = () => {
      const q = queues.get(device.id) ?? []
      queues.set(device.id, [])
      return q
    }
    const ready = take()
    if (ready.length) return json(res, 200, { commands: ready })
    // Long-poll: answer as soon as a command is queued, or empty after POLL_MS.
    const done = (commands: PhoneCommand[]) => {
      clearTimeout(timer)
      if (pollers.get(device.id) === wake) pollers.delete(device.id)
      if (!res.writableEnded) json(res, 200, { commands })
    }
    const wake = () => done(take())
    const timer = setTimeout(() => done([]), POLL_MS)
    pollers.get(device.id)?.()
    pollers.set(device.id, wake)
    req.on('close', () => {
      clearTimeout(timer)
      if (pollers.get(device.id) === wake) pollers.delete(device.id)
    })
    return
  }

  if (url.pathname === '/phone/command-result' && req.method === 'POST') {
    const body = await readJson(req, 3 * 1024 * 1024) // screenshots of the phone screen
    const resolve = waiting.get(String(body['id'] ?? ''))
    if (resolve) {
      waiting.delete(String(body['id']))
      resolve(body['result'] ?? { ok: false, error: 'empty result' })
    }
    return json(res, 200, { ok: true })
  }

  if (url.pathname === '/phone/log' && req.method === 'POST') {
    // The phone app's errors and diagnostics, so problems on the phone can be read on the PC.
    const body = await readJson(req, 64 * 1024)
    const entries = Array.isArray(body['entries']) ? body['entries'].slice(0, 200) : []
    const file = path.join(app.getPath('userData'), 'phone.log')
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`)
      const lines = entries.map(e => {
        const x = (e ?? {}) as { t?: number; level?: string; msg?: string }
        // One entry, one line: control characters can't forge extra log lines.
        const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n)
        return `${new Date(Number(x.t) || Date.now()).toISOString()} [${device.name}] ${clean(x.level ?? 'log', 8)} ${clean(x.msg, 2000)}`
      })
      if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n')
    } catch {}
    return json(res, 200, { ok: true })
  }

  if (url.pathname === '/phone/desktop-call' && req.method === 'POST') {
    const body = await readJson(req)
    const target = String(body['target'] ?? '')
    const op = String(body['op'] ?? '')
    if (!DESKTOP_CALLS[target]?.has(op)) return json(res, 400, { ok: false, error: `not allowed: ${target}.${op}` })
    const args = (body['args'] && typeof body['args'] === 'object' ? body['args'] : {}) as { text?: string; device?: string }
    return json(res, 200, await alexaOp(op, args))
  }

  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
  if (!phoneApiAllowed(req.method ?? 'GET', url.pathname)) return json(res, 403, { error: 'Not available from the phone.' })
  const conn = backend.getConnection()
  if (!conn) return json(res, 503, { error: 'Hermes is starting on the PC.' })
  const target = new URL(conn.baseUrl)
  url.searchParams.delete('token')
  const headers: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'origin', 'referer', 'x-hermes-session-token', 'connection', 'cookie'].includes(k)) continue
    headers[k] = v
  }
  headers['host'] = target.host
  headers['x-hermes-session-token'] = conn.token
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, method: req.method, path: `${url.pathname}${url.search}`, headers },
    up => {
      const out: http.OutgoingHttpHeaders = { ...up.headers }
      delete out['access-control-allow-origin']
      for (const [k, v] of Object.entries(out)) if (v !== undefined) res.setHeader(k, v)
      res.writeHead(up.statusCode ?? 502)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'Couldn’t reach Hermes on the PC.' })
    else res.destroy()
  })
  req.pipe(upstream)
}

function onUpgrade(backend: HermesBackend, req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://bridge')
  const conn = backend.getConnection()
  if (!isPrivateAddress(req.socket.remoteAddress) || !PHONE_WS.has(url.pathname) || !deviceFor(url.searchParams.get('token')) || !conn) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  url.searchParams.set('token', conn.token)
  const target = new URL(conn.wsUrl)
  const upstreamUrl = `ws://${target.host}${url.pathname}${url.search}`
  wss!.handleUpgrade(req, socket, head, phone => {
    const upstream = new WebSocket(upstreamUrl, { headers: { Origin: `http://${target.host}` } })
    const pending: { data: WebSocket.RawData; binary: boolean }[] = []
    upstream.on('open', () => {
      for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary })
    })
    const gateway = url.pathname === '/api/ws'
    phone.on('message', (raw, binary) => {
      let data: WebSocket.RawData = raw
      if (gateway) {
        // Only the app's own JSON-RPC methods reach Hermes from the phone.
        const { forward, refuse } = filterPhoneFrames(raw.toString())
        for (const id of refuse)
          phone.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Not available from the phone.' } }) + '\n')
        if (!forward.length) return
        data = Buffer.from(forward.join('\n') + '\n')
        binary = false
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else pending.push({ data, binary })
    })
    upstream.on('message', (data, binary) => {
      if (phone.readyState === WebSocket.OPEN) phone.send(data, { binary })
    })
    const close = () => {
      if (phone.readyState <= WebSocket.OPEN) phone.close()
      if (upstream.readyState <= WebSocket.OPEN) upstream.close()
    }
    phone.on('close', close)
    upstream.on('close', close)
    phone.on('error', close)
    upstream.on('error', close)
  })
}

async function start(backend: HermesBackend): Promise<void> {
  await stop()
  listenError = undefined
  const srv = http.createServer((req, res) => {
    onRequest(backend, req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'bridge error' })
    })
  })
  wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  srv.on('upgrade', (req, socket, head) => onUpgrade(backend, req, socket, head))
  await new Promise<void>(resolve => {
    srv.once('error', err => {
      listenError = `Couldn’t open port ${PHONE_PORT}: ${(err as Error).message}`
      resolve()
    })
    srv.listen(PHONE_PORT, '0.0.0.0', () => resolve())
  })
  if (srv.listening) server = srv
  notify()
}

async function stop(): Promise<void> {
  wss?.clients.forEach(c => c.terminate())
  wss?.close()
  wss = null
  const s = server
  server = null
  await new Promise<void>(resolve => (s ? s.close(() => resolve()) : resolve()))
  notify()
}

/**
 * One-time Windows setup (UAC prompt): mark the current Wi-Fi as a Private network and allow the bridge's
 * port from the local subnet on Private networks only.
 */
function allowOnHomeWifi(): Promise<boolean> {
  const script = [
    "Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -like 'Wi-Fi*' } | Set-NetConnectionProfile -NetworkCategory Private",
    `Remove-NetFirewallRule -DisplayName 'VYRSE phone' -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName 'VYRSE phone' -Direction Inbound -Protocol TCP -LocalPort ${PHONE_PORT} -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise(resolve => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`],
      { windowsHide: true },
    )
    child.on('exit', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

export function attachPhoneBridge(main: BrowserWindow, backend: HermesBackend): void {
  load()
  notify = () => {
    if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.phoneStatus, phoneStatus())
  }
  ipcMain.handle(IPC_CHANNELS.phone, async (event, op: string, args: Record<string, unknown> = {}) => {
    if (event.sender !== main.webContents) return { error: 'not allowed' }
    switch (op) {
      case 'status':
        return phoneStatus()
      case 'enable':
        store.enabled = true
        save()
        await start(backend)
        return phoneStatus()
      case 'disable':
        store.enabled = false
        pairing = null
        save()
        await stop()
        return phoneStatus()
      case 'pair':
        pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + PAIR_MS, tries: 0 }
        setTimeout(() => notify(), PAIR_MS + 50)
        notify()
        return phoneStatus()
      case 'cancelPair':
        pairing = null
        notify()
        return phoneStatus()
      case 'remove':
        store.devices = store.devices.filter(d => d.id !== args['id'])
        save()
        // Drop that phone's live connections: every socket re-checks its key on reconnect.
        wss?.clients.forEach(c => c.terminate())
        notify()
        return phoneStatus()
      case 'command':
        return phoneCommand(String(args['action'] ?? ''), (args['args'] as Record<string, unknown>) ?? {})
      case 'allowFirewall':
        return { ok: await allowOnHomeWifi(), ...phoneStatus() }
      default:
        return { error: `unknown op ${op}` }
    }
  })
  if (store.enabled) void start(backend)
  app.on('will-quit', () => void stop())
}
