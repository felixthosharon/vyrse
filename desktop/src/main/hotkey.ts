import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron'

import { IPC_CHANNELS } from '../shared/backend-types'

/**
 * Push-to-talk: a system-wide shortcut (works over games and other apps) that toggles VYRSE's
 * listening, exactly like the mic button. The renderer chooses the accelerator (Settings → Voice);
 * registration fails when another app already owns the combination, which the renderer reports.
 */
export function attachTalkShortcut(main: BrowserWindow): void {
  let current: string | null = null

  ipcMain.handle(IPC_CHANNELS.setTalkShortcut, (event, accelerator: string | null) => {
    if (event.sender !== main.webContents) return false
    if (current) globalShortcut.unregister(current)
    current = null
    if (!accelerator) return true
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.talkShortcut)
      })
      if (ok) current = accelerator
      return ok
    } catch {
      return false
    }
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())
}
