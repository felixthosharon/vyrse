import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app, clipboard, ClipboardItem, globalShortcut, ipcMain, type BrowserWindow } from 'electron'

import { IPC_CHANNELS } from '../shared/backend-types'

/**
 * Dictate anywhere: a system-wide shortcut starts (or finishes) dictation in the renderer, which hands
 * the transcript back here to be typed into whatever app has focus. Typing is a paste: the text goes on
 * the clipboard, Ctrl+V is sent to the foreground window, and the user's clipboard is put back.
 *
 * Ctrl+V comes from one PowerShell kept warm for the session (started on first use), so typing doesn't
 * wait for PowerShell to boot each time.
 */
const PASTER = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line -eq 'paste') { [System.Windows.Forms.SendKeys]::SendWait('^v') }",
  "  [Console]::Out.WriteLine('done')",
  "}",
].join('\n')

let paster: ChildProcessWithoutNullStreams | null = null
let pending: Array<() => void> = []

function getPaster(): ChildProcessWithoutNullStreams {
  if (paster && paster.exitCode === null) return paster
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(PASTER, 'utf16le').toString('base64')],
    { windowsHide: true },
  )
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim() === 'done') pending.shift()?.()
  })
  child.on('exit', () => {
    if (paster === child) paster = null
    pending.splice(0).forEach(resolve => resolve())
  })
  paster = child
  return child
}

function sendPaste(): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 3000)
    pending.push(() => {
      clearTimeout(timer)
      resolve()
    })
    getPaster().stdin.write('paste\n')
  })
}

/** A copy of everything on the clipboard (text, images, files) that can be written back later. */
async function snapshotClipboard(): Promise<ClipboardItem[] | null> {
  try {
    const copies: ClipboardItem[] = []
    for (const item of await clipboard.read()) {
      const data: ConstructorParameters<typeof ClipboardItem>[0] = {}
      for (const type of item.types) data[type] = (await item.getType(type as string)) as Blob
      copies.push(new ClipboardItem(data))
    }
    return copies
  } catch {
    return null
  }
}

async function typeIntoFocusedApp(text: string): Promise<void> {
  // Everything on the clipboard (text, images, files) is saved and put back afterwards.
  const saved = await snapshotClipboard()
  await clipboard.writeText(text)
  await sendPaste()
  // Give the target app a moment to read the clipboard before restoring it.
  await new Promise(resolve => setTimeout(resolve, 350))
  if ((await clipboard.readText()) !== text) return // something else wrote the clipboard meanwhile; leave it
  if (saved && saved.length) await clipboard.write(saved).catch(() => {})
  else clipboard.clear()
}

export function attachDictation(main: BrowserWindow): void {
  let current: string | null = null

  ipcMain.handle(IPC_CHANNELS.setDictateShortcut, (event, accelerator: string | null) => {
    if (event.sender !== main.webContents) return false
    if (current) globalShortcut.unregister(current)
    current = null
    if (!accelerator) return true
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (!main.isDestroyed()) main.webContents.send(IPC_CHANNELS.dictateShortcut)
      })
      if (ok) current = accelerator
      if (ok) getPaster() // warm it up now, so the first dictation types instantly
      return ok
    } catch {
      return false
    }
  })

  // Copy buttons: write-only clipboard access from the main process (the renderer's Clipboard API needs a
  // permission grant and a fresh click, and failed silently).
  ipcMain.handle(IPC_CHANNELS.copyText, async (event, text: unknown) => {
    if (event.sender !== main.webContents || typeof text !== 'string') return false
    await clipboard.writeText(text.slice(0, 200_000))
    return true
  })

  ipcMain.handle(IPC_CHANNELS.typeText, async (event, text: unknown) => {
    if (event.sender !== main.webContents || typeof text !== 'string' || !text.trim()) return false
    // VYRSE itself in front: the renderer puts the words in its own composer instead.
    // (Electron keeps reporting a minimised window as focused, hence the extra checks.)
    if (main.isFocused() && main.isVisible() && !main.isMinimized()) return false
    await typeIntoFocusedApp(text.slice(0, 20_000))
    return true
  })

  app.on('will-quit', () => {
    paster?.kill()
    paster = null
  })
}
