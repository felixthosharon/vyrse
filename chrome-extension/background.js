// VYRSE for Chrome: lets VYRSE (the assistant running on this PC) use the tabs of THIS Chrome, your everyday
// profile with your logins, instead of a separate browser. It connects only to VYRSE on 127.0.0.1 with the token
// setup wrote into config.js, and only does what VYRSE asks for: list/open/switch tabs, read a page, click, type,
// press keys, scroll, take a screenshot, highlight something. Clicks and typing go through Chrome's debugger
// protocol so pages treat them as real input (Chrome shows "VYRSE started debugging this browser" meanwhile).
import { CONFIG } from './config.js'

const URL = `ws://127.0.0.1:${CONFIG.port}/`
let ws = null
let ready = false

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  try {
    ws = new WebSocket(URL)
  } catch {
    return
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: CONFIG.token, version: chrome.runtime.getManifest().version }))
  ws.onmessage = async (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    if (msg.type === 'welcome') {
      ready = true
      setStatus(true, msg.latest || '')
      return
    }
    if (msg.type !== 'command') return
    let reply
    try {
      reply = { type: 'result', id: msg.id, ok: true, result: await run(msg.cmd, msg.args || {}) }
    } catch (err) {
      reply = { type: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) }
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply))
  }
  ws.onclose = () => {
    ws = null
    ready = false
    setStatus(false)
  }
  ws.onerror = () => {}
}

// The badge: nothing when all's well, "!" when VYRSE isn't running, "↑" when VYRSE has a newer copy installed
// (pressing reload on this extension's card in chrome://extensions loads it).
function setStatus(on, latest = '') {
  const outdated = !!(on && latest && latest !== chrome.runtime.getManifest().version)
  chrome.storage.session.set({ connected: on, latest: on ? latest : '' }).catch(() => {})
  chrome.action.setBadgeText({ text: !on ? '!' : outdated ? '↑' : '' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: outdated ? '#5fd4ee' : '#e5007a' }).catch(() => {})
}

// A message every 20 s keeps the service worker (and so the connection) alive; the alarm brings it back after
// Chrome stops the worker or VYRSE restarts.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
  else connect()
}, 20000)
chrome.alarms.create('vyrse-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'status') {
    connect()
    chrome.storage.session.get('latest').then((v) => reply({ connected: ready, latest: (v && v.latest) || '' }), () => reply({ connected: ready }))
    return true
  }
})
connect()

// ---------------------------------------------------------------------------------------------------- tabs
async function currentTab(tabId) {
  if (tabId) return chrome.tabs.get(Number(tabId))
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab) return tab
  const [any] = await chrome.tabs.query({ active: true })
  if (!any) throw new Error('No Chrome tab is open.')
  return any
}

function tabInfo(t) {
  return { tab: t.id, title: t.title, url: t.url, active: t.active, window: t.windowId }
}

function waitLoaded(tabId, ms = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listen)
      clearTimeout(timer)
      setTimeout(resolve, 300)
    }
    const listen = (id, info) => {
      if (id === tabId && info.status === 'complete') done()
    }
    const timer = setTimeout(done, ms)
    chrome.tabs.onUpdated.addListener(listen)
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(), done)
  })
}

// ------------------------------------------------------------------------------------- real input (debugger)
const attached = new Map() // tabId -> detach timer

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
    } catch (err) {
      if (!String(err).includes('Already attached')) throw err
    }
  }
  clearTimeout(attached.get(tabId))
  attached.set(tabId, setTimeout(() => {
    attached.delete(tabId)
    chrome.debugger.detach({ tabId }).catch(() => {})
  }, 30000))
  return chrome.debugger.sendCommand({ tabId }, method, params)
}
chrome.debugger.onDetach.addListener((source) => {
  clearTimeout(attached.get(source.tabId))
  attached.delete(source.tabId)
})

const KEYS = {
  enter: ['Enter', 13, '\r'], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27], backspace: ['Backspace', 8],
  delete: ['Delete', 46], up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
  pageup: ['PageUp', 33], pagedown: ['PageDown', 34], home: ['Home', 36], end: ['End', 35], space: [' ', 32, ' '],
  f5: ['F5', 116],
}

