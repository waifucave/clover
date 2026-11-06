#Requires -Version 5.1
<#
.SYNOPSIS
  Build Clover's pinned srt-win launcher with a static CRT, and check its hash.

.DESCRIPTION
  Lane C, C-M2 part 2 (spec §4; controller ruling 1). Vendors the launcher from
  `anthropics/sandbox-runtime` at the pinned tag/commit into `vendor/srt-win-src`
  (a build input, never committed — like `.clover-sdk/`), builds `srt-win.exe`
  with the CRT linked statically (no VC++ redistributable prerequisite, per S2),
  and fails closed when the result's SHA-256 differs from the pinned constant in
  `packages/core/src/fence/win-sandbox.ts` (`SRT_WIN_SHA256`).

  Lane M's CI runs this build and signs the result; this script is the build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-srt-win.ps1
  # Verifies vendor/srt-win/srt-win.exe against the pinned hash.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-srt-win.ps1 -RecordHash
  # First trusted build only: writes the measured hash into the core constant
  # and vendor/srt-win/SHA256. Review the diff before committing it.
#>
[CmdletBinding()]
param(
  [string]$Tag = "v0.0.81",
  [string]$Commit = "c40cf14a65d025e3cd27f071f13a73c12b3b1f92",
  [string]$Repo = "https://github.com/anthropics/sandbox-runtime.git",
  [switch]$RecordHash
)

$ErrorActionPreference = "Stop"

function RepoRoot {
  $here = Split-Path -Parent $MyInvocation.ScriptName
  return (Resolve-Path (Join-Path $here "..")).Path
}

$root = RepoRoot
$srcDir = Join-Path $root "vendor/srt-win-src"
$outDir = Join-Path $root "vendor/srt-win"
$outExe = Join-Path $outDir "srt-win.exe"
$constFile = Join-Path $root "packages/core/src/fence/win-sandbox.ts"

function PinnedHash {
  $line = Select-String -Path $constFile -Pattern 'SRT_WIN_SHA256 = "([^"]+)"' | Select-Object -First 1
  if (-not $line) { throw "SRT_WIN_SHA256 not found in $constFile" }
  return $line.Matches[0].Groups[1].Value
}

function Check-Tools {
  foreach ($t in @("git", "cargo") ) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "build-srt-win: $t is not on PATH" }
  }
}

function Sync-Source {
  if (Test-Path (Join-Path $srcDir ".git")) {
    Push-Location $srcDir
    try {
      git fetch --depth 1 origin $Commit 2>$null
      if ($LASTEXITCODE -ne 0) { git fetch origin 2>$null }
      git checkout --force $Commit
    } finally { Pop-Location }
  } else {
    New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
    git clone --no-checkout $Repo $srcDir
    Push-Location $srcDir
    try { git checkout $Commit } finally { Pop-Location }
  }
  Push-Location $srcDir
  try {
    $head = (git rev-parse HEAD).Trim()
    if ($head -ne $Commit) { throw "build-srt-win: checked out $head, expected $Commit" }
    $tagCommit = (git rev-list -n 1 $Tag 2>$null)
    if ($tagCommit -and $tagCommit.Trim() -ne $Commit) { throw "build-srt-win: tag $Tag is $($tagCommit.Trim()), expected $Commit" }
  } finally { Pop-Location }
  Write-Host "build-srt-win: source at $Commit"
}

function Build-Launcher {
  Push-Location $srcDir
  try {
    # Static CRT: no VCRUNTIME140/MSVCP140 prerequisite on the target machine (S2).
    $env:RUSTFLAGS = "-C target-feature=+crt-static"
    cargo build --release --locked --manifest-path (Join-Path $srcDir "Cargo.toml")
    if ($LASTEXITCODE -ne 0) { throw "build-srt-win: cargo build failed" }
  } finally { Pop-Location }
  $built = Join-Path $srcDir "target/release/srt-win.exe"
  if (-not (Test-Path $built)) { throw "build-srt-win: expected output not found at $built" }
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  Copy-Item -Force $built $outExe
  Write-Host "build-srt-win: built $outExe"
}

function Check-NoDynamicCrt {
  # The redistributable's DLLs must not be in the import table (UCRT's api-ms-win-*
  # forwarders and ucrtbase are system components and stay allowed).
  $dumpbin = $null
  foreach ($v in @("VS170COMNTOOLS", "VS160COMNTOOLS")) {
    $tools = [Environment]::GetEnvironmentVariable($v)
    if ($tools) {
      $cand = Join-Path (Split-Path $tools) "IDE/dumpbin.exe"
      if (Test-Path $cand) { $dumpbin = $cand }
    }
  }
  if (-not $dumpbin) {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
      $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
      if ($path) {
        $cand = Get-ChildItem -Path (Join-Path $path "VC/Tools/MSVC") -Filter "dumpbin.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cand) { $dumpbin = $cand.FullName }
      }
    }
  }
  if (-not $dumpbin) {
    Write-Warning "build-srt-win: dumpbin not found; skipping the dynamic-CRT import check"
    return
  }
  $imports = & $dumpbin /dependents $outExe 2>$null | Out-String
  foreach ($bad in @("VCRUNTIME140", "MSVCP140", "VCOMP140", "CONCRT140", "MSVCR", "MSVCP")) {
    if ($imports -match $bad) { throw "build-srt-win: $outExe imports ${bad}.dll (dynamic CRT); the static-CRT build failed" }
  }
  Write-Host "build-srt-win: no dynamic-CRT imports"
}

Check-Tools
Sync-Source
Build-Launcher
Check-NoDynamicCrt

$hash = (Get-FileHash -Algorithm SHA256 $outExe).Hash.ToLower()
Write-Host "build-srt-win: SHA-256 $hash"

if ($RecordHash) {
  $text = Get-Content -Raw $constFile
  $updated = $text -replace 'SRT_WIN_SHA256 = "[^"]+"', "SRT_WIN_SHA256 = `"$hash`""
  if ($updated -eq $text) { throw "build-srt-win: could not update SRT_WIN_SHA256" }
  Set-Content -NoNewline $constFile -Value $updated
  Set-Content -NoNewline (Join-Path $outDir "SHA256") -Value "$hash  srt-win.exe`n"
  Write-Host "build-srt-win: recorded the hash in win-sandbox.ts and vendor/srt-win/SHA256; review the diff"
} else {
  $expected = (PinnedHash).ToLower()
  if ($expected -eq "pending-first-trusted-build") {
    Write-Warning "build-srt-win: no pinned hash yet (SRT_WIN_SHA256 is pending); re-run with -RecordHash on a trusted machine, review, and commit the result"
  } elseif ($hash -ne $expected) {
    throw "build-srt-win: hash mismatch: got $hash, expected $expected"
  } else {
    Write-Host "build-srt-win: hash matches the pin"
  }
}
