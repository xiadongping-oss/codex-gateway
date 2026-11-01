param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
if (Test-Path -LiteralPath $Destination) { throw 'Archive already exists' }
[System.IO.Compression.ZipFile]::CreateFromDirectory($sourceRoot, $Destination, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$archive = [System.IO.Compression.ZipFile]::OpenRead($Destination)
try {
  $expected = @{}
  $prefix = (Split-Path -Leaf $sourceRoot) + '/'
  Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force | ForEach-Object {
    $entryName = $prefix + $_.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/')
    $expected[$entryName] = $_.FullName
  }
  $verified = 0
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith('/')) { continue }
    $entryName = $entry.FullName.Replace('\', '/')
    if (-not $expected.ContainsKey($entryName)) { throw "Unexpected archive entry: $entryName" }
    $stream = $entry.Open()
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hasher.Dispose() }
    $sourceStream = [System.IO.File]::OpenRead($expected[$entryName])
    $sourceHasher = [System.Security.Cryptography.SHA256]::Create()
    try { $sourceHash = [BitConverter]::ToString($sourceHasher.ComputeHash($sourceStream)).Replace('-', '') }
    finally { $sourceStream.Dispose(); $sourceHasher.Dispose() }
    if ($actual -ne $sourceHash) { throw "Archive mismatch: $entryName" }
    $expected.Remove($entryName)
    $verified++
  }
  if ($expected.Count -ne 0) { throw 'Archive is missing files' }
  Write-Output "ZIP verified: $verified files"
} finally { $archive.Dispose() }
