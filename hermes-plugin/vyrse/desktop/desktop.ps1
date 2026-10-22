# Background desktop actions for VYRSE through Windows UI Automation: no mouse, no keyboard, no focus change
# (except action=focus). Input: -Request <base64 JSON {action, ...}>. Output: one JSON object on stdout.
param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, WindowsBase
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class VyrseUser32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$Scope = [System.Windows.Automation.TreeScope]
$Self = @('VYRSE', 'electron', 'cua-driver', 'TextInputHost', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost')
# Not windows a person works in: the desktop itself, overlays, widgets and desktop skins. Never listed, moved or closed.
$NotApps = @('NVIDIA Overlay', 'NVIDIA Share', 'Rainmeter', 'Widgets', 'WidgetBoard', 'GameBar', 'GameBarFTServer', 'LockApp',
  'SystemSettingsBroker', 'XboxGameBarWidgets', 'PhoneExperienceHost', 'CrossDeviceResume')

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Fail($message) { Out-Json @{ ok = $false; error = $message } }

function Get-AppWindows {
  $list = @()
  foreach ($w in $A::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $c = $w.Current
      if (-not $c.Name -or $c.IsOffscreen) { continue }
      $proc = (Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue).ProcessName
      if ($Self -contains $proc -or $NotApps -contains $proc -or $c.Name -match '^(VYRSE|Vyrse)' -or $c.Name -eq 'Program Manager') { continue }
      $list += [pscustomobject]@{ el = $w; title = $c.Name; app = $proc; pid = $c.ProcessId; hwnd = $c.NativeWindowHandle }
    } catch {}
  }
  # front to back, as they're stacked on screen (UI Automation's order isn't the z-order), minus cloaked ones
  # (on another virtual desktop, or a suspended app that only looks open)
  $rank = @{}
  $h = [VyrseUser32]::GetTopWindow([IntPtr]::Zero); $i = 0
  while ($h -ne [IntPtr]::Zero -and $i -lt 5000) { $rank[[int64]$h] = $i; $i++; $h = [VyrseUser32]::GetWindow($h, 2) }
  @($list | Where-Object {
      $cloaked = 0
      -not ([VyrseUser32]::DwmGetWindowAttribute([IntPtr]$_.hwnd, 14, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0)
    } | Sort-Object { if ($rank.ContainsKey([int64]$_.hwnd)) { $rank[[int64]$_.hwnd] } else { 99999 } })
}

function Find-Window([string]$query) {
  if ($req.hwnd) {
    $hit = Get-AppWindows | Where-Object { $_.hwnd -eq [int]$req.hwnd } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  if (-not $query) { Fail 'Say which window: part of its title or the app name (e.g. "notepad").' }
  $q = $query.ToLower() -replace '\.exe$', ''
  $qs = $q -replace '[ _-]', ''  # "Windows Terminal" = WindowsTerminal
  $wins = Get-AppWindows
  $hit = $wins | Where-Object { $_.app.ToLower() -eq $q -or $_.app.ToLower() -eq $qs } | Select-Object -First 1
  if (-not $hit) { $hit = $wins | Where-Object { $_.title.ToLower().Contains($q) } | Select-Object -First 1 }
  if (-not $hit) { $hit = $wins | Where-Object { $_.app.ToLower().Contains($q) } | Select-Object -First 1 }
  if (-not $hit) { Fail "No open window matches '$query'. Open windows: $(($wins | ForEach-Object { "$($_.title) [$($_.app)]" }) -join '; ')" }
  $hit
}

function Set-Place($w, [string]$pos) {
  $h = [IntPtr]$w.hwnd
  switch ($pos) {
    { $_ -in 'minimize', 'minimise' } { [void][VyrseUser32]::ShowWindow($h, 6); return @{ ok = $true; window = $w.title; now = 'minimized' } }
    'maximize' { [void][VyrseUser32]::ShowWindow($h, 3); return @{ ok = $true; window = $w.title; now = 'maximized' } }
    'restore' { [void][VyrseUser32]::ShowWindow($h, 9); return @{ ok = $true; window = $w.title; now = 'restored' } }
  }
  $frac = @{ 'left' = @(0, 0, 0.5, 1); 'right' = @(0.5, 0, 0.5, 1); 'top' = @(0, 0, 1, 0.5); 'bottom' = @(0, 0.5, 1, 0.5);
    'top-left' = @(0, 0, 0.5, 0.5); 'top-right' = @(0.5, 0, 0.5, 0.5); 'bottom-left' = @(0, 0.5, 0.5, 0.5); 'bottom-right' = @(0.5, 0.5, 0.5, 0.5);
    'full' = @(0, 0, 1, 1); 'center' = @(0.15, 0.1, 0.7, 0.8);
    'left-third' = @(0, 0, 0.3333, 1); 'middle-third' = @(0.3333, 0, 0.3334, 1); 'right-third' = @(0.6667, 0, 0.3333, 1);
    'left-two-thirds' = @(0, 0, 0.6667, 1); 'right-two-thirds' = @(0.3333, 0, 0.6667, 1) }
  if (-not $frac.ContainsKey($pos)) { return @{ ok = $false; error = "Position must be one of: $(($frac.Keys + @('minimize','maximize','restore')) -join ', ')." } }
  [void][VyrseUser32]::ShowWindow($h, 9)
  $screen = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
  $f = $frac[$pos]
  $x = $screen.X + [int]($screen.Width * $f[0]); $y = $screen.Y + [int]($screen.Height * $f[1])
  $wd = [int]($screen.Width * $f[2]); $ht = [int]($screen.Height * $f[3])
  $outer = New-Object VyrseUser32+RECT; $vis = New-Object VyrseUser32+RECT
  [void][VyrseUser32]::GetWindowRect($h, [ref]$outer)
  $dl = 0; $dt = 0; $dr = 0; $db = 0
  if ([VyrseUser32]::DwmGetWindowAttribute($h, 9, [ref]$vis, 16) -eq 0) {
    $dl = $vis.Left - $outer.Left; $dt = $vis.Top - $outer.Top; $dr = $outer.Right - $vis.Right; $db = $outer.Bottom - $vis.Bottom
  }
  [void][VyrseUser32]::MoveWindow($h, $x - $dl, $y - $dt, $wd + $dl + $dr, $ht + $dt + $db, $true)
  @{ ok = $true; window = $w.title; app = $w.app; now = $pos }
}

function Get-EditTarget($win) {
  # Prefer the element that has keyboard focus inside this window, else the first writable text area.
  $cond = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Document)),
    (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Edit)))
  foreach ($el in $win.FindAll($Scope::Descendants, $cond)) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly) {
      if ($el.Current.HasKeyboardFocus) { return @{ el = $el; vp = $vp } }
      if (-not $first) { $first = @{ el = $el; vp = $vp } }
    } elseif (-not $fallback -and $el.Current.NativeWindowHandle -ne 0) { $fallback = @{ el = $el; vp = $null } }
  }
  if ($first) { return $first }
  $fallback
}

