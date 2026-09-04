# Maintenance Rules

## Source of truth

GitHub is the source of truth for development. `main` is the latest stable/released source. Use focused `feature/...` or `fix/...` branches and pull requests for non-trivial changes; do not treat the old `develop` branch as an active integration source unless it is explicitly reintroduced and synchronized.

See `package.json` and GitHub Releases for the stable version.

`main` should be protected in GitHub so pull requests and required CI checks are enforced before merges. Repository-side documentation/workflows are not a substitute for GitHub branch protection.

## Priorities

When trade-offs are required, use this order:

1. **Reliability and bounded ownership**
2. **No added or invented words**
3. **Low first-audio latency**
4. **Smooth UX, simple architecture and low resource use**

Never add heavy local AI, local TTS models, or architecture that materially increases first-audio latency/RAM without an explicit decision.

## Runtime invariants

- Windows 11 deployment at `C:\Malay-TTS-Bot`.
- Normal production startup is Task Scheduler as **SYSTEM** using portable Node and `src\bootstrap.js`.
- Portable Node/FFmpeg binaries belong in release packages, **not Git source**.
- One Discord message = one TTS item.
- Message combining/merging stays removed.
- Gemini Live sessions are fresh, one-turn sessions; do not restore multi-turn reuse.
- Do not convert the bot to an EXE for performance.
- `/restarttts` resets process-global TTS/provider state, so it must only run when all guild queues and Gemini provider work are idle.
- `config/settings.json` is loaded at startup and by the guarded `/restarttts` command only. Do not restore automatic file watching that can mutate settings during active work.
- Editing Gemini key values or `GEMINI_API_KEY_SLOT` in `.env` requires a full bot process restart. `/restarttts` does not reconstruct the runtime key ring from a changed `.env`.

## Provider chain

Normal chat and `/ask` speech use **Gemini 3.1 Flash Live → Google Malay (`google-ms`)**. These are the only two speech providers. Preserve normal fresh one-turn Live setup and first-audio timing.

`/ask` generates its displayed answer with the existing Gemini text model, then sends that exact finalized answer into the same strict read-aloud Live path. The collision-resistant transcript boundaries and system instruction prohibit answering, translating, completing, paraphrasing, rewriting or adding words. Google receives the same exact answer only when Live is unavailable or fails. There is no second text-generation or rewriting stage. Recovery tails may still use Google or already-generated PCM when deterministic recovery requires bypassing Live.

Provider first-audio success is not the same as audible Discord playback. `/ask` therefore keeps one bounded post-provider audibility window: it must both enter playback and make real `playbackDuration` progress. If Gemini was selected but reaches 0 ms playback progress, cancel that stale Live turn and retry the exact answer once with Google only. If Google also reaches 0 ms, retire the `/ask` item and release FIFO; never create a retry loop. Once any `/ask` playback progress exists, never restart the full answer from the beginning. Keep this guard scoped to `/ask` unless a deliberate product decision changes normal-chat timing.

The runtime accepts **ten environment key slots** and keeps **round-robin selection**. One Live speech item uses one selected key; duplicate credentials do not create independent quota/auth capacity. Quota failures do not trigger same-request key rotation. Environment key changes require a full process restart.

## Voice / speaker architecture

Gemini voice pool:

- Charon — Male · Informative
- Orus — Male · Firm
- Schedar — Male · Even
- Gacrux — Female · Mature
- Vindemiatrix — Female · Gentle
- Despina — Female · Smooth

Speaker username must **not** be included in Gemini message text. The speaker label is generated separately with Google Malay TTS, cached locally, played first, then the configured short gap, then the user's Gemini message.

Speaker-label work is privacy-sensitive provider work too. It must be lazy/cancellable, owner-scoped by guild/user, must stop only the opting-out user's consumers, and must not write a new cache entry after cancellation. Per-user opt-out purges that owner's memory/disk entries; never return to an unowned cache key that prevents targeted deletion.

Voice-log delivery must re-fetch the configured recipient from the event guild and re-check Manage Guild on every event. Authorization lookup failure or lost permission disables and clears the subscription. Removing the bot from a guild deletes that guild's persisted record.

## Discord speech eligibility

Normal `MessageCreate` TTS is deliberately limited to human speech-like content:

