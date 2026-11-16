// Voice smoke (VYRSE_SMOKE=voice): the real Hermes voice paths, headless, the way the app uses them.
// VYRSE_SMOKE_VOICE is a JSON plan file:
//   { "tts": ["sentence", ...],                 speak-stream: first-audio latency, length, level; saved as WAV
//     "stt": ["file.wav", ...],                 /api/audio/transcribe (the TTS outputs are transcribed too)
//     "wake": ["file16k.wav", ...],             wake.start {client_capture} + wake.feed in 100 ms frames
//     "outDir": "folder" }                      TTS WAVs land here
// One JSON line per check goes to VYRSE_SMOKE_OUT. Nothing touches the mic, the speakers or the UI.

import fs from 'node:fs'
import path from 'node:path'

import type { BackendConnection } from '../shared/backend-types'

interface Plan {
  tts?: string[]
  stt?: string[]
  wake?: string[]
  outDir?: string
  /** send TTS text a few words at a time, like a streaming reply (else all at once) */
  ttsStreamed?: boolean
  /** real-time factor for wake feeding: 1 = as fast as a live mic (default), 4 = four times faster */
  wakeSpeed?: number
}

function wav(pcm: Int16Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + pcm.length * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(pcm.length * 2, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(b, 44)
  return b
}

/** 16-bit mono PCM samples of a plain WAV file (first data chunk). */
function readWavPcm(file: string): { pcm: Int16Array; rate: number } {
  const b = fs.readFileSync(file)
  const rate = b.readUInt32LE(24)
  let off = 12
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'data') {
      const data = b.subarray(off + 8, off + 8 + size)
      return { pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), rate }
    }
    off += 8 + size
  }
  throw new Error(`no data chunk in ${file}`)
}

function rmsDb(pcm: Int16Array): number {
  let s = 0
  for (let i = 0; i < pcm.length; i++) s += (pcm[i]! / 32768) ** 2
  return Math.round(10 * Math.log10(s / Math.max(1, pcm.length) + 1e-12) * 10) / 10
}

