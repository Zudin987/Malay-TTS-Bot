@echo off
setlocal
cd /d C:\Malay-TTS-Bot

echo Malay TTS Bot clean setup v0.24.0
echo.

set "NODE_EXE=C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe"
set "PATH=C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64;%PATH%"
set "NPM_CLI=C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node_modules\npm\bin\npm-cli.js"

if not exist "%NODE_EXE%" goto :missingruntime
if not exist "%NPM_CLI%" goto :missingruntime

"%NODE_EXE%" -e "if (process.versions.node.split('.')[0] !== '24') process.exit(24)"
if errorlevel 1 (
  echo.
  echo The bundled runtime is not Node.js 24.x.
  echo Re-extract the current Clean release package before continuing.
  pause
  exit /b 1
)

echo Using bundled Node.js runtime and npm.
echo Installing bot dependencies with npm ci...
"%NODE_EXE%" "%NPM_CLI%" ci
set "NPM_EXIT=%ERRORLEVEL%"
if not "%NPM_EXIT%"=="0" (
  echo.
  echo npm ci failed with exit code %NPM_EXIT%. Review the error above; no bot files were deleted.
  pause
  exit /b 1
)

echo.
echo Dependencies installed.
echo.
echo Installing the SYSTEM task and protecting private state...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Malay-TTS-Bot\install-task.ps1"
set "TASK_EXIT=%ERRORLEVEL%"
if not "%TASK_EXIT%"=="0" (
  echo Task or file-permission setup failed. Run setup-clean.cmd as administrator.
  pause
  exit /b 1
)
echo.
echo Running health check...
"%NODE_EXE%" "C:\Malay-TTS-Bot\src\doctor.js"
set "DOCTOR_EXIT=%ERRORLEVEL%"
if not "%DOCTOR_EXIT%"=="0" (
  echo.
  echo Setup installed dependencies, but the health check failed with exit code %DOCTOR_EXIT%.
  echo Fix the FAIL item above, then run doctor.cmd again.
  pause
  exit /b 1
)

echo.
echo Deploying slash commands including /changevoice and /restarttts...
"%NODE_EXE%" "C:\Malay-TTS-Bot\deploy-commands.js"
set "DEPLOY_EXIT=%ERRORLEVEL%"
if not "%DEPLOY_EXIT%"=="0" (
  echo.
  echo Dependencies are installed, but slash-command deployment failed with exit code %DEPLOY_EXIT%.
  echo Correct the Discord values in .env, then run deploy-commands.cmd later.
  pause
  exit /b 1
)

echo.
echo Setup complete. Start the installed SYSTEM Task Scheduler task, or double-click start-hidden.vbs for a manual hidden start.
pause
exit /b 0

:missingruntime
echo Bundled Node/npm runtime files are missing from this folder.
echo Re-extract the current Clean release package into C:\Malay-TTS-Bot and run setup-clean.cmd again.
echo A separate system Node.js installation is not required.
echo.
pause
exit /b 1
