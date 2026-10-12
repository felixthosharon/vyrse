import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'node:path'

import { IPC_CHANNELS, type OrbState } from '../shared/backend-types'

const SIZE = { width: 540, height: 72 }
const TOP = 8

/**
 * The status pill: a slim always-on-top capsule at the top-centre of the screen that mirrors VYRSE's
 * presence (listening, working, speaking, reminders) with a short caption while the main window is
 * minimised or behind other windows. Clicking it brings VYRSE back. It never takes focus, and the
 * transparent area around it is click-through.
 */
export function attachOrb(main: BrowserWindow, rendererUrl: string | undefined, rendererIndex: string): void {
  let orb: BrowserWindow | null = null
  let state: OrbState = { active: false, presence: 'idle' }

  const covered = () => main.isMinimized() || !main.isVisible() || !main.isFocused()

  const create = () => {
    const area = screen.getDisplayMatching(main.getBounds()).workArea
    const win = new BrowserWindow({
      ...SIZE,
      x: Math.round(area.x + (area.width - SIZE.width) / 2),
      y: area.y + TOP,
      title: 'VYRSE orb',
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
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    // Only the pill itself takes clicks; the transparent rest of the window passes them through.
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setVisibleOnAllWorkspaces(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('did-finish-load', () => win.webContents.send(IPC_CHANNELS.orbState, state))
    if (rendererUrl) void win.loadURL(new URL('orb.html', rendererUrl).toString())
    else void win.loadFile(path.join(path.dirname(rendererIndex), 'orb.html'))
    win.on('closed', () => {
      if (orb === win) orb = null
    })
    return win
  }

  const sync = () => {
    if (main.isDestroyed()) return
    if (state.active && covered()) {
      orb ??= create()
      orb.webContents.send(IPC_CHANNELS.orbState, state)
      if (!orb.isVisible()) orb.showInactive()
    } else if (orb?.isVisible()) {
      orb.hide()
    }
  }

  ipcMain.on(IPC_CHANNELS.presence, (event, next: OrbState) => {
    if (event.sender !== main.webContents) return
    state = {
      active: Boolean(next?.active),
      presence: String(next?.presence ?? 'idle'),
      ...(next?.label ? { label: String(next.label).slice(0, 60) } : {}),
    }
    sync()
  })
  ipcMain.on(IPC_CHANNELS.orbInteractive, (event, interactive: boolean) => {
    if (!orb || orb.isDestroyed() || event.sender !== orb.webContents) return
    orb.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on(IPC_CHANNELS.showMain, () => {
    if (main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  })

  for (const e of ['focus', 'blur', 'minimize', 'restore', 'hide', 'show'] as const) main.on(e as 'focus', sync)
  main.on('closed', () => {
    if (orb && !orb.isDestroyed()) orb.destroy()
    orb = null
  })
}
