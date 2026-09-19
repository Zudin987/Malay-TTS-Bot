# Malay TTS Bot

Self-hosted Discord text-to-speech bot for **Malaysian Malay and Malaysian English**. It reads eligible messages in a voice channel and offers a separate `/ask` command for short AI answers. Runs on Windows; no local AI model is required.

[Download latest release](https://github.com/Zudin987/Malay-TTS-Bot/releases/latest) · [Project website](https://zudin987.github.io/projects/malay-tts/)

## What it does

- Reads eligible Discord messages aloud using Gemini speech, with Google Malay TTS as a fallback.
- Announces speakers separately and supports voice, pronunciation and per-user opt-out controls.
- Answers explicit `/ask` requests without turning ordinary chat into AI conversations.
- Runs as a Windows scheduled task with portable Node and FFmpeg included in the CLEAN release ZIP.

## Requirements

- **Windows 11**, administrator access for setup and an internet connection.
- Your own Discord bot with **Message Content Intent** enabled and permission to read the intended text channel and connect/speak in a voice channel.
- A Gemini API key for speech and `/ask`.

## Install

1. [Download the latest CLEAN ZIP](https://github.com/Zudin987/Malay-TTS-Bot/releases/latest) and extract it into an **empty** `C:\Malay-TTS-Bot` folder.
2. Create and invite your Discord bot with the `bot` and `applications.commands` scopes.
3. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` and `GEMINI_API_KEY`.
4. Run `setup-clean.cmd` **as administrator** to install dependencies, check configuration, deploy commands and register the scheduled task.
5. Start the **Malay TTS Bot** task. Join a voice channel, run `/join`, then check `/status`.

If setup fails, run `doctor.cmd` and follow the reported error. Never share `.env`, bot tokens or API keys in an issue.

## Everyday use and upgrades

Useful commands: `/join`, `/leave`, `/ask`, `/speaker`, `/changevoice`, `/name`, `/dictionary`, `/status`, `/ttsprivacy` and `/ttsoptout`.

For a clean upgrade, stop the old bot, preserve **only** `.env` and `data\guilds.json`, extract the new CLEAN ZIP into an empty installation folder, restore those two files and rerun `setup-clean.cmd` as administrator. Do not restore an old `config/settings.json`.

**Privacy:** Eligible messages may be sent to Gemini and then Google on fallback; speaker names go to Google separately. `/ask` sends the question to Gemini. Use `/ttsprivacy` for details and `/ttsoptout` to opt out of normal-chat TTS. Opt-out cannot retract data already sent to a provider.

## More information

[Technical reference](TECHNICAL_REFERENCE.md) · [Maintenance and troubleshooting](MAINTENANCE.md) · [Release notes](RELEASE-NOTES.md) · [Third-party notices](THIRD-PARTY-NOTICES.md)
