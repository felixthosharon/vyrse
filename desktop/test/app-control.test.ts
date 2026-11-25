import { describe, expect, it } from 'vitest'

import { explainFailure, parseSmartAppControl, saysBlocked, warnBeforeInstall } from '../src/main/app-control'

const reg = (hex: string) => `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    ${hex}\r\n\r\n`

describe('Smart App Control', () => {
  it('reads the setting Windows keeps', () => {
    expect(parseSmartAppControl(reg('0x0'))).toBe('off')
    expect(parseSmartAppControl(reg('0x1'))).toBe('on')
    expect(parseSmartAppControl(reg('0x2'))).toBe('evaluating')
    expect(parseSmartAppControl('ERROR: not found')).toBe('unknown')
  })

  it('recognises the block in the output', () => {
    expect(saysBlocked(['ImportError: DLL load failed while importing _sqlite3: An Application Control policy has blocked this file.'])).toBe(true)
    expect(saysBlocked(['error: failed to spawn (os error 4551)'])).toBe(true)
    expect(saysBlocked(['could not resolve host github.com', 'sha256 a45519bc'])).toBe(false)
  })

  it('warns before installing only when it is enforcing', () => {
    expect(warnBeforeInstall('on')?.blocked).toBe(true)
    for (const s of ['off', 'evaluating', 'unknown'] as const) expect(warnBeforeInstall(s)).toBeNull()
  })

  it('claims a block only on evidence', () => {
    expect(explainFailure('on', ['os error 4551'])?.message).toBe('Smart App Control blocked Hermes')
    expect(explainFailure('on', ['no internet'])?.message).toContain('probably')
    expect(explainFailure('off', ['os error 4551'])?.message).toContain('Windows blocked')
    expect(explainFailure('off', ['no internet'])).toBeNull()
  })
})
