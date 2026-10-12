import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: {}, safeStorage: {} }))
vi.mock('../src/main/alexa', () => ({ alexaOp: vi.fn() }))

import { filterPhoneFrames, isPrivateAddress, phoneApiAllowed } from '../src/main/phone-bridge'

describe('phone bridge: only the home network gets in', () => {
  it('accepts home-network and loopback addresses', () => {
    for (const ip of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.5', '172.16.4.2', '172.31.255.1', '127.0.0.1', '169.254.3.3'])
      expect(isPrivateAddress(ip), ip).toBe(true)
  })
  it('rejects everything else', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.1.1', '192.169.1.1', '', undefined, 'garbage', '::ffff:1.2.3.4'])
      expect(isPrivateAddress(ip as string), String(ip)).toBe(false)
  })
})

describe('phone bridge: a paired phone reaches only what the app uses', () => {
  it('allows the app’s endpoints', () => {
    for (const [m, p] of [
      ['POST', '/api/audio/transcribe'],
      ['GET', '/api/config'],
      ['PUT', '/api/config'],
      ['GET', '/api/plugins/vyrse/state'],
      ['POST', '/api/plugins/vyrse/desktop-result/abc123'],
      ['GET', '/api/skills/content'],
      ['POST', '/api/skills/hub/install'],
    ])
      expect(phoneApiAllowed(m!, p!), `${m} ${p}`).toBe(true)
  })
  it('refuses the rest of Hermes (files, terminal, env, plugin management) and path tricks', () => {
    for (const [m, p] of [
      ['POST', '/api/plugins/vyrse/wake-train/start'],
      ['POST', '/api/plugins/vyrse/wake-train/sample'],
      ['GET', '/api/files/read'],
      ['POST', '/api/pty'],
      ['GET', '/api/env'],
      ['POST', '/api/plugins/install'],
      ['GET', '/api/plugins/other/state'],
      ['GET', '/api/plugins/vyrse/../../env'],
      ['DELETE', '/api/memory'],
      ['POST', '/api/audio/speak'],
    ])
      expect(phoneApiAllowed(m!, p!), `${m} ${p}`).toBe(false)
  })
  it('forwards the app’s JSON-RPC calls and answers the rest itself', () => {
    const data = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'prompt.submit', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools.configure', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { choice: 'once' } }),
      'not json',
    ].join('\n')
    const { forward, refuse } = filterPhoneFrames(data)
    expect(forward.map(l => JSON.parse(l).id)).toEqual([1, 3])
    expect(refuse).toEqual([2])
  })
})
