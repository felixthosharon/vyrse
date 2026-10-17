import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, type Display, type Rectangle } from 'electron'
import path from 'node:path'

import { IPC_CHANNELS, type OverlayMessage } from '../shared/backend-types'
import { ClickWatch } from './click-watch'
import type { HermesBackend } from './hermes-backend'

/**
 * VYRSE drawing on top of the user's screen: "show me where" rings around real buttons, the ghost cursor while
 * VYRSE drives an app, and live captions. One transparent, click-through, never-focused window
 * per display, created when first needed and hidden when it has nothing to show. It can't be clicked, so it
 * can never get in the way; Esc stops VYRSE while it's driving.
 *
 * Rectangles from Windows (UI Automation, OCR) are physical pixels; they're converted to each display's
 * coordinates here.
 */
export function attachOverlay(main: BrowserWindow, rendererUrl: string | undefined, rendererIndex: string, backend?: HermesBackend): void {
  const windows = new Map<number, BrowserWindow>()
  let escHeld = false

  // A click inside the ring the user was shown takes it away at once (and a walkthrough moves on).
  let ring: Rectangle | null = null // physical pixels
  let ringTimer: NodeJS.Timeout | undefined
  const endRing = () => {
    ring = null
    clearTimeout(ringTimer)
    clicks.stop()
  }
  const clicks = new ClickWatch((x, y) => {
    if (!ring) return
    const pad = 10
    if (x < ring.x - pad || y < ring.y - pad || x > ring.x + ring.width + pad || y > ring.y + ring.height + pad) return
    endRing()
    for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.overlayShow, { kind: 'point', op: 'end' })
    if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.overlayClicked)
    // and straight to the backend too, so a walkthrough moves on even if the window is busy or asleep
    const conn = backend?.getConnection()
    if (conn) {
      void fetch(`${conn.baseUrl}/api/plugins/vyrse/point/clicked`, {
        method: 'POST',
        headers: { 'X-Hermes-Session-Token': conn.token },
        signal: AbortSignal.timeout(3_000),
      }).catch(() => {})
    }
  })

  const create = (display: Display) => {
    const win = new BrowserWindow({
      ...display.bounds,
      title: 'VYRSE overlay',
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true)
    win.setVisibleOnAllWorkspaces(true)
    // Not content-protected: it has to show up in screen recordings (and it's click-through, so harmless).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    if (rendererUrl) void win.loadURL(new URL('overlay.html', rendererUrl).toString())
    else void win.loadFile(path.join(path.dirname(rendererIndex), 'overlay.html'))
    win.on('closed', () => windows.delete(display.id))
    windows.set(display.id, win)
    return win
  }

  const ready = (win: BrowserWindow) =>
    win.webContents.isLoading() ? new Promise<void>(r => win.webContents.once('did-finish-load', () => r())) : Promise.resolve()

  const deliver = async (display: Display, message: OverlayMessage) => {
    let win = windows.get(display.id)
    if (!win || win.isDestroyed()) win = create(display)
    else win.setBounds(display.bounds)
    await ready(win)
    win.webContents.send(IPC_CHANNELS.overlayShow, message)
    if (!win.isVisible()) win.showInactive()
  }

  // Physical-pixel rectangle -> the display it's on, in that display's own coordinates.
  const place = (rect: Rectangle): { display: Display; rect: Rectangle } => {
    const dip = process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect
    const display = screen.getDisplayMatching(dip)
    return { display, rect: { x: dip.x - display.bounds.x, y: dip.y - display.bounds.y, width: dip.width, height: dip.height } }
  }
  // Captions go on the display the user is on (where the mouse is).
  const here = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

  const setEsc = (on: boolean) => {
    if (on && !escHeld) {
      escHeld = globalShortcut.register('Escape', () => {
        if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.overlayStop)
        setEsc(false)
        for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.overlayShow, { kind: 'ghost', op: 'end' })
      })
    } else if (!on && escHeld) {
      globalShortcut.unregister('Escape')
      escHeld = false
    }
  }

  ipcMain.on(IPC_CHANNELS.overlay, (event, message: OverlayMessage) => {
    if (event.sender !== main.webContents || !message || typeof message !== 'object') return
    if (message.kind === 'clear' || (message.kind === 'point' && message.op === 'end')) endRing()
    if (message.kind === 'point' && message.op !== 'end' && message.rect) {
      ring = { ...message.rect }
      clearTimeout(ringTimer)
      ringTimer = setTimeout(endRing, message.hold ? 62_000 : 13_000)
      clicks.start()
    }
    if (message.kind === 'clear') {
      setEsc(false)
      for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.overlayShow, message)
      return
    }
    if ((message.kind === 'point' || message.kind === 'ghost') && message.rect) {
      const { display, rect } = place(message.rect)
      // the other displays drop any ring/cursor they were showing
      for (const [id, w] of windows) if (id !== display.id && !w.isDestroyed()) w.webContents.send(IPC_CHANNELS.overlayShow, { kind: message.kind, op: 'end' })
      if (message.kind === 'ghost') setEsc(message.op !== 'end')
      void deliver(display, { ...message, rect })
      return
    }
    if (message.kind === 'ghost') setEsc(message.op !== 'end')
    void deliver(here(), message)
  })

  // An overlay with nothing on it hides (so it costs nothing while idle).
  ipcMain.on(IPC_CHANNELS.overlayIdle, event => {
    for (const w of windows.values()) if (w.webContents === event.sender && w.isVisible()) w.hide()
  })

  // Live captions hear the PC's own sound (what's playing), not the microphone.
  main.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const [source] = await desktopCapturer.getSources({ types: ['screen'] })
    if (!source) return callback({})
    callback({ video: source, audio: 'loopback' })
  })

  main.on('closed', () => {
    endRing()
    setEsc(false)
    for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  })
}
