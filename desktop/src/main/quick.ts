import path from 'node:path'

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'

import { IPC_CHANNELS } from '../shared/backend-types'

const WIDTH = 700
const MIN_HEIGHT = 72
const MAX_HEIGHT = 540

/**
 * Quick-ask bar: a system-wide shortcut opens a small Spotlight-style bar over whatever app is in front
 * (on the screen with the mouse). The question goes to the main window, which asks Hermes in the open
 * conversation and streams the reply back here. Esc, the shortcut again, or clicking elsewhere hides it.
 */
export function attachQuickAsk(main: BrowserWindow, rendererUrl: string | undefined, rendererIndex: string): void {
  let bar: BrowserWindow | null = null
  let accelerator: string | null = null

  const create = () => {
    const win = new BrowserWindow({
      width: WIDTH,
      height: MIN_HEIGHT,
      title: 'VYRSE quick ask',
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    // Clicking anywhere else dismisses it, like Spotlight.
    win.on('blur', () => hide())
    if (rendererUrl) void win.loadURL(new URL('quick.html', rendererUrl).toString())
    else void win.loadFile(path.join(path.dirname(rendererIndex), 'quick.html'))
    win.on('closed', () => {
      if (bar === win) bar = null
    })
    return win
  }

  const hide = () => {
    if (!bar || bar.isDestroyed() || !bar.isVisible()) return
    bar.webContents.send(IPC_CHANNELS.quickHide)
    bar.hide()
  }

  const show = () => {
    bar ??= create()
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const [, height] = bar.getSize()
    bar.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height * 0.2), width: WIDTH, height: height ?? MIN_HEIGHT })
    const reveal = () => {
      bar?.show()
      bar?.focus()
      bar?.webContents.send(IPC_CHANNELS.quickShow)
    }
    if (bar.webContents.isLoading()) bar.webContents.once('did-finish-load', reveal)
    else reveal()
  }

  const toggle = () => (bar?.isVisible() ? hide() : show())

  ipcMain.handle(IPC_CHANNELS.setQuickShortcut, (event, next: string | null) => {
    if (event.sender !== main.webContents) return false
    if (accelerator) globalShortcut.unregister(accelerator)
    accelerator = null
    if (!next) return true
    try {
      const ok = globalShortcut.register(next, toggle)
      if (ok) accelerator = next
      return ok
    } catch {
      return false
    }
  })

  const fromBar = (sender: Electron.WebContents) => Boolean(bar && !bar.isDestroyed() && sender === bar.webContents)

  ipcMain.on(IPC_CHANNELS.quickAsk, (event, payload: { id?: unknown; text?: unknown }) => {
    if (!fromBar(event.sender) || typeof payload?.id !== 'string' || typeof payload.text !== 'string') return
    if (main.isDestroyed()) return
    main.webContents.send(IPC_CHANNELS.quickForward, { id: payload.id.slice(0, 64), text: payload.text.slice(0, 4000) })
  })
  ipcMain.on(IPC_CHANNELS.quickAnswer, (event, update: unknown) => {
    if (event.sender !== main.webContents || !bar || bar.isDestroyed()) return
    bar.webContents.send(IPC_CHANNELS.quickUpdate, update)
  })
  ipcMain.on(IPC_CHANNELS.quickResize, (event, height: unknown) => {
    if (!fromBar(event.sender) || typeof height !== 'number' || !bar) return
    const [width] = bar.getSize()
    bar.setSize(width ?? WIDTH, Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height))))
  })
  ipcMain.on(IPC_CHANNELS.quickHideRequest, event => {
    if (fromBar(event.sender)) hide()
  })
  ipcMain.on(IPC_CHANNELS.quickOpenMain, event => {
    if (!fromBar(event.sender) || main.isDestroyed()) return
    hide()
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  })

  main.on('closed', () => {
    if (bar && !bar.isDestroyed()) bar.destroy()
    bar = null
  })
  app.on('will-quit', () => {
    if (accelerator) globalShortcut.unregister(accelerator)
  })
}
