import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron'

import { IPC_CHANNELS, type AlexaDevice, type AlexaStatus } from '../shared/backend-types'

/**
 * Alexa (Echo) control through the unofficial Alexa web API (alexa-remote2): text commands ("turn off the
 * lights" exactly as if spoken to the Echo), speech and announcements on an Echo.
 *
 * Login happens on Amazon's own pages, through alexa-remote2's login proxy, in a VYRSE window. The proxy
 * listens on 127.0.0.1 only and stops after login. The resulting session (no password, ever) is stored
 * encrypted with Windows' DPAPI (safeStorage) in VYRSE's user data and refreshed automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AlexaRemote = require('alexa-remote2') as new () => AlexaRemoteApi

interface AlexaRemoteApi {
  init(options: Record<string, unknown>, callback: (err?: Error | null) => void): void
  on(event: 'cookie', listener: () => void): void
  stop(): void
  cookieData: unknown
  serialNumbers: Record<string, RawDevice>
  sendSequenceCommand(serial: string, command: string, value: string, callback: (err?: Error | null) => void): void
  alexaCookie?: { stopProxyServer?: () => void }
}

interface RawDevice {
  serialNumber: string
  accountName: string
  deviceFamily: string
  online: boolean
  capabilities?: string[]
}

const AMAZON_PAGE = 'amazon.in'
const SESSION_FILE = () => path.join(app.getPath('userData'), 'alexa-session.bin')

let alexa: AlexaRemoteApi | null = null
let status: AlexaStatus = { state: 'off', devices: [] }
let loginWindow: BrowserWindow | null = null
let notify: (s: AlexaStatus) => void = () => {}

function setStatus(next: Partial<AlexaStatus>): void {
  status = { ...status, ...next }
  notify(status)
}

function saveSession(data: unknown): void {
  if (!data || !safeStorage.isEncryptionAvailable()) return
  try {
    fs.writeFileSync(SESSION_FILE(), safeStorage.encryptString(JSON.stringify(data)))
  } catch (err) {
    console.warn('[alexa] could not save session:', err)
  }
}

function loadSession(): unknown {
  try {
    if (!fs.existsSync(SESSION_FILE()) || !safeStorage.isEncryptionAvailable()) return null
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(SESSION_FILE())))
  } catch {
    return null
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** The Alexa app on a phone or PC ("This Device") also takes volume, but nobody hears it there. */
function isAlexaApp(d: { name: string; family: string }): boolean {
  return /^this device$/i.test(d.name.trim()) || /^(VOX|TABLET|THIRD_PARTY_AVS_MEDIA_DISPLAY|MSHOP|WHA)$/i.test(d.family)
}

/**
 * Speakers (they take volume): real Echo hardware first, the Alexa app last (it used to win whenever it was
 * online and the Echo's flag said otherwise, so commands ran silently in the app), online before offline.
 */
function listDevices(): AlexaDevice[] {
  const all = Object.values(alexa?.serialNumbers ?? {})
  return all
    .filter(d => (d.capabilities ?? []).includes('VOLUME_SETTING'))
    .map(d => ({ serial: d.serialNumber, name: d.accountName, family: d.deviceFamily, online: Boolean(d.online) }))
    .sort((a, b) => Number(isAlexaApp(a)) - Number(isAlexaApp(b)) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
}

function openLoginWindow(url: string, parent: BrowserWindow): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return
  }
  loginWindow = new BrowserWindow({
    width: 480,
    height: 720,
    parent,
    title: 'Sign in to Amazon for Alexa',
    autoHideMenuBar: true,
    // An in-memory session: nothing from this login stays in VYRSE's browser storage.
    webPreferences: { session: session.fromPartition('alexa-login'), sandbox: true, contextIsolation: true },
  })
  void loginWindow.loadURL(url)
  loginWindow.on('closed', () => {
    loginWindow = null
    if (status.state === 'login') {
      alexa?.alexaCookie?.stopProxyServer?.()
      alexa?.stop()
      alexa = null
      setStatus({ state: 'off', error: 'Amazon sign-in was closed before it finished.' })
    }
  })
}

