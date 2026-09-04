Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Malay-TTS-Bot"

nodeExe = "C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe"
stopScript = "C:\Malay-TTS-Bot\src\stop-bot.js"
command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & stopScript & Chr(34)

exitCode = shell.Run(command, 0, True)

If exitCode = 0 Then
  shell.Popup "TTS bot stopped cleanly.", 2, "Malay TTS Bot", 64
ElseIf exitCode = 2 Then
  shell.Popup "TTS bot is not running.", 2, "Malay TTS Bot", 64
Else
  shell.Popup "Could not stop the bot cleanly. Check data\bot.log. Task Manager is still available as a fallback.", 5, "Malay TTS Bot", 48
End If