async function pressKeys(tabId, combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  let modifiers = 0
  let key = null
  for (const p of parts) {
    if (p === 'alt') modifiers |= 1
    else if (p === 'ctrl' || p === 'control') modifiers |= 2
    else if (p === 'meta' || p === 'win' || p === 'cmd') modifiers |= 4
    else if (p === 'shift') modifiers |= 8
    else key = p
  }
  if (!key) throw new Error(`No key in '${combo}'`)
  let [name, code, text] = KEYS[key] || [key.length === 1 ? key : key[0].toUpperCase() + key.slice(1), key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, key.length === 1 ? key : undefined]
  if (modifiers & 2 || modifiers & 1 || modifiers & 4) text = undefined
  const base = { modifiers, key: name, windowsVirtualKeyCode: code, code: name.length === 1 ? `Key${name.toUpperCase()}` : name }
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text })
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function clickAt(tabId, x, y, count = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count })
}

// ---------------------------------------------------------------------------------------- in-page helpers
async function inPage(tabId, func, ...args) {
  return inFrame(tabId, 0, func, ...args)
}

async function inFrame(tabId, frameId, func, ...args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId || 0] }, func, args })
  if (!res) throw new Error("Couldn't run in that page (Chrome blocks extensions on chrome:// and Web Store pages).")
  return res.result
}

async function inAllFrames(tabId, func, ...args) {
  try {
    return await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args })
  } catch (err) {
    // one frame Chrome won't let us into (e.g. a chrome-extension:// frame) mustn't hide the rest
    const res = await chrome.scripting.executeScript({ target: { tabId }, func, args })
    if (!res || !res.length) throw err
    return res
  }
}

// Runs in every frame: its size, address and the iframes it holds (to place frames inside the tab).
function frameInfo() {
  const iframes = []
  for (const f of document.querySelectorAll('iframe,frame')) {
    const r = f.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    let src = ''
    try { src = new URL(f.src || f.getAttribute('src') || '', location.href).href } catch {}
    iframes.push({ x: r.left + f.clientLeft, y: r.top + f.clientTop, w: f.clientWidth || r.width, h: f.clientHeight || r.height, src })
  }
  return { url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, iframes }
}

// Where each frame's top-left sits in the tab's viewport (CSS px). Frames from other sites can't say, so each one
// is matched to an <iframe> in its parent by address, then by size.
async function frameOffsets(tabId) {
  const infos = await inAllFrames(tabId, frameInfo)
  const byId = new Map(infos.filter((r) => r && r.result).map((r) => [r.frameId, r.result]))
  let tree = []
  try {
    tree = (await chrome.webNavigation.getAllFrames({ tabId })) || []
  } catch {}
  const parentOf = new Map(tree.map((f) => [f.frameId, f.parentFrameId]))
  const offsets = new Map([[0, { x: 0, y: 0 }]])
  const used = new Set()
  const same = (a, b) => {
    try {
      const A = new URL(a), B = new URL(b)
      return A.origin === B.origin && (A.pathname === B.pathname || A.href === B.href)
    } catch { return false }
  }
  const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin } catch { return false } }
  for (let pass = 0; pass < 4; pass++) {
    for (const [id, info] of byId) {
      if (offsets.has(id)) continue
      const parent = parentOf.has(id) ? parentOf.get(id) : 0
      if (!offsets.has(parent) || !byId.has(parent)) continue
      const holes = byId.get(parent).iframes.map((f, i) => ({ ...f, key: `${parent}:${i}` })).filter((f) => !used.has(f.key))
      const fits = (f) => Math.abs(f.w - info.w) <= 4 && Math.abs(f.h - info.h) <= 4
      const pick = holes.find((f) => same(f.src, info.url) && fits(f)) || holes.find((f) => same(f.src, info.url)) ||
        holes.find((f) => sameOrigin(f.src, info.url) && fits(f)) || holes.find(fits)
      if (!pick) continue
      used.add(pick.key)
      const base = offsets.get(parent)
      offsets.set(id, { x: base.x + pick.x, y: base.y + pick.y })
    }
  }
  return { offsets, top: byId.get(0) }
}

