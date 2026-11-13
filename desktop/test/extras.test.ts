import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: {}, net: {} }))

import { isNewer, parseVersion, pasteFileName } from '../src/main/extras'

describe('update check', () => {
  it('reads plain versions only', () => {
    expect(parseVersion('1.6.0')).toEqual([1, 6, 0])
    expect(parseVersion('v1.10.2')).toEqual([1, 10, 2])
    expect(parseVersion('1.6')).toBeNull()
    expect(parseVersion('1.6.0-beta')).toBeNull()
  })

  it('compares by number, not by text', () => {
    expect(isNewer('1.10.0', '1.9.3')).toBe(true)
    expect(isNewer('1.6.1', '1.6.0')).toBe(true)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('1.6.0', '1.6.0')).toBe(false)
    expect(isNewer('1.5.9', '1.6.0')).toBe(false)
    expect(isNewer('nonsense', '1.6.0')).toBe(false)
  })
})

describe('pasted pictures', () => {
  it('names a picture after when it was pasted', () => {
    expect(pasteFileName('image/png', new Date('2026-11-13T10:20:30.400Z'))).toBe('paste-2026-11-13T10-20-30-400Z.png')
    expect(pasteFileName('IMAGE/JPEG', new Date(0))).toMatch(/\.jpg$/)
  })

  it('refuses anything that is not a picture', () => {
    expect(pasteFileName('text/html', new Date(0))).toBeNull()
    expect(pasteFileName('application/x-msdownload', new Date(0))).toBeNull()
    expect(pasteFileName('image/svg+xml', new Date(0))).toBeNull()
  })
})
