import { app, BrowserWindow, shell } from 'electron'
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

  // Developer UI checks can run without a window appearing on screen (never in the installed app).
  const offscreen = !app.isPackaged && process.env.VYRSE_SMOKE_HIDDEN === '1'
  win.once('ready-to-show', () => {
    if (!offscreen) return win.show()
    win.setPosition(-6000, -6000)
    win.showInactive()
  })

  // Voice needs the microphone; nothing else (camera, geolocation, notifications, clipboard…) is granted.
  // Copy buttons write through the main process instead (desktop.copyText).
  const allowed = new Set(['media', 'audioCapture', 'speaker-selection'])
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    // display-capture: live captions hear the PC's sound (the video track is dropped at once)
    callback(permission === 'display-capture' || (allowed.has(permission) && !mediaTypes.includes('video')))
  })
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => allowed.has(permission) || permission === 'display-capture')

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

  // A hidden test run starts on a new conversation instead of continuing the user's latest one.
  const query = offscreen ? { test: '1' } : undefined
  if (rendererUrl) void win.loadURL(offscreen ? `${rendererUrl}${rendererUrl.includes('?') ? '&' : '?'}test=1` : rendererUrl)
  else void win.loadFile(rendererIndex, query ? { query } : undefined)
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