// Runs inside each frame: number every visible control (icon-only ones included) and describe it.
function pageSnapshot(withText) {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],[contenteditable=""],[contenteditable=true],' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],' +
    '[role=combobox],[role=textbox],[role=searchbox],[role=menuitemcheckbox],[role=menuitemradio],[role=treeitem],[onclick],[tabindex]:not([tabindex="-1"])'
  const vw = innerWidth
  const vh = innerHeight
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby')
    const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : ''
    const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText : ''
    const img = el.querySelector?.('img[alt]')
    const svgTitle = el.querySelector?.('svg title')
    const candidates = [el.getAttribute('aria-label'), labelled, el.innerText, el.value && el.type !== 'password' && /button|submit|reset/.test(el.type) ? el.value : '',
      forLabel, el.getAttribute('title'), el.getAttribute('placeholder'), el.getAttribute('alt'), img?.getAttribute('alt'),
      svgTitle?.textContent, el.getAttribute('data-tooltip'), el.getAttribute('data-tip'), el.getAttribute('data-original-title'),
      el.getAttribute('mattooltip'), el.getAttribute('name')]
    for (const c of candidates) {
      const t = clean(c)
      if (t) return t.slice(0, 80)
    }
    return ''
  }
  const iconHint = (el) => {
    const bits = []
    const walk = [el, ...el.querySelectorAll('svg,use,i,span,img')].slice(0, 6)
    for (const n of walk) {
      const cls = typeof n.className === 'string' ? n.className : n.getAttribute?.('class') || ''
      for (const c of cls.split(/\s+/)) if (/icon|fa-|bi-|glyph|material|symbol|ico[-_]/i.test(c)) bits.push(c)
      const href = n.getAttribute?.('href') || n.getAttribute?.('xlink:href') || ''
      if (href.startsWith('#')) bits.push(href.slice(1))
      if (n.tagName === 'IMG') bits.push((n.getAttribute('src') || '').split('/').pop().split('?')[0])
      if (/material-(icons|symbols)/.test(cls)) bits.push(clean(n.textContent))
    }
    return clean([...new Set(bits)].join(' ')).slice(0, 80)
  }
  const roleOf = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'select', TEXTAREA: 'textbox', SUMMARY: 'button', LABEL: 'label' }[el.tagName]) ||
    (el.tagName === 'INPUT' ? (/button|submit|reset|image/.test(el.type) ? 'button' : el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : el.type === 'search' ? 'searchbox' : 'textbox') : el.isContentEditable ? 'textbox' : 'button')
  document.querySelectorAll('[data-vyrse-ref]').forEach((el) => el.removeAttribute('data-vyrse-ref'))
  const out = []
  let n = 0
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2))
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2))
    const top = document.elementFromPoint(cx, cy)
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue
    n += 1
    el.setAttribute('data-vyrse-ref', String(n))
    const name = nameOf(el)
    const item = { local: n, type: roleOf(el), name, rect: { x: r.left, y: r.top, width: r.width, height: r.height } }
    if (!clean(el.innerText) && !el.value) {
      item.icon = true
      const hint = iconHint(el)
      if (hint) item.hint = hint
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') item.value = el.type === 'password' ? '' : clean(el.value).slice(0, 60)
    if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked
    else if (el.getAttribute('aria-checked')) item.checked = el.getAttribute('aria-checked') === 'true'
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true
    out.push(item)
    if (n >= 300) break
  }
  const result = { title: document.title, url: location.href, dpr: devicePixelRatio, viewport: { width: vw, height: vh },
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight }, elements: out }
  if (withText) result.text = clean(document.body ? document.body.innerText : '').slice(0, 7000)
  return result
}

function pageRect(ref) {
  const el = document.querySelector(`[data-vyrse-ref="${ref}"]`)
  if (!el) return null
  let r = el.getBoundingClientRect()
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    r = el.getBoundingClientRect()
  }
  return { x: r.left, y: r.top, width: r.width, height: r.height, name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().slice(0, 60) }
}

function pageFocus(ref, clear) {
  const el = document.querySelector(`[data-vyrse-ref="${ref}"]`)
  if (!el) return false
  el.focus()
  if (clear) {
    if (typeof el.select === 'function') el.select()
    else if (el.isContentEditable) document.execCommand('selectAll')
  }
  return true
}

