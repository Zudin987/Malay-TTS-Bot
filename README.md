# Malay TTS Bot — v0.23.5 — Reliability & Privacy Hardening

Private Windows Discord Malaysian Malay / Malaysian English TTS bot. The runtime stays lightweight: no local AI model, no EXE conversion, no message merging, and every Gemini Live message uses a fresh one-turn session.

## Provider order

1. Gemini 3.1 Flash Live
2. Gemini 2.5 Native Audio Live
3. Gemini 3.1 Flash TTS (streamed Interactions API, `store:false`)
4. Google Malay TTS fallback

Gemini voice pool:

- Male: Charon, Enceladus
- Female: Aoede, Despina

Speaker usernames are **not** inserted into Gemini text. The username is generated separately with Google Malay TTS, cached locally, played first, followed by the configured gap (100 ms default), then the user message uses the assigned Gemini voice.

## v0.23.5 highlights

- **Cancellation-safe streamed provider backpressure.** Gemini 3.1 Flash TTS and Google Malay fallback now stop waiting for `drain` when output is aborted, closed or errors, preventing cancelled work from hanging completion or retaining a Gemini concurrency slot.
- **Privacy opt-out has no hidden 500-user ceiling.** Guild-state normalization and `/ttsoptout` mutation both preserve the complete valid opted-out user set.
- **Speaker-label decoder lifetime is bounded.** A wedged FFmpeg speaker-label decode is terminated by a hard watchdog instead of surviving after the foreground label wait times out.
- **Release hygiene is stricter.** CI rejects `guilds.json.bak`, stale lock/stop files and temp/runtime artifacts in addition to existing secret/cache/log guards.
- **CI is Node-24-native.** GitHub Actions uses checkout/setup-node v7, Ubuntu runs dependency audit, and the full suite remains cross-platform on Ubuntu and Windows.
- **Regression suite expanded to 57 tests.** New coverage exercises provider cancellation while backpressured, >500-user opt-out persistence/mutation, and wedged speaker-label FFmpeg termination.

### v0.23.4 hardening retained

- **Adaptive Gemini Live audio-end grace.** Missing/delayed completion metadata no longer clips healthy audio after a fixed 650 ms gap; ordinary `generationComplete` turns still close audio immediately.
- **HTTP-200 Gemini TTS SSE errors are classified correctly.** RPD/daily quota, auth, permission, config/request and retryable transport failures now feed the same provider-health logic as HTTP failures.
- **Cutoff recovery keeps ownership metadata.** Recovery items preserve the originating Discord message ID and voice-channel ID.
- **Less hot-path disk I/O.** Non-critical guild normalization and automatic voice-assignment persistence are coalesced briefly, while explicit settings/privacy writes remain synchronous.
- **FFmpeg path lookup is cached.** Repeated playback avoids redundant filesystem probes and automatically invalidates when `FFMPEG_PATH` changes.
- **Unicode-safe speaker labels.** ZWJ emoji sequences are preserved and the 80-character safety limit truncates by grapheme cluster.
- **Single-instance lock race hardened.** Lock ownership now includes a nonce and stale/corrupt lock replacement requires exact-record revalidation before deletion.
- **Windows CI added.** The full Node 24 regression suite now runs on both Ubuntu and Windows, with Ubuntu also probing the real FFmpeg/libopus filter path.

