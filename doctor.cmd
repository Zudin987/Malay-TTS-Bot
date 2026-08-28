@echo off
setlocal
cd /d C:\Malay-TTS-Bot
set "BOTNODE=C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe"

if not exist "%BOTNODE%" (
  echo [FAIL] Bundled Node runtime is missing:
  echo %BOTNODE%
  echo Re-extract the clean build or drop-in.
  pause
  exit /b 1
)

"%BOTNODE%" "C:\Malay-TTS-Bot\src\doctor.js"
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" echo Fix the FAIL items above before relying on the bot.
pause
exit /b %EXITCODE%
