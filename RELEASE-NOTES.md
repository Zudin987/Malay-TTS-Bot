## v0.24.0

Reliability fixes from the full lifecycle audit, with a validated CLEAN Windows package.

- Preserves all ten `.env` Gemini key slots and round-robin selection: 1 → 2 → … → 10 → 1. Empty slots are skipped and duplicate credentials count once.
- Normal speech uses Gemini 3.1 Flash Live → Google Malay. Removed the older Live fallback and exact-speech provider, their unused settings and compatibility branches. Normal fresh-turn Live timing and the six voice choices remain intact.
- STOP, opt-out, message deletion and disconnect cancel owned work promptly, including generation, buffering, label lookup and late recovery. Prefetch promotion and voice recovery no longer hold the queue behind abandoned work.
- `/ask` deadlines cover complete responses. Only accepted requests supersede previous work, every invalid credential is retired, and speech is bound to the actual reply. STOP/finished/unavailable controls remain consistent. The displayed answer is spoken literally through Google Malay.
- Logs redact configured credentials before both sinks and bound queued memory. Live frames, transcription, total turn lifetime, decoded audio and child-process cleanup are bounded. Status shows effective timers, active work and failures before playback.
- Windows startup uses OS-owned exclusivity and nonce/PID-bound local stop control. Stop works during login; startup/shutdown have deadlines. `setup-clean.cmd` installs the checked-in SYSTEM task and protects inherited state permissions.

### CLEAN installation or upgrade

1. Stop the existing bot using `stop-bot.vbs`.
2. Back up only `.env` and `data\guilds.json`.
3. Extract `Malay-TTS-Bot-v0.24.0-CLEAN.zip` into an empty `C:\Malay-TTS-Bot` installation. Restore only those two user files; keep the new `config\settings.json`.
4. Run `setup-clean.cmd` as administrator, then start the **Malay TTS Bot** SYSTEM task or use `restart-bot.vbs`.

The ZIP includes portable **Node 24.19.0 with npm** and **FFmpeg 9.0.1**, a per-file checksum manifest and fresh defaults. Application dependencies are installed with the bundled npm. It contains no user `.env`, guild state, application `node_modules`, logs, caches or lock files. npm's own dependencies remain inside the portable Node distribution.

### Validation and limits

Publishing is gated on five consecutive full-suite passes on Linux and Windows, source/JSON checks, dependency audit, actual ZIP re-extraction, all shipped JavaScript/JSON checks, a bundled-npm clean install, and two SYSTEM starts/stops with the real packaged audio codec path, ten-key rotation and inherited state ACLs. The release includes the resulting `verification.json` and ZIP SHA-256.

Windows CI exercises the Windows Server runner; it does not replace checking a real Discord voice session on the target Windows 11 machine. No production Discord token or Gemini key is used in CI. Normal Live speech remains generative: strict prompting cannot guarantee every spoken word. `/ask` uses literal Google speech, and unsafe estimated replay has been removed. Google Malay remains the existing unofficial endpoint.

Release publishing is gated in the workflow. Repository branch-protection settings must separately require `validate`, `windows-validate` and `clean-windows-package`; this release does not claim those admin settings were changed.
