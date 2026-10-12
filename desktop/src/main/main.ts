import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { HermesBackend } from './hermes-backend'
import { installGuards } from './guard'
import { registerBackendIpc } from './ipc'
import { captureWindow, driveUi, runScript, runSmoke } from './smoke'
import { attachTalkShortcut } from './hotkey'
import { attachDictation } from './dictation'
import { attachAlexa } from './alexa'
import { attachEchoSkill } from './alexa-skill'
import { attachQuickAsk } from './quick'
import { attachPhoneBridge } from './phone-bridge'
import { attachOrb } from './orb'
import { createMainWindow } from './window'

// Test-only: feed Chromium's fake microphone from a WAV file (end-to-end voice smoke tests).
if (process.env.VYRSE_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.VYRSE_FAKE_MIC)
}

// VYRSE is a normal app: one instance, closing the window quits and stops Hermes.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main().catch(err => {
    // A startup failure must never leave a windowless VYRSE (and its Hermes) running.
    console.error('[vyrse] fatal startup error:', err)
    app.exit(1)
  })
}

async function main(): Promise<void> {
  // Headless lifecycle checks (see smoke.ts); unset in normal use.
  // Developer switches (dev server URL, smoke-test scripts) do nothing in the installed app: there they
  // would let anything that can set an environment variable load other code with VYRSE's privileges.
  const smoke = app.isPackaged ? undefined : process.env.VYRSE_SMOKE
  const rendererUrl = app.isPackaged ? undefined : process.env.VYRSE_RENDERER_URL
  // Packaged: the built UI ships in resources/renderer. Dev: the sibling app/dist build.
  const rendererIndex = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'index.html')
    : path.resolve(__dirname, '..', '..', '..', 'app', 'dist', 'index.html')
  const backend = new HermesBackend(path.join(app.getPath('logs'), 'hermes-backend.log'))
  let quitting = false

  let mainWindow: BrowserWindow | null = null
  app.on('second-instance', () => {
    const win = mainWindow
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.on('window-all-closed', () => app.quit())

  // Stop Hermes (and its llama-server) before Electron exits.
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void backend.stop().finally(() => app.exit(Number(process.exitCode ?? 0)))
  })

  installGuards(rendererUrl, rendererIndex)
  await app.whenReady()
  registerBackendIpc(backend)

  if (smoke === 'script') {
    const win = createMainWindow(rendererUrl, rendererIndex)
    attachOrb(win, rendererUrl, rendererIndex)
    attachTalkShortcut(win)
    attachDictation(win)
    attachAlexa(win)
    attachEchoSkill(win)
    attachQuickAsk(win, rendererUrl, rendererIndex)
    attachPhoneBridge(win, backend)
    win.webContents.on('console-message', d => {
      if (d.level === 'warning' || d.level === 'error' || d.message.startsWith('[vyrse:voice]'))
        console.log(`[smoke] renderer ${d.level}: ${d.message}`)
    })
    const steps = JSON.parse(fs.readFileSync(process.env.VYRSE_SMOKE_STEPS!, 'utf8'))
    runScript(win, backend, steps, process.env.VYRSE_SMOKE_DIR ?? app.getPath('temp'), code => {
      process.exitCode = code
      app.quit()
    })
  } else if (smoke === 'ui') {
    const win = createMainWindow(rendererUrl, rendererIndex)
    win.webContents.on('console-message', d => {
      if (d.level === 'warning' || d.level === 'error') console.log(`[smoke] renderer ${d.level}: ${d.message}`)
    })
    driveUi(
      win,
      backend,
      process.env.VYRSE_SMOKE_PROMPT ?? 'Use the terminal to run `echo vyrse-ui-test`, then tell me the output in one sentence.',
      process.env.VYRSE_SMOKE_SHOT ?? path.join(app.getPath('temp'), 'vyrse-ui.png'),
      code => {
        process.exitCode = code
        app.quit()
      },
    )
  } else if (smoke === 'window') {
    const win = createMainWindow(rendererUrl, rendererIndex)
    captureWindow(win, backend, process.env.VYRSE_SMOKE_SHOT ?? path.join(app.getPath('temp'), 'vyrse-window.png'), code => {
      process.exitCode = code
      app.quit()
    })
  } else if (smoke) {
    runSmoke(smoke, backend, code => {
      process.exitCode = code
      app.quit()
    })
  } else {
    mainWindow = createMainWindow(rendererUrl, rendererIndex)
    attachOrb(mainWindow, rendererUrl, rendererIndex)
    attachTalkShortcut(mainWindow)
    attachDictation(mainWindow)
    attachAlexa(mainWindow)
    attachEchoSkill(mainWindow)
    attachQuickAsk(mainWindow, rendererUrl, rendererIndex)
    attachPhoneBridge(mainWindow, backend)
  }

  void backend.start()
}
