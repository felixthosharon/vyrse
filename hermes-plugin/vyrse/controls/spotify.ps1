# "Play lofi on Spotify": open Spotify's search for the words, press Play on the top result through UI Automation
# (no mouse, no keys), then read back what is really playing. Works with Spotify Free and Premium, no account link.
# Input: -Request <base64 JSON {query}>. Output: one JSON object on stdout.
param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 4; exit 0 }
function Fail($message) { Out-Json @{ ok = $false; error = $message } }

function Now-Playing {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(5000); $task.Result }
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  foreach ($s in $mgr.GetSessions()) {
    if ($s.SourceAppUserModelId -notmatch 'spotify') { continue }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    return @{ status = $s.GetPlaybackInfo().PlaybackStatus.ToString(); title = $p.Title; artist = $p.Artist }
  }
  return $null
}

function Spotify-Window {
  foreach ($p in @(Get-Process spotify -ErrorAction SilentlyContinue)) {
    if ($p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }
  }
  return [IntPtr]::Zero
}

$query = ([string]$req.query).Trim()
if (-not $query) { Fail 'Say what to play (a song, artist, playlist or mood).' }
$exe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
$registered = Test-Path 'HKCU:\Software\Classes\spotify\shell\open\command'
if (-not $registered -and -not (Test-Path $exe) -and -not (Get-AppxPackage -Name '*Spotify*' -ErrorAction SilentlyContinue)) {
  Fail 'Spotify is not installed on this PC.'
}
$before = Now-Playing
Start-Process ('spotify:search:' + [Uri]::EscapeDataString($query))

$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$isButton = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$words = @($query.ToLower() -split '\W+' | Where-Object { $_.Length -gt 1 })

function Norm([string]$s) { (($s.ToLower() -replace '[^\p{L}\p{N}]+', ' ').Trim()) }

# The search page is a group named "Search for <words> | Spotify" (the search field itself isn't visible to UI
# Automation). Each result holds a "Play <title>" button, the title, the artist and a label with its type
# ("Song", "Single", "Album", "Playlist", "Artist"...). Spotify's shuffle setting applies when a whole single,
# album or playlist is started, so for a named song press that song's own row.
function Pick-Result($page) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $want = Norm $query; $wantTitle = $want; $wantArtist = ''
  if ($query -match '^(.+?)\s+by\s+(.+)$') { $wantTitle = Norm $Matches[1]; $wantArtist = Norm $Matches[2] }
  $results = @()
  foreach ($b in @($page.FindAll($Scope::Descendants, $isButton))) {
    if ($results.Count -ge 36) { break }
    $name = $b.Current.Name
    if ($name -notmatch '^Play (.+)$' -or -not $b.Current.IsEnabled) { continue }
    $title = $Matches[1]
    $item = $b; for ($k = 0; $k -lt 3 -and $item; $k++) { $item = $walker.GetParent($item) }
    $kind = ''; $artist = ''
    if ($item) {
      $texts = @($item.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      $label = $texts | Where-Object { $_ -match '^(Song|Single|EP|Album|Compilation|Playlist|Artist|Podcast|Episode|Audiobook)\b' } | Select-Object -First 1
      if ($label) { $kind = ($label -split ' ')[0] }
      $artist = ($texts | Where-Object { $_ -ne $title -and $_ -ne $name -and $_ -notmatch '^(Song|Single|EP|Album|Playlist|Artist|More options|Add to|Save )' } | Select-Object -First 1)
    }
    $results += [pscustomobject]@{ button = $b; title = $title; t = (Norm $title); kind = $kind; artist = (Norm $artist); off = $b.Current.IsOffscreen }
  }
  $script:lastResults = $results
  if (-not $results.Count) { return $null }
  $exact = @($results | Where-Object { $_.t -eq $wantTitle -and (-not $wantArtist -or $_.artist.Contains($wantArtist)) })
  if (-not $exact.Count) { $exact = @($results | Where-Object { "$($_.t) $($_.artist)" -eq $want }) }
  if ($exact.Count) {
    foreach ($k in 'Song', 'Artist', 'Playlist', 'Album', 'Single', 'EP') { $hit = $exact | Where-Object kind -eq $k | Select-Object -First 1; if ($hit) { return $hit } }
    return $exact[0]
  }
  # A mood or genre ("lofi", "chill rap"): a playlist with those words keeps going; else the first related result.
  # Cards without a type label are suggestions above the real results ("Radio" mixes, browse tiles): last resort.
  $related = @($results | Where-Object { $t = "$($_.t) $($_.artist)"; @($words | Where-Object { $t.Contains($_) }).Count })
  $hit = $related | Where-Object kind -eq 'Playlist' | Select-Object -First 1
  if ($hit) { return $hit }
  $hit = $related | Where-Object kind | Select-Object -First 1
  if ($hit) { return $hit }
  if ($related.Count) { return $related[0] }
  return ($results | Where-Object { $_.kind -and -not $_.off } | Select-Object -First 1)
}

