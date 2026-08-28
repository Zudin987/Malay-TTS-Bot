Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Malay-TTS-Bot"
shell.Run """C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe"" ""C:\Malay-TTS-Bot\src\bootstrap.js""", 0, False
