## v0.24.5

Provider loudness calibration release. Google Malay fallback playback now uses the same 1.5x gain that already blended well for Google-generated speaker labels, while Gemini 3.1 Live remains at 1.0x. With the shipped `fixedVolume` of 0.6, normal Gemini playback remains 0.60 and normal Google fallback playback becomes 0.90 before the existing peak limiter.

### Provider volume matching

- Added explicit provider playback gain settings: `geminiLive: 1.0` and `googleMs: 1.5`.
- Provider gain applies only to normal TTS playback. Existing `speakerLabel.gain` remains independent and unchanged at 1.5.
- The configured provider gain is applied before the existing `-5 dB` peak limiter, preserving the current clipping protection and Opus pipeline.
- Unknown/non-provider playback paths keep neutral 1.0x gain.
- No `loudnorm` stage was added, so the low-latency streaming path remains unchanged apart from the provider multiplier.

### Regression coverage

- Added direct tests for Gemini 1.0x and Google 1.5x provider gain defaults.
- Added coverage for the shipped 0.6 master volume producing 0.60 Gemini and 0.90 Google playback levels.
- Added bounds checks for configurable provider gain and verified that the peak limiter remains the final audio filter.
- The implementation preserves existing queueing, provider fallback, cutoff recovery, speaker-label behavior and playback verification.

### Maintenance since v0.24.4

- Simplified the main README while retaining the full technical reference and clarified which setup/reference documentation is authoritative.
- Updated pinned GitHub Actions artifact dependencies and the matching immutable-pin regression assertions.
- Dependency versions are otherwise unchanged.

### CLEAN installation or upgrade

1. Stop the existing bot using `stop-bot.vbs`.
2. Back up only `.env` and `data\guilds.json`.
3. Extract `Malay-TTS-Bot-v0.24.5-CLEAN.zip` into an empty `C:\Malay-TTS-Bot` installation. Restore only those two user files; keep the new `config\settings.json`.
4. Run `setup-clean.cmd` as administrator, then start the **Malay TTS Bot** SYSTEM task or use `restart-bot.vbs`.

The ZIP includes the repository's checksum-pinned portable Node/npm and FFmpeg runtimes, a per-file checksum manifest and fresh defaults. It contains no user `.env`, guild state, application `node_modules`, logs, caches or lock files.

### Validation and limits

Publishing remains gated on five consecutive full-suite passes on Linux and Windows, source/JSON validation, dependency audit, real CLEAN ZIP re-extraction, bundled-runtime checks, and Windows proof of SYSTEM starts/stops, ten-key rotation, deferred-store persistence, the PCM/filter/Opus/decode path, packaged hashes, full application/private-state ACLs, protected data logs and standard-user write denial. The release includes `verification.json` and the CLEAN ZIP SHA-256.

CI uses fixture credentials and does not use a production Discord token or Gemini key. Gemini Live speech remains generative, so the provider gain is a practical perceptual calibration rather than an absolute LUFS guarantee. The Google fallback remains the existing unofficial Translate TTS endpoint.
