param([Parameter(Mandatory=$true)][string]$Directory, [Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZsTestForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$utf8 = New-Object System.Text.UTF8Encoding($false)
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 600
$form.Height = 200
$form.TopMost = $true
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = [System.Windows.Forms.DockStyle]::Fill
$form.Controls.Add($box)
$initialClipboard = $null
try { $initialClipboard = [System.Windows.Forms.Clipboard]::GetDataObject() } catch { }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 75
$timer.Add_Tick({
  $request = Join-Path $Directory 'request.json'
  if ([IO.File]::Exists((Join-Path $Directory 'pause')) -or -not [IO.File]::Exists($request)) { return }
  # Windows can briefly hold a newly published file open (sharing or lock
  # violation). Retry only the read, before performing any command: retrying
  # after a command executes could insert text or change the clipboard twice.
  try {
    $raw = [IO.File]::ReadAllText($request, $utf8)
  } catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [System.IO.IOException] -and (($cause.HResult -band 0xffff) -in @(32, 33))) {
      if ([IO.File]::Exists((Join-Path $Directory 'lock-ready'))) {
        [IO.File]::WriteAllText((Join-Path $Directory 'lock-seen'), 'retry')
      }
      return
    }
    [IO.File]::WriteAllText((Join-Path $Directory 'error.txt'), $_.Exception.ToString(), $utf8)
    return
  }
  try {
    $data = $raw | ConvertFrom-Json
    [IO.File]::Delete($request)
    $out = @{ id = $data.id; ok = $true }
    switch ($data.command) {
      'focus' {
        $form.Show(); $form.Activate(); [void][ZsTestForeground]::SetForegroundWindow($form.Handle)
        [void]$box.Focus()
        $out.foreground = ([ZsTestForeground]::GetForegroundWindow() -eq $form.Handle -and $box.Focused)
      }
      'state' {
        $out.foreground = ([ZsTestForeground]::GetForegroundWindow() -eq $form.Handle -and $box.Focused)
        $out.text = $box.Text
      }
      'clear' { $box.Clear() }
      'selectText' { $box.Text = [string]$data.text; $box.SelectAll() }
      'clipboard' { [System.Windows.Forms.Clipboard]::SetText([string]$data.text) }
      'clipboardClearIsolatedCi' {
        if ($env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'isolated CI only' }
        [System.Windows.Forms.Clipboard]::Clear()
      }
      'clipboardFormatsIsolatedCi' {
        if ($env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'isolated CI only' }
        $clipObject = [System.Windows.Forms.Clipboard]::GetDataObject()
        $out.count = if ($null -eq $clipObject) { 0 } else { @($clipObject.GetFormats()).Count }
      }
      'readClipboard' { $out.text = [System.Windows.Forms.Clipboard]::GetText() }
      'close' { $timer.Stop(); $form.Close() }
      default { throw 'unknown command' }
    }
    $json = ConvertTo-Json -Compress -InputObject $out
    # Файл ответа виден читателю только после завершения записи: иначе Node
    # может открыть пустой или частичный JSON между созданием и WriteAllText.
    $response = Join-Path $Directory ('response-' + $data.id + '.json')
    $temporary = Join-Path $Directory ('response-' + $data.id + '.tmp')
    [IO.File]::WriteAllText($temporary, $json, $utf8)
    [IO.File]::Move($temporary, $response)
  } catch {
    [IO.File]::WriteAllText((Join-Path $Directory 'error.txt'), $_.Exception.ToString(), $utf8)
  }
})
$form.Add_Shown({ $timer.Start(); [IO.File]::WriteAllText((Join-Path $Directory 'ready'), 'ready', $utf8) })
try { [void]$form.ShowDialog() } finally {
  $timer.Dispose()
  if ($null -ne $initialClipboard) {
    try { [System.Windows.Forms.Clipboard]::SetDataObject($initialClipboard, $true) } catch { }
  }
  $form.Dispose()
}
