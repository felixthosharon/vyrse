// Dev harness: the VYRSE interface (built app/dist, mock backend: no Hermes needed) in OFFSCREEN windows at several
// sizes and both themes, clicked through like a first-time user; a screenshot per state and every page error.
// Nothing appears on screen. Run: npx electron scripts/dev/ui_shots.js <app/dist> <out dir> [only-size-name]
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [dist, out, only, onlyTheme] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const SIZES = [
  ['narrow', 400, 760],
  ['small', 800, 600],
  ['laptop', 1366, 768],
  ['fhd', 1920, 1080],
]
const sleep = ms => new Promise(r => setTimeout(r, ms))
fs.mkdirSync(out, { recursive: true })
const errors = []

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG())
}

const js = (win, code) => win.webContents.executeJavaScript(code, true)
const click = (win, selector) =>
  js(win, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
const clickText = (win, text) =>
  js(win, `(() => { const el = [...document.querySelectorAll('button,[role=button],a,[role=tab],[role=menuitem]')].find(e => e.innerText && e.innerText.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())})); if (!el) return false; el.click(); return true })()`)
const type = (win, text) =>
  js(win, `(() => { const t = document.querySelector('textarea'); if (!t) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); return true })()`)
const key = (win, k, mods = {}) =>
  js(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ctrlKey: ${!!mods.ctrl} })), true`)

async function run(size, theme, first) {
  const [name, w, h] = size
  const tag = `${name}-${theme}`
  const part = session.fromPartition(`ui-${tag}-${Date.now()}`)
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, webPreferences: { offscreen: true, session: part } })
  win.webContents.on('console-message', d => {
    if (d.level === 'error') errors.push(`${tag}: ${d.message}`.slice(0, 300))
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`${tag}: renderer gone ${d.reason}`))
  for (let i = 0; ; i++) {
    try {
      await win.loadFile(path.join(dist, 'index.html'))
      break
    } catch (err) {
      if (i >= 3) throw err
      await sleep(1500)
    }
  }
  await sleep(2500)
  if (first) await shot(win, `${tag}-0-first-run`)
  await js(win, `localStorage.setItem('vyrse.settings.v1', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('vyrse.settings.v1') || '{}'), { userName: 'Sam', theme: '${theme}', onboarded: true }))), true`)
  await win.reload()
  await sleep(2500)
  await shot(win, `${tag}-1-home`)
  const steps = [
    ['2-sent', async () => { await type(win, 'hi, what can you do?'); await sleep(6000) }],
    ['3-long', async () => { await type(win, 'show me a chart of my screen time this week and a table of my top apps'); await sleep(8000) }],
    ['4-settings', async () => { await click(win, '[aria-label="Settings"]'); await sleep(1200) }],
    ['5-settings-voice', async () => { await clickText(win, 'Voice'); await sleep(1000) }],
    ['6-settings-appearance', async () => { await clickText(win, 'Appearance'); await sleep(1000) }],
    ['7-history', async () => { await click(win, '[aria-label="Close settings"]'); await sleep(500); await click(win, '[aria-label="History"]'); await sleep(1200) }],
    ['9-workspace', async () => { await click(win, '[aria-label="Close history"]'); await sleep(400); await click(win, '[aria-label^="Show workspace"]'); await sleep(1500) }],
    ['8-palette', async () => { await click(win, '[aria-label="Close history"]'); await sleep(500); await key(win, 'k', { ctrl: true }); await sleep(1000) }],
  ]
  for (const [label, act] of steps) {
    try {
      await act()
      await shot(win, `${tag}-${label}`)
    } catch (err) {
      errors.push(`${tag} ${label}: ${err.message}`)
    }
  }
  win.destroy()
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  for (const size of SIZES) {
    if (only && size[0] !== only) continue
    for (const theme of ['dark', 'light']) {
      if (onlyTheme && theme !== onlyTheme) continue
      try {
        await run(size, theme, theme === 'dark')
      } catch (err) {
        errors.push(`${size[0]}-${theme}: harness ${err.message}`)
      }
    }
  }
  fs.writeFileSync(path.join(out, 'errors.txt'), errors.join('\n'))
  console.log(`done, ${errors.length} errors`)
  app.quit()
})
