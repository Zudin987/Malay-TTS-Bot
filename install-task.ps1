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

if ($InstallPath.StartsWith('\\')) { throw 'The SYSTEM task must not execute from a network/UNC path.' }
$PathRoot = [IO.Path]::GetPathRoot($InstallPath)
if ($InstallPath.TrimEnd('\') -eq $PathRoot.TrimEnd('\')) { throw 'Refusing to register a SYSTEM task against a drive root.' }
$InstallItem = Get-Item -LiteralPath $InstallPath -Force
if (($InstallItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The installation root must not be a reparse point.' }
$ReparsePoint = Get-ChildItem -LiteralPath $InstallPath -Force -Recurse -ErrorAction Stop |
  Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
  Select-Object -First 1
if ($ReparsePoint) { throw "The installation tree contains a reparse point: $($ReparsePoint.FullName)" }

function Invoke-CheckedIcacls([string[]]$Arguments, [string]$Failure) {
  & icacls.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Reset-DescendantAcls([string]$Directory, [string]$Failure) {
  if (Get-ChildItem -LiteralPath $Directory -Force | Select-Object -First 1) {
    Invoke-CheckedIcacls -Arguments @((Join-Path $Directory '*'), '/reset', '/T', '/C') -Failure $Failure
  }
}

$OwnerSid = $Identity.User.Value
# npm ci runs before this script. Seal every executable/config/runtime/dependency
# path before SYSTEM registration. Reset first so pre-existing explicit entries
# cannot survive beneath the root. Application code/runtime remains readable
# and executable to authenticated local users, but only the three deliberate
# maintenance identities receive write access. Private state is narrowed again
# below after this complete-tree pass.
Invoke-CheckedIcacls -Arguments @($InstallPath, '/reset', '/T', '/C') -Failure 'Failed to reset the application-tree ACL.'
Invoke-CheckedIcacls -Arguments @(
  $InstallPath, '/inheritance:r', '/grant:r',
  "*${OwnerSid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
  '*S-1-5-11:(OI)(CI)RX', '*S-1-5-32-545:(OI)(CI)RX'
) -Failure 'Failed to seal the application-tree ACL.'
Reset-DescendantAcls -Directory $InstallPath -Failure 'Failed to inherit the sealed application-tree ACL.'

$DataPath = Join-Path $InstallPath 'data'
New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
# Inheritance protects future atomic replacements, backups, caches and locks.
Invoke-CheckedIcacls -Arguments @(
  $DataPath, '/inheritance:r', '/grant:r',
  "*${OwnerSid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'
) -Failure 'Failed to protect the state directory.'
Reset-DescendantAcls -Directory $DataPath -Failure 'Failed to inherit the protected state-directory ACL.'
$EnvPath = Join-Path $InstallPath '.env'
if (Test-Path -LiteralPath $EnvPath) {
  Invoke-CheckedIcacls -Arguments @(
    $EnvPath, '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545'
  ) -Failure 'Failed to remove broad access from .env.'
  Invoke-CheckedIcacls -Arguments @(
    $EnvPath, '/inheritance:r', '/grant:r',
    "*${OwnerSid}:F", '*S-1-5-18:R', '*S-1-5-32-544:F'
  ) -Failure 'Failed to protect .env.'
}

# https://learn.microsoft.com/powershell/module/scheduledtasks/new-scheduledtaskprincipal
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $Bootstrap + '"') -WorkingDirectory $InstallPath
$Trigger = New-ScheduledTaskTrigger -AtStartup
$System = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $Action -Trigger $Trigger -Principal $System -Settings $Settings -Description 'Malay TTS Bot: portable Node, SYSTEM, bounded startup and clean stop control.' -Force | Out-Null
$Task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\'
if ($Task.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or $Task.Actions[0].Execute -ne $Node -or $Task.Actions[0].WorkingDirectory -ne $InstallPath) { throw 'The registered task does not match the required SYSTEM runtime.' }
Write-Host "Installed '$TaskName' as SYSTEM with the portable Node runtime. Start it from Task Scheduler or restart-bot.vbs."
