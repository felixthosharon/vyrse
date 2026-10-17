# Where is a control on screen? For "show me where" and the ghost cursor. Looks in the app window the user is
# on (or -Request window): first Windows UI Automation (buttons, menus, tabs, links, fields by their names),
# then Windows OCR of the window (any visible text). Prints JSON {ok, rect{x,y,width,height} in physical screen
# pixels, name, source, window}.
param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class VyrseLoc {
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
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
[void][VyrseLoc]::SetProcessDPIAware()

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5; exit 0 }

# The window's own pixels (PrintWindow, full content), even when another window covers it; cropped to its visible
# frame (the DWM rect) so image pixels line up with screen coordinates.
function Save-WindowImage($t, [string]$path) {
  $r = $t.rect
  $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  $wr = New-Object VyrseLoc+RECT
  [void][VyrseLoc]::GetWindowRect($t.hwnd, [ref]$wr)
  $full = New-Object System.Drawing.Bitmap ([Math]::Max(1, $wr.Right - $wr.Left)), ([Math]::Max(1, $wr.Bottom - $wr.Top))
  $g = [System.Drawing.Graphics]::FromImage($full)
  $hdc = $g.GetHdc()
  $printed = [VyrseLoc]::PrintWindow($t.hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($printed) {
    $g.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $w, $hgt), (New-Object System.Drawing.Rectangle ($r.Left - $wr.Left), ($r.Top - $wr.Top), $w, $hgt), [System.Drawing.GraphicsUnit]::Pixel)
  } else {
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
  }
  $g.Dispose(); $full.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
$query = [string]$req.query
if (-not $query.Trim()) { Out-Json @{ ok = $false; error = 'Say what to find (the button or text on screen).' } }
$skip = @('VYRSE', 'electron', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost', 'TextInputHost', 'Rainmeter', 'NVIDIA Overlay', 'cua-driver')
$want = [string]$req.window

# ---- the window: the named one, or the top-most real app window that isn't VYRSE -----------------------
$target = $null
$h = [VyrseLoc]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  if ([VyrseLoc]::IsWindowVisible($h) -and -not [VyrseLoc]::IsIconic($h)) {
    $cloaked = 0
    [void][VyrseLoc]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    $sb = New-Object System.Text.StringBuilder 512
    [void][VyrseLoc]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    $procId = 0
    [void][VyrseLoc]::GetWindowThreadProcessId($h, [ref]$procId)
    $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    $r = New-Object VyrseLoc+RECT
    [void][VyrseLoc]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
    $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
    $real = $cloaked -eq 0 -and $title -and $title -ne 'Program Manager' -and $w -gt 200 -and $hgt -gt 150 -and ($skip -notcontains $proc) -and $title -notmatch '^Vyrse'
    if ($real -and (-not $want -or $title.ToLower().Contains($want.ToLower()) -or $proc.ToLower() -eq $want.ToLower().Replace('.exe', ''))) {
      $target = @{ hwnd = $h; title = $title; app = $proc; rect = $r; pid = $procId }
      break
    }
  }
  $h = [VyrseLoc]::GetWindow($h, 2)
}
if (-not $target) { Out-Json @{ ok = $false; error = $(if ($want) { "No open window matches '$want'." } else { 'No app window found behind VYRSE.' }) } }

# ---- its pop-ups: menus, dropdowns and dialogs are windows of their own (Chrome's profile menu, a File menu),
# untitled, above the app in z-order. They're searched first, and the picture is then what's on screen.
$popups = @()
$h = [VyrseLoc]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero -and $h -ne $target.hwnd) {
  if ([VyrseLoc]::IsWindowVisible($h) -and -not [VyrseLoc]::IsIconic($h)) {
    $procId = 0
    [void][VyrseLoc]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($procId -eq $target.pid) {
      $cloaked = 0
      [void][VyrseLoc]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
      $pr = New-Object VyrseLoc+RECT
      [void][VyrseLoc]::DwmGetWindowAttribute($h, 9, [ref]$pr, 16)
      if ($cloaked -eq 0 -and ($pr.Right - $pr.Left) -ge 20 -and ($pr.Bottom - $pr.Top) -ge 20) { $popups += @{ hwnd = $h; rect = $pr } }
    }
  }
  $h = [VyrseLoc]::GetWindow($h, 2)
}
$area = New-Object VyrseLoc+RECT
$area.Left = $target.rect.Left; $area.Top = $target.rect.Top; $area.Right = $target.rect.Right; $area.Bottom = $target.rect.Bottom
foreach ($pp in $popups) {
  $area.Left = [Math]::Min($area.Left, $pp.rect.Left); $area.Top = [Math]::Min($area.Top, $pp.rect.Top)
  $area.Right = [Math]::Max($area.Right, $pp.rect.Right); $area.Bottom = [Math]::Max($area.Bottom, $pp.rect.Bottom)
}
$roots = @($popups | ForEach-Object { $_.hwnd }) + @($target.hwnd)

