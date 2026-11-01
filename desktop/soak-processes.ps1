param([switch]$StopOwned)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rootPid = [int]$env:CGW_SOAK_PID
$expectedExe = $env:CGW_SOAK_EXE
$ownedRoot = $env:CGW_SOAK_ROOT
$known = @($env:CGW_SOAK_KNOWN | ConvertFrom-Json)
$all = @(Get-CimInstance Win32_Process)
$selected = @{}
function Born($process) { return $process.CreationDate.ToUniversalTime().ToString('o') }
foreach ($process in $all) {
  if ($process.ProcessId -eq $rootPid -and $process.ExecutablePath -eq $expectedExe -and $process.CommandLine.Contains($ownedRoot)) {
    $selected[[int]$process.ProcessId] = @{process=$process;proof='spawned-shell-path-and-isolated-root'}
  }
  foreach ($receipt in $known) {
    if ($process.ProcessId -eq $receipt.pid -and (Born $process) -eq $receipt.createdAt) {
      $selected[[int]$process.ProcessId] = @{process=$process;proof='previously-observed-pid-and-creation-time'}
      break
    }
  }
}
do {
  $added = $false
  foreach ($process in $all) {
    if (-not $selected.ContainsKey([int]$process.ProcessId) -and $selected.ContainsKey([int]$process.ParentProcessId)) {
      $parent = $selected[[int]$process.ParentProcessId].process
      if ($process.CreationDate -ge $parent.CreationDate) {
        $selected[[int]$process.ProcessId] = @{process=$process;proof='observed-descendant-with-nondecreasing-creation-time'}
        $added = $true
      }
    }
  }
} while ($added)
$rows = @()
foreach ($entry in $selected.Values) {
  $process = $entry.process
  $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
  if (-not $live) { continue }
  # Confirm the CIM identity survived until the metrics read; never trust PID alone.
  if ([Math]::Abs(($live.StartTime.ToUniversalTime() - $process.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 5) { throw 'Process identity changed during sampling' }
  $rows += [ordered]@{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;createdAt=(Born $process);name=$process.Name;executable=$process.ExecutablePath;ownership=$entry.proof;isolatedRootInCommand=[bool]($process.CommandLine -and $process.CommandLine.Contains($ownedRoot));workingSetBytes=$live.WorkingSet64;privateBytes=$live.PrivateMemorySize64;peakWorkingSetBytes=$live.PeakWorkingSet64;cpuSeconds=$live.TotalProcessorTime.TotalSeconds;handles=$live.HandleCount;threads=$live.Threads.Count}
  if ($StopOwned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
}
[ordered]@{at=[DateTime]::UtcNow.ToString('o');processes=@($rows | Sort-Object pid);forcedStop=[bool]$StopOwned} | ConvertTo-Json -Depth 5 -Compress
