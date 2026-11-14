import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findSetupSource, hermesInstallArgs, HERMES_INSTALLER_URL, setupState, type SetupSource } from '../src/main/setup'

let tmp: string
let home: string
let bundle: string

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vyrse-setup-'))
  home = path.join(tmp, 'hermes')
  bundle = path.join(tmp, 'resources', 'setup')
  write(path.join(bundle, 'scripts', 'setup.ps1'))
  write(path.join(bundle, 'hermes-plugin', 'vyrse', 'plugin.yaml'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const installed = (): SetupSource => ({ root: bundle, bundled: true, appVersion: '1.6.0' })
const link = (target: string) => {
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true })
  fs.symlinkSync(target, path.join(home, 'plugins', 'vyrse'), 'junction')
}

describe('setupState', () => {
  it('is missing until the plugin is in Hermes', () => {
    expect(setupState(home, installed())).toBe('missing')
    expect(setupState(home, null)).toBe('missing')
  })

  it('is missing when the plugin link points at a folder that is gone', () => {
    const gone = path.join(tmp, 'old-vyrse')
    write(path.join(gone, 'plugin.yaml'))
    link(gone)
    fs.rmSync(gone, { recursive: true })
    expect(setupState(home, installed())).toBe('missing')
  })

  it('runs setup again after the installed app changes version', () => {
    link(path.join(bundle, 'hermes-plugin', 'vyrse'))
    expect(setupState(home, installed())).toBe('stale')
    write(path.join(home, 'vyrse', 'setup.json'), JSON.stringify({ version: '1.5.0' }))
    expect(setupState(home, installed())).toBe('stale')
    write(path.join(home, 'vyrse', 'setup.json'), JSON.stringify({ version: '1.6.0' }))
    expect(setupState(home, installed())).toBe('ok')
  })

  it('leaves a plugin linked to a source checkout alone', () => {
    const checkout = path.join(tmp, 'dev', 'hermes-plugin', 'vyrse')
    write(path.join(checkout, 'plugin.yaml'))
    link(checkout)
    expect(setupState(home, installed())).toBe('ok')
    expect(setupState(home, { root: path.join(tmp, 'dev'), bundled: false, appVersion: '1.6.0' })).toBe('ok')
  })
})

describe('findSetupSource', () => {
  it('uses the folder shipped in the installed app', () => {
    expect(findSetupSource(true, path.join(tmp, 'resources'), '1.6.0')).toEqual({ root: bundle, bundled: true, appVersion: '1.6.0' })
    expect(findSetupSource(true, path.join(tmp, 'nowhere'), '1.6.0')).toBeNull()
  })
})

describe('installing Hermes', () => {
  it('runs the official installer from a file, without questions', () => {
    const args = hermesInstallArgs()
    expect(HERMES_INSTALLER_URL).toBe('https://hermes-agent.nousresearch.com/install.ps1')
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])
    const script = args[args.indexOf('-Command') + 1]!
    expect(script).toContain(`-Uri '${HERMES_INSTALLER_URL}'`)
    expect(script).toContain('-File $f -NonInteractive')
    expect(script).toContain('exit $LASTEXITCODE')
    expect(script).not.toMatch(/iex|Invoke-Expression/i) // never piped straight into the shell
  })

  it('can run a local script instead (developer checks)', () => {
    expect(hermesInstallArgs('C:\\tmp\\fake.ps1').slice(-3)).toEqual(['-File', 'C:\\tmp\\fake.ps1', '-NonInteractive'])
  })
})