function Read-Text($win) {
  $target = Get-EditTarget $win
  if ($target -and $target.vp) { return $target.vp.Current.Value }
  $tp = $null
  if ($target -and $target.el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return $tp.DocumentRange.GetText(20000) }
  $names = foreach ($el in $win.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Text)))) { $el.Current.Name }
  ($names | Where-Object { $_ } | Select-Object -Unique) -join "`n"
}

switch ($req.action) {
  'windows' {
    Out-Json @{ ok = $true; windows = @(Get-AppWindows | ForEach-Object { @{ title = $_.title; app = $_.app } }) }
  }
  'open' {
    $target = [string]$req.target
    if (-not $target) { Fail 'Say what to open: an app (notepad, calc, chrome), a file path or a URL.' }
    $before = @(Get-AppWindows | ForEach-Object { $_.hwnd })
    # Resolve bare app names to a real program (ShellExecute on "notepad" can pop an "open with" dialog).
    $aliases = @{ calculator = 'calc.exe'; calc = 'calc.exe'; paint = 'mspaint.exe'; 'file explorer' = 'explorer.exe'; explorer = 'explorer.exe'; settings = 'ms-settings:'; terminal = 'wt.exe'; 'task manager' = 'taskmgr.exe'; word = 'winword.exe'; excel = 'excel.exe' }
    $key = $target.ToLower().Trim()
    if ($aliases.ContainsKey($key)) { $target = $aliases[$key] }
    elseif ($target -notmatch '[\\/:]' -and -not [IO.Path]::HasExtension($target)) {
      $cmd = Get-Command "$target.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($cmd) { $target = $cmd.Source }
      else {
        $app = Get-StartApps | Where-Object { $_.Name -like "*$target*" } | Select-Object -First 1
        if ($app) { $target = "shell:AppsFolder\$($app.AppID)" }
      }
    }
    if ($target.StartsWith('shell:AppsFolder')) { Start-Process -FilePath 'explorer.exe' -ArgumentList $target }
    else { try { Start-Process -FilePath $target -ErrorAction Stop } catch {
      Fail "Windows couldn't open '$target': $($_.Exception.Message)"
    } }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 350
      $new = Get-AppWindows | Where-Object { $before -notcontains $_.hwnd } | Select-Object -First 1
      if ($new) { Out-Json @{ ok = $true; opened = $new.title; app = $new.app } }
    }
    Out-Json @{ ok = $true; opened = $target; note = 'Started; no new window appeared yet (it may reuse an existing window).' }
  }
  'type' {
    $w = Find-Window $req.window
    $target = Get-EditTarget $w.el
    if (-not $target) {
      # No text box (e.g. Calculator): point at the buttons that can be pressed instead.
      $buttons = foreach ($el in $w.el.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Button)))) {
        if (-not $el.Current.IsOffscreen -and $el.Current.Name) { $el.Current.Name }
      }
      $names = ($buttons | Select-Object -Unique | Select-Object -First 40) -join ', '
      Fail "'$($w.title)' has no text field. Press its buttons one at a time with action=click and name=<label>. Buttons: $names"
    }
    $text = [string]$req.text
    if ($target.vp) {
      $value = if ($req.mode -eq 'replace') { $text } else { $target.vp.Current.Value + $text }
      $target.vp.SetValue($value)
      Out-Json @{ ok = $true; window = $w.title; text_now = ($target.vp.Current.Value | ForEach-Object { if ($_.Length -gt 300) { $_.Substring($_.Length - 300) } else { $_ } }) }
    }
    $hwnd = [IntPtr]$target.el.Current.NativeWindowHandle
    foreach ($ch in $text.ToCharArray()) { [void][VyrseUser32]::PostMessage($hwnd, 0x0102, [IntPtr][int]$ch, [IntPtr]::Zero) }
    Out-Json @{ ok = $true; window = $w.title; note = 'Sent as key messages; cannot be read back to verify.' }
  }
  'read' {
    $w = Find-Window $req.window
    $text = Read-Text $w.el
    if ($text.Length -gt 6000) { $text = $text.Substring(0, 6000) + "`n…(truncated)" }
    Out-Json @{ ok = $true; window = $w.title; app = $w.app; text = $text }
  }
  'click' {
    $w = Find-Window $req.window
    if ($null -ne $req.x -and $null -ne $req.y) {
      # The control was chosen by looking at the window (see.py): press whatever is at that point, in the background
      # through its UI Automation pattern, climbing to the nearest pressable parent (an icon inside a button).
      [void][VyrseUser32]::SetProcessDPIAware()  # x/y are physical pixels, as locate.ps1 reports them
      # The control is the smallest element in this window that holds the point (the window's own tree, so it
      # works when the window is covered, and inside XAML-hosted toolbars that FromPoint can't see into).
      $cache = New-Object System.Windows.Automation.CacheRequest
      $cache.Add($A::BoundingRectangleProperty)
      $active = $cache.Activate()
      try { $all = $w.el.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition ($A::IsOffscreenProperty, $false))) } finally { $active.Dispose() }
      $el = $null; $area = [double]::MaxValue
      foreach ($cand in $all) {
        $b = $cand.Cached.BoundingRectangle
        if ($b.IsEmpty -or $req.x -lt $b.X -or $req.y -lt $b.Y -or $req.x -gt $b.X + $b.Width -or $req.y -gt $b.Y + $b.Height) { continue }
        if ($b.Width * $b.Height -lt $area) { $el = $cand; $area = $b.Width * $b.Height }
      }
      if (-not $el) { $el = $A::FromPoint((New-Object System.Windows.Point ([double]$req.x), ([double]$req.y))) }
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      for ($i = 0; $el -and $i -lt 5; $i++) {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); break }
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); break }
        if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); break }
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); break }
        $el = $walker.GetParent($el)
        $p = $null
      }
      if (-not $p) {
        # nothing pressable through UI Automation (custom-drawn apps): a real click at that spot, if it's on a screen
        $onScreen = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Contains([int]$req.x, [int]$req.y) }).Count -gt 0
        if (-not $onScreen) { Fail "'$($req.name)' is off the screen, so I can't click it. Bring the window onto the screen." }
        [void][VyrseUser32]::ShowWindow([IntPtr]$w.hwnd, 9); [void][VyrseUser32]::SetForegroundWindow([IntPtr]$w.hwnd)
        Start-Sleep -Milliseconds 150
        [void][VyrseUser32]::SetCursorPos([int]$req.x, [int]$req.y)
        [VyrseUser32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); [VyrseUser32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
        Out-Json @{ ok = $true; window = $w.title; clicked = [string]$req.name; how = 'mouse' }
      }
      Out-Json @{ ok = $true; window = $w.title; clicked = $(if ($el.Current.Name) { $el.Current.Name } else { [string]$req.name }); type = $el.Current.ControlType.ProgrammaticName }
    }
    $name = ([string]$req.name).ToLower().Trim()
    if (-not $name) { Fail 'Say which button or item to click (its visible label).' }
    # Accessible names spell out digits and symbols (Calculator: "Nine", "Multiply by", "Equals").
    $spoken = @{ '0' = 'zero'; '1' = 'one'; '2' = 'two'; '3' = 'three'; '4' = 'four'; '5' = 'five'; '6' = 'six'; '7' = 'seven'; '8' = 'eight'; '9' = 'nine';
      '+' = 'plus'; '-' = 'minus'; '*' = 'multiply by'; 'x' = 'multiply by'; '×' = 'multiply by'; 'times' = 'multiply by'; 'multiply' = 'multiply by';
      '/' = 'divide by'; '÷' = 'divide by'; 'divide' = 'divide by'; '=' = 'equals'; '.' = 'decimal separator'; '%' = 'percent' }
    $wanted = @($name)
    if ($spoken.ContainsKey($name)) { $wanted += $spoken[$name] }
    $exact = $null; $partial = $null; $seen = @()
    foreach ($el in $w.el.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $n = $el.Current.Name
      if (-not $n -or $el.Current.IsOffscreen -or -not $el.Current.IsEnabled) { continue }
      $ln = $n.ToLower()
      if ($wanted -contains $ln) { $exact = $el; break }
      if (-not $partial -and $name.Length -gt 1 -and $ln.Contains($name)) { $partial = $el }
      if ($el.Current.ControlType -eq $CT::Button -or $el.Current.ControlType -eq $CT::MenuItem -or $el.Current.ControlType -eq $CT::TabItem) { $seen += $n }
    }
    $el = if ($exact) { $exact } else { $partial }
    if (-not $el) { Fail "No '$($req.name)' in '$($w.title)'. Clickable labels: $(($seen | Select-Object -Unique | Select-Object -First 40) -join ', ')" }
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
    elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle() }
    elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select() }
    elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand() }
    else { Fail "'$($el.Current.Name)' can't be pressed in the background; use computer_use." }
    Out-Json @{ ok = $true; window = $w.title; clicked = $el.Current.Name; type = $el.Current.ControlType.ProgrammaticName }
  }
  'focus' {
    $w = Find-Window $req.window
    $h = [IntPtr]$w.hwnd
    if ([VyrseUser32]::IsIconic($h)) { [void][VyrseUser32]::ShowWindow($h, 9) }
    $fg = [VyrseUser32]::GetWindowThreadProcessId([VyrseUser32]::GetForegroundWindow(), [IntPtr]::Zero)
    $me = [VyrseUser32]::GetCurrentThreadId()
    [void][VyrseUser32]::AttachThreadInput($me, $fg, $true)
    [void][VyrseUser32]::SetForegroundWindow($h)
    [void][VyrseUser32]::AttachThreadInput($me, $fg, $false)
    Out-Json @{ ok = $true; focused = $w.title }
  }
  'close' {
    $w = Find-Window $req.window
    $wp = $null
    if ($w.el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { $wp.Close() } else { [void][VyrseUser32]::PostMessage([IntPtr]$w.hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    Out-Json @{ ok = $true; closed = $w.title; note = 'If it had unsaved changes it may be asking whether to save.' }
  }
  'arrange' {
    # Snap a window to part of its screen (flush, compensating for Windows 11's invisible resize borders),
    # or minimise / maximise / restore it. Doesn't take focus.
    $w = Find-Window $req.window
    $pos = ([string]$req.position).ToLower().Trim() -replace '[ _]', '-'
    $r = Set-Place $w $pos
    if (-not $r.ok) { Fail $r.error }
    Out-Json $r
  }
  'tidy' {
    # "Tidy my windows": the ones that are open (not minimised), front-most first, laid out side by side.
    # 1 -> full; 2 -> halves; 3 -> left half + right quarters; 4 -> quarters; more -> the four in front, rest minimised.
    $wins = @(Get-AppWindows | Where-Object { -not [VyrseUser32]::IsIconic([IntPtr]$_.hwnd) })
    if ($wins.Count -eq 0) { Fail 'No open windows to tidy.' }
    $layouts = @{ 1 = @('full'); 2 = @('left', 'right'); 3 = @('left', 'top-right', 'bottom-right'); 4 = @('top-left', 'top-right', 'bottom-left', 'bottom-right') }
    $n = [Math]::Min(4, $wins.Count)
    $done = @()
    for ($i = 0; $i -lt $wins.Count; $i++) {
      $pos = if ($i -lt $n) { $layouts[$n][$i] } else { 'minimize' }
      $r = Set-Place $wins[$i] $pos
      $done += "$($wins[$i].app): $pos"
    }
    Out-Json @{ ok = $true; arranged = $done }
  }
  'keys' {
    # A keyboard shortcut sent to one window (e.g. ctrl+s to save). It has to bring that window forward to do it.
    $w = Find-Window $req.window
    $combo = ([string]$req.keys).ToLower().Trim()
    if (-not $combo) { Fail 'Say which keys, e.g. "ctrl+s".' }
    $named = @{ enter = '{ENTER}'; esc = '{ESC}'; escape = '{ESC}'; tab = '{TAB}'; space = ' '; delete = '{DELETE}'; backspace = '{BACKSPACE}';
      up = '{UP}'; down = '{DOWN}'; left = '{LEFT}'; right = '{RIGHT}'; home = '{HOME}'; end = '{END}'; pageup = '{PGUP}'; pagedown = '{PGDN}' }
    1..12 | ForEach-Object { $named["f$_"] = "{F$_}" }
    $mods = ''; $key = ''
    foreach ($part in ($combo -split '\+')) {
      switch ($part.Trim()) {
        'ctrl' { $mods += '^' } 'control' { $mods += '^' } 'shift' { $mods += '+' } 'alt' { $mods += '%' }
        default { $key = if ($named.ContainsKey($_)) { $named[$_] } elseif ($_.Length -eq 1) { $_ } else { Fail "Unknown key '$_'." } }
      }
    }
    if (-not $key) { Fail "No key in '$combo'." }
    $h = [IntPtr]$w.hwnd
    if ([VyrseUser32]::IsIconic($h)) { [void][VyrseUser32]::ShowWindow($h, 9) }
    $fg = [VyrseUser32]::GetWindowThreadProcessId([VyrseUser32]::GetForegroundWindow(), [IntPtr]::Zero)
    $me = [VyrseUser32]::GetCurrentThreadId()
    [void][VyrseUser32]::AttachThreadInput($me, $fg, $true)
    [void][VyrseUser32]::SetForegroundWindow($h)
    [void][VyrseUser32]::AttachThreadInput($me, $fg, $false)
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("$mods$key")
    Out-Json @{ ok = $true; window = $w.title; sent = $combo }
  }
  default { Fail "Unknown action '$($req.action)'." }
}
