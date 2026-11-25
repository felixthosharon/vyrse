import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HermesBackend } from '../src/main/hermes-backend'

let tmp: string
const before = process.env.HERMES_HOME
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vyrse-sac-'))
  process.env.HERMES_HOME = path.join(tmp, 'hermes')
})
afterEach(() => {
  if (before === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = before
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('an install Windows blocks', () => {
  const failing = (line: string) => {
    const f = path.join(tmp, 'fake.ps1')
    fs.writeFileSync(f, `param([switch]$NonInteractive)\nWrite-Output '${line}'\nexit 1\n`)
    return f
  }

  it('warns first, then names the cause', async () => {
    const b = new HermesBackend(undefined, null, failing('ImportError: DLL load failed: (os error 4551)'), async () => 'on')
    await b.start()
    expect(b.getStatus()).toMatchObject({ phase: 'not-installed', blocked: true })
    await b.installHermes()
    expect(b.getStatus()).toMatchObject({ phase: 'not-installed', blocked: true, message: 'Smart App Control blocked Hermes' })
  }, 20_000)

  it('leaves other failures as they were', async () => {
    const b = new HermesBackend(undefined, null, failing('could not resolve host'), async () => 'off')
    await b.start()
    expect(b.getStatus().blocked).toBeUndefined()
    await b.installHermes()
    expect(b.getStatus().message).toBe("Hermes Agent didn't install")
  }, 20_000)
})