// Runs in the TOP frame: a glowing ring and caption at a spot in the tab (CSS px), drawn above everything,
// iframes included. When `follow` names an element of this frame, the ring tracks it as the page scrolls.
// A click inside the ring removes it straight away and tells VYRSE (the next walkthrough step can follow).
function pageRing(rect, caption, ms, step, follow) {
  const old = document.getElementById('__vyrse_hl')
  if (old) old.__vyrseRemove ? old.__vyrseRemove() : old.remove()
  if (!rect) return true
  const el = follow ? document.querySelector(`[data-vyrse-ref="${follow}"]`) : null
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  const box = document.createElement('div')
  box.id = '__vyrse_hl'
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border-radius:12px;border:3px solid #ff2d95;' +
    'box-shadow:0 0 0 4px rgba(255,45,149,.25),0 0 24px 6px rgba(255,45,149,.55);transition:opacity .2s ease, transform .2s ease;animation:__vyrse_p 1.4s ease-in-out infinite'
  const tag = document.createElement('div')
  tag.style.cssText = 'position:absolute;left:0;top:calc(100% + 10px);white-space:nowrap;font:600 14px/1.3 system-ui,sans-serif;color:#fff;' +
    'background:rgba(12,12,16,.94);padding:7px 12px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35)'
  tag.textContent = (step ? step + ' · ' : '') + (caption || '')
  if (caption || step) box.appendChild(tag)
  const style = document.createElement('style')
  style.textContent = '@keyframes __vyrse_p{0%,100%{box-shadow:0 0 0 4px rgba(255,45,149,.25),0 0 18px 4px rgba(255,45,149,.45)}50%{box-shadow:0 0 0 8px rgba(255,45,149,.15),0 0 32px 10px rgba(255,45,149,.65)}}'
  box.appendChild(style)
  document.documentElement.appendChild(box)
  let live = { ...rect }
  let raf = 0
  const place = () => {
    if (!box.isConnected) return
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect()
      live = { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    Object.assign(box.style, { left: live.x - 6 + 'px', top: live.y - 6 + 'px', width: live.width + 12 + 'px', height: live.height + 12 + 'px' })
    if (live.y + live.height + 56 > innerHeight) Object.assign(tag.style, { top: 'auto', bottom: 'calc(100% + 10px)' })
    raf = requestAnimationFrame(place)
  }
  const inside = (x, y) => x >= live.x - 8 && x <= live.x + live.width + 8 && y >= live.y - 8 && y <= live.y + live.height + 8
  const onDown = (e) => {
    if (!inside(e.clientX, e.clientY)) return
    remove()
    try { chrome.runtime.sendMessage({ type: 'vyrse-ring-clicked' }) } catch {}
  }
  const remove = () => {
    cancelAnimationFrame(raf)
    removeEventListener('pointerdown', onDown, true)
    box.style.opacity = '0'
    box.style.transform = 'scale(.96)'
    setTimeout(() => box.remove(), 180)
  }
  box.__vyrseRemove = remove
  addEventListener('pointerdown', onDown, true)
  place()
  if (ms > 0) setTimeout(() => box.isConnected && remove(), ms)
  return true
}

// Runs in every frame while a ring is up: report clicks (frames from other sites can't see the ring themselves).
function watchClicks() {
  if (window.__vyrseWatch) return true
  window.__vyrseWatch = true
  addEventListener('pointerdown', (e) => {
    try { chrome.runtime.sendMessage({ type: 'vyrse-click', x: e.clientX, y: e.clientY }) } catch {}
  }, true)
  return true
}

function pageScroll(direction, amount) {
  const dy = { up: -1, down: 1, top: -1e9, bottom: 1e9 }[direction] ?? 1
  const step = Math.abs(dy) > 1 ? dy : dy * innerHeight * (amount || 0.8)
  // scroll the page, or the biggest scrollable area when the page itself doesn't scroll (web apps)
  const before = scrollY
  scrollBy({ top: step, behavior: 'instant' })
  if (scrollY === before) {
    let best = null
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el
      }
    }
    if (best) best.scrollBy({ top: Math.abs(dy) > 1 ? dy : dy * best.clientHeight * (amount || 0.8), behavior: 'instant' })
  }
  return { y: Math.round(scrollY), height: document.documentElement.scrollHeight }
}

async function screenshot(tab) {
  try {
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    return url.split(',')[1]
  } catch {
    const shot = await cdp(tab.id, 'Page.captureScreenshot', { format: 'png' })
    return shot.data
  }
}

