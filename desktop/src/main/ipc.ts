import { BrowserWindow, ipcMain } from 'electron'

import { IPC_CHANNELS, type BackendStatus } from '../shared/backend-types'
import type { HermesBackend } from './hermes-backend'
import { trusted } from './guard'

/** Exposes backend connection/status to the renderer and pushes status changes to every window. */
export function registerBackendIpc(backend: HermesBackend): void {
  // Hermes' token goes only to VYRSE's own pages.
  ipcMain.handle(IPC_CHANNELS.getConnection, event => (trusted(event) ? backend.getConnection() : null))
  ipcMain.handle(IPC_CHANNELS.getStatus, event => (trusted(event) ? backend.getStatus() : null))
  ipcMain.handle(IPC_CHANNELS.restart, event => (trusted(event) ? backend.restart() : undefined))

  backend.on('status', (status: BackendStatus) => {
    // The renderer never sees log tails unless the backend actually failed.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.status, status)
    }
  })
}