- **Quota and transport failures are separated.** A quota error on Gemini 3.1 Live no longer suppresses Gemini 2.5 Live as if the whole Live transport were broken.
- **Exponential per-provider circuit breakers.** Short quota/rate failures cool down for 15s, then 60s, then 300s on repeated failures; success resets the streak. Temporary errors use a smaller 8s -> 30s -> 120s ladder.
- **Burst protection / Google-first mode.** Two rapid Gemini quota failures within 15s trigger a 45s Gemini bypass so spam does not repeatedly burn latency rediscovering known quota errors.
- **Half-open recovery probes.** After a cooldown, only one failed Gemini provider is probed at a time. Other messages keep flowing to a known-working fallback instead of stampeding the recovering provider.
- **Daily quota recognition.** Clear RPD/daily-quota errors cool down until the next Pacific daily reset instead of retrying every minute.
- **HTTP 400 fail-fast.** Gemini 3.1 TTS HTTP 400/INVALID_ARGUMENT now preserves the server detail in `/status` and disables that exact provider until `/restarttts` or its relevant settings change.
- **Narrower auth gate.** Only clear credential failures (401/UNAUTHENTICATED/invalid-key messages) disable all Gemini providers. Generic 403/PERMISSION_DENIED is treated as model/project access instead.
- **Global Gemini concurrency cap: 2.** Current speech is prioritized over speculative prefetch, preventing your own burst/prefetch work from amplifying free-tier throttling.
- **Latency-first provider windows.** Within the existing 7s overall budget, the default first-audio windows are 2.5s (3.1 Live), 1.6s (2.5 Live), 1.6s (3.1 TTS), while reserving at least 1.2s for Google.
- Voice choices are intentionally reduced to **Charon, Enceladus, Aoede and Despina**. Existing saved assignments to removed voices are automatically reassigned when next used.
- The default profile is stricter about no invented/extra words and uses prompt-level guidance for about **0.95x** natural pace, calm delivery, slightly lower comfortable pitch and brief natural clause pauses. No SSML tags are injected into user text.
- Current user audio defaults are preserved in the new clean settings: **60% message volume** and **1.50x speaker-label gain**.

## v0.23.2 / v0.23.1 foundations retained

- v0.23.2 overlaps cold Discord voice connection with TTS generation while keeping playback gated on Ready.
- v0.23.2 uses strict FIFO streaming prefetch with a bounded in-memory spool so the immediate successor can start without waiting for full generation.
- v0.23.2 propagates active provider failure directly into FFmpeg/playback recovery instead of waiting for the long progress watchdog.
- v0.23.2 makes provider completion metadata non-blocking after audible playback ends.
- Live first-audio budget expiry now reliably counts as a provider health failure/cooldown instead of being hidden as a cancellation.
- Live audio closes on `generationComplete` or after a conservative 650 ms post-audio grace when completion markers are delayed/missing; completion metadata is handled separately from audio progression.
- Enabling `/ttsoptout` now cancels that user's current, queued and prefetched TTS work, with a second opt-out check immediately before enqueue to close the message/command race.
- Google speaker-name default gain is now **1.50x**. The same shared peak limiter still caps both label and message output; no heavier live loudness-normalizer was added, preserving latency and voice character.
- Speaker-label reset is decided at playback time and committed when the username audio is actually heard, rather than when a Discord message is queued.
- Discord voice disconnects pause local audio. Voice recovery is serialized per guild and connection cleanup is protected by an ownership epoch.
- Recovery avoids repeating already-heard speech. Full replay is allowed only before the configurable early-playback threshold (250 ms default); recoverable raw PCM uses a small overlap tail instead.
- Playback watchdog uses known raw/MP3 duration where available, a progress watchdog, and a 60-second active-playback hard maximum; transient Discord voice pauses do not consume that timeout.
- Provider work is abortable on queue drop, disconnect/clear, failover budget expiry and shutdown.
- One end-to-end first-audio budget covers Gemini and Google fallback (7000 ms default).
- Gemini authentication failures disable all Gemini attempts until `/restarttts`; shared Live setup/transport failures suppress the redundant second Live setup attempt temporarily.
- First-audio success and completed-turn success are tracked separately. Midstream provider failures affect provider health.
- Gemini 3.1 TTS now streams audio instead of buffering the full result before playback. Its 4s first-audio timer is separate from inactivity/output/absolute completion bounds. Google fallback begins after its first ordered MP3 chunk, with a 3.5s first-chunk deadline and separate 12s bounded completion window.
- Gemini 3.1 TTS uses Interactions API `store:false` and `Api-Revision: 2026-05-20`.
- Gemini speech boundaries use a fresh high-entropy nonce per turn; the old configurable fixed delimiter is removed, and bracketed/directive-looking user text is explicitly treated as literal text.
- 400-character handling is grapheme-safe and reserves room for link/media phrases. Common bare domains are detected.
- Discord mentions use collision-safe temporary tokens; role/channel/user mentions are resolved when possible.
- `config/settings.json` reload recovery, guild-store validation and runtime clamping were hardened.
- Custom `/dictionary` overrides are now stored per guild in `data/guilds.json`, so clean upgrades preserve them.
- `FFMPEG_PATH` is supported and the doctor checks the real PCM -> filters -> libopus/Ogg -> decode path.
- Speaker-label cache now has corruption/duration validation, age/count pruning and separate gain.
- `/status` uses embeds and includes provider/attempt/recovery and local latency metrics without risking Discord's 2000-character content limit.
- `/join` and `/leave` require Manage Server. Commands are guild-only. Stage channels are deliberately unsupported.
- Fatal uncaught exceptions/rejections exit non-zero so Task Scheduler can restart the bot rather than leave a damaged process alive.
- `restart-bot.vbs` restarts the existing **Malay TTS Bot** Task Scheduler task instead of launching Node as the interactive user.
- Old rapid/queued merge and configurable multi-turn Live-session code/settings were removed.
- A permanent offline regression suite is included under `test/`.

