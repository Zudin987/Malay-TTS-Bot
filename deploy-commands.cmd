@echo off
setlocal
cd /d C:\Malay-TTS-Bot
set "BOTNODE=C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe"

if not exist "%BOTNODE%" (
  echo [FAIL] Bundled Node runtime is missing.
  pause
  exit /b 1
)

"%BOTNODE%" "C:\Malay-TTS-Bot\deploy-commands.js"
set "EXITCODE=%ERRORLEVEL%"
echo.
if "%EXITCODE%"=="0" (
  echo Slash commands deployed successfully.
) else (
  echo Slash-command deployment failed. Check .env and the error above.
)
pause
exit /b %EXITCODE%
