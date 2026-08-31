# Malay TTS Bot

Private Windows Discord TTS bot for **Malaysian Malay / Malaysian English**.

Lightweight design: Gemini first, Google Malay fallback, no local AI model, and Task Scheduler-friendly Windows runtime.

## Use

1. Install/use the bot at `C:\Malay-TTS-Bot`.
2. On upgrade, preserve only `.env` and `data\guilds.json`.
3. Replace the old app files with the new clean build.
4. Run `setup-clean.cmd`.
5. Run `doctor.cmd` if you want to verify dependencies/audio.
6. Start the existing **Malay TTS Bot** Task Scheduler task.

Provider order:

1. Gemini 3.1 Flash Live
2. Gemini 2.5 Native Audio Live
3. Gemini 3.1 Flash TTS
4. Google Malay TTS fallback

The bot is designed to read eligible Discord messages aloud, not answer them. Usernames are spoken separately with Google Malay TTS.

## Gemini API keys

The bot accepts up to five configured Gemini API keys in `.env`:

- `GEMINI_API_KEY` — slot 1 and the backward-compatible default
- `GEMINI_API_KEY_2`
- `GEMINI_API_KEY_3`
- `GEMINI_API_KEY_4`
- `GEMINI_API_KEY_5`
- `GEMINI_API_KEY_SLOT=1` — selects the active slot at process startup

Only one key is active at a time. Changing `GEMINI_API_KEY_SLOT` requires restarting the bot process. Quota/rate-limit errors do **not** automatically rotate to another key; the existing Gemini provider cooldown and Google fallback remain in control.

## Important

- Keep `.env` private.
- Do not restore an old `config/settings.json` during a clean upgrade.
- Messages sent to Gemini/Google are processed by those providers under their applicable terms.
- `/ttsoptout` is available for users who do not want eligible messages sent to TTS providers.

Useful commands: `/join`, `/leave`, `/speaker`, `/changevoice`, `/name`, `/dictionary`, `/restarttts`, `/status`, `/ttsprivacy`, `/ttsoptout`.

[Maintenance](MAINTENANCE.md) · [Latest release](../../releases/latest)
