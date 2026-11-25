import { BrowserWindow, ipcMain, shell } from 'electron'

import { IPC_CHANNELS, type BackendStatus } from '../shared/backend-types'
import { SECURITY_PAGE } from './app-control'
import type { HermesBackend } from './hermes-backend'
import { trusted } from './guard'

/** Exposes backend connection/status to the renderer and pushes status changes to every window. */
export function registerBackendIpc(backend: HermesBackend): void {
  // Hermes' token goes only to VYRSE's own pages.
  ipcMain.handle(IPC_CHANNELS.getConnection, event => (trusted(event) ? backend.getConnection() : null))
  ipcMain.handle(IPC_CHANNELS.getStatus, event => (trusted(event) ? backend.getStatus() : null))
  ipcMain.handle(IPC_CHANNELS.restart, event => (trusted(event) ? backend.restart() : undefined))
  ipcMain.handle(IPC_CHANNELS.setup, event => (trusted(event) ? backend.setup() : undefined))
  ipcMain.handle(IPC_CHANNELS.installHermes, event => (trusted(event) ? backend.installHermes() : undefined))
  ipcMain.handle(IPC_CHANNELS.openSecurity, event => (trusted(event) ? shell.openExternal(SECURITY_PAGE) : undefined))

  backend.on('status', (status: BackendStatus) => {
    // The renderer never sees log tails unless the backend actually failed.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.status, status)
    }
  })
}
