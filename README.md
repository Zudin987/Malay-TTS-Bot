# Malay TTS Bot

Private Windows Discord TTS bot for **Malaysian Malay / Malaysian English**.

Lightweight design: Gemini first, Google Malay fallback, no local AI model, and Task Scheduler-friendly Windows runtime.

## Use

1. Stop the previous bot with `stop-bot.vbs`, then install/use the bot at `C:\Malay-TTS-Bot`.
2. On upgrade, preserve only `.env` and `data\guilds.json`.
3. Extract the new CLEAN build into an empty installation and restore only those two user files.
4. Run `setup-clean.cmd` **as administrator**. It installs dependencies, protects the state directory and registers the SYSTEM task.
5. Run `doctor.cmd` if you want to verify dependencies/audio.
6. Start the **Malay TTS Bot** Task Scheduler task, or use `restart-bot.vbs`.

Speech providers: **Gemini 3.1 Flash Live → Google Malay (`google-ms`)**.

Live keeps a fresh one-turn session, a 2500 ms first-audio window and the existing setup timing. Google starts directly after an initial Live failure, with up to its configured 3500 ms first-audio window. The overall first-audio budget remains 7000 ms; there are no intermediate speech providers.

Normal eligible Discord messages remain strict TTS-only and are not treated as questions for the bot to answer. The explicit `/ask` command is the separate opt-in chat-answer path. Usernames are spoken separately with Google Malay TTS.

## Speaker name speed

Speaker usernames can be made faster in `config/settings.json` without regenerating the cached Google Malay label audio:

```json
"speakerLabel": {
  "enabled": true,
  "speed": 1.15,
  "gapMs": 75,
  "maxWaitMs": 300,
  "gain": 1.5
}
```

`speakerLabel.speed` accepts **0.8x through 1.5x**. The default is **1.15x**. `gapMs` is the silence between the spoken username and the message; the default is **75 ms**.

## /ask short chat answers

Use `/ask question:<text>` when you intentionally want an AI answer. It uses `gemini-3.1-flash-lite` with minimal thinking and returns one compact public Discord embed, normally 1–3 short sentences. The embed title is `<display name> ask` and contains **Question** and **AI reply** fields. The model itself still cannot request images, embeds, tables, or long article-style output.

After the embed is posted, the same answer is queued when the asker is in the active normal voice channel. Only the answer is spoken. Google Malay reads this already-generated text literally: Live's self-transcription cannot independently prove lexical fidelity, so `/ask` does not send the answer to a conversational speech model. TTS failure never removes the posted answer. Bot replies remain excluded from normal MessageCreate speech.

Text generation uses the existing ten-slot Gemini round-robin. Credential-auth failures disable only the bad slot and try the next available key within one request deadline. Quota and model/project permission failures do not rotate keys to retry the same request.

## Gemini API keys

The bot accepts up to ten configured Gemini API keys in `.env`:

- `GEMINI_API_KEY` — slot 1 and the backward-compatible default
- `GEMINI_API_KEY_2`
- `GEMINI_API_KEY_3`
- `GEMINI_API_KEY_4`
- `GEMINI_API_KEY_5`
- `GEMINI_API_KEY_6`
- `GEMINI_API_KEY_7`
- `GEMINI_API_KEY_8`
- `GEMINI_API_KEY_9`
- `GEMINI_API_KEY_10`
- `GEMINI_API_KEY_SLOT=1` — optional starting slot for the round-robin sequence

With all ten slots populated, Gemini requests use **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 1**. Each Live speech item selects one key. Empty slots are skipped; duplicate credentials count once. Google speech does not consume a Gemini key selection.

If a key is rejected as invalid/revoked, that slot is removed from the runtime round-robin until `/restarttts`. Quota/rate-limit failures do not trigger an immediate second-key retry inside the same message; the normal provider cooldown and Google fallback still apply.

The round-robin is intended for multiple keys from the same Google Cloud project. Keys in the same project share that project's Gemini quota, so this does not multiply project quota. Changing key values or the starting slot in `.env` requires restarting the bot process.

## Important

- Keep `.env` private.
- Do not restore an old `config/settings.json` during a clean upgrade.
- Messages sent to Gemini/Google are processed by those providers under their applicable terms.
- `/ttsoptout` is available for users who do not want eligible messages sent to TTS providers.

Useful commands: `/ask`, `/join`, `/leave`, `/speaker`, `/changevoice`, `/name`, `/dictionary`, `/restarttts`, `/status`, `/ttsprivacy`, `/ttsoptout`.

[Maintenance](MAINTENANCE.md) · [Latest release](../../releases/latest)


## Gemini read-aloud prompting

Live uses a strict system instruction and a collision-resistant, nonce-delimited transcript. The working normal-chat protocol and six voices remain: Charon, Orus, Schedar, Gacrux, Vindemiatrix and Despina. The prompt forbids answering, rewriting and additional words; generative speech still cannot provide an absolute lexical guarantee. `/ask` and recovery tails use Google when literal delivery is required.

Square-bracket spans are neutralized for Gemini audio, for example `[laughs]` becomes `(laughs)`. This preserves their words without treating them as performance tags. Google input is unchanged.

Edit `geminiLive.profile` in `config/settings.json`: fidelity belongs in `systemInstruction`; delivery/accent/pacing belongs in `stylePrompt`. Provider fallback defaults use the same profile definitions as missing-file startup.

Eligible normal speech remains text, resolved mentions and `hantar gambar` for images. Links, non-image files, GIFs, videos, emoji and code-only payloads remain silent. One Discord message remains one logical speech item.

Historical release notes are available on [GitHub Releases](../../releases).

## Windows process control

The checked-in `install-task.ps1` registers the portable Node executable, absolute bootstrap path and `C:\Malay-TTS-Bot` working directory under SYSTEM. It uses one instance, a startup trigger and three restarts after failure. The `data` directory grants inherited access to SYSTEM, Administrators and the installing user, so new atomic state files and backups keep the same protection.

A small control socket bound only to `127.0.0.1` provides OS-owned exclusivity and nonce/PID-bound graceful stopping. The port is derived from the installation path (23000–38999). `data/bot.lock` records identity; stale, empty or corrupt records are replaced only after the OS grants ownership. A port collision fails closed. Stop control starts before Discord login, startup is limited to 45 seconds and shutdown to five seconds. The bot does not kill an arbitrary PID or poll a stop-request file.

## Release validation

v0.24.0 ships portable Node 24.19.0 including npm, and FFmpeg 9.0.1. Source commits contain no binaries. `scripts/build-clean.py` downloads checksum-pinned runtimes and builds from tracked source using an explicit allowlist and fixed archive ordering/timestamps. `release-manifest.json` records the source commit and per-file checksums.

CI requires five consecutive full test passes on both Linux and Windows. It re-extracts the real CLEAN ZIP, checks every shipped JavaScript and JSON file (including portable npm), installs application dependencies with bundled npm and no system Node on PATH, and verifies two SYSTEM starts/stops, ten-key rotation, the PCM/filter/Opus/decode path and inherited private-state ACLs. Publishing from main depends on every gate passing and never overwrites an existing release/tag.

Repository administrators should separately require `validate`, `windows-validate` and `clean-windows-package` in branch protection. Workflow publishing gates do not configure GitHub's merge permissions.
