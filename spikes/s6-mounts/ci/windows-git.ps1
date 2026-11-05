# Windows diagnostic: can Git for Windows (and its bash) work inside the WinFsp tree?
#
# Three ways to lay the tree out:
#   1. the whole tree on a drive letter that DefineDosDevice makes (T:, WinFsp's default);
#   2. the whole tree on a drive letter the Mount Manager knows (\\.\T:, needs admin);
#   3. no link inside a WinFsp volume at all: a real folder, C:\s6tree\home, holding a junction to
#      this computer's home and the other computer's home mounted on a folder (--single);
#   4. the whole tree on T: as a network volume (\\clover\tree, --volume-prefix), as sshfs-win does.
# For each it asks Windows for the repo folder's final path (what git's getcwd() and, with
# core.symlinks on, its chdir() do) and runs git and Git Bash inside it.
#
#   windows-git.ps1 -Helper <clover-mount.exe> -Export <export dir> -Serve <serve.ts> [-Out <file>]
param([string]$Helper, [string]$Export, [string]$Serve, [string]$Out = "$env:RUNNER_TEMP\s6\results\windows-git.txt")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class S6Path {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder buf, uint len, uint flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern uint GetLongPathNameW(string path, StringBuilder buf, uint len);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern uint GetFileAttributesW(string path);
  // flags: 0 DOS name (what git asks for), 1 volume GUID, 2 NT device name, 4 no volume, 8 as opened
  public static string Probe(string p) {
    var sb = new StringBuilder(2048);
    IntPtr h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    bool bad = h == new IntPtr(-1);
    string r = "open " + (bad ? "error " + Marshal.GetLastWin32Error() : "ok");
    if (!bad) {
      foreach (uint f in new uint[] { 0, 1, 2, 4, 8 }) {
        sb.Length = 0;
        uint n = GetFinalPathNameByHandleW(h, sb, 2048, f);
        r += " | final(" + f + ") " + (n == 0 ? "error " + Marshal.GetLastWin32Error() : sb.ToString());
      }
      CloseHandle(h);
    }
    sb.Length = 0;
    uint m = GetLongPathNameW(p, sb, 2048);
    r += " | long " + (m == 0 ? "error " + Marshal.GetLastWin32Error() : sb.ToString());
    uint a = GetFileAttributesW(p);
    r += " | attrs " + (a == 0xFFFFFFFF ? "error " + Marshal.GetLastWin32Error() : a.ToString("x"));
    return r;
  }
}
"@

function Say([string]$s) { Write-Host $s; Add-Content -Path $Out -Value $s }

$svc = Start-Process bun -ArgumentList "`"$Serve`" --root `"$Export`" --port 7400" -PassThru -WindowStyle Hidden
Start-Sleep 3
$layout = "C:\s6tree"
New-Item -ItemType Directory -Force "$layout\home" | Out-Null
New-Item -ItemType Junction -Path "$layout\home\Runner" -Target $env:USERPROFILE | Out-Null
$env:CHERE_INVOKING = "1" # Git Bash starts in the current folder, not in HOME

$cases = @(
  @{ Name = "1. tree on T: (DefineDosDevice)"; Mount = "T:"; Args = "--self Runner=$env:USERPROFILE"; Repo = "T:\home\Desktop1\clover"
     Probe = @("T:\", "T:\home", "T:\home\Desktop1", "T:\home\Desktop1\clover", "T:\home\Runner") },
  @{ Name = "2. tree on \\.\T: (Mount Manager)"; Mount = "\\.\T:"; Args = "--self Runner=$env:USERPROFILE"; Repo = "T:\home\Desktop1\clover"
     Probe = @("T:\", "T:\home\Desktop1\clover", "T:\home\Runner") },
  @{ Name = "3. real folder, junction for this computer, the other one mounted on a folder"; Mount = "$layout\home\Desktop1"; Args = "--single"; Repo = "$layout\home\Desktop1\clover"
     Probe = @("$layout\home\Desktop1", "$layout\home\Desktop1\clover", "$layout\home\Runner") },
  @{ Name = "4. tree on T: as a network volume (\\clover\tree)"; Mount = "T:"; Args = "--self Runner=$env:USERPROFILE --volume-prefix \clover\tree"; Repo = "T:\home\Desktop1\clover"
     Probe = @("T:\", "T:\home\Desktop1\clover", "\\clover\tree\home\Desktop1\clover") }
)
Say "git: $(git --version); core.symlinks here: $(git config --show-origin --get core.symlinks)"

$i = 0
foreach ($c in $cases) {
  $i++
  Say ""
  Say "== $($c.Name): --mountpoint $($c.Mount)"
  $log = "$env:RUNNER_TEMP\s6\results\windows-git-helper-$i.log"
  $h = Start-Process $Helper -ArgumentList "--mountpoint `"$($c.Mount)`" --policy plain --remote Desktop1=127.0.0.1:7400 $($c.Args)" -PassThru -WindowStyle Hidden -RedirectStandardError $log
  for ($k = 0; ($k -lt 75) -and -not (Test-Path $c.Repo); $k++) { Start-Sleep -Milliseconds 200 }
  Say "repo visible: $(Test-Path $c.Repo)"
  foreach ($p in $c.Probe) { Say "probe $p : $([S6Path]::Probe($p))" }
  Push-Location $c.Repo
  Say "pwd: $((Get-Location).Path)"
  $o = (git status --porcelain 2>&1 | Select-Object -First 3) -join " / "
  Say "git status, started in the repo: exit $LASTEXITCODE $o"
  $o = (git rev-parse --show-toplevel 2>&1) -join " / "
  Say "git rev-parse --show-toplevel: $o"
  foreach ($sl in @("false", "true")) {
    $o = (git -c core.symlinks=$sl status --porcelain 2>&1 | Select-Object -First 2) -join " / "
    Say "git -c core.symlinks=$sl status: exit $LASTEXITCODE $o"
  }
  $o = (& "C:\Program Files\Git\bin\bash.exe" -lc 'pwd; git status --porcelain | head -3; echo git exit ${PIPESTATUS[0]}' 2>&1) -join " / "
  Say "Git Bash, started in the repo: $o"
  Pop-Location
  $o = (git -C $c.Repo status --porcelain 2>&1 | Select-Object -First 2) -join " / "
  Say "git -C <repo> status: exit $LASTEXITCODE $o"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $o = (git -C $c.Repo -c core.fsmonitor=false status --porcelain 2>&1 | Measure-Object).Count
  Say "git -C status took $($sw.ElapsedMilliseconds) ms ($o lines)"
  if ($c.Probe -contains "$layout\home\Runner" -or $c.Probe -contains "T:\home\Runner") {
    $self = if ($c.Mount -like "$layout*") { "$layout\home\Runner" } else { "T:\home\Runner" }
    $o = (Get-ChildItem $self -ErrorAction Continue | Select-Object -First 3 | ForEach-Object Name) -join ", "
    Say "this computer's entry ($self) lists: $o"
  }
  Stop-Process -Id $h.Id -Force
  for ($k = 0; ($k -lt 50) -and (Test-Path $c.Repo); $k++) { Start-Sleep -Milliseconds 200 }
  Get-Content $log -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Say "helper: $_" }
}
Stop-Process -Id $svc.Id -Force
exit 0
