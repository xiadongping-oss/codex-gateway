param([Parameter(Mandatory=$true)][string]$PackageDirectory, [switch]$VerifyMigration)
$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$packageReport = Get-Content -LiteralPath (Join-Path $packageRoot 'report.json') -Raw | ConvertFrom-Json
if ($packageReport.status -ne 'packaged') { throw 'A completed packaging run is required' }
$artifact = @($packageReport.artifacts | Where-Object { $_.file.EndsWith('-Setup.exe') })
if ($artifact.Count -ne 1) { throw 'Expected one installer' }
$setup = Join-Path $packageRoot $artifact[0].file
function Hash-File([string]$File) {
  $stream = [IO.File]::OpenRead($File); $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
if ((Hash-File $setup) -ne $artifact[0].sha256) { throw 'Installer checksum mismatch' }
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Gateway'
$settingsKey = 'Software\codexgateway\Codex Gateway'
$legacyKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexGateway'
function Registry-Snapshot([string]$Path) {
  $key = $registry.OpenSubKey($Path)
  if ($null -eq $key) { return 'absent' }
  try {
    $values = @($key.GetValueNames() | Sort-Object | ForEach-Object { @{name=$_;kind=[string]$key.GetValueKind($_);value=$key.GetValue($_)} })
    return (ConvertTo-Json -InputObject $values -Depth 5 -Compress)
  } finally { $key.Dispose() }
}
foreach ($key in @($uninstallKey, $settingsKey)) {
  if ((Registry-Snapshot $key) -ne 'absent') { throw "Existing desktop installation/settings found; refuse host test: $key" }
}
$legacyBefore = Registry-Snapshot $legacyKey
$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Gateway.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Gateway 卸载.lnk'),
  (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Codex Gateway.lnk')
)
$shortcutsBefore = @{}
foreach ($file in $shortcutPaths) { $shortcutsBefore[$file] = if (Test-Path -LiteralPath $file) { Hash-File $file } else { 'absent' } }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('cgw-installer-' + [Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot '安装目录 with spaces'
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$reportFile = Join-Path $packageRoot ('install-test-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.json')
$report = [ordered]@{status='running';scope='Exact NSIS artifact; temporary install directory; no shortcuts; no application launch';startedAt=[DateTime]::UtcNow.ToString('o');installerSha256=$artifact[0].sha256;steps=@();installedAppLaunched=$false;cleanMachine=$false;testRoot=$testRoot}
function Save-Report { $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportFile -Encoding UTF8 }
function Run-Installer([string]$Executable, [string]$Arguments) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $Executable; $start.Arguments = $Arguments; $start.UseShellExecute = $false
  $start.CreateNoWindow = $true; $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = [Diagnostics.Process]::Start($start)
  if (-not $process.WaitForExit(120000)) { throw 'Test installer timed out; preserve test directory for inspection' }
  return $process.ExitCode
}
function Verify-Installed {
  $key = $registry.OpenSubKey($uninstallKey)
  if ($null -eq $key) { throw 'Missing installed registration' }
  try { if ($key.GetValue('InstallLocation').Trim('"') -ne $installDir) { throw 'Unexpected install location' } }
  finally { $key.Dispose() }
  $binary = Join-Path $installDir 'codex-gateway-desktop.exe'
  $portable = Join-Path $packageRoot ('Codex-Gateway-' + $packageReport.version + '-windows-x64-preview')
  if ((Hash-File $binary) -ne (Hash-File (Join-Path $portable 'codex-gateway-desktop.exe'))) { throw 'Installed executable mismatch' }
  & node (Join-Path $PSScriptRoot '../prepare-desktop.mjs') --verify --target=win32-x64 "--out=$(Join-Path $installDir 'gateway-resources')"
  if ($LASTEXITCODE -ne 0) { throw 'Installed resource verification failed' }
}
function Assert-OriginalPreserved {
  if ((Registry-Snapshot $legacyKey) -ne $legacyBefore) { throw 'Legacy installation registration changed' }
  foreach ($file in $shortcutPaths) {
    $actual = if (Test-Path -LiteralPath $file) { Hash-File $file } else { 'absent' }
    if ($actual -ne $shortcutsBefore[$file]) { throw 'An existing shortcut changed' }
  }
}
Save-Report
try {
  $code = Run-Installer $setup "/S /NS /D=$installDir"
  if ($code -ne 0) { throw "Install failed: $code" }
  Verify-Installed; Assert-OriginalPreserved
  $report.steps += @{name='install';status='passed';exitCode=$code}
  Save-Report
  & node (Join-Path $PSScriptRoot '../gateway/tests/prepared-resources-smoke.mjs') "--resources=$(Join-Path $installDir 'gateway-resources')"
  if ($LASTEXITCODE -ne 0) { throw 'Installed bundled gateway smoke failed' }
  $report.steps += @{name='installed-bundled-gateway';status='passed'}
  if ($VerifyMigration) {
    $migrationReport = Join-Path $packageRoot ('installed-migration-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.json')
    & node (Join-Path $PSScriptRoot 'installed-migration-smoke.mjs') "--resources=$(Join-Path $installDir 'gateway-resources')" "--report=$migrationReport"
    if ($LASTEXITCODE -ne 0) { throw 'Installed migration and gateway flow failed; preserve test installation' }
    $report.steps += @{name='installed-migration-worker-and-gateway';status='passed';evidence=$migrationReport;releaseWindowTested=$false}
    Save-Report
  }
  $sentinel = Join-Path $installDir 'user-retained.txt'
  [IO.File]::WriteAllText($sentinel, 'Owned test fixture: preserve unknown files')
  $sentinelHash = Hash-File $sentinel
  $code = Run-Installer $setup "/S /NS /D=$installDir"
  if ($code -ne 0) { throw "Reinstall failed: $code" }
  Verify-Installed; Assert-OriginalPreserved
  if ((Hash-File $sentinel) -ne $sentinelHash) { throw 'Reinstall changed unknown file' }
  $report.steps += @{name='same-version-reinstall';status='passed';exitCode=$code}
  # Exercise the downgrade gate using only the registration owned by this test.
  $key = $registry.OpenSubKey($uninstallKey, $true)
  try { $key.SetValue('DisplayVersion', '99.0.0') } finally { $key.Dispose() }
  try {
    $code = Run-Installer $setup "/S /NS /D=$installDir"
    if ($code -eq 0) { throw 'Downgrade was not rejected' }
    Verify-Installed
    $report.steps += @{name='downgrade-registration-gate';status='passed';exitCode=$code;scope='Simulated future installer registration, not a data migration test'}
  } finally {
    $key = $registry.OpenSubKey($uninstallKey, $true)
    if ($key) { try { $key.SetValue('DisplayVersion', $packageReport.version) } finally { $key.Dispose() } }
  }
  Save-Report
  $code = Run-Installer (Join-Path $installDir 'uninstall.exe') '/S'
  if ($code -ne 0) { throw "Uninstaller launch failed: $code" }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $removed = -not (Test-Path -LiteralPath (Join-Path $installDir 'codex-gateway-desktop.exe')) -and (Registry-Snapshot $uninstallKey) -eq 'absent'
    if ($removed) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $removed) { throw 'Uninstall did not finish' }
  if (Test-Path -LiteralPath (Join-Path $installDir 'gateway-resources')) { throw 'Uninstall left packaged resources' }
  if ((Hash-File $sentinel) -ne $sentinelHash) { throw 'Uninstall removed unknown file' }
  Assert-OriginalPreserved
  $report.steps += @{name='uninstall';status='passed';unknownFilePreserved=$true;legacyRegistrationAndShortcutsUnchanged=$true}
  # Restore the absence of installer settings. Never remove an existing user's key.
  $key = $registry.OpenSubKey($settingsKey)
  if ($key) {
    try {
      if ($key.GetValue('') -ne $installDir -or $key.SubKeyCount -ne 0) { throw 'Installer settings no longer owned by this test' }
      if (@($key.GetValueNames() | Where-Object { $_ -notin @('', 'Installer Language') }).Count) { throw 'Unexpected installer settings; preserve for review' }
    } finally { $key.Dispose() }
    $registry.DeleteSubKey($settingsKey, $false)
  }
  $parent = $registry.OpenSubKey('Software\codexgateway')
  if ($parent) { try { $empty = $parent.SubKeyCount -eq 0 -and $parent.ValueCount -eq 0 } finally { $parent.Dispose() }; if ($empty) { $registry.DeleteSubKey('Software\codexgateway', $false) } }
  $resolved = (Resolve-Path -LiteralPath $testRoot).Path
  if ($resolved -ne [IO.Path]::GetFullPath($testRoot) -or [IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Cleanup target escaped owned temporary directory' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
  $report.temporaryDataRemoved = $true
  $report.status = 'passed'
} catch { $report.status = 'failed'; $report.error = $_.Exception.Message; throw }
finally { $report.finishedAt=[DateTime]::UtcNow.ToString('o'); Save-Report; $registry.Dispose(); Write-Output "Installation report: $reportFile" }
