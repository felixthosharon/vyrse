import { describe, expect, it } from 'vitest'

import { LogTail, parseReadyPort, RestartPolicy } from '../src/main/backend-policy'

describe('parseReadyPort', () => {
  it('reads the backend sentinel', () => {
    expect(parseReadyPort('HERMES_BACKEND_READY port=53202\n')).toBe(53202)
  })
  it('accepts the dashboard sentinel from older runtimes', () => {
    expect(parseReadyPort('noise\nHERMES_DASHBOARD_READY port=9119\n')).toBe(9119)
  })
  it('ignores sentinels that are not at a line start or are invalid', () => {
    expect(parseReadyPort('echo HERMES_BACKEND_READY port=1')).toBeNull()
    expect(parseReadyPort('HERMES_BACKEND_READY port=70000')).toBeNull()
    expect(parseReadyPort('Hermes backend listening')).toBeNull()
  })
})

describe('RestartPolicy', () => {
  it('backs off exponentially and stops after the budget', () => {
    let t = 0
    const policy = new RestartPolicy(3, 60_000, 1_000, () => t)
    expect(policy.nextDelay()).toBe(1_000)
    expect(policy.nextDelay()).toBe(2_000)
    expect(policy.nextDelay()).toBe(4_000)
    expect(policy.nextDelay()).toBeNull()
    t = 61_000 // old attempts age out of the window
    expect(policy.nextDelay()).toBe(1_000)
  })
})

describe('LogTail', () => {
  it('keeps only the most recent non-empty lines', () => {
    const tail = new LogTail(3)
    tail.push('a\n\nb\r\nc\nd')
    expect(tail.last()).toEqual(['b', 'c', 'd'])
  })
})
