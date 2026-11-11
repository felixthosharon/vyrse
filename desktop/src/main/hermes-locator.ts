import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface HermesInstall {
  hermesHome: string
  agentRoot: string
  /** Hermes' own launcher (`.hermes/bin/hermes.cmd`): picks the right Python for the install */
  launcher?: string
  /** the install's Python, for installs without a launcher */
  python?: string
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
 * Locate the Hermes git install under `<home>\hermes-agent` and how to run it.
 * Hermes publishes a launcher (`.hermes\bin\hermes.cmd`) that picks the right Python for the install; newer
 * installs have only that. Older ones have a Python in `venv`, used when there is no launcher.
 * `VYRSE_HERMES_PYTHON` + `VYRSE_HERMES_ROOT` override for dev checkouts.
 * Returns null when Hermes is not installed: the UI shows an install hint.
 */
export function locateHermes(env: NodeJS.ProcessEnv = process.env): HermesInstall | null {
  const hermesHome = resolveHermesHome(env)

  if (env.VYRSE_HERMES_PYTHON && env.VYRSE_HERMES_ROOT) {
    return { hermesHome, agentRoot: env.VYRSE_HERMES_ROOT, python: env.VYRSE_HERMES_PYTHON }
  }

  const agentRoot = path.join(hermesHome, 'hermes-agent')
  if (!fs.existsSync(path.join(agentRoot, 'hermes_cli'))) return null
  const windows = process.platform === 'win32'
  const launcher = path.join(agentRoot, '.hermes', 'bin', windows ? 'hermes.cmd' : 'hermes')
  if (fs.existsSync(launcher)) return { hermesHome, agentRoot, launcher }
  const python = windows ? path.join(agentRoot, 'venv', 'Scripts', 'python.exe') : path.join(agentRoot, 'venv', 'bin', 'python')
  return fs.existsSync(python) ? { hermesHome, agentRoot, python } : null
}

/** What to spawn to run a Hermes command (`serve ...`) for this install. Arguments must not need quoting. */
export function hermesCommand(install: HermesInstall, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!install.launcher) return { file: install.python!, args: ['-m', 'hermes_cli.main', ...args], verbatim: false }
  if (process.platform !== 'win32') return { file: install.launcher, args, verbatim: false }
  // A .cmd can't be started directly: cmd.exe runs it. With /s, cmd strips the outer quotes and runs the rest as is.
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${install.launcher}" ${args.join(' ')}"`], verbatim: true }
}
