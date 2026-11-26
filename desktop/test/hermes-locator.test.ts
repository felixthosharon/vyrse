import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hermesCommand, locateHermes } from '../src/main/hermes-locator'

let home: string
const write = (f: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '')
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vyrse-locate-'))
  fs.mkdirSync(path.join(home, 'hermes-agent', 'hermes_cli'), { recursive: true })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe.runIf(process.platform === 'win32')('finding Hermes', () => {
  const env = () => ({ HERMES_HOME: home })

  it('finds a v0.23+ install (bin\\hermes.exe in the Hermes home, no venv)', () => {
    expect(locateHermes(env())).toBeNull()
    write(path.join(home, 'bin', 'hermes.exe'))
    const found = locateHermes(env())!
    expect(found.launcher).toBe(path.join(home, 'bin', 'hermes.exe'))
    // an .exe starts directly, without cmd.exe
    expect(hermesCommand(found, ['serve'])).toEqual({ file: found.launcher, args: ['serve'], verbatim: false })
  })

  it('still prefers the launcher in the checkout on older installs', () => {
    write(path.join(home, 'bin', 'hermes.cmd'))
    write(path.join(home, 'hermes-agent', '.hermes', 'bin', 'hermes.cmd'))
    expect(locateHermes(env())!.launcher).toBe(path.join(home, 'hermes-agent', '.hermes', 'bin', 'hermes.cmd'))
  })

  it('falls back to the venv Python', () => {
    write(path.join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe'))
    expect(locateHermes(env())!.python).toBe(path.join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe'))
  })
})
