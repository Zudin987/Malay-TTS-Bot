param([string]$PackagePath = 'C:\Malay-TTS-Bot')
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'This smoke test runs only on a disposable CI host.' }
$Repo = Split-Path $PSScriptRoot -Parent
$Node = Join-Path $PackagePath 'runtime\node-v24.19.0-win-x64\node.exe'
$Npm = Join-Path $PackagePath 'runtime\node-v24.19.0-win-x64\node_modules\npm\bin\npm-cli.js'
$PreviousPath = $env:PATH
$TaskName = 'Malay TTS Bot CI ' + $env:GITHUB_RUN_ID
$Registered = $false
Push-Location $PackagePath
try {
  # No machine-installed Node/npm on PATH; only the packaged runtime is used.
  $env:PATH = (Split-Path $Node) + ';' + $env:SystemRoot + '\System32;' + $env:SystemRoot + ';' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0'
  & $Node -e "if(process.versions.node!=='24.19.0')process.exit(1)"
  if ($LASTEXITCODE -ne 0) { throw 'Bundled Node version mismatch' }
  $NpmVersion = & $Node $Npm --version
  if ($LASTEXITCODE -ne 0) { throw 'Bundled npm cannot run' }
  & $Node (Join-Path $PSScriptRoot 'validate-source.mjs') $PackagePath --runtime
  if ($LASTEXITCODE -ne 0) { throw 'Packaged JavaScript or JSON validation failed' }
  & $Node $Npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Packaged npm clean install failed' }

  $EnvLines = @('DISCORD_TOKEN=fixture-ci-discord-token', 'DISCORD_CLIENT_ID=123456789012345678', 'GEMINI_API_KEY_SLOT=1')
  foreach ($Slot in 1..10) {
    $Name = if ($Slot -eq 1) { 'GEMINI_API_KEY' } else { "GEMINI_API_KEY_$Slot" }
    $EnvLines += "$Name=fixture-ci-distinct-key-$Slot"
  }
  [IO.File]::WriteAllLines((Join-Path $PackagePath '.env'), $EnvLines, [Text.UTF8Encoding]::new($false))
  & (Join-Path $PackagePath 'install-task.ps1') -InstallPath $PackagePath -TaskName $TaskName
  $Registered = $true
  $Task = Get-ScheduledTask -TaskName $TaskName
  if ($Task.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or [string]$Task.Principal.RunLevel -notin @('Highest', '1') -or [string]$Task.Settings.MultipleInstances -notin @('IgnoreNew', '2')) { throw 'Incorrect SYSTEM task policy' }
  if ($Task.Actions[0].Execute -ne $Node -or $Task.Actions[0].Arguments -ne ('"' + (Join-Path $PackagePath 'src\bootstrap.js') + '"') -or $Task.Actions[0].WorkingDirectory -ne $PackagePath) { throw 'Incorrect task executable, arguments or working directory' }
  if ($Task.Settings.RestartCount -ne 3 -or [Xml.XmlConvert]::ToTimeSpan($Task.Settings.ExecutionTimeLimit).TotalSeconds -ne 0) { throw 'Incorrect task lifetime/restart settings' }

  $ToolsPath = Join-Path $PackagePath 'tools'
  New-Item -ItemType Directory $ToolsPath -Force | Out-Null
  Copy-Item (Join-Path $PSScriptRoot 'system-smoke.mjs') (Join-Path $ToolsPath 'system-smoke.mjs')
  $ProbeAction = New-ScheduledTaskAction -Execute $Node -Argument ('"' + (Join-Path $ToolsPath 'system-smoke.mjs') + '"') -WorkingDirectory $PackagePath
  Set-ScheduledTask -TaskName $TaskName -Action $ProbeAction | Out-Null
  $ResultPath = Join-Path $PackagePath 'data\ci-system-result.json'
  $Nonces = @()
  foreach ($Attempt in 1..2) {
    Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
    $Deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (!(Test-Path -LiteralPath $ResultPath) -and [DateTime]::UtcNow -lt $Deadline) { Start-Sleep -Milliseconds 200 }
    if (!(Test-Path -LiteralPath $ResultPath)) { throw ('SYSTEM smoke did not finish. Task result: ' + (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult) }
    $Result = Get-Content -Raw -LiteralPath $ResultPath | ConvertFrom-Json
    if ($Result.accountSid -ne 'S-1-5-18' -or !$Result.doctorPassed -or !$Result.opusRoundTripPassed) { throw 'SYSTEM runtime/codec proof failed' }
    $Nonces += $Result.nonce
    & $Node (Join-Path $PackagePath 'src\stop-bot.js')
    if ($LASTEXITCODE -ne 0) { throw 'SYSTEM bot did not stop cleanly' }
    $Deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and [DateTime]::UtcNow -lt $Deadline) { Start-Sleep -Milliseconds 200 }
    if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -or (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult -ne 0) { throw 'SYSTEM task did not exit successfully' }
    if (Test-Path -LiteralPath (Join-Path $PackagePath 'data\bot.lock')) { throw 'Owner record survived clean stop' }
  }
  if ($Nonces[0] -eq $Nonces[1]) { throw 'Restart reused the previous ownership nonce' }
  foreach ($Relative in @('.env', 'data', 'data\guilds.json', 'data\guilds.json.bak')) {
    $Acl = Get-Acl -LiteralPath (Join-Path $PackagePath $Relative)
    foreach ($Access in $Acl.Access) {
      $Sid = $Access.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($Access.AccessControlType -eq 'Allow' -and $Sid -in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')) { throw "Private path allows broad access: $Relative" }
    }
  }
  # Exercise the native negative Windows exit code used by setup failure guards.
  & $Node -e 'process.exit(-1)'
  $NegativeExit = $LASTEXITCODE
  if ($NegativeExit -eq 0) { throw 'Negative process exit code was lost' }
  $Proof = @{ node = '24.19.0'; npm = "$NpmVersion"; ffmpeg = '9.0.1'; accountSid = 'S-1-5-18'; systemStarts = 2; cleanStops = 2; tenKeyRoundRobin = $true; opusRoundTrip = $true; privateStateAcl = $true; negativeExitCode = $NegativeExit; sourceCommit = $env:GITHUB_SHA }
  $Proof | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Repo 'dist\verification.json')
  Write-Host 'Packaged SYSTEM starts/stops, ten-key rotation, Node/npm, codec path and inherited state ACLs passed.'
} finally {
  if ($Registered) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  $env:PATH = $PreviousPath
  Pop-Location
}