// ------------------------------------------------------------------------------------- snapshot across frames
const refsByTab = new Map() // tabId -> Map(ref -> { frameId, local })
const ringByTab = new Map() // tabId -> rect of the ring that's up (tab viewport, CSS px)

async function snapshotTab(tab, withText, withImage) {
  const { offsets, top } = await frameOffsets(tab.id)
  const results = await inAllFrames(tab.id, pageSnapshot, !!withText)
  const vw = top ? top.w : 0
  const vh = top ? top.h : 0
  const refs = new Map()
  const elements = []
  const texts = []
  let main = null
  for (const r of results.sort((a, b) => a.frameId - b.frameId)) {
    const snap = r && r.result
    if (!snap) continue
    if (r.frameId === 0) main = snap
    const off = offsets.get(r.frameId)
    if (!off) continue // a frame we can't place (hidden, or not matched) can't be clicked reliably
    if (withText && snap.text) texts.push(snap.text)
    for (const e of snap.elements) {
      const rect = { x: e.rect.x + off.x, y: e.rect.y + off.y, width: e.rect.width, height: e.rect.height }
      if (vw && (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > vw || rect.y > vh)) continue
      const ref = elements.length + 1
      refs.set(ref, { frameId: r.frameId, local: e.local })
      const { local, ...rest } = e
      elements.push({ ...rest, ref, rect, ...(r.frameId ? { frame: true } : {}) })
    }
  }
  refsByTab.set(tab.id, refs)
  const out = { tab: tab.id, title: (main && main.title) || tab.title, url: tab.url, dpr: (top && top.dpr) || 1,
    viewport: { width: vw, height: vh }, scroll: main ? main.scroll : null, elements }
  if (withText) out.text = texts.join('\n').slice(0, 9000)
  if (withImage) out.image = await screenshot(tab)
  return out
}

async function locateRef(tab, ref) {
  const info = (refsByTab.get(tab.id) || new Map()).get(Number(ref))
  if (!info) throw new Error(`There's no [${ref}] any more (the page changed). Read the page again.`)
  const at = await inFrame(tab.id, info.frameId, pageRect, info.local)
  if (!at) throw new Error(`[${ref}] is gone (the page changed). Read the page again.`)
  const off = info.frameId ? (await frameOffsets(tab.id)).offsets.get(info.frameId) : { x: 0, y: 0 }
  if (!off) throw new Error(`[${ref}] is in a part of the page I can't place any more. Read the page again.`)
  return { ...info, rect: { x: at.x + off.x, y: at.y + off.y, width: at.width, height: at.height }, name: at.name }
}

async function showRing(tab, rect, opts = {}) {
  ringByTab.set(tab.id, rect)
  await inAllFrames(tab.id, watchClicks).catch(() => {})
  return inPage(tab.id, pageRing, rect, opts.caption || '', opts.ms ?? 12000, opts.step || '', opts.follow ?? null)
}

async function hideRing(tabId) {
  ringByTab.delete(tabId)
  await inPage(tabId, pageRing, null, '', 0, '', null).catch(() => {})
}

function ringClicked(tabId) {
  ringByTab.delete(tabId)
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', name: 'ring_clicked', tab: tabId }))
}

// clicks reported from inside frames: inside the ring? then it goes, and VYRSE hears about it
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender && sender.tab && sender.tab.id
  if (!msg || !tabId) return
  if (msg.type === 'vyrse-ring-clicked') return ringClicked(tabId)
  if (msg.type !== 'vyrse-click' || !sender.frameId || !ringByTab.has(tabId)) return
  const ring = ringByTab.get(tabId)
  frameOffsets(tabId).then(({ offsets }) => {
    const off = offsets.get(sender.frameId)
    if (!off) return
    const x = msg.x + off.x, y = msg.y + off.y
    if (x >= ring.x - 8 && x <= ring.x + ring.width + 8 && y >= ring.y - 8 && y <= ring.y + ring.height + 8) {
      hideRing(tabId)
      ringClicked(tabId)
    }
  }).catch(() => {})
})

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

async function settle(tabId) {
  await pause(600)
  const after = await chrome.tabs.get(tabId)
  if (after.status === 'loading') await waitLoaded(tabId)
}

