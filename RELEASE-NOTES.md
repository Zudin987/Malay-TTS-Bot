## v0.24.1

Phase Two reliability, privacy, deployment and release hardening with a validated CLEAN Windows package.

- Preserves all ten `.env` Gemini key slots and round-robin selection: 1 → 2 → … → 10 → 1. Empty slots are skipped and duplicate credentials count once.
- Normal speech remains Gemini 3.1 Flash Live → Google Malay. The retired older Live and exact-speech providers remain absent; normal fresh-turn timing and the six voice choices remain intact.
- Speaker-label generation and cache entries are owner-scoped. `/ttsoptout` cancels/purges only that guild user's label data, while unrelated jobs and identical labels owned by other users continue. Legacy unowned entries are removed at startup.
- `/ask` uses a bounded fair button-write queue: saturated or locally timed-out writes keep their coalesced latest intent, terminal state wins, and real rejected writes have bounded retries. A newer request cancels older pre-audible speech only after its answer is visible, the voice connection is confirmed and its own item is queued; failed replacement requests preserve valid older speech.
- Voice-log recipients are re-fetched from the event guild and must still have Manage Guild for every DM. Lost/uncertain authorization or deletion of the configured channel clears the subscription, and guild removal deletes persisted guild state.
- `/join` reports a concurrent different-channel rejection instead of claiming it joined. `/ttsprivacy` now explains message, separate speaker-name/cache and explicit `/ask` processing, and opt-out performs the documented cache purge.
- Deferred guild-state writes are flushed during clean and fatal shutdown. Settings changes no longer hot-reload around the idle-only `/restarttts` guard.
- Logs redact configured credentials before both sinks and bound queued memory. Live frames, transcription, total turn lifetime, decoded audio and child-process cleanup are bounded. Status shows effective timers, active work and failures before playback.
- Windows setup rejects UNC/drive-root/reparse-point trees and seals source, configuration, runtime, dependencies, state and data logs before registering SYSTEM. Release CI verifies hashes and proves a real standard account cannot open protected files for write.
- GitHub-owned Actions are pinned to reviewed full commit SHAs, and Dependabot is configured to maintain the pins.

### CLEAN installation or upgrade

1. Stop the existing bot using `stop-bot.vbs`.
2. Back up only `.env` and `data\guilds.json`.
3. Extract `Malay-TTS-Bot-v0.24.1-CLEAN.zip` into an empty `C:\Malay-TTS-Bot` installation. Restore only those two user files; keep the new `config\settings.json`.
4. Run `setup-clean.cmd` as administrator, then start the **Malay TTS Bot** SYSTEM task or use `restart-bot.vbs`.

The ZIP includes portable **Node 24.19.0 with npm** and **FFmpeg 9.0.1**, a per-file checksum manifest and fresh defaults. Application dependencies are installed with the bundled npm. It contains no user `.env`, guild state, application `node_modules`, logs, caches or lock files. npm's own dependencies remain inside the portable Node distribution.

### Validation and limits

Publishing is gated on five consecutive full-suite passes on Linux and Windows, source/JSON checks, dependency audit, actual ZIP re-extraction, all shipped JavaScript/JSON checks, a bundled-npm clean install, and two SYSTEM starts/stops with the real packaged audio codec path, ten-key rotation, deferred-store persistence, full application/private-state ACLs, source/runtime hash checks, protected data logs, and standard-user write denial. The release includes the resulting `verification.json` and ZIP SHA-256.

Windows CI exercises the Windows Server runner; it does not replace checking a real Discord voice session on the target Windows 11 machine. No production Discord token or Gemini key is used in CI. Normal Live speech remains generative: strict prompting cannot guarantee every spoken word. `/ask` uses literal Google speech, and unsafe estimated replay has been removed. Google Malay remains the existing unofficial endpoint.

Release publishing is gated in the workflow and never overwrites an existing tag or release. Repository branch/tag protection and immutable-release settings remain separate GitHub administration controls and must be verified independently of source code.
