import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Preparing Hermes for VYRSE (scripts/setup.ps1: the plugin, voice, wake word, skills, Hermes options).
 * The installer ships the script and what it installs in resources/setup, so someone who only downloaded the
 * installer is set up from inside the app; a source checkout uses the repo itself.
 */
export interface SetupSource {
  /** folder holding scripts/setup.ps1, hermes-plugin, hermes-patches and assets */
  root: string
  /** shipped inside the installed app (not a source checkout) */
  bundled: boolean
  appVersion: string
}

export type SetupState = 'ok' | 'missing' | 'stale'

export function findSetupSource(packaged: boolean, resourcesPath: string, appVersion: string): SetupSource | null {
  const root = packaged ? path.join(resourcesPath, 'setup') : path.resolve(__dirname, '..', '..', '..')
  return fs.existsSync(path.join(root, 'scripts', 'setup.ps1')) ? { root, bundled: packaged, appVersion } : null
}

function stampFile(hermesHome: string): string {
  return path.join(hermesHome, 'vyrse', 'setup.json')
}

/**
 * missing: the vyrse plugin isn't in Hermes (setup never ran, or its folder is gone).
 * stale: this installed VYRSE is a different version from the one that last ran setup, so the script runs again
 * (it only changes what's missing). A source checkout is never stale: its owner runs the script.
 */
export function setupState(hermesHome: string, source: SetupSource | null): SetupState {
  if (!fs.existsSync(path.join(hermesHome, 'plugins', 'vyrse', 'plugin.yaml'))) return 'missing'
  if (!source?.bundled) return 'ok'
  let linked = ''
  try {
    linked = fs.realpathSync(path.join(hermesHome, 'plugins', 'vyrse'))
  } catch {
    return 'missing'
  }
  // Linked to a source checkout: that checkout is in charge, not the installed app.
  const inside = path.relative(source.root, linked)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return 'ok'
  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile(hermesHome), 'utf8')) as { version?: string }
    return stamp.version === source.appVersion ? 'ok' : 'stale'
  } catch {
    return 'stale'
  }
}

/** Where an installed VYRSE keeps the user's .gguf models: outside the app folder, which an update replaces. */
export function userModelsDir(): string {
  return path.join(os.homedir(), 'VYRSE', 'models')
}

/** Runs setup.ps1; every output line goes to onLine. Resolves true when it finished without anything left to do. */
export function runSetup(source: SetupSource, hermesHome: string, onLine: (line: string) => void): Promise<boolean> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(source.root, 'scripts', 'setup.ps1')]
  if (source.bundled) {
    const models = userModelsDir()
    try {
      fs.mkdirSync(models, { recursive: true })
      const readme = path.join(source.root, 'models', 'README.md')
      if (fs.existsSync(readme) && !fs.existsSync(path.join(models, 'README.md'))) fs.copyFileSync(readme, path.join(models, 'README.md'))
    } catch {
      // setup reports the folder it could not use
    }
    args.push('-ModelsDir', models)
  }
  return new Promise(resolve => {
    const child = spawn('powershell.exe', args, {
      env: { ...process.env, HERMES_HOME: hermesHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let rest = ''
    const feed = (data: Buffer) => {
      const lines = (rest + data.toString('utf8')).split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line.trimEnd())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.once('error', err => {
      onLine(`setup could not start: ${err.message}`)
      resolve(false)
    })
    child.once('exit', code => {
      if (rest.trim()) onLine(rest.trimEnd())
      if (code === 0) {
        try {
          fs.mkdirSync(path.dirname(stampFile(hermesHome)), { recursive: true })
          fs.writeFileSync(stampFile(hermesHome), JSON.stringify({ version: source.appVersion, at: new Date().toISOString() }))
        } catch {
          // without the stamp, setup simply runs again next time
        }
      }
      resolve(code === 0)
    })
  })
}

/** Hermes Agent's own installer for Windows (the one its README tells people to run). */
export const HERMES_INSTALLER_URL = 'https://hermes-agent.nousresearch.com/install.ps1'

/**
 * PowerShell arguments that install Hermes Agent without asking questions: fetch the official installer to a
 * file and run that file (run as a file it reports success or failure through its exit code). `localScript`
 * runs a script already on disk instead (developer checks only).
 */
export function hermesInstallArgs(localScript?: string): string[] {
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  if (localScript) return [...base, '-File', localScript, '-NonInteractive']
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    "$f = Join-Path $env:TEMP 'hermes-install.ps1'",
    "Write-Output 'Downloading the Hermes installer'",
    `Invoke-WebRequest -UseBasicParsing -Uri '${HERMES_INSTALLER_URL}' -OutFile $f`,
    '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f -NonInteractive',
    'exit $LASTEXITCODE',
  ].join('; ')
  return [...base, '-Command', script]
}

/** Run Hermes Agent's installer; true when it finished cleanly. Lines of its output go to `onLine`. */
export function installHermes(onLine: (line: string) => void, localScript?: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', hermesInstallArgs(localScript), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let rest = ''
    const feed = (data: Buffer) => {
      // The installer draws progress with colour codes; keep the words.
      const lines = (rest + data.toString('utf8')).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/)
      rest = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line.trimEnd())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.once('error', err => {
      onLine(`the installer could not start: ${err.message}`)
      resolve(false)
    })
    child.once('exit', code => {
      if (rest.trim()) onLine(rest.trimEnd())
      resolve(code === 0)
    })
  })
}
