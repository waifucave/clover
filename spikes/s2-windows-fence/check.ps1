$ErrorActionPreference = 'Stop'
Write-Output 'Clover token compatibility probe (not a security admission)'
$native = Join-Path $PSScriptRoot 'windows-probe.cs'
if (!(Test-Path $native)) { $native = Join-Path $PSScriptRoot '..\..\native\sandbox\windows-probe.cs' }
Add-Type -Path $native
$root = Join-Path 'C:\clover-tools' ('clover-fence-' + [Guid]::NewGuid().ToString('N'))
$appName = 'com.waifucave.clover.spike.' + [Guid]::NewGuid().ToString('N')
$appSid = [CloverLaunchProbe]::AppSid($appName)
New-Item -ItemType Directory -Path $root | Out-Null
try {
    & icacls $root /grant ('*' + [CloverLaunchProbe]::RestrictSid + ':(OI)(CI)M') ('*' + $appSid + ':(OI)(CI)M') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL setup failed' }
    & icacls $root /setintegritylevel '(OI)(CI)L' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture integrity setup failed' }
    $env:TMP = $root
    $env:TEMP = $root
    $env:HOME = $root
    $env:USERPROFILE = $root
    $env:MSYS2_PATH_TYPE = 'inherit'
    $git = 'C:\Program Files\Git'
    $bash = Join-Path $git 'bin\bash.exe'
    $powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $env:PATH = "$git\bin;$git\usr\bin;C:\clover-tools\node;C:\clover-tools\bun;$env:PATH"
    $checks = @(
        @{name='powershell-pipeline'; exe=$powershell; args='-NoProfile -Command "if ((1,2,3 | Measure-Object -Sum).Sum -ne 6) { exit 2 }"'},
        @{name='bash-pipeline-subshell'; exe=$bash; args='--noprofile --norc -c "test $(printf abc | wc -c) = 3 && (true) && x=$(echo yes) && test $x = yes"'},
        @{name='git'; exe=$bash; args='--noprofile --norc -c "git init -q repo && cd repo && git status --porcelain"'},
        @{name='ssh-version'; exe=$bash; args='--noprofile --norc -c "ssh -V"'},
        @{name='node'; exe=$bash; args='--noprofile --norc -c "node -e ''process.exit(0)''"'},
        @{name='bun'; exe=$bash; args='--noprofile --norc -c "bun -e ''process.exit(0)''"'},
        @{name='build'; exe=$bash; args='--noprofile --norc -c "printf export\\ default\\ 42 > input.js && bun build ./input.js --outfile output.js && test -s output.js"'}
    )
    foreach ($mode in @('privileges','privileges-low','restricted','low','appcontainer')) {
        foreach ($check in $checks) {
            Write-Output ("CHECK " + $mode + ' ' + $check.name)
            try {
                $r = [CloverLaunchProbe]::Run($mode,$check.exe,$check.args,$root,$appName) | ConvertFrom-Json
                $r | Add-Member -NotePropertyName check -NotePropertyValue $check.name
                $r | ConvertTo-Json -Compress
            } catch {
                # Only native launch errors, never command output or environment values.
                Write-Output (ConvertTo-Json -Compress @{ mode=$mode; check=$check.name; launch_error=$_.Exception.InnerException.NativeErrorCode })
            }
            Get-ChildItem -Force $root | Remove-Item -Recurse -Force
        }
    }
} finally {
    [CloverLaunchProbe]::RemoveApp($appName)
    Remove-Item -Recurse -Force $root
}
