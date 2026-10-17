// Headless lifecycle checks, run with VYRSE_SMOKE=<mode> (see scripts/smoke.ps1). Never used by the app UI.
//   start           start → ready → quit
//   crash           kill the real server once, expect recovery
//   crash-launcher  kill only the venv launcher stub, expect recovery (previously orphaned the server)
//   probe           create a "vyrse" session over the gateway, run one prompt (VYRSE_SMOKE_PROMPT or a terminal
//                   echo), report events and tool calls, quit
//   window          open the real UI window, screenshot it to VYRSE_SMOKE_SHOT, quit
//   ui              type VYRSE_SMOKE_PROMPT into the real composer, wait for Hermes, screenshot, quit

import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import type { BackendConnection, BackendStatus } from '../shared/backend-types'
import { askVyrse } from './alexa-skill'
import type { HermesBackend } from './hermes-backend'

export function runSmoke(mode: string, backend: HermesBackend, quit: (exitCode: number) => void): void {
  let crashInjected = false

  backend.on('status', (status: BackendStatus) => {
    console.log(`[smoke] ${status.phase}: ${status.message}`)
    if (status.phase === 'failed' || status.phase === 'not-installed') return quit(1)
    if (status.phase !== 'ready') return

    const conn = backend.getConnection()!
    console.log(`[smoke] connection ${JSON.stringify({ ...conn, token: '<redacted>' })}`)

    const target = mode === 'crash' ? backend.pids.server : mode === 'crash-launcher' ? backend.pids.launcher : undefined
    if (target && !crashInjected) {
      crashInjected = true
      console.log(`[smoke] killing pid ${target} (${JSON.stringify(backend.pids)}) to simulate a crash`)
      process.kill(target)
      return
    }

    if (mode === 'probe') {
      probeTurn(conn)
        .then(() => quit(0))
        .catch(err => {
          console.log(`[smoke] probe failed: ${(err as Error).message}`)
          quit(1)
        })
      return
    }
    quit(0)
  })
}

/** Minimal raw JSON-RPC exchange; the real client lives in the renderer (vendored @hermes/shared). */
async function probeTurn(conn: BackendConnection): Promise<void> {
  const socket = new WebSocket(`${conn.wsUrl}?token=${encodeURIComponent(conn.token)}`)
  const pending = new Map<string, (msg: any) => void>()
  const events: Record<string, number> = {}
  let nextId = 0
  let onEvent: (type: string, payload: any) => void = () => {}

  socket.addEventListener('message', ev => {
    for (const line of String(ev.data).split('\n')) {
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(String(msg.id))) {
        pending.get(String(msg.id))!(msg)
        pending.delete(String(msg.id))
      } else if (msg.method === 'event') {
        const type = msg.params?.type as string
        events[type] = (events[type] ?? 0) + 1
        onEvent(type, msg.params?.payload)
      } else if (msg.id !== undefined && msg.method) {
        console.log(`[smoke] server request ${msg.method} → declining`)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled by smoke probe' } }))
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('socket error')))
  })

  const call = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = `p${++nextId}`
      pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)))
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })

  const created = await call('session.create', { source: 'vyrse', close_on_disconnect: true })
  const sid = created.session_id as string
  const info = created.info ?? {}
  console.log(`[smoke] session ${sid} model=${info.model} provider=${info.provider}`)

  const started = Date.now()
  let firstDelta = 0
  let text = ''
  const done = new Promise<any>(resolve => {
    onEvent = (type, payload) => {
      if (type === 'message.delta') {
        if (!firstDelta) firstDelta = Date.now()
        text += payload?.text ?? ''
      }
      if (type === 'session.info' && payload?.tools && Object.keys(payload.tools).length) {
        console.log(`[smoke] toolsets ${JSON.stringify(payload.tools)}`)
      }
      if (type === 'tool.start') console.log(`[smoke] tool.start ${payload?.name} ${JSON.stringify(payload?.args ?? payload?.arguments ?? payload?.input ?? '').slice(0, 300)}`)
      if (type === 'tool.complete') console.log(`[smoke] tool.complete ${payload?.name} ${payload?.duration_s ?? ''}s ${JSON.stringify(payload?.result ?? payload?.output ?? '').slice(0, 300)}`)
      if (type === 'message.complete') resolve(payload)
    }
  })
  await call('prompt.submit', {
    session_id: sid,
    text: process.env.VYRSE_SMOKE_PROMPT || 'Use the terminal tool to run `echo vyrse-probe`, then reply with one short sentence.',
  })
  const complete = await done
  console.log(`[smoke] first delta after ${firstDelta ? firstDelta - started : -1} ms, total ${Date.now() - started} ms`)
  console.log(`[smoke] status=${complete?.status} text=${JSON.stringify((complete?.text ?? text).slice(0, 900))}`)
  console.log(`[smoke] events ${JSON.stringify(events)}`)
  socket.close()
}

