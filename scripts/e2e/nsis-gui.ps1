param([Parameter(Mandatory=$true)][string]$Setup, [Parameter(Mandatory=$true)][string]$InstallPath)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Only use in a disposable GitHub Actions Windows runner.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NsisGui {
  public delegate bool Callback(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, Callback f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public class Item {
    public IntPtr Handle; public int Id; public string Class; public string Text; public int Style;
    public bool Visible; public bool Enabled;
  }
  static Item Info(IntPtr h) {
    StringBuilder cls = new StringBuilder(256), text = new StringBuilder(2048);
    GetClassName(h, cls, cls.Capacity); GetWindowText(h, text, text.Capacity);
    return new Item { Handle=h, Id=GetDlgCtrlID(h), Class=cls.ToString(), Text=text.ToString(),
      Style=GetWindowLong(h,-16), Visible=IsWindowVisible(h), Enabled=IsWindowEnabled(h) };
  }
  public static IntPtr FindWindow(int pid) {
    IntPtr result=IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == (uint)pid && IsWindowVisible(h) && Info(h).Class == "#32770") { result=h; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static Item[] Children(IntPtr parent) {
    List<Item> items=new List<Item>();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) { items.Add(Info(h)); return true; }, IntPtr.Zero);
    return items.ToArray();
  }
  public static void SetText(IntPtr h, string value) { SendMessage(h, 0x000C, IntPtr.Zero, value); }
  public static void Uncheck(IntPtr h) { SendMessage(h, 0x00F1, IntPtr.Zero, IntPtr.Zero); }
  public static void Click(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
}
'@
$p = Start-Process -FilePath $Setup -PassThru
$deadline = (Get-Date).AddMinutes(4)
$lastSignature = ''
$lastClick = [DateTime]::MinValue
$directorySeen = $false
$clicks = 0
try {
  while ((Get-Date) -lt $deadline) {
    $p.Refresh()
    if ($p.HasExited) {
      if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)" }
      if (-not $directorySeen) { throw 'Installer did not display a directory page' }
      if ($clicks -lt 2) { throw 'Installer did not navigate through the wizard' }
      Write-Output "GUI completed: directory page visited, $clicks buttons clicked."
      exit 0
    }
    $window = [NsisGui]::FindWindow($p.Id)
    if ($window -ne [IntPtr]::Zero) {
      $items = @([NsisGui]::Children($window) | Where-Object { $_.Visible })
      $edit = $items | Where-Object { $_.Class -eq 'Edit' -and $_.Id -eq 1019 } | Select-Object -First 1
      if ($null -ne $edit -and -not $directorySeen) {
        [NsisGui]::SetText($edit.Handle, $InstallPath)
        $directorySeen = $true
        Write-Output "Directory page: entered $InstallPath"
      }
      # Do not let the finish page start the app outside its isolated profile.
      foreach ($item in $items) {
        if ($item.Class -eq 'Button' -and (($item.Style -band 15) -eq 3)) { [NsisGui]::Uncheck($item.Handle) }
      }
      $signature = (($items | ForEach-Object { "$($_.Id):$($_.Class):$($_.Text):$($_.Enabled)" }) -join '|')
      $next = $items | Where-Object { $_.Class -eq 'Button' -and $_.Id -eq 1 -and $_.Enabled } | Select-Object -First 1
      if ($null -ne $next -and (($signature -ne $lastSignature) -or ((Get-Date) - $lastClick).TotalSeconds -gt 8)) {
        Write-Output "Wizard button: $($next.Text); controls: $($signature.Substring(0,[Math]::Min(500,$signature.Length)))"
        [NsisGui]::Click($next.Handle)
        $lastSignature = $signature
        $lastClick = Get-Date
        $clicks++
      }
    }
    Start-Sleep -Milliseconds 400
  }
  throw 'Timed out waiting for graphical NSIS installer'
} finally {
  $p.Refresh()
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}
