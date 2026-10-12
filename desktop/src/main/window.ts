import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

/**
 * The renderer is the existing VYRSE UI: a Vite dev server in development
 * (VYRSE_RENDERER_URL) or the built `app/dist/index.html` in production.
 */
export function createMainWindow(rendererUrl: string | undefined, rendererIndex: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: '#05070b',
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    title: 'VYRSE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Wake-word capture and streaming must keep running while minimised.
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Voice needs the microphone; nothing else (camera, geolocation, notifications, clipboard…) is granted.
  // Copy buttons write through the main process instead (desktop.copyText).
  const allowed = new Set(['media', 'audioCapture', 'speaker-selection'])
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    callback(allowed.has(permission) && !mediaTypes.includes('video'))
  })
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  // The UI is a single page: never navigate away, open external links in the real browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:\/\//.test(url) && !isLocal(url)) void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isLocal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererUrl) void win.loadURL(rendererUrl)
  else void win.loadFile(rendererIndex)
  return win
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1'
  } catch {
    return false
  }
}
