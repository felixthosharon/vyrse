import { execFile } from 'node:child_process'

import type { BackendStatus } from '../shared/backend-types'

/**
 * Windows' Smart App Control only lets a program file run when it is signed by a trusted publisher or well known
 * to Microsoft. Hermes runs on Python and about 240 native libraries that their makers don't sign, so with it on
 * Hermes can't be installed or started, and Windows has no per-app exception. VYRSE only reads the setting and
 * explains it: turning it off is the user's own choice, in Windows Security.
 */
export type SmartAppControl = 'on' | 'evaluating' | 'off' | 'unknown'

export const SECURITY_PAGE = 'windowsdefender://appbrowser'

const KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'
const VALUE = 'VerifiedAndReputablePolicyState'

export function parseSmartAppControl(regOutput: string): SmartAppControl {
  const m = regOutput.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i)
  if (!m) return 'unknown'
  const state = parseInt(m[1]!, 16)
  return state === 1 ? 'on' : state === 2 ? 'evaluating' : state === 0 ? 'off' : 'unknown'
}

export function smartAppControl(): Promise<SmartAppControl> {
  if (process.platform !== 'win32') return Promise.resolve('unknown')
  return new Promise(resolve => {
    execFile('reg.exe', ['query', KEY, '/v', VALUE], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? 'unknown' : parseSmartAppControl(out)))
  })
}

/** Windows' own words (error 4551) for "an application control policy has blocked this file". */
export function saysBlocked(lines: string[]): boolean {
  return lines.some(l => /(?:error|code)[ :=]*4551\b|application control policy|smart app control/i.test(l))
}

const WHY = 'Hermes, the AI engine VYRSE runs on, uses Python files that are not signed, and Smart App Control has no exception for single apps.'
const HOW =
  'To use VYRSE on this PC, you would turn Smart App Control off: Windows Security > App & browser control > Smart App Control settings > Off. ' +
  'It lowers protection for all apps, Microsoft Defender keeps running, and on older Windows 11 versions it can only be turned back on by reinstalling Windows, so update Windows first.'

/** Before anything is installed: say it now rather than after a long download. Null when nothing is in the way. */
export function warnBeforeInstall(state: SmartAppControl): Partial<BackendStatus> | null {
  if (state !== 'on') return null
  return { blocked: true, message: 'Smart App Control will probably block the install', detail: `${WHY} ${HOW}` }
}

/** After a failure: the explanation, when Windows blocking files is what the evidence points to. */
export function explainFailure(state: SmartAppControl, lines: string[]): Partial<BackendStatus> | null {
  const said = saysBlocked(lines)
  if (state === 'on') {
    return { blocked: true, message: said ? 'Smart App Control blocked Hermes' : 'Smart App Control probably blocked Hermes', detail: `${WHY} ${HOW}` }
  }
  if (said) {
    return {
      blocked: true,
      message: 'Windows blocked a file Hermes needs',
      detail: 'An application control policy on this PC blocked it. On a school or work PC, only its administrator can allow it.',
    }
  }
  return null
}
