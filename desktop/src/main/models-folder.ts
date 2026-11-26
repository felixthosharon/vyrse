import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveHermesHome } from './hermes-locator'

/**
 * The folder people paste .gguf models into (Hermes config `vyrse.models_dir`, set by setup.ps1; the plugin's
 * model watcher adds whatever lands there). Worked out here, never taken from the page, so the window can only
 * ever open this one folder.
 */
export function modelsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = path.join(os.homedir(), 'VYRSE', 'models')
  try {
    const config = fs.readFileSync(path.join(resolveHermesHome(env), 'config.yaml'), 'utf8')
    return modelsDirFromConfig(config) ?? fallback
  } catch {
    return fallback
  }
}

/** `models_dir` under the top-level `vyrse:` section of Hermes' config.yaml (a plain line scan, no YAML library). */
export function modelsDirFromConfig(config: string): string | null {
  let inVyrse = false
  for (const line of config.split(/\r?\n/)) {
    if (/^\S/.test(line)) inVyrse = /^vyrse:\s*$/.test(line)
    else if (inVyrse) {
      const m = /^\s+models_dir:\s*(.+?)\s*$/.exec(line)
      if (m) {
        const value = m[1]!.replace(/^(['"])(.*)\1$/, '$2').replace(/\\\\/g, '\\')
        return path.isAbsolute(value) ? value : null
      }
    }
  }
  return null
}

/** Opens the models folder in Explorer (created first if it isn't there yet). Returns '' or what went wrong. */
export async function openModelsFolder(open: (dir: string) => Promise<string>, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = modelsFolder(env)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return `Couldn't create ${dir}: ${(err as Error).message}`
  }
  return open(dir)
}
