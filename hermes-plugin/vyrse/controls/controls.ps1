# Media, volume, brightness, lock and clipboard for VYRSE, without touching any window.
# Input: -Request <base64 JSON {action, ...}>. Output: one JSON object on stdout.
param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 4; exit 0 }
function Fail($message) { Out-Json @{ ok = $false; error = $message } }

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class VyrseKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static void Tap(byte vk) { keybd_event(vk, 0, 1, UIntPtr.Zero); keybd_event(vk, 0, 3, UIntPtr.Zero); }
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
public static class VyrseMonitors {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription; }
  delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, out uint n);
  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYSICAL_MONITOR[] arr);
  [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr h, out uint min, out uint cur, out uint max);
  [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr h, uint value);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] arr);
  // DDC/CI brightness for every external monitor that supports it. level < 0 = read only. Returns -1 if none.
  public static int Brightness(int level) {
    int result = -1;
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (h, dc, r, d) => {
      uint n; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(h, out n) || n == 0) return true;
      var arr = new PHYSICAL_MONITOR[n];
      if (!GetPhysicalMonitorsFromHMONITOR(h, n, arr)) return true;
      foreach (var m in arr) {
        uint min, cur, max;
        if (!GetMonitorBrightness(m.hPhysicalMonitor, out min, out cur, out max) || max <= min) continue;
        if (level >= 0) { uint v = (uint)(min + (max - min) * Math.Max(0, Math.Min(100, level)) / 100); if (SetMonitorBrightness(m.hPhysicalMonitor, v)) cur = v; }
        if (result < 0) result = (int)Math.Round(100.0 * (cur - min) / (max - min));
      }
      DestroyPhysicalMonitors(n, arr);
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
public static class VyrseAudio {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice dev; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), Guid.Empty)); }
  public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void Mute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
"@

function Volume-State { @{ ok = $true; volume = [int][Math]::Round([VyrseAudio]::Get() * 100); muted = [VyrseAudio]::Muted() } }

function Now-Playing {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(5000); $task.Result }
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if ($null -eq $s) { return @{ ok = $true; playing = $false; note = 'Nothing is playing.' } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $status = $s.GetPlaybackInfo().PlaybackStatus.ToString()
  @{ ok = $true; playing = ($status -eq 'Playing'); status = $status; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; app = $s.SourceAppUserModelId }
}

switch ($req.action) {
  'media' {
    $keys = @{ play_pause = 0xB3; next = 0xB0; previous = 0xB1; stop = 0xB2 }
    $k = [string]$req.command
    if (-not $keys.ContainsKey($k)) { Fail 'command must be play_pause, next, previous or stop' }
    [VyrseKeys]::Tap([byte]$keys[$k])
    Start-Sleep -Milliseconds 400
    try { Out-Json (Now-Playing) } catch { Out-Json @{ ok = $true; sent = $k } }
  }
  'now_playing' { Out-Json (Now-Playing) }
  'volume' {
    $op = [string]$req.command
    switch ($op) {
      'get' { }
      'set' { [VyrseAudio]::Set([float]$req.level / 100); [VyrseAudio]::Mute($false) }
      'up' { [VyrseAudio]::Set([VyrseAudio]::Get() + [float]($(if ($req.level) { $req.level } else { 10 })) / 100) }
      'down' { [VyrseAudio]::Set([VyrseAudio]::Get() - [float]($(if ($req.level) { $req.level } else { 10 })) / 100) }
      'mute' { [VyrseAudio]::Mute($true) }
      'unmute' { [VyrseAudio]::Mute($false) }
      'toggle_mute' { [VyrseAudio]::Mute(-not [VyrseAudio]::Muted()) }
      default { Fail 'command must be get, set, up, down, mute, unmute or toggle_mute' }
    }
    Out-Json (Volume-State)
  }
  'brightness' {
    try {
      $current = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness
      if ($null -ne $req.level) {
        $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1
        $null = Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 0; Brightness = [byte][Math]::Max(0, [Math]::Min(100, [int]$req.level)) }
        $current = [int]$req.level
      }
      Out-Json @{ ok = $true; brightness = $current }
    } catch {
      # Desktop monitors: DDC/CI (the monitor's own control channel).
      $level = if ($null -ne $req.level) { [int]$req.level } else { -1 }
      $now = [VyrseMonitors]::Brightness($level)
      if ($now -lt 0) { Fail "This monitor doesn't accept brightness changes from Windows (turn on DDC/CI in the monitor's menu, or use its buttons)." }
      Out-Json @{ ok = $true; brightness = $now; via = 'DDC/CI' }
    }
  }
  'lock' { [void][VyrseKeys]::LockWorkStation(); Out-Json @{ ok = $true; locked = $true } }
  # Monitors to standby (any mouse move or key wakes them); posted, so it never blocks on a hung window.
  'screen_off' { [void][VyrseKeys]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2); Out-Json @{ ok = $true; screen = 'off' } }
  'clipboard_get' {
    Add-Type -AssemblyName System.Windows.Forms
    $text = [System.Windows.Forms.Clipboard]::GetText()
    $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
    $hasImage = [System.Windows.Forms.Clipboard]::ContainsImage()
    if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) + "`n…(truncated)" }
    Out-Json @{ ok = $true; text = $text; files = @($files); has_image = $hasImage }
  }
  'clipboard_set' {
    Add-Type -AssemblyName System.Windows.Forms
    $text = [string]$req.text
    if (-not $text) { Fail 'clipboard_set needs text' }
    [System.Windows.Forms.Clipboard]::SetText($text)
    Out-Json @{ ok = $true; copied = $text.Length }
  }
  default { Fail "Unknown action '$($req.action)'." }
}
