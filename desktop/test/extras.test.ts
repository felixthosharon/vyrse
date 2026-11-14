import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: {}, net: {} }))

import { checksumFor, isNewer, parseVersion, pasteFileName, updateAssets } from '../src/main/extras'

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

describe('one-click update', () => {
  const base = 'https://github.com/felixthosharon/vyrse/releases/download/v1.8.0/'
  const assets = [
    { name: 'VYRSE-Setup-1.8.0.exe', browser_download_url: `${base}VYRSE-Setup-1.8.0.exe` },
    { name: 'VYRSE.apk', browser_download_url: `${base}VYRSE.apk` },
    { name: 'SHA256SUMS.txt', browser_download_url: `${base}SHA256SUMS.txt` },
  ]

  it('finds the installer and the checksum list of a release', () => {
    expect(updateAssets(assets, '1.8.0')).toEqual({ installer: `${base}VYRSE-Setup-1.8.0.exe`, sums: `${base}SHA256SUMS.txt`, name: 'VYRSE-Setup-1.8.0.exe' })
  })

  it('refuses a release without checksums, a wrong version, or a download from elsewhere', () => {
    expect(updateAssets(assets.slice(0, 2), '1.8.0')).toBeNull()
    expect(updateAssets(assets, '1.9.0')).toBeNull()
    expect(updateAssets(assets, 'latest')).toBeNull()
    expect(updateAssets([{ name: 'VYRSE-Setup-1.8.0.exe', browser_download_url: 'https://example.com/VYRSE-Setup-1.8.0.exe' }, assets[2]], '1.8.0')).toBeNull()
    expect(updateAssets(null, '1.8.0')).toBeNull()
  })

  it('reads the hash for one file out of a checksum list', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const sums = `${a} *VYRSE-Setup-1.8.0.exe\r\n${b}  VYRSE.apk\n`
    expect(checksumFor(sums, 'VYRSE-Setup-1.8.0.exe')).toBe(a)
    expect(checksumFor(sums, 'VYRSE.apk')).toBe('b'.repeat(64))
    expect(checksumFor(sums, 'other.exe')).toBeNull()
    expect(checksumFor('not a checksum list', 'VYRSE.apk')).toBeNull()
  })
})
