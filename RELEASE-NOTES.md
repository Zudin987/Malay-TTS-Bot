## v0.24.3

Patch release hardening `/ask` speech after v0.24.2 correctly restored Gemini 3.1 Live as the primary speech provider.

### `/ask` audibility fallback

- Root cause addressed: provider **first audio** and Discord **audible playback** are separate milestones. A Live turn could return PCM successfully, be selected as the provider, and then leave the audio pipeline waiting up to the old 10-second player-start limit before the listener heard anything.
- `/ask` now has one bounded **3500 ms post-provider audibility window**. The window covers both entering Discord `Playing` and obtaining real `playbackDuration` progress; entering `Playing` alone is not treated as audible success.
- If Gemini 3.1 Live is selected but the `/ask` item reaches **0 ms playback progress** within that audibility window, the stale Live turn is cancelled and the exact displayed answer is retried **once** with Google Malay (`google-ms`). That retry sets `skipLive: true`, so it cannot loop back into Live.
- If Google already owns the `/ask` attempt and still reaches 0 ms playback progress, no second retry is created. The failed `/ask` item retires and FIFO continues to later normal-chat TTS.
- Once any `/ask` audio has made real playback progress, the bot never restarts the full answer from the beginning. Existing conservative verified-tail recovery may still operate, preventing a late local/provider completion from creating a duplicate full answer.
- Normal chat keeps its existing 10-second Discord player-start behavior; this shorter audibility policy is scoped only to `/ask`.

### Regression coverage

Added explicit tests for:

- bounded `/ask` audibility timing while normal chat retains its previous timeout;
- Gemini first-audio success followed by zero playback progress -> exactly one Google-only retry;
- cancellation of stale Gemini work during that retry;
- no full-answer replay after any actual playback progress;
- Google zero-progress failure -> no retry loop;
- `Playing` without `playbackDuration` progress not counting as `/ask` audibility;
- provider failure on `/ask` clearing queue ownership so a following normal-chat item still runs.

The v0.24.2 provider-routing regressions remain in place: exact displayed answer -> Gemini 3.1 Live first, exact-text Google fallback, deterministic ten-key rotation, provider metrics and one logical `/ask` queue item.

### Release hygiene and preserved protections

- `package.json` and the root `package-lock.json` metadata are both aligned to **0.24.3**, correcting the non-runtime version-metadata mismatch noted after v0.24.2.
- The existing ten Gemini key slots, deterministic round robin, bad-key isolation, quota/cooldown behavior, `/ask` ownership and STOP/supersession rules, no-prefetch protection, privacy opt-out/cache ownership, graceful shutdown, clean-package exclusions, checksum-pinned portable runtimes, Windows SYSTEM lifecycle, full-tree ACL sealing, standard-user write-denial proof and release-provenance gates remain preserved.

### CLEAN installation or upgrade

1. Stop the existing bot using `stop-bot.vbs`.
2. Back up only `.env` and `data\guilds.json`.
3. Extract `Malay-TTS-Bot-v0.24.3-CLEAN.zip` into an empty `C:\Malay-TTS-Bot` installation. Restore only those two user files; keep the new `config\settings.json`.
4. Run `setup-clean.cmd` as administrator, then start the **Malay TTS Bot** SYSTEM task or use `restart-bot.vbs`.

The ZIP includes portable **Node 24.19.0 with npm** and **FFmpeg 9.0.1**, a per-file checksum manifest and fresh defaults. It contains no user `.env`, guild state, application `node_modules`, logs, caches or lock files.

### Validation and limits

Publishing remains gated on five consecutive full-suite passes on Linux and Windows, source/JSON validation, dependency audit, real CLEAN ZIP re-extraction, bundled-runtime checks, and Windows proof of two SYSTEM starts/stops, ten-key rotation, deferred-store persistence, the PCM/filter/Opus/decode audio path, packaged hashes, full application/private-state ACLs, protected data logs and standard-user write denial. The release includes `verification.json` and the CLEAN ZIP SHA-256.

CI uses fixture credentials and does not use a production Discord token or Gemini key. Gemini Live speech remains generative, so strict prompting materially constrains lexical behavior but cannot provide an independent absolute acoustic fidelity guarantee. Google Malay remains the existing unofficial fallback endpoint.
