import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, type NativeImage, type Rectangle } from 'electron'

import { IPC_CHANNELS } from '../shared/backend-types'

/**
 * "What's this?": a system-wide shortcut freezes the screen under the cursor, the user drags a box over anything
 * (an error message, a chart, a setting, a line of code), and VYRSE gets that picture with the question.
 *
 * The screen is captured BEFORE the selection window opens, so the picture never contains VYRSE's own overlay.
 * The selection page has no preload and no scripts from outside: it reports the box by navigating to a URL that
 * is caught here and never loaded.
 */
const KEEP = 12
/** smaller than this (in screen pixels) is a stray click, not a selection */
const MIN_SIDE = 12
const REPORT = 'https://explain.invalid/'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:transparent;font:500 13px "Segoe UI",system-ui,sans-serif}
#shot{position:fixed;inset:0;width:100%;height:100%}
#dim{position:fixed;inset:0;background:rgba(6,9,13,.42)}
#box{position:fixed;display:none;border:1.5px solid rgba(127,227,255,.95);border-radius:6px;box-shadow:0 0 0 100vmax rgba(6,9,13,.42),0 0 24px rgba(127,227,255,.35)}
#hint{position:fixed;left:50%;top:28px;transform:translateX(-50%);padding:9px 16px;border-radius:999px;color:#f2f5f8;background:rgba(16,20,26,.86);border:1px solid rgba(255,255,255,.14);white-space:nowrap}
#hint b{color:#7fe3ff;font-weight:600}
</style></head><body><img id="shot" draggable="false"><div id="dim"></div><div id="box"></div>
<div id="hint">Drag a box over what you want explained &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
<script>
const box=document.getElementById('box'),dim=document.getElementById('dim');let a=null;
const done=s=>{location.href=${JSON.stringify(REPORT)}+s};
const rect=e=>({x:Math.min(a.x,e.clientX),y:Math.min(a.y,e.clientY),w:Math.abs(e.clientX-a.x),h:Math.abs(e.clientY-a.y)});
addEventListener('mousedown',e=>{if(e.button!==0){done('cancel');return}a={x:e.clientX,y:e.clientY};dim.style.display='none';box.style.display='block';box.style.left=a.x+'px';box.style.top=a.y+'px';box.style.width='0';box.style.height='0'});
addEventListener('mousemove',e=>{if(!a)return;const r=rect(e);box.style.left=r.x+'px';box.style.top=r.y+'px';box.style.width=r.w+'px';box.style.height=r.h+'px'});
addEventListener('mouseup',e=>{if(!a)return;const r=rect(e);done([r.x,r.y,r.w,r.h].map(Math.round).join(','))});
addEventListener('keydown',e=>{if(e.key==='Escape')done('cancel')});
</script></body></html>`

/** The box the page reported ("x,y,w,h" in CSS pixels of the selection window), or null for a cancel or nonsense. */
export function parseSelection(url: string): Rectangle | null {
  if (!url.startsWith(REPORT)) return null
  const parts = url.slice(REPORT.length).split(',').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0)) return null
  const [x, y, width, height] = parts as [number, number, number, number]
  return { x, y, width, height }
}

/** The selection in the screenshot's own pixels, clamped to the picture; null when it is too small to mean anything. */
export function cropRect(sel: Rectangle, win: { width: number; height: number }, image: { width: number; height: number }): Rectangle | null {
  const sx = image.width / win.width
  const sy = image.height / win.height
  const x = Math.max(0, Math.min(image.width - 1, Math.round(sel.x * sx)))
  const y = Math.max(0, Math.min(image.height - 1, Math.round(sel.y * sy)))
  const width = Math.min(image.width - x, Math.round(sel.width * sx))
  const height = Math.min(image.height - y, Math.round(sel.height * sy))
  return width >= MIN_SIDE && height >= MIN_SIDE ? { x, y, width, height } : null
}

async function captureDisplay(display: Electron.Display): Promise<NativeImage | null> {
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find(s => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  const image = source?.thumbnail
  return image && !image.isEmpty() ? image : null
}

function save(image: NativeImage): string | null {
  const dir = path.join(app.getPath('userData'), 'pastes')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = path.join(dir, `explain-${stamp}.png`)
    fs.writeFileSync(file, image.toPNG())
    for (const old of fs.readdirSync(dir).filter(n => n.startsWith('explain-')).sort().slice(0, -KEEP)) {
      fs.rmSync(path.join(dir, old), { force: true })
    }
    return file
  } catch {
    return null
  }
}

export function attachExplain(main: BrowserWindow): void {
  let current: string | null = null
  let picker: BrowserWindow | null = null

  const start = async (): Promise<void> => {
    if (picker || main.isDestroyed()) return
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const shot = await captureDisplay(display).catch(() => null)
    if (!shot || picker) return
    const win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    picker = win
    win.setAlwaysOnTop(true, 'screen-saver')
    const close = (): void => {
      if (picker === win) picker = null
      if (!win.isDestroyed()) win.destroy()
    }
    const finish = (url: string): void => {
      const size = shot.getSize()
      const sel = parseSelection(url)
      const crop = sel ? cropRect(sel, display.bounds, size) : null
      close()
      if (!crop || main.isDestroyed()) return
      const file = save(shot.crop(crop))
      if (!file) return
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
      main.webContents.send(IPC_CHANNELS.explainRegion, file)
    }
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      finish(url)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('blur', close)
    win.on('closed', () => {
      if (picker === win) picker = null
    })
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
      // the frozen screen sits under the dimmer, so nothing moves while a box is drawn
      await win.webContents.executeJavaScript(`document.getElementById('shot').src=${JSON.stringify(shot.toDataURL())};true`)
      if (!win.isDestroyed()) {
        win.show()
        win.focus()
      }
    } catch {
      close()
    }
  }

  ipcMain.handle(IPC_CHANNELS.setExplainShortcut, (event, accelerator: string | null) => {
    if (event.sender !== main.webContents) return false
    if (current) globalShortcut.unregister(current)
    current = null
    if (!accelerator) return true
    try {
      const ok = globalShortcut.register(accelerator, () => void start())
      if (ok) current = accelerator
      return ok
    } catch {
      return false
    }
  })
  ipcMain.on(IPC_CHANNELS.explainStart, event => {
    if (event.sender === main.webContents) void start()
  })
}