async function connect(parent: BrowserWindow): Promise<AlexaStatus> {
  if (status.state === 'ready' || status.state === 'connecting') return status
  const saved = loadSession()
  const port = await freePort()
  const instance = new AlexaRemote()
  alexa = instance
  setStatus({ state: saved ? 'connecting' : 'login', error: undefined, devices: [] })
  instance.on('cookie', () => saveSession(instance.cookieData))
  instance.init(
    {
      cookie: saved ?? undefined,
      formerRegistrationData: saved ?? undefined,
      proxyOnly: true,
      proxyOwnIp: '127.0.0.1',
      proxyListenBind: '127.0.0.1', // never reachable from the network
      proxyPort: port,
      amazonPage: AMAZON_PAGE,
      acceptLanguage: 'en-IN',
      amazonPageProxyLanguage: 'en_IN',
      useWsMqtt: false,
      bluetooth: false,
      notifications: false,
      logger: () => {},
    },
    err => {
      if (alexa !== instance) return
      if (err) {
        // First callback of a fresh login: the proxy is up, the user signs in on Amazon's page.
        if (/Please open http/.test(err.message)) {
          setStatus({ state: 'login' })
          openLoginWindow(`http://127.0.0.1:${port}/`, parent)
          return
        }
        setStatus({ state: 'error', error: `Alexa: ${err.message}`.slice(0, 300) })
        return
      }
      saveSession(instance.cookieData)
      if (loginWindow && !loginWindow.isDestroyed()) {
        status.state = 'ready' // so closing the window isn't treated as a cancelled login
        loginWindow.close()
      }
      setStatus({ state: 'ready', devices: listDevices() })
    },
  )
  return status
}

function disconnect(): AlexaStatus {
  alexa?.alexaCookie?.stopProxyServer?.()
  alexa?.stop()
  alexa = null
  try {
    fs.rmSync(SESSION_FILE(), { force: true })
  } catch {}
  setStatus({ state: 'off', devices: [], error: undefined })
  return status
}

function pickDevice(name?: string): AlexaDevice | null {
  const devices = listDevices()
  if (!devices.length) return null
  const wanted = (name ?? '').trim().toLowerCase()
  if (wanted) {
    const exact = devices.find(d => d.name.toLowerCase() === wanted)
    if (exact) return exact
    const partial = devices.find(d => d.name.toLowerCase().includes(wanted))
    if (partial) return partial
  }
  return devices[0]!
}

function run(command: 'textCommand' | 'speak' | 'announcement', text: string, device?: string): Promise<{ ok: boolean; device?: string; error?: string }> {
  return new Promise(resolve => {
    if (!alexa || status.state !== 'ready') {
      resolve({ ok: false, error: 'Alexa isn’t connected. Connect it in Settings → Echo / Alexa.' })
      return
    }
    const target = pickDevice(device)
    if (!target) {
      resolve({ ok: false, error: 'No Echo devices found on this Amazon account.' })
      return
    }
    alexa.sendSequenceCommand(target.serial, command, text.slice(0, 500), err =>
      resolve(err ? { ok: false, device: target.name, error: String(err.message ?? err).slice(0, 300) } : { ok: true, device: target.name }),
    )
  })
}

/** Say something on the Echo through the Amazon sign-in (used for slow Echo → VYRSE answers). */
export async function speakOnEcho(text: string): Promise<{ ok: boolean; device?: string; error?: string }> {
  const spoken = await run('speak', text)
  if (spoken.ok) return spoken
  // Some accounts/devices refuse a plain speak; an announcement usually still gets through.
  const announced = await run('announcement', text)
  return announced.ok ? announced : { ...announced, error: `speak: ${spoken.error}; announce: ${announced.error}` }
}

/** Whether a slow answer can be spoken on the Echo later (signed in, with an Echo). */
export function echoReachable(): boolean {
  return status.state === 'ready' && listDevices().length > 0
}


/**
 * What Hermes can ask of the Echo: status and sending a command / speech / announcement. Used by the
 * window and by the phone bridge (a request made from the phone app is carried out here on the PC).
 */
export async function alexaOp(op: string, args: { text?: string; device?: string } = {}): Promise<unknown> {
  switch (op) {
    case 'status':
      return status
    case 'command':
      return run('textCommand', String(args.text ?? ''), args.device)
    case 'speak':
      return run('speak', String(args.text ?? ''), args.device)
    case 'announce':
      return run('announcement', String(args.text ?? ''), args.device)
    default:
      return { ok: false, error: `unknown op ${op}` }
  }
}

export function attachAlexa(main: BrowserWindow): void {
  notify = s => {
    if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.alexaStatus, s)
  }
  ipcMain.handle(IPC_CHANNELS.alexa, async (event, op: string, args: { text?: string; device?: string } = {}) => {
    if (event.sender !== main.webContents) return { ok: false, error: 'not allowed' }
    if (op === 'connect') return connect(main)
    if (op === 'disconnect') return disconnect()
    return alexaOp(op, args)
  })
  // Reconnect quietly at start when a session was saved earlier.
  if (fs.existsSync(SESSION_FILE())) void connect(main)
  app.on('will-quit', () => {
    alexa?.stop()
    alexa = null
  })
}
