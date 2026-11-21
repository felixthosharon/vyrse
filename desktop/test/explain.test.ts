import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, desktopCapturer: {}, globalShortcut: {}, ipcMain: {}, screen: {} }))

import { cropRect, parseSelection } from '../src/main/explain'

describe("What's this? selection", () => {
  it('reads the box the selection page reports', () => {
    expect(parseSelection('https://explain.invalid/10,20,300,150')).toEqual({ x: 10, y: 20, width: 300, height: 150 })
    expect(parseSelection('https://explain.invalid/cancel')).toBeNull()
    expect(parseSelection('https://explain.invalid/1,2,3')).toBeNull()
    expect(parseSelection('https://explain.invalid/-5,2,30,40')).toBeNull()
    expect(parseSelection('https://example.com/10,20,300,150')).toBeNull()
  })

  it('scales the box to the screenshot (150% display) and clamps it', () => {
    const win = { width: 1280, height: 720 }
    const image = { width: 1920, height: 1080 }
    expect(cropRect({ x: 100, y: 100, width: 200, height: 100 }, win, image)).toEqual({ x: 150, y: 150, width: 300, height: 150 })
    expect(cropRect({ x: 1200, y: 700, width: 400, height: 400 }, win, image)).toEqual({ x: 1800, y: 1050, width: 120, height: 30 })
  })

  it('ignores a stray click', () => {
    expect(cropRect({ x: 50, y: 50, width: 3, height: 2 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBeNull()
  })
})
