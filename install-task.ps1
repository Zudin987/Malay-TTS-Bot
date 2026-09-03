param(
  [string]$InstallPath = 'C:\Malay-TTS-Bot',
  [string]$TaskName = 'Malay TTS Bot'
)
$ErrorActionPreference = 'Stop'
$InstallPath = [IO.Path]::GetFullPath($InstallPath)
$Node = Join-Path $InstallPath 'runtime\node-v24.19.0-win-x64\node.exe'
$Bootstrap = Join-Path $InstallPath 'src\bootstrap.js'
if (!(Test-Path -LiteralPath $Node) -or !(Test-Path -LiteralPath $Bootstrap)) { throw 'Extract the complete Clean release before installing the task.' }
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run setup-clean.cmd as administrator to install the SYSTEM task and protect private state.' }

$DataPath = Join-Path $InstallPath 'data'
New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
$OwnerSid = $Identity.User.Value
# Inheritance protects future atomic replacements, backups, caches and locks.
& icacls.exe $DataPath /inheritance:r /grant:r "*${OwnerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the state directory.' }
$EnvPath = Join-Path $InstallPath '.env'
if (Test-Path -LiteralPath $EnvPath) {
  & icacls.exe $EnvPath /inheritance:r /grant:r "*${OwnerSid}:F" '*S-1-5-18:R' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to protect .env.' }
}

# https://learn.microsoft.com/powershell/module/scheduledtasks/new-scheduledtaskprincipal
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $Bootstrap + '"') -WorkingDirectory $InstallPath
$Trigger = New-ScheduledTaskTrigger -AtStartup
$System = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $Action -Trigger $Trigger -Principal $System -Settings $Settings -Description 'Malay TTS Bot: portable Node, SYSTEM, bounded startup and clean stop control.' -Force | Out-Null
$Task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\'
if ($Task.Principal.UserId -notin @('SYSTEM', 'S-1-5-18') -or $Task.Actions[0].Execute -ne $Node -or $Task.Actions[0].WorkingDirectory -ne $InstallPath) { throw 'The registered task does not match the required SYSTEM runtime.' }
Write-Host "Installed '$TaskName' as SYSTEM with the portable Node runtime. Start it from Task Scheduler or restart-bot.vbs."