# The window (with its pop-ups) as an image: the window's own pixels when it's alone (right even when it's
# covered), the screen itself while a pop-up is open (that's what the user sees).
function Save-AreaImage([string]$path) {
  if (-not $popups.Count) { Save-WindowImage $target $path; return }
  $w = $area.Right - $area.Left; $hgt = $area.Bottom - $area.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($area.Left, $area.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

function Norm([string]$s) { ($s.ToLower() -replace '[^\p{L}\p{N}]+', ' ').Trim() }
$q = Norm $query
$qWords = @($q.Split(' ') | Where-Object { $_ })
function Score([string]$name) {
  $n = Norm $name
  if (-not $n) { return 0 }
  if ($n -eq $q) { return 100 }
  if ($n.StartsWith($q)) { return 85 - [Math]::Min(20, ($n.Length - $q.Length)) }
  if ($n.Contains($q)) { return 70 - [Math]::Min(25, ($n.Length - $q.Length) / 2) }
  $words = @($n.Split(' '))
  $hit = @($qWords | Where-Object { $words -contains $_ }).Count
  if ($hit -eq 0) { return 0 }
  return [int](55 * $hit / [Math]::Max($qWords.Count, $words.Count))
}

# ---- mode=sig: a cheap fingerprint of what's showing (title, pop-ups, how many controls): it changes when a
# click opened a menu, a panel or a new page. For noticing that the user clicked what VYRSE ringed. ----
if ($req.mode -eq 'sig') {
  $A = [System.Windows.Automation.AutomationElement]
  $n = 0
  try { foreach ($rh in $roots) { $n += $A::FromHandle($rh).FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ($A::IsOffscreenProperty, $false))).Count } } catch {}
  Out-Json @{ ok = $true; window = $target.title; sig = "$($target.title)|$($popups.Count)|$n" }
}

# ---- mode=list: every control in the window (icon-only ones too) plus a screenshot, for looking at it ----
# The caller numbers them on the screenshot and asks the vision model which one the user means.
if ($req.mode -eq 'list') {
  $r = $area
  $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  $png = [string]$req.out
  Save-AreaImage $png
  $A = [System.Windows.Automation.AutomationElement]
  $CT = [System.Windows.Automation.ControlType]
  $cache = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($A::NameProperty, $A::BoundingRectangleProperty, $A::ControlTypeProperty, $A::HelpTextProperty, $A::AutomationIdProperty, $A::IsEnabledProperty, $A::ClassNameProperty)) { $cache.Add($p) }
  $types = @($CT::Button, $CT::MenuItem, $CT::TabItem, $CT::Hyperlink, $CT::ListItem, $CT::CheckBox, $CT::RadioButton,
    $CT::ComboBox, $CT::Edit, $CT::TreeItem, $CT::SplitButton, $CT::Slider, $CT::DataItem, $CT::Image, $CT::Text)
  $typeCond = New-Object System.Windows.Automation.OrCondition (, [System.Windows.Automation.Condition[]]@($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty, $_) }))
  $cond = New-Object System.Windows.Automation.AndCondition ((New-Object System.Windows.Automation.PropertyCondition ($A::IsOffscreenProperty, $false)), $typeCond)
  $items = @()
  try {
    $found = @()
    $active = $cache.Activate()
    try { foreach ($rh in $roots) { $found += @($A::FromHandle($rh).FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) } } finally { $active.Dispose() }
    foreach ($el in $found) {
      $c = $el.Cached
      $b = $c.BoundingRectangle
      if ($b.IsEmpty -or $b.Width -lt 6 -or $b.Height -lt 6) { continue }
      if ($b.Width * $b.Height -gt 0.4 * $w * $hgt) { continue }  # a whole pane, not a control
      if ($b.X + $b.Width -lt $r.Left -or $b.Y + $b.Height -lt $r.Top -or $b.X -gt $r.Right -or $b.Y -gt $r.Bottom) { continue }
      $items += @{ type = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); name = [string]$c.Name; help = [string]$c.HelpText
        id = [string]$c.AutomationId; enabled = [bool]$c.IsEnabled; cls = [string]$c.ClassName
        rect = @{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height } }
      if ($items.Count -ge 400) { break }
    }
  } catch {}
  # where the web page sits on screen (a browser's document area), so a spot can be clicked inside the page
  $viewport = $null
  try {
    $doc = $A::FromHandle($target.hwnd).FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty, $CT::Document)))
    if ($doc) { $vb = $doc.Current.BoundingRectangle; if (-not $vb.IsEmpty) { $viewport = @{ x = [int]$vb.X; y = [int]$vb.Y; width = [int]$vb.Width; height = [int]$vb.Height } } }
  } catch {}
  $popupRects = @($popups | ForEach-Object { @{ x = $_.rect.Left; y = $_.rect.Top; width = $_.rect.Right - $_.rect.Left; height = $_.rect.Bottom - $_.rect.Top } })
  Out-Json @{ ok = $true; window = $target.title; app = $target.app; image = $png; popups = $popups.Count; popup_rects = $popupRects; viewport = $viewport
    rect = @{ x = $r.Left; y = $r.Top; width = $w; height = $hgt }; items = $items }
}

