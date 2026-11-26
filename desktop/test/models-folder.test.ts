import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import { modelsDirFromConfig, modelsFolder, openModelsFolder } from '../src/main/models-folder'

describe('models folder', () => {
  it('reads vyrse.models_dir from Hermes config', () => {
    const config = 'model:\n  default: x\nvyrse:\n  models_dir: C:\\dev\\VYRSE\\models\nother:\n  models_dir: D:\\nope\n'
    expect(modelsDirFromConfig(config)).toBe('C:\\dev\\VYRSE\\models')
    expect(modelsDirFromConfig("vyrse:\n  models_dir: 'C:\\Users\\you\\VYRSE\\models'\n")).toBe('C:\\Users\\you\\VYRSE\\models')
  })

  it('ignores models_dir outside the vyrse section and relative paths', () => {
    expect(modelsDirFromConfig('other:\n  models_dir: C:\\x\n')).toBeNull()
    expect(modelsDirFromConfig('vyrse:\n  models_dir: models\n')).toBeNull()
  })

  it('falls back to %USERPROFILE%\\VYRSE\\models without a config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vyrse-mf-'))
    expect(modelsFolder({ HERMES_HOME: home })).toBe(path.join(os.homedir(), 'VYRSE', 'models'))
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('creates the folder and opens only that one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vyrse-mf-'))
    const target = path.join(home, 'my models')
    fs.writeFileSync(path.join(home, 'config.yaml'), `vyrse:\n  models_dir: ${target}\n`)
    const opened: string[] = []
    expect(await openModelsFolder(async dir => (opened.push(dir), ''), { HERMES_HOME: home })).toBe('')
    expect(opened).toEqual([target])
    expect(fs.statSync(target).isDirectory()).toBe(true)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
