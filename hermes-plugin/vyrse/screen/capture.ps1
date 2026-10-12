# Screenshot for VYRSE screen reading. -Target window: the top-most real app window that isn't VYRSE
# (i.e. what the user was looking at); -Target screen: every monitor. Prints JSON {title, process, path}.
param([ValidateSet('window', 'screen')][string]$Target = 'window', [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class VyrseWin {
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
}
"@
[void][VyrseWin]::SetProcessDPIAware()
$skip = @('VYRSE', 'electron', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost', 'TextInputHost', 'Rainmeter', 'NVIDIA Overlay', 'cua-driver')

function Save-Region($x, $y, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

if ($Target -eq 'screen') {
  $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
  Save-Region $v.X $v.Y $v.Width $v.Height
  @{ title = 'Whole screen'; process = ''; path = $Out } | ConvertTo-Json -Compress
  exit 0
}

$h = [VyrseWin]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  if ([VyrseWin]::IsWindowVisible($h) -and -not [VyrseWin]::IsIconic($h)) {
    $cloaked = 0
    [void][VyrseWin]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    $sb = New-Object System.Text.StringBuilder 512
    [void][VyrseWin]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    $procId = 0
    [void][VyrseWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    $r = New-Object VyrseWin+RECT
    [void][VyrseWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
    $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
    if ($cloaked -eq 0 -and $title -and $title -ne 'Program Manager' -and $w -gt 200 -and $hgt -gt 150 -and ($skip -notcontains $proc) -and $title -notmatch '^Vyrse') {
      Save-Region $r.Left $r.Top $w $hgt
      @{ title = $title; process = $proc; path = $Out } | ConvertTo-Json -Compress
      exit 0
    }
  }
  $h = [VyrseWin]::GetWindow($h, 2)
}
throw 'No application window found behind VYRSE.'