- ordinary chat text -> speak
- Discord user/role/channel mention -> resolve/read the name where possible
- image attachment/embed -> `hantar gambar`
- normal text plus an image -> speak the text plus `hantar gambar`
- `/ask` -> handled by its separate interaction/TTS path

The following are intentionally silent when they are the only payload, and are stripped when mixed with ordinary chat:

- raw/autolink/masked links
- non-image files
- GIFs
- videos
- Unicode/custom/text emoji and kaomoji
- fenced or inline code-only payloads
- Discord/web preview embeds that are not actual image posts

Do **not** restore `hantar link`, `hantar fail`, `hantar GIF`, `hantar video`, or `hantar code` narration to normal chat TTS without an explicit product decision.

## Text / profile rules

Gemini preprocessing stays light and deterministic after the Discord speech-eligibility gate:

- preserve the approved ordinary chat text
- resolve Discord mentions where possible
- lightly remove Discord formatting/control characters
- keep image narration as `hantar gambar`

Do **not**:

- restore the 620-word dictionary to Gemini
- grammar-rewrite or translate Gemini input
- guess or complete unfinished sentences
- aggressively remove meaningful chat wording
- add semantic rewriting

The system/profile must prioritize no invented/extra words. It may naturally pronounce an existing unambiguous shorthand token, but must never add surrounding particles, subjects, objects, answers, filler, laughter, or sentence endings that were not present.

Desired delivery: natural Malaysian Malay/Malaysian English, smooth code-switching, about 0.95x normal pace, calm/plain/restrained, short natural pauses, controlled pitch, no excited/high final word, and preserved voice identity.

## User data and clean upgrades

The only user files normally preserved across clean upgrades are:

- `.env`
- `data\guilds.json`

Do not commit or ship either file. Do not restore an older `config\settings.json` over a newer release default.

Also exclude runtime/generated data such as:

- `node_modules/`
- `data/speaker-label-cache/`
- `data/bot.log`, `data/bot-old.log` (and legacy root logs)
- `data/bot.lock`
- `data/stop.request`
- backups/temp files

## Release gates

Before calling a release final:

- run `node --check` on every shipped `.js` file
- parse every shipped `.json` file
- run the full regression suite repeatedly (at least 5 consecutive clean passes for timing-sensitive releases)
- test the FFmpeg PCM -> filters/limiter -> libopus/Ogg -> decode path
- review provider cancellation, failover, queue, speaker-label and disconnect/recovery behavior
- verify `/ask` provider-first-audio without playback progress cannot hold FIFO: Gemini gets at most one Google-only retry, Google failure terminates, and any real playback progress forbids full-answer restart
- verify privacy opt-out cancels queued/current message TTS and active speaker-label provider work
- verify opt-out/cache purge is owner-scoped and leaves another guild/user's work intact
- verify voice-log recipients are current authorized guild members before every DM
- verify graceful shutdown flushes deferred guild-store writes
- verify the doctor reports all configured Gemini slots and duplicate-slot warnings without exposing key contents
- build only a CLEAN package
- re-extract the final ZIP and validate it
- verify `.env`, `data/guilds.json`, `node_modules`, `.git`, cache PCM, logs and temp/runtime lock files are absent
- include the newest default `config/settings.json`
- add the portable Node 24 runtime only to the release package, not the repository
- on Windows, reject reparse-point install trees, seal the whole application DACL before SYSTEM task registration, verify packaged hashes, and prove a real standard account cannot write source, config, runtime, dependencies or logs
- pin every `uses:` action to a verified full commit SHA; update pins through reviewed Dependabot pull requests
- keep the live npm advisory audit mandatory; during a network-only outage, `audit-dependencies.mjs` may accept only an unexpired (maximum 48-hour), zero-vulnerability baseline bound to the exact unchanged package and lockfile hashes

## Git workflow

- `main`: latest stable/released source.
- Use focused `feature/...` or `fix/...` branches for substantial changes.
- Open a pull request to `main` and wait for Ubuntu + Windows CI before merging.
- Prefer small, reviewable PRs with a clear latency/correctness/privacy reason.
- Keep release notes for user-visible behavior and operational changes.
- Do not publish a release from an unreviewed direct push.
