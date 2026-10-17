import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Tells the overlay when the user clicks anywhere on screen, while a "show me where" ring is up (the overlay is
 * click-through, so it can't see clicks itself). A small PowerShell helper polls the left mouse button and prints
 * "x y" (physical pixels) on each press. It runs only while a ring is showing.
 */
const SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class VyrseClicks {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
[void][VyrseClicks]::SetProcessDPIAware()
$key = if ([VyrseClicks]::GetSystemMetrics(23)) { 2 } else { 1 }  # swapped buttons: the primary is the right one
$down = $false
while ($true) {
  $now = ([VyrseClicks]::GetAsyncKeyState($key) -band 0x8000) -ne 0
  if ($now -and -not $down) { $p = New-Object VyrseClicks+P; [void][VyrseClicks]::GetCursorPos([ref]$p); [Console]::Out.WriteLine("$($p.X) $($p.Y)"); [Console]::Out.Flush() }
  $down = $now
  Start-Sleep -Milliseconds 25
}
`

export class ClickWatch {
  private child: ChildProcess | null = null

  constructor(private readonly onClick: (x: number, y: number) => void) {}

  start(): void {
    if (process.platform !== 'win32' || this.child) return
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    this.child = child
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const [x, y] = buffer.slice(0, nl).trim().split(/\s+/).map(Number)
        buffer = buffer.slice(nl + 1)
        if (Number.isFinite(x) && Number.isFinite(y)) this.onClick(x!, y!)
      }
    })
    child.on('exit', () => {
      if (this.child === child) this.child = null
    })
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill()
  }
}
