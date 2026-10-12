<#
.SYNOPSIS
  Prepare Hermes Agent for VYRSE (safe to re-run; run again after `hermes update`).

.DESCRIPTION
  VYRSE is a desktop interface for Hermes. This script only does what Hermes needs for it:
    1. checks the Hermes install
    2. re-applies VYRSE's small Hermes patches (hermes-patches/*.patch) if an update dropped them
    3. links + enables the `vyrse` Hermes plugin
    4. installs the plugin's voice libraries into %HERMES_HOME%\vyrse\pylib
    5. downloads + verifies the voice models (Kokoro TTS), places the wake word model in %HERMES_HOME%\vyrse\models
       and installs VYRSE's Hermes skills (hermes-plugin\skills)
    6. sets the Hermes config VYRSE relies on (never overwrites choices you changed later)

  -Check reports what is missing without changing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Check
#>
param(
  [switch]$Check,
  # Optional local copy of the fp32 Kokoro model (kokoro-v1.0.onnx, ~325 MB); otherwise it is downloaded and verified.
  [string]$KokoroModel = ""
)
# Native tools (git, hermes) write warnings to stderr; failures are checked explicitly instead.
$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$Agent = Join-Path $HermesHome 'hermes-agent'
$Py = Join-Path $Agent 'venv\Scripts\python.exe'
$Hermes = Join-Path $Agent 'venv\Scripts\hermes.exe'
$Uv = Join-Path $HermesHome 'bin\uv.exe'
$VyrseDir = Join-Path $HermesHome 'vyrse'
$Problems = 0

function Ok($msg) { Write-Host "  [ok]   $msg" -ForegroundColor Green }
function Todo($msg) { Write-Host "  [todo] $msg" -ForegroundColor Yellow; $script:Problems++ }
function Did($msg) { Write-Host "  [done] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "  [fail] $msg" -ForegroundColor Red; $script:Problems++ }

Write-Host "VYRSE setup ($(if ($Check) { 'check only' } else { 'apply' }))  Hermes home: $HermesHome"

# 1. Hermes -------------------------------------------------------------------------------
Write-Host "Hermes Agent"
if (-not (Test-Path $Py) -or -not (Test-Path $Hermes)) {
  Fail "Hermes Agent not found at $Agent. Install it first: https://hermes-agent.nousresearch.com"
  exit 1
}
Ok ((& $Hermes --version 2>$null | Select-Object -First 1))

# 2. Patches ------------------------------------------------------------------------------
Write-Host "Hermes patches"
foreach ($patch in Get-ChildItem (Join-Path $Repo 'hermes-patches') -Filter *.patch | Sort-Object Name) {
  git -C $Agent apply --check --reverse $patch.FullName 2>$null
  if ($LASTEXITCODE -eq 0) { Ok "$($patch.Name) applied"; continue }
  git -C $Agent apply --check $patch.FullName 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "$($patch.Name) no longer applies cleanly (Hermes changed upstream) - needs a refresh"; continue }
  if ($Check) { Todo "$($patch.Name) not applied" } else { git -C $Agent apply $patch.FullName; Did "$($patch.Name) applied" }
}

# 3. Plugin -------------------------------------------------------------------------------
Write-Host "vyrse plugin"
$PluginLink = Join-Path $HermesHome 'plugins\vyrse'
$PluginSrc = Join-Path $Repo 'hermes-plugin\vyrse'
if (Test-Path $PluginLink) { Ok "linked: $PluginLink" }
elseif ($Check) { Todo "plugin not linked" }
else {
  New-Item -ItemType Directory -Force (Split-Path $PluginLink) | Out-Null
  New-Item -ItemType Junction -Path $PluginLink -Target $PluginSrc | Out-Null
  Did "linked $PluginLink -> $PluginSrc"
}
$enabled = (& $Hermes config get plugins.enabled 2>$null) -join ' '
if ($enabled -match '\bvyrse\b') { Ok "enabled" }
elseif ($Check) { Todo "plugin not enabled" }
else { & $Hermes plugins enable vyrse | Out-Null; Did "enabled" }