/** Screenshot the UI once it has rendered and the backend is ready (window mode). */
export function captureWindow(win: BrowserWindow, backend: HermesBackend, file: string, quit: (code: number) => void): void {
  win.webContents.on('console-message', details => console.log(`[smoke] renderer ${details.level}: ${details.message}`))
  const shoot = () =>
    setTimeout(async () => {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(file, image.toPNG())
      console.log(`[smoke] screenshot ${file} (${image.getSize().width}x${image.getSize().height})`)
      quit(0)
    }, 4_000)
  backend.on('status', status => {
    if (status.phase === 'ready') shoot()
  })
}

/**
 * End-to-end UI check (ui mode): types into the real composer like a person would
 * (native text input + Enter), waits for the turn to finish, then screenshots.
 */
export function driveUi(win: BrowserWindow, backend: HermesBackend, prompt: string, file: string, quit: (code: number) => void): void {
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const composerReady = () =>
    js<boolean>(`(() => { const t = document.querySelector('textarea'); return !!t && !t.disabled && !/connecting|reconnecting|offline/i.test(document.querySelector('header')?.innerText ?? '') })()`)

  let started = false
  backend.on('status', status => {
    if (status.phase !== 'ready' || started) return
    started = true
    void (async () => {
      try {
        for (let i = 0; i < 60 && !(await composerReady()); i++) await sleep(500)
        if (process.env.VYRSE_SMOKE_CRASH_FIRST === '1' && backend.pids.server) {
          // Kill Hermes under a connected UI; the shell restarts it and the UI must reconnect.
          console.log(`[smoke] crashing backend ${backend.pids.server} under the connected UI`)
          process.kill(backend.pids.server)
          await sleep(3_000)
          for (let i = 0; i < 120 && !(await composerReady()); i++) await sleep(500)
          console.log(`[smoke] UI reconnected: ${await composerReady()}`)
        }
        await sleep(1_500) // let the resumed conversation settle
        if (process.env.VYRSE_SMOKE_NEW === '1') {
          await js(`document.querySelector('button[aria-label="New conversation"]')?.click()`)
          await sleep(500)
        }
        await js(`document.querySelector('textarea').focus()`)
        win.webContents.insertText(prompt)
        await sleep(200)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        const t0 = Date.now()
        await sleep(1_500)
        if (process.env.VYRSE_SMOKE_STOP_AFTER_MS) {
          // Press the composer's stop button (it becomes Stop while busy) mid-turn.
          await sleep(Number(process.env.VYRSE_SMOKE_STOP_AFTER_MS))
          await js(`document.querySelector('footer button[aria-label="Stop response"]')?.click()`)
          console.log('[smoke] pressed stop')
        }
        let sawBusy = false
        while (Date.now() - t0 < 240_000) {
          const answer = process.env.VYRSE_SMOKE_APPROVE // deny | once | session | always
          if (answer) {
            const dialog = await js<string>(`document.querySelector('[role=alertdialog]')?.innerText ?? ''`)
            if (dialog.includes('wants permission')) {
              console.log(`[smoke] approval shown: ${JSON.stringify(dialog.slice(0, 300))}`)
              const label = { deny: 'Deny', once: 'Allow once', session: 'Allow this session', always: 'Always allow' }[answer]
              await js(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})?.click()`)
              console.log(`[smoke] answered approval: ${label}`)
            }
          }
          const busy = await js<boolean>(`!!document.querySelector('textarea')?.disabled`)
          sawBusy ||= busy
          if (sawBusy && !busy) break
          await sleep(1_000)
        }
        console.log(`[smoke] turn finished after ${Math.round((Date.now() - t0) / 1000)}s (sawBusy=${sawBusy})`)
        await sleep(1_200)
        const footer = await js<string>(`document.querySelector('footer')?.innerText ?? ''`)
        console.log(`[smoke] footer text: ${JSON.stringify(footer.slice(0, 600))}`)
        const image = await win.webContents.capturePage()
        fs.writeFileSync(file, image.toPNG())
        console.log(`[smoke] screenshot ${file}`)
        quit(0)
      } catch (err) {
        console.log(`[smoke] ui drive failed: ${(err as Error).message}`)
        quit(1)
      }
    })()
  })
}

type Step =
  | { click: string; text?: string } // CSS selector; optional exact innerText match among matches
  | { type: string } // native text input into the focused element
  | { enter: true }
  | { focus: string }
  | { wait: number }
  | { waitIdle: number } // wait until the composer is enabled again (turn finished), max ms
  | { shot: string } // screenshot file name (inside VYRSE_SMOKE_DIR)
  | { log: string } // JS expression; result printed
  | { eval: string } // JS statement for test setup/assertion helpers
  | { waitFor: string; timeout?: number } // poll a JS expression until truthy
  | { window: 'minimize' | 'restore' } // main window state
  | { orb: string } // log the floating orb's visibility; screenshot it to this file name when shown
  | { echoAsk: string } // a question as the verified Echo skill gateway would hand it to VYRSE; logs the spoken answer

/**
 * Scripted UI check (script mode): VYRSE_SMOKE_STEPS is a JSON array of Steps run after the
 * backend is ready and the UI is connected. Used to exercise real UI flows end to end.
 */
export function runScript(win: BrowserWindow, backend: HermesBackend, steps: Step[], dir: string, quit: (code: number) => void): void {
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const connected = () =>
    js<boolean>(`(() => { const t = document.querySelector('textarea'); return !!t && !/connecting|reconnecting|offline/i.test(document.querySelector('header')?.innerText ?? '') })()`)
  let started = false
  backend.on('status', status => {
    if (status.phase !== 'ready' || started) return
    started = true
    void (async () => {
      try {
        for (let i = 0; i < 60 && !(await connected()); i++) await sleep(500)
        await sleep(1_500)
        for (const [i, step] of steps.entries()) {
          if ('click' in step) {
            const ok = await js<boolean>(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(step.click)})]; const el = ${step.text ? `els.find(e => e.innerText.trim().startsWith(${JSON.stringify(step.text)}))` : 'els[0]'}; if (!el) return false; el.click(); return true })()`)
            console.log(`[smoke] step ${i} click ${step.click}${step.text ? ` "${step.text}"` : ''}: ${ok ? 'ok' : 'NOT FOUND'}`)
            if (!ok) throw new Error(`element not found: ${step.click}`)
          } else if ('focus' in step) {
            await js(`document.querySelector(${JSON.stringify(step.focus)})?.focus()`)
          } else if ('type' in step) {
            win.webContents.insertText(step.type)
          } else if ('enter' in step) {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
            win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
          } else if ('wait' in step) {
            await sleep(step.wait)
          } else if ('waitIdle' in step) {
            const t0 = Date.now()
            await sleep(1_500)
            while (Date.now() - t0 < step.waitIdle && (await js<boolean>(`!!document.querySelector('textarea')?.disabled`))) await sleep(1_000)
            console.log(`[smoke] step ${i} idle after ${Math.round((Date.now() - t0) / 1000)}s`)
          } else if ('shot' in step) {
            const image = await win.webContents.capturePage()
            const file = path.join(dir, step.shot)
            fs.writeFileSync(file, image.toPNG())
            console.log(`[smoke] step ${i} screenshot ${file}`)
          } else if ('log' in step) {
            const value = await js<unknown>(step.log)
            console.log(`[smoke] step ${i} log: ${JSON.stringify(value)?.slice(0, 800)}`)
          } else if ('eval' in step) {
            await js(step.eval)
          } else if ('window' in step) {
            if (step.window === 'minimize') win.minimize()
            else {
              win.restore()
              win.focus()
            }
          } else if ('orb' in step) {
            const orb = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'VYRSE orb' || w !== win)
            const shown = Boolean(orb && !orb.isDestroyed() && orb.isVisible())
            console.log(`[smoke] step ${i} orb visible: ${shown}${shown ? ` at ${JSON.stringify(orb!.getBounds())}` : ''}`)
            if (shown) {
              const file = path.join(dir, step.orb)
              fs.writeFileSync(file, (await orb!.webContents.capturePage()).toPNG())
            }
          } else if ('echoAsk' in step) {
            const t0 = Date.now()
            const answer = await askVyrse(win, step.echoAsk)
            console.log(`[smoke] step ${i} echo answer after ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(answer)}`)
          } else if ('waitFor' in step) {
            const t0 = Date.now()
            let ok = false
            while (Date.now() - t0 < (step.timeout ?? 60_000) && !(ok = Boolean(await js(step.waitFor)))) await sleep(500)
            console.log(`[smoke] step ${i} waitFor ${ok ? 'met' : 'TIMED OUT'} after ${Math.round((Date.now() - t0) / 1000)}s`)
          }
        }
        quit(0)
      } catch (err) {
        console.log(`[smoke] script failed: ${(err as Error).message}`)
        quit(1)
      }
    })()
  })
}
