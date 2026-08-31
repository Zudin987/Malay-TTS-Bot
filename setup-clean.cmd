@echo off
setlocal
cd /d C:\Malay-TTS-Bot

echo Malay TTS Bot clean setup v0.23.6
echo.

where node >nul 2>&1
if errorlevel 1 goto :missingnode
where npm >nul 2>&1
if errorlevel 1 goto :missingnode

for /f "delims=" %%V in ('node -p "process.versions.node"') do set NODE_VERSION=%%V
for /f "delims=" %%M in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%M
echo Found system Node.js %NODE_VERSION%
if not "%NODE_MAJOR%"=="24" (
  echo.
  echo This bot requires Node.js 24.x for npm ci.
  echo Install Node.js 24 LTS, then close and reopen this setup file.
  echo winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  pause
  exit /b 1
)

echo Installing bot dependencies with npm ci...
call npm ci
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
echo Tightening local permissions for secrets/state where possible...
if exist ".env" (
  icacls ".env" /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(F)" "*S-1-5-18:(R)" "*S-1-5-32-544:(F)" >nul 2>&1
  if errorlevel 1 echo WARNING: Could not restrict .env ACL automatically. Protect it manually with Windows file permissions.
)
if exist "data\guilds.json" (
  icacls "data\guilds.json" /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" >nul 2>&1
  if errorlevel 1 echo WARNING: Could not restrict data\guilds.json ACL automatically.
)
echo.
echo Running health check...
"C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe" "C:\Malay-TTS-Bot\src\doctor.js"
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
"C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe" "C:\Malay-TTS-Bot\deploy-commands.js"
set "DEPLOY_EXIT=%ERRORLEVEL%"
if not "%DEPLOY_EXIT%"=="0" (
  echo.
  echo Dependencies are installed, but slash-command deployment failed with exit code %DEPLOY_EXIT%.
  echo Correct the Discord values in .env, then run deploy-commands.cmd later.
  pause
  exit /b 1
)

echo.
echo Setup complete. Start the existing Task Scheduler task, or double-click start-hidden.vbs for a manual hidden start.
pause
exit /b 0

:missingnode
echo Node/npm was not found in PATH.
echo Install Node.js 24 LTS, then close and reopen this setup file:
echo.
echo winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
echo.
pause
exit /b 1
