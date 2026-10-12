# Find files with the Windows Search index (instant, offline), open them or show them in Explorer.
# Input: -Request <base64 JSON {action, ...}>. Output: one JSON object on stdout.
param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 4; exit 0 }
function Fail($message) { Out-Json @{ ok = $false; error = $message } }

# Programs and scripts are never started from here (that goes through VYRSE's desktop tool and approvals).
$Runnable = @('.exe', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.com', '.pif', '.lnk', '.reg', '.hta', '.cpl', '.jar', '.py', '.pyw',
  '.url', '.appref-ms', '.application', '.msc', '.scf', '.inf', '.ws', '.gadget', '.settingcontent-ms', '.msix', '.msixbundle', '.appx', '.appxbundle', '.diagcab', '.library-ms', '.search-ms', '.xbap', '.vbscript', '.psd1', '.mshxml', '.chm')

# Developer and system clutter that buries real results.
$Noise = @('\node_modules\', '\site-packages\', '\.venv', '\venv\', '\.git\', '\__pycache__\', '\AppData\', '\.cache\',
  '\dist-packages\', '\.hermes-runtime\', '\.gradle\', '\.nuget\', '\.cargo\', '\target\debug\', '\.next\', '\bower_components\')

function Known-Folder($name) {
  switch ($name.ToLower()) {
    'downloads' { return (New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path }
    'desktop' { return [Environment]::GetFolderPath('Desktop') }
    'documents' { return [Environment]::GetFolderPath('MyDocuments') }
    'pictures' { return [Environment]::GetFolderPath('MyPictures') }
    'videos' { return [Environment]::GetFolderPath('MyVideos') }
    'music' { return [Environment]::GetFolderPath('MyMusic') }
    default { if ($name -match '^[A-Za-z]:\\' -and (Test-Path -LiteralPath $name)) { return $name } }
  }
  return $null
}

function Sql-Text($s) { return ($s -replace "'", "''") }

switch ($req.action) {
  'find' {
    $words = @(([string]$req.query) -split '[^\p{L}\p{N}._-]+' | Where-Object { $_.Length -gt 0 } | Select-Object -First 6)
    $where = New-Object System.Collections.Generic.List[string]
    $scope = if ($req.in) { Known-Folder ([string]$req.in) } else { $null }
    if ($req.in -and -not $scope) { Fail "I don't know the folder '$($req.in)'. Use downloads, desktop, documents, pictures, videos, music or a full path." }
    if (-not $scope) { $scope = $env:USERPROFILE }
    # "What's in my downloads": the folder itself, not everything unpacked inside it; with words, search deep.
    $mode = if ($req.in -and -not $words.Count) { 'DIRECTORY' } else { 'SCOPE' }
    $where.Add("$mode='file:$((Sql-Text $scope) -replace '\\', '/')'")
    if ($words.Count) {
      $terms = ($words | ForEach-Object { '"' + (Sql-Text $_) + '*"' }) -join ' AND '
      if ($req.content) { $where.Add("CONTAINS(*, '$terms')") } else { $where.Add("CONTAINS(System.FileName, '$terms')") }
    }
    switch ([string]$req.kind) {
      'document' { $where.Add("System.Kind = 'document'") }
      'pdf' { $where.Add("System.FileExtension = '.pdf'") }
      'image' { $where.Add("System.Kind = 'picture'") }
      'video' { $where.Add("System.Kind = 'video'") }
      'audio' { $where.Add("System.Kind = 'music'") }
      'folder' { $where.Add("System.Kind = 'folder'") }
      'archive' { $where.Add("(System.FileExtension = '.zip' OR System.FileExtension = '.rar' OR System.FileExtension = '.7z')") }
      'code' { $where.Add("(System.FileExtension = '.py' OR System.FileExtension = '.ts' OR System.FileExtension = '.tsx' OR System.FileExtension = '.js' OR System.FileExtension = '.json' OR System.FileExtension = '.cs' OR System.FileExtension = '.cpp' OR System.FileExtension = '.java')") }
    }
    $days = @{ today = 1; week = 7; month = 31; year = 366 }[[string]$req.modified]
    if ($days) { $where.Add("System.DateModified >= '" + (Get-Date).AddDays(-$days).ToString('yyyy-MM-dd HH:mm:ss') + "'") }
    # Hidden/partial files (".parts", ".tmp") never; folders only when asked for or named.
    $where.Add("NOT System.FileName LIKE '.%'")
    if (-not $words.Count -and [string]$req.kind -ne 'folder') { $where.Add("NOT System.Kind = 'folder'") }
    foreach ($n in $Noise) { $where.Add("NOT System.ItemPathDisplay LIKE '%" + (Sql-Text $n) + "%'") }
    if (-not $words.Count -and -not $req.kind -and -not $days -and -not $req.in) { Fail 'Say what to look for (words from the name, a kind, or how recent).' }

    $limit = [Math]::Min([Math]::Max([int]($req.limit), 1), 40)
    if (-not $req.limit) { $limit = 15 }
    $sql = "SELECT TOP $limit System.ItemPathDisplay, System.ItemNameDisplay, System.DateModified, System.Size, System.Kind FROM SystemIndex WHERE " + ($where -join ' AND ') + ' ORDER BY System.DateModified DESC'
    try {
      $conn = New-Object -ComObject ADODB.Connection
      $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
      $rs = $conn.Execute($sql)
    } catch { Fail "Windows Search isn't available: $($_.Exception.Message)" }
    $rows = New-Object System.Collections.Generic.List[object]
    while (-not $rs.EOF) {
      # Empty columns come back as DBNull (folders have no size).
      $kind = $rs.Fields.Item(4).Value; if ($kind -is [DBNull]) { $kind = $null }
      $modified = $rs.Fields.Item(2).Value; if ($modified -is [DBNull]) { $modified = $null }
      $size = $rs.Fields.Item(3).Value; if ($size -is [DBNull]) { $size = $null }
      $rows.Add([ordered]@{
        name = $rs.Fields.Item(1).Value
        path = $rs.Fields.Item(0).Value
        kind = if ($kind -is [array]) { $kind -join ',' } else { [string]$kind }
        size_kb = if ($null -ne $size) { [Math]::Round([double]$size / 1KB) } else { $null }
        modified = if ($modified) { ([datetime]$modified).ToString('yyyy-MM-dd HH:mm') } else { $null }
      })
      $rs.MoveNext()
    }
    $conn.Close()
    Out-Json @{ ok = $true; count = $rows.Count; searched = $scope; results = $rows.ToArray() }
  }
  { $_ -in 'open', 'reveal' } {
    $path = [string]$req.path
    # Local drive paths only: a network path (\\server\share) would make Windows hand that server your sign-in
    # hash, and URLs or protocol links (ms-settings:, http:...) aren't files.
    if ($path -notmatch '^[A-Za-z]:[\\/]') { Fail "I only open files on this PC (a full path like C:\...)." }
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { Fail "That file doesn't exist: $path" }
    if ($req.action -eq 'reveal') {
      Start-Process explorer.exe -ArgumentList "/select,`"$path`""
      Out-Json @{ ok = $true; revealed = $path }
    }
    $ext = [IO.Path]::GetExtension($path).ToLower()
    if ((Test-Path -LiteralPath $path -PathType Leaf) -and $Runnable -contains $ext) {
      Fail "$ext files are programs or scripts; I only open documents, media and folders here. Use the desktop tool to run programs."
    }
    Start-Process -FilePath $path
    Out-Json @{ ok = $true; opened = $path }
  }
  default { Fail "Unknown action: $($req.action)" }
}