$deadline = (Get-Date).AddSeconds(25)
$pick = $null; $window = $false; $page = $null
while ((Get-Date) -lt $deadline -and -not $pick) {
  Start-Sleep -Milliseconds 700
  $h = Spotify-Window
  if ($h -eq [IntPtr]::Zero) { continue }
  $window = $true
  try {
    $win = $A::FromHandle($h)
    $page = $null
    foreach ($g in $win.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Group)))) {
      if ($g.Current.Name -match '^Search for (.+) \| Spotify$' -and (Norm ([Uri]::UnescapeDataString(($Matches[1] -replace '\+', ' ')))) -eq (Norm $query)) { $page = $g; break }
    }
    if (-not $page) { continue }
    Start-Sleep -Milliseconds 600
    $pick = Pick-Result $page
    if (-not $pick) { continue }
    if ($env:VYRSE_SPOTIFY_DEBUG) { [Console]::Error.WriteLine(($script:lastResults | ForEach-Object { "$($_.kind)|$($_.title)|$($_.artist)" }) -join "`n") }
    # The page can redraw between finding a result and pressing it (the element goes stale): find it again.
    $pressed = $pick.button.Current.Name
    # What's loaded right now (a freshly opened Spotify reloads the last song): the new song must differ from it.
    try { $loaded = Now-Playing; if ($loaded -and $loaded.title) { $before = $loaded } } catch { }
    $p = $null
    if ($pressed -and $pick.button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
    else { $pick = $null; $pressed = $null }
  } catch { $pick = $null; $pressed = $null }
}
if (-not $window) { Fail "Spotify didn't open in time. Say so; don't claim it's playing." }
if (-not $page) { Fail "Opened Spotify, but its search for '$query' didn't load in time. Say so; don't claim it's playing." }
if (-not $pick) { Fail "Spotify searched for '$query' but showed no result it could press. Say so; don't claim it's playing." }

# Report what's really playing now (Windows' media info), not what we hoped for. The old track can show as
# playing for a moment, so wait for the title to change (unless they asked for the song that was already on).
$now = $null
for ($i = 0; $i -lt 14; $i++) {
  Start-Sleep -Milliseconds 500
  try { $now = Now-Playing } catch { $now = $null }
  if ($now -and $now.status -eq 'Playing' -and $now.title -and (-not $before -or $now.title -ne $before.title)) { break }
}
if ($now -and $now.status -eq 'Playing') {
  Out-Json @{ ok = $true; playing = $true; pressed = $pressed; started = "$($pick.kind) $($pick.title)".Trim(); title = $now.title; artist = $now.artist; app = 'Spotify' }
}
Out-Json @{ ok = $false; pressed = $pressed; status = $(if ($now) { $now.status } else { 'unknown' });
  error = "Pressed '$pressed' in Spotify, but nothing started playing. Say so; don't claim it's playing." }