## Clean upgrade

Your install folder is expected to be:

`C:\Malay-TTS-Bot`

Before replacing an older clean build, preserve only:

- `.env`
- `data\guilds.json`

Then:

1. Stop the current bot.
2. Replace the old `C:\Malay-TTS-Bot` contents with this clean package.
3. Restore `.env` and `data\guilds.json`.
4. **Do not restore an old `config\settings.json`**; v0.23.5 ships the release defaults.
5. Run `setup-clean.cmd` from an Administrator-capable interactive account. It runs `npm ci`, applies best-effort restrictive ACLs to `.env`/`guilds.json`, runs the doctor and deploys slash commands.
6. Start the existing **Malay TTS Bot** Task Scheduler task.

Your working Task Scheduler setup can remain:

- Task name: `Malay TTS Bot`
- Account: `SYSTEM`
- Program: `C:\Malay-TTS-Bot\runtime\node-v24.19.0-win-x64\node.exe`
- Arguments: `C:\Malay-TTS-Bot\src\bootstrap.js`
- Start in: `C:\Malay-TTS-Bot`
- Configure the task to restart on failure so fatal runtime errors recover automatically.

## FFmpeg under SYSTEM

The bot resolves FFmpeg in this order:

1. `FFMPEG_PATH` from `.env`
2. `runtime\ffmpeg\bin\ffmpeg.exe`
3. `runtime\ffmpeg.exe`
4. `ffmpeg` from the process PATH

If FFmpeg works in your normal Command Prompt but the SYSTEM task cannot find it, put the absolute executable path in `.env`, for example:

`FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe`

Run `doctor.cmd` after changing it.

## Default speech profile

Gemini preprocessing remains intentionally light and deterministic. It does not use the old large pronunciation dictionary, rewrite grammar, complete unfinished sentences, merge Discord messages, or aggressively remove keyboard-smash/noise. The Google fallback keeps the mature local dictionary path.

Default profile goals are exact recitation, Malaysian Malay/Malaysian English pronunciation, slightly slower-than-normal calm delivery, restrained pitch movement and neutral/gently downward statement endings.

Generative Live speech still cannot provide a mathematical guarantee that it will never produce an extra sound/word. v0.23.5 retains the hardened prompts/recovery, while the exact Gemini TTS and Google fallback paths remain available when Live fails.

## Useful commands

- `/join` — manually join/move to your normal voice channel (Manage Server)
- `/leave` — stop TTS and disconnect (Manage Server)
- `/speaker` — username announcement mode/reset
- `/changevoice` — choose/reset a user's Gemini voice
- `/name` — set/remove a spoken alias
- `/dictionary` — per-guild Google-fallback pronunciation override (stored in `guilds.json`)
- `/voicelog` — optional voice join/leave log
- `/restarttts` — safely reload settings and reset TTS provider health when the queue is idle
- `/status` — provider, recovery, queue, cache and latency diagnostics
- `/ttsprivacy` — show the provider/data-processing notice and your opt-out status
- `/ttsoptout enabled:true|false` — prevent/allow your eligible messages from being sent to TTS providers

## Privacy note for the private guild

With billing disabled / unpaid Gemini service, messages sent for Gemini speech generation are processed by Google under the applicable Gemini API terms. `store:false` disables Interactions state storage but does not override the broader unpaid-service data terms. Do not use the bot for private/confidential channel content; restrict the API key and protect `.env` with local Windows permissions. The bot ships `/ttsprivacy` as a guild notice and a per-user `/ttsoptout`; opted-out text is rejected before voice connection/preprocessing/provider work.

## Validation

Run:

```cmd
npm test
node --check src\bootstrap.js
doctor.cmd
```

`doctor.cmd` validates the installed dependencies and the actual FFmpeg/Opus pipeline. The included tests make no Discord/Gemini/Google network requests.