# ---- 1. UI Automation: named controls, with their properties fetched in one round trip ----------------
$best = $null
try {
  $A = [System.Windows.Automation.AutomationElement]
  $CT = [System.Windows.Automation.ControlType]
  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.Add($A::NameProperty); $cache.Add($A::BoundingRectangleProperty); $cache.Add($A::ControlTypeProperty)
  $cache.Add($A::HelpTextProperty); $cache.Add($A::AutomationIdProperty)
  $types = @($CT::Button, $CT::MenuItem, $CT::TabItem, $CT::Hyperlink, $CT::ListItem, $CT::CheckBox, $CT::RadioButton,
    $CT::ComboBox, $CT::Edit, $CT::TreeItem, $CT::SplitButton, $CT::Text, $CT::Image, $CT::DataItem, $CT::Menu, $CT::ToolBar)
  $typeCond = New-Object System.Windows.Automation.OrCondition (, [System.Windows.Automation.Condition[]]@($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty, $_) }))
  $cond = New-Object System.Windows.Automation.AndCondition ((New-Object System.Windows.Automation.PropertyCondition ($A::IsOffscreenProperty, $false)), $typeCond)
  $found = @()
  $active = $cache.Activate()
  try { foreach ($rh in $roots) { $found += @($A::FromHandle($rh).FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) } } finally { $active.Dispose() }
  foreach ($el in $found) {
    $c = $el.Cached
    # icon buttons often carry their meaning in a tooltip or an id ("SearchButton") rather than the name
    $idWords = ([string]$c.AutomationId -creplace '([a-z])([A-Z])', '$1 $2') -replace '[_\-]+', ' '
    $s = [Math]::Max((Score $c.Name), [Math]::Max((Score ([string]$c.HelpText)) - 10, (Score $idWords) - 15))
    if ($s -lt 40) { continue }
    $b = $c.BoundingRectangle
    if ($b.IsEmpty -or $b.Width -lt 4 -or $b.Height -lt 4) { continue }
    # a clickable control beats static text with the same name
    if ($c.ControlType -ne $CT::Text -and $c.ControlType -ne $CT::Image) { $s += 4 }
    if (-not $best -or $s -gt $best.score) {
      $best = @{ score = $s; name = $(if ($c.Name) { $c.Name } else { [string]$c.HelpText }); type = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
        rect = @{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height }; source = 'uia' }
    }
  }
} catch {}

# ---- 2. OCR of the window: any visible text --------------------------------------------------------------
if (-not $best -or $best.score -lt 60) {
  try {
    $r = $area
    $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
    $png = Join-Path $env:TEMP "vyrse-locate-$PID.png"
    Save-AreaImage $png

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sbmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    $ocr = Await ($engine.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    Remove-Item $png -ErrorAction SilentlyContinue
    foreach ($line in $ocr.Lines) {
      $words = @($line.Words)
      for ($i = 0; $i -lt $words.Count; $i++) {
        for ($len = 1; $len -le [Math]::Min($qWords.Count + 2, $words.Count - $i); $len++) {
          $span = $words[$i..($i + $len - 1)]
          $s = Score (($span | ForEach-Object { $_.Text }) -join ' ')
          if ($s -lt 40 -or ($best -and $s -le $best.score)) { continue }
          $x1 = ($span | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
          $y1 = ($span | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
          $x2 = ($span | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
          $y2 = ($span | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
          $best = @{ score = $s; name = (($span | ForEach-Object { $_.Text }) -join ' '); source = 'ocr'
            rect = @{ x = [int]($r.Left + $x1 - 4); y = [int]($r.Top + $y1 - 3); width = [int]($x2 - $x1 + 8); height = [int]($y2 - $y1 + 6) } }
        }
      }
    }
  } catch {}
}

if (-not $best) { Out-Json @{ ok = $false; error = "Couldn't find '$query' in $($target.title)."; window = $target.title; app = $target.app } }
$wr = $area
Out-Json @{ ok = $true; rect = $best.rect; name = $best.name; type = $best.type; source = $best.source; score = $best.score; window = $target.title; app = $target.app
  area = @{ x = $wr.Left; y = $wr.Top; width = $wr.Right - $wr.Left; height = $wr.Bottom - $wr.Top } }
