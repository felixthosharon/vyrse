import { app, ipcMain, net, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { IPC_CHANNELS, type AppInfo } from '../shared/backend-types'

/** Where new versions are published. Asked anonymously: no account, no identifiers, only "what is the latest release". */
const RELEASES_API = 'https://api.github.com/repos/felixthosharon/vyrse/releases/latest'
const RELEASES_PAGE = 'https://github.com/felixthosharon/vyrse/releases/latest'

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

async function checkForUpdate(): Promise<AppInfo> {
  const version = app.getVersion()
  const info: AppInfo = { version, releasesUrl: RELEASES_PAGE }
  try {
    const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VYRSE-desktop' } })
    if (!res.ok) return { ...info, error: `GitHub answered ${res.status}` }
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : ''
    if (!parseVersion(latest)) return { ...info, error: 'No release found' }
    const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/felixthosharon/vyrse/') ? body.html_url : RELEASES_PAGE
    return { ...info, latest, newer: isNewer(latest, version), releasesUrl: url }
  } catch {
    return { ...info, error: "Couldn't reach GitHub" }
  }
}

/** Small things every desktop app needs: its version, an update check, and pictures pasted from the clipboard. */
export function attachExtras(main: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.appInfo, async (event, check: unknown): Promise<AppInfo | null> => {
    if (event.sender !== main.webContents) return null
    return check === true ? checkForUpdate() : { version: app.getVersion(), releasesUrl: RELEASES_PAGE }
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
