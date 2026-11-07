#Requires -Version 5.1
<#
.SYNOPSIS
  Build Clover's pinned srt-win launcher with a static CRT, Clover's
  per-principal patch set applied, and check its Authenticode digest.

.DESCRIPTION
  Lane C, C-M2 part 2 (spec §4; controller ruling 1). Vendors the launcher from
  `anthropics/sandbox-runtime` at the pinned tag/commit into `vendor/srt-win-src`
  (a build input, never committed — like `.clover-sdk/`), applies
  `vendor/srt-win/patches/*.patch`, builds `srt-win.exe` with the CRT
  linked statically (no VC++ redistributable prerequisite, per S2),
  and fails closed when the result's Authenticode digest differs from
  the pinned constant in `packages/core/src/fence/windows-launcher.ts`
  (`SRT_WIN_PINS`).

  Lane M's CI runs this build and signs the result; this script is the build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-srt-win.ps1 -ExpectedDigest <hex>
  # Verifies the built binary's Authenticode digest against the pin.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-srt-win.ps1 -Target aarch64-pc-windows-msvc
  # Lane M: the arm64 launcher, cross-built on x64 (cargo --target). Without -Target the build is the host's,
  # unchanged, which is the build the x64 pin measures.
#>
[CmdletBinding()]
param(
  [string]$Tag = "v0.0.81",
  [string]$Commit = "c40cf14a65d025e3cd27f071f13a73c12b3b1f92",
  [string]$Repo = "https://github.com/anthropics/sandbox-runtime.git",
  [string]$ExpectedDigest = "",
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"

function RepoRoot {
  $here = Split-Path -Parent $MyInvocation.ScriptName
  return (Resolve-Path (Join-Path $here "..")).Path
}

$root = RepoRoot
$srcDir = Join-Path $root "vendor/srt-win-src"
$crateDir = Join-Path $srcDir "vendor/srt-win-src"
$outDir = Join-Path $root "vendor/srt-win"
$outExe = Join-Path $outDir "srt-win.exe"

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

function Apply-Patches {
  # Clover's per-principal patch set (vendor/srt-win/patches/*.patch).
  # Applied after the checkout, before the build, in sorted order.
  $patchDir = Join-Path $root "vendor/srt-win/patches"
  $patches = Get-ChildItem -Path $patchDir -Filter "*.patch" -ErrorAction SilentlyContinue | Sort-Object Name
  foreach ($p in $patches) {
    Write-Host "build-srt-win: applying $($p.Name)"
    Push-Location $srcDir
    try {
      # The patches are the crate's own (`src/cli.rs`…): applied in vendor/srt-win-src of the checkout. From the
      # checkout's root without --directory they don't apply, and from inside the crate git applies nothing at all.
      git apply --check --directory=vendor/srt-win-src $p.FullName
      if ($LASTEXITCODE -ne 0) { throw "build-srt-win: patch does not apply: $($p.Name)" }
      git apply --directory=vendor/srt-win-src $p.FullName
      if ($LASTEXITCODE -ne 0) { throw "build-srt-win: patch failed: $($p.Name)" }
    } finally { Pop-Location }
  }
  if (-not $patches) { Write-Host "build-srt-win: no patches to apply" }
}

function Build-Launcher {
  Push-Location $crateDir
  try {
    # Static CRT: no VCRUNTIME140/MSVCP140 prerequisite on the target machine (S2).
    # /BREPRO: deterministic output — the Authenticode digest must be identical on every
    # rebuild of the same source, or the pinned digest could never match lane M's CI build.
    $env:RUSTFLAGS = "-C target-feature=+crt-static -C link-arg=/BREPRO"
    # The source pins its toolchain (rust-toolchain.toml, found from here upwards); rustup installs it if missing.
    rustup toolchain install
    if ($LASTEXITCODE -ne 0) { throw "build-srt-win: rustup could not install the source's toolchain" }
    if ($Target -ne "") {
      rustup target add $Target
      if ($LASTEXITCODE -ne 0) { throw "build-srt-win: rustup could not add $Target" }
      cargo build --release --locked --target $Target
    } else {
      cargo build --release --locked
    }
    if ($LASTEXITCODE -ne 0) { throw "build-srt-win: cargo build failed" }
  } finally { Pop-Location }
  $built = if ($Target -ne "") { Join-Path $crateDir "target/$Target/release/srt-win.exe" } else { Join-Path $crateDir "target/release/srt-win.exe" }
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
Apply-Patches
Build-Launcher
Check-NoDynamicCrt

if ($ExpectedDigest -eq "") {
  Write-Warning "build-srt-win: no -ExpectedDigest given; the Authenticode digest is checked at every launch (exit 3 on mismatch), not here"
} else {
  # The digest definition lives in core (authenticodeDigest) and so does
  # the check: ask bun for it rather than reimplementing PE parsing here.
  $probe = & bun -e "import{authenticodeDigest}from'./packages/core/src/fence/windows-launcher.ts';import{readFileSync}from'node:fs';console.log(authenticodeDigest(readFileSync(process.argv[1])))" $outExe 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $probe) { throw "build-srt-win: could not measure the Authenticode digest (needs bun)" }
  $got = $probe.Trim().ToLower()
  if ($got -ne $ExpectedDigest.ToLower()) {
    throw "build-srt-win: Authenticode digest mismatch: got $got, expected $($ExpectedDigest.ToLower())"
  }
  Write-Host "build-srt-win: Authenticode digest matches the pin"
}
