# The one elevated step of Clover's Windows installer (packaging/windows/installer.nsh): Bash's sandbox principal
# (lane C's `clover-core sandbox setup|remove`). The controller's ruling: nothing is ever elevated from the per-user
# install folder, which the user (and so anything running as them) can write. So this script:
#   setup   copies clover-core.exe from the installer's payload into %ProgramFiles%\Clover Sandbox\ (only admins can
#           write there), checks that copy's Authenticode digest against the pin the release build compiled into
#           the installer, and runs `sandbox setup` from the copy
#   remove  runs `sandbox remove` from that protected copy (verified when it was made), then deletes the folder
# It is never a file on disk: the release build (scripts/release/build.ts) puts its text, with the pin, into the
# installer, and the installer passes it to an elevated PowerShell as an encoded command. The two runtime values
# arrive in base64 (UTF-16), so no character of a folder name is ever parsed as code: the source path, and the SID
# of the user who ran the installer, whose own copy this is (%ProgramFiles%\Clover Sandbox\<SID>\, so one user's
# remove never breaks another's). Exit codes: clover-core's own (0 done, 1 failed, 2 not elevated, 3 the launcher
# missing or not pinned), or 4 the exe to run is missing, 5 the copy's digest is not the pinned one, 6 the protected
# folder is not protected (owned by someone other than Administrators, SYSTEM or TrustedInstaller, or writable by
# users), 7 a bad argument; on 4 to 7 nothing was run.
param([string]$Action, [string]$SourceB64, [string]$UserB64)
$ErrorActionPreference = 'Stop'
$Pin = '__CLOVER_CORE_DIGEST__'

# The PE Authenticode digest (scripts/release/srt-win.ts's authenticodeDigest, the same rules): the file but its
# CheckSum, its certificate-table entry and its certificate table, zero-padded to 8 bytes; $null for a file that
# isn't a well-formed PE, or whose certificate entry could hide code.
function Get-CloverDigest([string]$Path) {
  $b = [IO.File]::ReadAllBytes($Path)
  $u16 = { param($at) if ($at + 2 -gt $b.Length) { throw 'truncated' }; [BitConverter]::ToUInt16($b, $at) }
  $u32 = { param($at) if ($at + 4 -gt $b.Length) { throw 'truncated' }; [BitConverter]::ToUInt32($b, $at) }
  try {
    if ($b.Length -lt 64 -or (& $u16 0) -ne 0x5A4D) { return $null }
    $pe = [int](& $u32 0x3C)
    if ((& $u32 $pe) -ne 0x4550) { return $null }
    $sections = & $u16 ($pe + 6); $optSize = & $u16 ($pe + 20); $opt = $pe + 24
    $magic = & $u16 $opt
    if ($magic -ne 0x10B -and $magic -ne 0x20B) { return $null }
    $headers = & $u32 ($opt + 60); $sum = $opt + 64
    $dirs = $opt + $(if ($magic -eq 0x20B) { 112 } else { 96 })
    if ((& $u32 ($dirs - 4)) -lt 5) { return $null }
    $ce = $dirs + 32
    if ($ce + 8 -gt $opt + $optSize) { return $null }
    $co = [long](& $u32 $ce); $cs = [long](& $u32 ($ce + 4))
    $end = [long]$headers
    for ($i = 0; $i -lt $sections; $i++) {
      $s = $opt + $optSize + 40 * $i
      $raw = [long](& $u32 ($s + 16)); $ptr = [long](& $u32 ($s + 20))
      if ($raw -gt 0 -and $ptr + $raw -gt $end) { $end = $ptr + $raw }
    }
    if ($end -gt $b.Length) { return $null }
    $hashedEnd = [long]$b.Length
    if ($cs -ne 0) {
      if ($co -lt $headers -or $co -lt $end -or $co + $cs -ne $b.Length -or $co % 8 -ne 0) { return $null }
      for ($j = $end; $j -lt $co; $j++) { if ($b[$j] -ne 0) { return $null } }
      $hashedEnd = $co
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    [void]$sha.TransformBlock($b, 0, $sum, $null, 0)
    [void]$sha.TransformBlock($b, $sum + 4, $ce - ($sum + 4), $null, 0)
    [void]$sha.TransformBlock($b, $ce + 8, $hashedEnd - ($ce + 8), $null, 0)
    $pad = (8 - ($hashedEnd % 8)) % 8
    [void]$sha.TransformFinalBlock((New-Object byte[] $pad), 0, $pad)
    return (($sha.Hash | ForEach-Object { $_.ToString('x2') }) -join '')
  } catch { return $null }
}

function Decode([string]$b64) { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64)) }
try { $Source = Decode $SourceB64; $User = Decode $UserB64 } catch { exit 7 }
if ($User -notmatch '^S-1-[0-9]+(-[0-9]+)+$' -or ($Action -ne 'setup' -and $Action -ne 'remove')) { exit 7 }

# Only these may own the protected folders, and none of the writers below may write to them.
$Owners = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$Writers = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4', 'S-1-5-32-546', $User)
$WriteRights = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
function Test-Protected([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($Owners -notcontains $owner) { return $false }
  foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -ne 'Allow' -or ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if ($Writers -contains $ace.IdentityReference.Value -and ($ace.FileSystemRights -band $WriteRights)) { return $false }
  }
  return $true
}

# Program Files as Windows has it, not as the user's environment says (HKCU\Environment can change $env:ProgramFiles).
$base = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Clover Sandbox'
$dir = Join-Path $base $User
$exe = Join-Path $dir 'clover-core.exe'
if ($Action -eq 'setup') {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { exit 4 }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (-not (Test-Protected $base) -or -not (Test-Protected $dir)) { exit 6 }
  Copy-Item -LiteralPath $Source -Destination $exe -Force
  if ((Get-CloverDigest $exe) -ne $Pin) { Remove-Item -LiteralPath $exe -Force; exit 5 }
} else {
  # Nothing was ever set up from here: nothing to remove.
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { exit 0 }
  if (-not (Test-Protected $base) -or -not (Test-Protected $dir)) { exit 6 }
}
$p = Start-Process -FilePath $exe -ArgumentList 'sandbox', $Action -WindowStyle Hidden -Wait -PassThru
$code = $p.ExitCode
if ($Action -eq 'remove' -and $code -eq 0) { Remove-Item -LiteralPath $dir -Recurse -Force }
exit $code
