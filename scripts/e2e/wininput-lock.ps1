param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$request = Join-Path $Directory 'request.json'
$stream = [IO.File]::Open($request, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  # Only start the target's reader after the exclusive handle is held.
  [IO.File]::WriteAllText((Join-Path $Directory 'lock-ready'), 'ready')
  [IO.File]::Delete((Join-Path $Directory 'pause'))
  $deadline = (Get-Date).AddSeconds(5)
  while (-not [IO.File]::Exists((Join-Path $Directory 'lock-seen'))) {
    if ((Get-Date) -gt $deadline) { throw 'Target did not observe the lock' }
    Start-Sleep -Milliseconds 50
  }
} finally {
  $stream.Dispose()
}
