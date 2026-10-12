import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface HermesInstall {
  hermesHome: string
  agentRoot: string
  python: string
}

/**
 * HERMES_HOME resolution mirrors Hermes itself on Windows: explicit env var,
 * else %LOCALAPPDATA%\hermes (POSIX: ~/.hermes).
 */
export function resolveHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERMES_HOME) return path.resolve(env.HERMES_HOME)
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(local, 'hermes')
  }
  return path.join(os.homedir(), '.hermes')
}

/**
 * Locate the Python interpreter of the Hermes git install (`<home>\hermes-agent\venv`).
 * `VYRSE_HERMES_PYTHON` + `VYRSE_HERMES_ROOT` override for dev checkouts.
 * Returns null when Hermes is not installed — the UI shows an install hint.
 */
export function locateHermes(env: NodeJS.ProcessEnv = process.env): HermesInstall | null {
  const hermesHome = resolveHermesHome(env)

  if (env.VYRSE_HERMES_PYTHON && env.VYRSE_HERMES_ROOT) {
    return { hermesHome, agentRoot: env.VYRSE_HERMES_ROOT, python: env.VYRSE_HERMES_PYTHON }
  }

  const agentRoot = path.join(hermesHome, 'hermes-agent')
  const python =
    process.platform === 'win32'
      ? path.join(agentRoot, 'venv', 'Scripts', 'python.exe')
      : path.join(agentRoot, 'venv', 'bin', 'python')

  if (!fs.existsSync(python) || !fs.existsSync(path.join(agentRoot, 'hermes_cli'))) return null
  return { hermesHome, agentRoot, python }
}
