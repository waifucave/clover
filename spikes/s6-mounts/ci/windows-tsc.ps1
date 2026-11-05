# Windows diagnostic: tsc inside the WinFsp tree doesn't see the Bun and Node types that resolve
# on the holder's own disk ("Cannot find module 'bun:test'", "Cannot find module 'node:os'").
# For the holder's folder and for the same folder through the tree (five layouts), it asks Node
# what node_modules holds (links, their targets, what they resolve to) and asks tsc which type
# packages it loaded and how it resolved them.
#
#   windows-tsc.ps1 -Helper <clover-mount.exe> -Export <export dir> -Serve <serve.ts> [-Out <file>]
param([string]$Helper, [string]$Export, [string]$Serve, [string]$Out = "$env:RUNNER_TEMP\s6\results\windows-tsc.txt")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
function Say([string]$s) { Write-Host $s; Add-Content -Path $Out -Value $s }

$probe = "$env:RUNNER_TEMP\s6\tsc-probe.js"
@'
const fs = require("fs"), path = require("path");
const base = process.argv[2];
const show = (label, f) => {
  try { console.log(label, JSON.stringify(f())); } catch (e) { console.log(label, "ERR", e.code, String(e.message).slice(0, 160)); }
};
for (const dir of ["node_modules/@types", "node_modules"]) {
  const d = path.join(base, dir);
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { console.log("readdir", d, "ERR", e.code); continue; }
  console.log("readdir", d, ents.length, "entries");
  for (const e of ents.filter((e) => /^(bun|node|bun-types|typescript|\.bun)$/.test(e.name))) {
    const p = path.join(d, e.name);
    console.log("--", p, "dirent dir/link/file:", e.isDirectory(), e.isSymbolicLink(), e.isFile());
    show("  lstat", () => { const s = fs.lstatSync(p); return { dir: s.isDirectory(), link: s.isSymbolicLink(), nlink: s.nlink, size: s.size, mode: s.mode.toString(8) }; });
    if (e.isSymbolicLink()) show("  readlink", () => fs.readlinkSync(p));
    show("  stat", () => { const s = fs.statSync(p); return { dir: s.isDirectory(), file: s.isFile() }; });
    show("  realpath", () => fs.realpathSync(p));
    show("  realpath.native", () => fs.realpathSync.native(p));
    show("  list", () => fs.readdirSync(p).slice(0, 6));
  }
}
show("@types/bun/package.json", () => fs.readFileSync(path.join(base, "node_modules/@types/bun/package.json"), "utf8").replace(/\s+/g, " ").slice(0, 160));
show("@types/bun/index.d.ts", () => fs.readFileSync(path.join(base, "node_modules/@types/bun/index.d.ts"), "utf8").replace(/\s+/g, " ").slice(0, 200));
show("resolve bun-types from @types/bun", () => require.resolve("bun-types/package.json", { paths: [path.join(base, "node_modules/@types/bun")] }));
show("resolve @types/node from bun-types", () => require.resolve("@types/node/package.json", { paths: [path.join(base, "node_modules/bun-types")] }));
'@ | Set-Content -Path $probe -Encoding utf8

function Check([string]$base) {
  Say "== $base"
  (node $probe $base 2>&1) | ForEach-Object { Say "$_" }
  Push-Location $base
  $files = node node_modules\typescript\bin\tsc --noEmit -p packages/protocol --listFilesOnly 2>&1
  Say "tsc --listFilesOnly: $($files.Count) files, bun-types $(($files | Select-String 'bun-types').Count), @types/node $(($files | Select-String '@types[\\/]node').Count)"
  $trace = node node_modules\typescript\bin\tsc --noEmit -p packages/protocol --traceResolution 2>&1
  $trace | Select-String -Pattern "type reference directive '(bun|bun-types|node)'", "real path for '[^']*(bun-types|@types.(bun|node))" |
    Select-Object -First 20 | ForEach-Object { Say "trace: $_" }
  $o = node node_modules\typescript\bin\tsc --noEmit -p packages/protocol 2>&1
  $code = $LASTEXITCODE
  Say "tsc -p packages/protocol: exit $code; $(($o | Select-Object -First 3) -join ' / ')"
  Pop-Location
}

$svc = Start-Process bun -ArgumentList "`"$Serve`" --root `"$Export`" --port 7400" -PassThru -WindowStyle Hidden
Start-Sleep 3
Check "$Export\clover"

$layout = "C:\s6tsc"
New-Item -ItemType Directory -Force "$layout\home" | Out-Null
$cases = @(
  @{ Name = "tree on T: (DefineDosDevice), as the speed runs mount it"; Mount = "T:"; Args = ""; Repo = "T:\home\Desktop1\clover" },
  @{ Name = "tree on T: as a network volume (\\clover\tree)"; Mount = "T:"; Args = "--volume-prefix \clover\tree"; Repo = "T:\home\Desktop1\clover" },
  @{ Name = "real folder, the other computer mounted on it (--single)"; Mount = "$layout\home\Desktop1"; Args = "--single"; Repo = "$layout\home\Desktop1\clover" },
  @{ Name = "real folder, the other computer a network volume on it (--single, \\clover\Desktop1)"; Mount = "$layout\home\Desktop1"; Args = "--single --volume-prefix \clover\Desktop1"; Repo = "$layout\home\Desktop1\clover" },
  @{ Name = "a network volume on a drive letter WinFsp picks, the folder a symlink to its UNC path"; Mount = "*"; Args = "--single --volume-prefix \clover\Desktop1"; Repo = "$layout\home\Desktop1\clover"; Link = "\\clover\Desktop1" }
)
$i = 0
foreach ($c in $cases) {
  $i++
  Say ""
  Say "#### $($c.Name): --mountpoint $($c.Mount)"
  $log = "$env:RUNNER_TEMP\s6\results\windows-tsc-helper-$i.log"
  $h = Start-Process $Helper -ArgumentList "--mountpoint `"$($c.Mount)`" --policy cached --remote Desktop1=127.0.0.1:7400 $($c.Args)" -PassThru -WindowStyle Hidden -RedirectStandardError $log
  if ($c.Link) {
    # the volume on a drive letter WinFsp picks, the folder a symlink to its UNC path
    for ($k = 0; ($k -lt 75) -and -not (Test-Path "$($c.Link)\clover"); $k++) { Start-Sleep -Milliseconds 200 }
    Say "UNC path visible: $(Test-Path "$($c.Link)\clover")"
    New-Item -ItemType SymbolicLink -Path "$layout\home\Desktop1" -Target $c.Link -ErrorAction Continue | Out-Null
  }
  for ($k = 0; ($k -lt 75) -and -not (Test-Path $c.Repo); $k++) { Start-Sleep -Milliseconds 200 }
  Say "repo visible: $(Test-Path $c.Repo)"
  if (Test-Path $c.Repo) { Check $c.Repo }
  Stop-Process -Id $h.Id -Force
  if ($c.Link) { Remove-Item "$layout\home\Desktop1" -Force -ErrorAction Continue }
  for ($k = 0; ($k -lt 50) -and (Test-Path $c.Repo); $k++) { Start-Sleep -Milliseconds 200 }
  Get-Content $log -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Say "helper: $_" }
}
Stop-Process -Id $svc.Id -Force
exit 0