// ------------------------------------------------------------------------------------------- commands
async function run(cmd, a) {
  switch (cmd) {
    case 'current': {
      const tab = await currentTab(a.tab)
      const win = await chrome.windows.get(tab.windowId).catch(() => null)
      return { ...tabInfo(tab), focused: !!(win && win.focused) }
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({})
      return { tabs: tabs.filter((t) => !t.url?.startsWith('devtools://')).map(tabInfo) }
    }
    case 'open': {
      const tab = await chrome.tabs.create({ url: a.url, active: true })
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      await waitLoaded(tab.id)
      return tabInfo(await chrome.tabs.get(tab.id))
    }
    case 'go': {
      const tab = await currentTab(a.tab)
      await chrome.tabs.update(tab.id, { url: a.url })
      await waitLoaded(tab.id)
      return tabInfo(await chrome.tabs.get(tab.id))
    }
    case 'switch': {
      const tab = await chrome.tabs.update(Number(a.tab), { active: true })
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      return tabInfo(tab)
    }
    case 'close': {
      const tab = await currentTab(a.tab)
      await chrome.tabs.remove(tab.id)
      return { closed: tab.title }
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const tab = await currentTab(a.tab)
      if (cmd === 'back') await chrome.tabs.goBack(tab.id)
      else if (cmd === 'forward') await chrome.tabs.goForward(tab.id)
      else await chrome.tabs.reload(tab.id)
      await waitLoaded(tab.id)
      return tabInfo(await chrome.tabs.get(tab.id))
    }
    case 'snapshot': {
      const tab = await currentTab(a.tab)
      return snapshotTab(tab, !!a.text, !!a.image)
    }
    case 'screenshot': {
      const tab = await currentTab(a.tab)
      return { tab: tab.id, image: await screenshot(tab) }
    }
    case 'click': {
      // by ref (from the last snapshot, any frame) or at a spot (x, y: tab viewport CSS px)
      const tab = await currentTab(a.tab)
      let rect, name = ''
      if (a.ref != null) ({ rect, name } = await locateRef(tab, a.ref))
      else if (a.rect) rect = a.rect
      else throw new Error('Say which control: ref or rect.')
      await inPage(tab.id, pageRing, rect, '', 700, '', null).catch(() => {})
      await pause(400)
      await clickAt(tab.id, rect.x + rect.width / 2, rect.y + rect.height / 2, a.double ? 2 : 1)
      await settle(tab.id)
      return { clicked: name, ...tabInfo(await chrome.tabs.get(tab.id)) }
    }
    case 'type': {
      const tab = await currentTab(a.tab)
      if (a.ref != null || a.rect) {
        let rect, info = null
        if (a.ref != null) {
          info = await locateRef(tab, a.ref)
          rect = info.rect
        } else rect = a.rect
        await clickAt(tab.id, rect.x + rect.width / 2, rect.y + rect.height / 2)
        if (info) await inFrame(tab.id, info.frameId, pageFocus, info.local, a.clear !== false).catch(() => {})
        else if (a.clear !== false) await pressKeys(tab.id, 'ctrl+a')
      }
      await cdp(tab.id, 'Input.insertText', { text: String(a.text || '') })
      if (a.submit) {
        await pressKeys(tab.id, 'enter')
        await settle(tab.id)
      }
      return { typed: String(a.text || '').length, ...tabInfo(await chrome.tabs.get(tab.id)) }
    }
    case 'keys': {
      const tab = await currentTab(a.tab)
      await pressKeys(tab.id, a.keys)
      return { pressed: a.keys }
    }
    case 'scroll': {
      const tab = await currentTab(a.tab)
      return inPage(tab.id, pageScroll, a.direction || 'down', a.amount || 0.8)
    }
    case 'highlight': {
      // a ring on a ref (any frame) or a spot (rect, tab viewport CSS px); no ref/rect = take it down
      const tab = await currentTab(a.tab)
      if (a.ref == null && !a.rect) {
        await hideRing(tab.id)
        return { shown: null }
      }
      let rect = a.rect, follow = null
      if (a.ref != null) {
        const info = await locateRef(tab, a.ref)
        rect = info.rect
        if (!info.frameId) follow = info.local
      }
      await showRing(tab, rect, { caption: a.caption, ms: a.ms ?? 30000, step: a.step, follow })
      return { shown: a.ref ?? 'spot' }
    }
    default:
      throw new Error(`Unknown command ${cmd}`)
  }
}
