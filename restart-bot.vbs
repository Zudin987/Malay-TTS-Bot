Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Malay-TTS-Bot"

nodeExe = "C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe"
stopScript = "C:\Malay-TTS-Bot\src\stop-bot.js"
taskName = "\Malay TTS Bot"

stopCommand = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & stopScript & Chr(34)
stopCode = shell.Run(stopCommand, 0, True)

If stopCode = 0 Or stopCode = 2 Then
  runCommand = "schtasks.exe /Run /TN " & Chr(34) & taskName & Chr(34)
  runCode = 1
  ' Task Scheduler can take a moment to notice that node.exe exited. Retry the
  ' scheduler launch briefly instead of falling back to an interactive process.
  For attempt = 1 To 5
    WScript.Sleep 600
    runCode = shell.Run(runCommand, 0, True)
    If runCode = 0 Then Exit For
  Next
  If runCode = 0 Then
    shell.Popup "TTS bot restart requested through the existing Task Scheduler task (SYSTEM).", 3, "Malay TTS Bot", 64
  Else
    shell.Popup "Bot stopped, but Task Scheduler could not start 'Malay TTS Bot'. Run this file as administrator or start the existing task manually.", 7, "Malay TTS Bot", 48
  End If
Else
  shell.Popup "Could not stop the bot cleanly, so restart was cancelled. Check bot.log.", 5, "Malay TTS Bot", 48
End If
