import { app, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * App-wide guards, so no window - present or future - can be turned against the app:
 * - VYRSE's own pages (the bundled renderer, or the dev server) are the only ones that may use its IPC;
 * - no window may embed <webview>s or open new windows;
 * - VYRSE's pages never navigate anywhere else (the Amazon sign-in window, a separate session with no
 *   preload, is the only window that browses).
 */
let rendererRoot = ''
let devOrigin = ''

export function installGuards(rendererUrl: string | undefined, rendererIndex: string): void {
  rendererRoot = pathToFileURL(path.dirname(rendererIndex)).href.toLowerCase() + '/'
  devOrigin = rendererUrl ? new URL(rendererUrl).origin : ''
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (isOwnPage(contents.getURL()) && !isOwnPage(url)) event.preventDefault()
    })
  })
}

export function isOwnPage(url: string | undefined): boolean {
  if (!url) return false
  if (devOrigin && url.startsWith(devOrigin + '/')) return true
  return Boolean(rendererRoot) && url.toLowerCase().startsWith(rendererRoot)
}

/** IPC from VYRSE's own pages only (never the sandboxed frame workspace mini apps run in). */
export function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  return isOwnPage(url) && !/\/app-frame\.html(?:[?#]|$)/i.test(url ?? '')
}
