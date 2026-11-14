import { app, ipcMain, net, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { IPC_CHANNELS, type AppInfo, type UpdateProgress } from '../shared/backend-types'

/** Where new versions are published. Asked anonymously: no account, no identifiers, only "what is the latest release". */
const RELEASES_API = 'https://api.github.com/repos/felixthosharon/vyrse/releases/latest'
const RELEASES_PAGE = 'https://github.com/felixthosharon/vyrse/releases/latest'
/** Installers are only ever taken from this project's own release downloads. */
const DOWNLOAD_PREFIX = 'https://github.com/felixthosharon/vyrse/releases/download/'

const PASTE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }
const PASTE_MAX_BYTES = 25 * 1024 * 1024
const PASTE_KEEP = 30

/** "1.6.0" / "v1.10.2" -> [1, 10, 2]; null when it isn't a plain version. */
export function parseVersion(text: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** true when `latest` is a later release than `current` (anything unparseable is "not newer"). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

/** The file a pasted picture is saved as, or null for a type VYRSE doesn't take. */
export function pasteFileName(mime: string, now: Date): string | null {
  const ext = PASTE_TYPES[mime.toLowerCase()]
  return ext ? `paste-${now.toISOString().replace(/[:.]/g, '-')}.${ext}` : null
}

interface ReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

/**
 * The installer and the checksum list of a release, when both are there and both come from this project's
 * own downloads. Anything else (a renamed file, a link elsewhere) means "no one-click update".
 */
export function updateAssets(assets: unknown, version: string): { installer: string; sums: string; name: string } | null {
  if (!Array.isArray(assets) || !parseVersion(version)) return null
  const name = `VYRSE-Setup-${version}.exe`
  const url = (wanted: string) => {
    const hit = (assets as ReleaseAsset[]).find(a => a?.name === wanted)
    const link = typeof hit?.browser_download_url === 'string' ? hit.browser_download_url : ''
    return link.startsWith(DOWNLOAD_PREFIX) ? link : ''
  }
  const installer = url(name)
  const sums = url('SHA256SUMS.txt')
  return installer && sums ? { installer, sums, name } : null
}

/** The SHA-256 a checksum list gives for `name` ("<hash> *<name>" or "<hash>  <name>" lines). */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2]!.trim() === name) return m[1]!.toLowerCase()
  }
  return null
}

/** Dev-only switches for testing the updater from a source checkout; ignored by the installed app. */
const devVersion = () => (!app.isPackaged && parseVersion(process.env.VYRSE_FAKE_VERSION ?? '') ? process.env.VYRSE_FAKE_VERSION! : null)
const dryRun = () => !app.isPackaged && process.env.VYRSE_UPDATE_DRY === '1'

/** One-click updates need the installed app (the installer replaces it); a source build or unpacked folder doesn't qualify. */
function installedCopy(): boolean {
  if (dryRun()) return true
  return app.isPackaged && process.platform === 'win32' && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall VYRSE.exe'))
}

let found: { version: string; installer: string; sums: string; name: string } | null = null

async function checkForUpdate(): Promise<AppInfo> {
  const version = devVersion() ?? app.getVersion()
  const info: AppInfo = { version, releasesUrl: RELEASES_PAGE }
  try {
    const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VYRSE-desktop' } })
    if (!res.ok) return { ...info, error: `GitHub answered ${res.status}` }
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; assets?: unknown }
    const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : ''
    if (!parseVersion(latest)) return { ...info, error: 'No release found' }
    const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/felixthosharon/vyrse/') ? body.html_url : RELEASES_PAGE
    const newer = isNewer(latest, version)
    const assets = newer ? updateAssets(body.assets, latest) : null
    found = assets ? { version: latest, ...assets } : null
    return { ...info, latest, newer, releasesUrl: url, canInstall: Boolean(assets) && installedCopy() }
  } catch {
    return { ...info, error: "Couldn't reach GitHub" }
  }
}

/** Download the installer, check it against the release's checksum list, and only then return its path. */
async function downloadUpdate(report: (p: UpdateProgress) => void): Promise<string> {
  if (!found) throw new Error('Check for updates first.')
  const { installer, sums, name } = found
  const sumsRes = await net.fetch(sums, { headers: { 'User-Agent': 'VYRSE-desktop' } })
  if (!sumsRes.ok) throw new Error("Couldn't get the checksum list.")
  const expected = checksumFor(await sumsRes.text(), name)
  if (!expected) throw new Error('The release has no checksum for the installer.')

  const res = await net.fetch(installer, { headers: { 'User-Agent': 'VYRSE-desktop' } })
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`)
  const total = Number(res.headers.get('content-length')) || 0
  const dir = path.join(app.getPath('temp'), 'vyrse-update')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const out = fs.createWriteStream(file)
  const hash = crypto.createHash('sha256')
  let done = 0
  let last = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      hash.update(value)
      if (!out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
      done += value.byteLength
      if (Date.now() - last > 250) {
        last = Date.now()
        report({ phase: 'downloading', done, total })
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  report({ phase: 'checking', done, total })
  if (hash.digest('hex') !== expected) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error("The download didn't match the release's checksum, so it was thrown away.")
  }
  return file
}

/** Small things every desktop app needs: its version, updates, and pictures pasted from the clipboard. */
export function attachExtras(main: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.appInfo, async (event, check: unknown): Promise<AppInfo | null> => {
    if (event.sender !== main.webContents) return null
    return check === true ? checkForUpdate() : { version: devVersion() ?? app.getVersion(), releasesUrl: RELEASES_PAGE }
  })

  // One-click update: download, verify, start the installer and step aside (it reopens VYRSE when done).
  let updating = false
  ipcMain.handle(IPC_CHANNELS.installUpdate, async (event): Promise<{ ok: boolean; error?: string }> => {
    if (event.sender !== main.webContents) return { ok: false, error: 'not allowed' }
    if (updating) return { ok: false, error: 'Already updating.' }
    if (!installedCopy()) return { ok: false, error: 'This copy of VYRSE was not installed with the installer.' }
    updating = true
    const report = (p: UpdateProgress) => {
      if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.updateProgress, p)
    }
    try {
      const file = await downloadUpdate(report)
      if (dryRun()) {
        report({ phase: 'ready', done: 0, total: 0 })
        console.log(`[update] verified ${file} (dry run: not started)`)
        return { ok: true }
      }
      report({ phase: 'installing', done: 0, total: 0 })
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(() => app.quit(), 800)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      updating = false
    }
  })

  // A picture pasted into the composer has no file behind it; Hermes reads attachments from disk, so it is
  // saved under VYRSE's own data folder (the newest few are kept).
  ipcMain.handle(IPC_CHANNELS.savePaste, async (event, mime: unknown, bytes: unknown): Promise<string | null> => {
    if (event.sender !== main.webContents || typeof mime !== 'string' || !(bytes instanceof Uint8Array)) return null
    const name = pasteFileName(mime, new Date())
    if (!name || bytes.byteLength === 0 || bytes.byteLength > PASTE_MAX_BYTES) return null
    const dir = path.join(app.getPath('userData'), 'pastes')
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, name)
      fs.writeFileSync(file, bytes)
      for (const old of fs.readdirSync(dir).filter(n => n.startsWith('paste-')).sort().slice(0, -PASTE_KEEP)) {
        fs.rmSync(path.join(dir, old), { force: true })
      }
      return file
    } catch {
      return null
    }
  })
}