# 4. Voice libraries ----------------------------------------------------------------------
Write-Host "Voice libraries ($VyrseDir\pylib)"
$Pylib = Join-Path $VyrseDir 'pylib'
& $Py -c "import sys; sys.path.append(r'$Pylib'); import kokoro_onnx, phonemizer, espeakng_loader" 2>$null
if ($LASTEXITCODE -eq 0) { Ok "kokoro-onnx, phonemizer, espeakng-loader" }
elseif ($Check) { Todo "voice libraries missing" }
else {
  New-Item -ItemType Directory -Force $Pylib | Out-Null
  & $Uv pip install --python $Py --target $Pylib --no-deps kokoro-onnx==0.6.1 | Out-Null
  & $Uv pip install --python $Py --target $Pylib phonemizer==3.4.0 espeakng-loader==0.2.4 | Out-Null
  Did "installed (numpy/onnxruntime come from the Hermes venv)"
}

# 5. Models -------------------------------------------------------------------------------
Write-Host "Voice models ($VyrseDir\models)"
$Models = Join-Path $VyrseDir 'models'
$KokoroDir = Join-Path $Models 'kokoro'
# Kokoro (VYRSE's voice) comes from its official release and is checked against known SHA-256 hashes, so a
# corrupted or tampered download is never used. A local copy can be given with -KokoroModel instead.
$KokoroRelease = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
$KokoroFiles = @(
  @{ Name = 'kokoro-v1.0.onnx'; Sha = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5'; Size = '325 MB'; Local = $KokoroModel },
  @{ Name = 'voices-v1.0.bin'; Sha = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'; Size = '28 MB'; Local = '' }
)
foreach ($f in $KokoroFiles) {
  $dest = Join-Path $KokoroDir $f.Name
  if ((Test-Path $dest) -and (Get-FileHash $dest -Algorithm SHA256).Hash -eq $f.Sha) { Ok "Kokoro $($f.Name)"; continue }
  if ($Check) { Todo "Kokoro $($f.Name) missing ($($f.Size))"; continue }
  New-Item -ItemType Directory -Force $KokoroDir | Out-Null
  $tmp = "$dest.download"
  if ($f.Local -and (Test-Path $f.Local)) { Copy-Item $f.Local $tmp -Force }
  else {
    Write-Host "  downloading $($f.Name) ($($f.Size))..."
    try { Invoke-WebRequest -UseBasicParsing -Uri "$KokoroRelease/$($f.Name)" -OutFile $tmp } catch { Fail "Kokoro $($f.Name): download failed ($($_.Exception.Message))"; continue }
  }
  if ((Get-FileHash $tmp -Algorithm SHA256).Hash -ne $f.Sha) { Remove-Item $tmp -Force; Fail "Kokoro $($f.Name): checksum mismatch, not used"; continue }
  Move-Item $tmp $dest -Force
  Did "Kokoro $($f.Name)"
}
$wake = Join-Path $Models 'wairz.npz'
# Never replaces a model you trained on your own voice (Settings -> Voice -> Teach it your voice).
if (Test-Path $wake) { Ok "wake word model" }
elseif ($Check) { Todo "wake word model missing" }
else { Copy-Item (Join-Path $Repo 'assets\voice\wake\vyrse-generic.npz') $wake; Did "wake word model (works for most voices; teach it yours in Settings -> Voice)" }

# 5b. VYRSE skills -------------------------------------------------------------------------
Write-Host "VYRSE skills"
foreach ($skill in Get-ChildItem (Join-Path $Repo 'hermes-plugin\skills') -Directory) {
  $dest = Join-Path $HermesHome "skills\vyrse\$($skill.Name)"
  $same = (Test-Path "$dest\SKILL.md") -and ((Get-FileHash "$dest\SKILL.md").Hash -eq (Get-FileHash "$($skill.FullName)\SKILL.md").Hash)
  if ($same) { Ok $skill.Name }
  elseif ($Check) { Todo "$($skill.Name) not installed or outdated" }
  else { New-Item -ItemType Directory -Force $dest | Out-Null; Copy-Item "$($skill.FullName)\*" $dest -Recurse -Force; Did $skill.Name }
}

# 6. Hermes config ------------------------------------------------------------------------
Write-Host "Hermes config"
# key, value, mode: 'always' = VYRSE requirement; 'default' = only when unset (user may change it)
$settings = @(
  @('platform_toolsets.vyrse', '["browser","code_execution","computer_use","delegation","file","memory","session_search","skills","terminal","vision","vyrse_ui","web"]', 'default'),
  @('tools.tool_search.defer', '["process_manage","session_search","browser_exec","browser_vault_enter_code","browser_vault_fill","browser_vault_list","browser_vault_save_login","browser_vault_unlock","delegate_task","execute_code","skill_manage","computer_use"]', 'default'),
  @('agent.max_output_tokens', '6144', 'default'),  # patch 0007: a looping local model can't generate forever
  @('tools.tool_search.eager', '["vyrse_ui","vyrse_desktop","vyrse_screen","vyrse_reminders","vyrse_skills","vyrse_workspace","vyrse_system","vyrse_controls","vyrse_briefing","vyrse_alexa","vyrse_files","vyrse_phone","vyrse_quiz","vyrse_log","vyrse_analyse"]', 'default'),
  @('computer_use.no_overlay', 'true', 'default'),
  @('computer_use.skip_window_titles', '["VYRSE orb"]', 'default'),
  @('tools.tool_search.listing', 'auto', 'default'),
  @('browser.backend', 'off', 'default'),
  @('browser.cdp_url', 'http://127.0.0.1:9222', 'default'),
  @('local_runtime.models_max', '1', 'default'),
  @('local_runtime.launch_overrides', ('{"qwen3.5-9b-q3_k_m": {"ctx": 65536, "ubatch": 512, "gpu_layers": "all", "mmproj": "' + ((Join-Path $HermesHome 'models\assets\qwen3.5-9b-mmproj-f16.gguf') -replace '\\', '/') + '", "mmproj_offload": false, "image_max_tokens": 384}, "gemma-3-12b-q4_k_m": {"chat_template_file": "' + ((Join-Path $Repo 'assets\templates\gemma3-tools.jinja') -replace '\\', '/') + '", "mmproj": "' + ((Join-Path $HermesHome 'models\assets\gemma-3-12b-mmproj-f16.gguf') -replace '\\', '/') + '", "mmproj_offload": false}}'), 'default'),
  @('memory.memory_enabled', 'true', 'default'),
  @('memory.user_profile_enabled', 'true', 'default'),
  @('compression.enabled', 'true', 'default'),
  @('approvals.mode', 'manual', 'default'),
  @('tts.provider', 'kokoro', 'always'),
  @('tts.kokoro', '{"voice":"af_heart","speed":1.0,"threads":4,"idle_unload_s":600}', 'default'),
  @('stt.provider', 'local', 'always'),
  @('stt.local.model', 'base.en', 'default'),
  @('stt.local.language', 'en', 'default'),
  @('stt.local.device', 'cpu', 'default'),
  @('stt.local.compute_type', 'int8', 'default'),
  @('stt.local.unload_after_idle_seconds', '600', 'default'),
  @('wake_word.enabled', 'true', 'always'),
  @('wake_word.provider', 'heed', 'always'),
  @('wake_word.capture', 'client', 'always'),
  @('wake_word.surface', 'gui', 'always'),
  @('wake_word.phrase', 'vyrse', 'default'),
  @('wake_word.start_new_session', 'false', 'default'),
  @('vyrse.models_dir', (Join-Path $Repo 'models'), 'default'),
  @('auth.adopt_external_logins', 'false', 'default')
)
foreach ($s in $settings) {
  $key, $value, $mode = $s
  $current = ((& $Hermes config get $key 2>$null) -join "`n").Trim()
  $unset = (-not $current) -or ($current -match 'not set|unknown|None')
  $normalized = $current -replace '\s', ''
  $wanted = $value -replace '[\s"\[\]{}]', ''
  $matches = ($normalized -replace '[-"\[\]{}:]', '') -match [regex]::Escape(($wanted -replace '[,:]', ''))
  if (-not $unset -and ($mode -eq 'default' -or $current -eq $value -or $matches)) { Ok "$key"; continue }
  if ($Check) { Todo "$key should be $value (now: $(if ($unset) { 'unset' } else { $current -replace "`n", ' ' }))"; continue }
  & $Hermes config set $key $value --force | Out-Null
  Did "$key = $value"
}

Write-Host ''
if ($Problems) { Write-Host "$Problems item(s) need attention." -ForegroundColor Yellow; exit 1 }
Write-Host 'Hermes is ready for VYRSE.' -ForegroundColor Green