export async function runVoiceSmoke(conn: BackendConnection, planFile: string, outFile: string): Promise<void> {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf-8')) as Plan
  const outDir = plan.outDir ?? path.dirname(outFile)
  fs.mkdirSync(outDir, { recursive: true })
  const log = (row: object) => {
    fs.appendFileSync(outFile, JSON.stringify(row) + '\n')
    console.log(`[smoke] ${JSON.stringify(row).slice(0, 300)}`)
  }
  const rest = async (p: string, body: object) => {
    const res = await fetch(`${conn.baseUrl}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hermes-Session-Token': conn.token },
      body: JSON.stringify(body),
    })
    return (await res.json()) as any
  }
  const lease = (active: boolean) =>
    Promise.allSettled(['/api/audio/tts-lease', '/api/audio/stt-lease'].map(p => rest(p, { lease: 'vyrse:smoke', active })))
  await lease(true)

  const ttsFiles: string[] = []
  try {
    // ---------------------------------------------------------------- TTS (speak-stream, as the app speaks)
    for (const [i, text] of (plan.tts ?? []).entries()) {
      const url = `${conn.wsUrl.replace(/\/api\/ws$/, '/api/audio/speak-stream')}?token=${encodeURIComponent(conn.token)}`
      const t0 = Date.now()
      const row = await new Promise<any>(resolve => {
        const ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'
        const chunks: Int16Array[] = []
        let rate = 24000
        let first = 0
        const timer = setTimeout(() => finish('timeout'), 60_000)
        let done = false
        let sentAll = 0
        const finish = (end: string) => {
          if (done) return // 'end' is followed by the socket closing
          done = true
          clearTimeout(timer)
          try { ws.close() } catch { /* closed */ }
          const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0))
          let o = 0
          for (const c of chunks) { pcm.set(c, o); o += c.length }
          const file = path.join(outDir, `tts-${i}.wav`)
          if (pcm.length) { fs.writeFileSync(file, wav(pcm, rate)); ttsFiles.push(file) }
          resolve({ check: 'tts', text, end, first_audio_ms: first ? first - t0 : null, total_ms: Date.now() - t0,
                    text_done_ms: sentAll ? sentAll - t0 : null,
                    seconds: Math.round((pcm.length / rate) * 100) / 100, rate, level_db: rmsDb(pcm), file: pcm.length ? file : null })
        }
        ws.onopen = async () => {
          if (!plan.ttsStreamed) {
            ws.send(JSON.stringify({ text }))
            ws.send(JSON.stringify({ done: true }))
            return
          }
          // like a reply streaming from the model: a few words every 120 ms
          const words = text.split(/(?<=\s)/)
          for (let w = 0; w < words.length; w += 3) {
            ws.send(JSON.stringify({ text: words.slice(w, w + 3).join('') }))
            await new Promise(r => setTimeout(r, 120))
          }
          sentAll = Date.now()
          ws.send(JSON.stringify({ done: true }))
        }
        ws.onmessage = ev => {
          if (typeof ev.data === 'string') {
            const msg = JSON.parse(ev.data)
            if (msg.type === 'start' && msg.sample_rate) rate = msg.sample_rate
            else if (msg.type === 'end') finish('end')
            else if (msg.type === 'fallback' || msg.type === 'error') finish(`${msg.type}: ${msg.message ?? msg.error ?? ''}`)
            return
          }
          if (!first) first = Date.now()
          chunks.push(new Int16Array(ev.data as ArrayBuffer))
        }
        ws.onerror = () => finish('socket error')
        ws.onclose = () => finish('closed')
      })
      log(row)
    }

    // ---------------------------------------------------------------- STT (the endpoint the app posts to)
    for (const file of [...ttsFiles, ...(plan.stt ?? [])]) {
      const t0 = Date.now()
      const dataUrl = `data:audio/wav;base64,${fs.readFileSync(file).toString('base64')}`
      try {
        // the route the app uses (VYRSE's, keeps short answers), and Hermes' own for comparison
        const res = await rest('/api/plugins/vyrse/transcribe', { data_url: dataUrl, mime_type: 'audio/wav' })
        const ms = Date.now() - t0
        const hermes = await rest('/api/audio/transcribe', { data_url: dataUrl, mime_type: 'audio/wav' })
        log({ check: 'stt', file: path.basename(file), ms, ok: res.ok !== false, transcript: res.transcript ?? '', hermes: hermes.transcript ?? '', error: res.error ?? res.detail })
      } catch (err) {
        log({ check: 'stt', file: path.basename(file), ms: Date.now() - t0, ok: false, error: String(err) })
      }
    }

    // ---------------------------------------------------------------- wake (client capture, as the app feeds it)
    if (plan.wake?.length) {
      const ws = new WebSocket(`${conn.wsUrl}?token=${encodeURIComponent(conn.token)}`)
      const pending = new Map<string, (msg: any) => void>()
      let detected = 0
      let nextId = 0
      ws.addEventListener('message', ev => {
        for (const line of String(ev.data).split('\n')) {
          if (!line.trim()) continue
          const msg = JSON.parse(line)
          if (msg.id !== undefined && pending.has(String(msg.id))) {
            pending.get(String(msg.id))!(msg)
            pending.delete(String(msg.id))
          } else if (msg.method === 'event' && msg.params?.type === 'wake.detected') detected++
          else if (msg.id !== undefined && msg.method) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'smoke' } }))
        }
      })
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () => reject(new Error('socket error')))
      })
      const call = (method: string, params: object) =>
        new Promise<any>(resolve => {
          const id = `w${++nextId}`
          pending.set(id, msg => resolve(msg.error ? { error: msg.error } : msg.result))
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        })
      const speed = plan.wakeSpeed ?? 1
      for (const file of plan.wake) {
        const { pcm, rate } = readWavPcm(file)
        if (rate !== 16000) { log({ check: 'wake', file: path.basename(file), error: `needs 16 kHz, got ${rate}` }); continue }
        const armed = await call('wake.start', { surface: 'gui', client_capture: true })
        const before = detected
        let firstAt: number | null = null
        for (let o = 0; o < pcm.length; o += 1600) {
          const frame = pcm.slice(o, o + 1600)
          await call('wake.feed', { pcm: Buffer.from(frame.buffer).toString('base64'), sample_rate: 16000 })
          if (firstAt === null && detected > before) firstAt = o / 16000
          await new Promise(r => setTimeout(r, 100 / speed))
        }
        await new Promise(r => setTimeout(r, 400))
        if (firstAt === null && detected > before) firstAt = pcm.length / 16000
        log({ check: 'wake', file: path.basename(file), detected: detected > before, at_s: firstAt,
              armed: armed?.listening !== false && !armed?.error, hint: armed?.hint ?? armed?.error?.message })
        await call('wake.stop', {})
      }
      ws.close()
    }
  } finally {
    await lease(false)
  }
}
