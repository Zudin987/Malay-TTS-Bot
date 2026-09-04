## v0.24.2

Patch release correcting `/ask` speech routing while preserving the v0.24.1 reliability, privacy, ownership and Windows deployment hardening.

- Root cause fixed: v0.24.1 intentionally set `/ask` queue items to `skipLive: true`, so a ready Gemini 3.1 Live provider was never attempted for `/ask`; Google MS was the hard-coded primary, not a runtime fallback or configuration failure.
- `/ask` now sends the exact already-generated/displayed answer through the normal **Gemini 3.1 Flash Live → Google Malay (`google-ms`)** speech chain. Google receives the same exact answer only when Live is unavailable or fails.
- Literal-response behavior is preserved without a second Gemini rewriting step. The existing fresh Live turn uses collision-resistant speech boundaries and the strict read-aloud system instruction that forbids answering, translating, completing, paraphrasing, rewriting or adding words.
- Status and `/ttsprivacy` now describe the real `/ask` speech provider chain instead of saying `/ask` always uses Google.
- All ten `.env` Gemini key slots remain supported: `GEMINI_API_KEY` through `GEMINI_API_KEY_10`. Deterministic round-robin selection, bad-key isolation, quota behavior and `/restarttts` reset behavior remain intact.
- `/ask` ownership, queue admission, no-prefetch behavior, STOP control, supersession rules and one-logical-item playback behavior remain unchanged. Recovery-only `skipLive` behavior remains available for deterministic recovery paths.
- Added `/ask` routing regressions for Live-primary selection, exact-text Google fallback, all-ten-key rotation, provider metrics, Live failure handling and single-item/no-duplicate queue ownership.
- The v0.24.1 privacy/cache/shutdown protections, clean-package allowlist, checksum-pinned runtimes, SYSTEM task lifecycle, full-tree ACL sealing, standard-user write-denial proof and release provenance gates remain unchanged.

### CLEAN installation or upgrade

1. Stop the existing bot using `stop-bot.vbs`.
2. Back up only `.env` and `data\guilds.json`.
3. Extract `Malay-TTS-Bot-v0.24.2-CLEAN.zip` into an empty `C:\Malay-TTS-Bot` installation. Restore only those two user files; keep the new `config\settings.json`.
4. Run `setup-clean.cmd` as administrator, then start the **Malay TTS Bot** SYSTEM task or use `restart-bot.vbs`.

The ZIP includes portable **Node 24.19.0 with npm** and **FFmpeg 9.0.1**, a per-file checksum manifest and fresh defaults. It contains no user `.env`, guild state, application `node_modules`, logs, caches or lock files.

### Validation and limits

Publishing remains gated on five consecutive full-suite passes on Linux and Windows, source/JSON validation, dependency audit, real CLEAN ZIP re-extraction, bundled-runtime checks, and Windows proof of two SYSTEM starts/stops, ten-key rotation, deferred-store persistence, the PCM/filter/Opus/decode audio path, packaged hashes, full application/private-state ACLs, protected data logs and standard-user write denial. The release includes `verification.json` and the CLEAN ZIP SHA-256.

CI uses fixture credentials and does not use a production Discord token or Gemini key. Gemini Live speech remains generative, so strict prompting materially constrains lexical behavior but cannot provide an independent absolute acoustic fidelity guarantee. Google Malay remains the existing unofficial fallback endpoint.
