# Maintenance Rules

## Source of truth

GitHub is the source of truth for development. `main` is the latest stable/released source. Use focused `feature/...` or `fix/...` branches and pull requests for non-trivial changes; do not treat the old `develop` branch as an active integration source unless it is explicitly reintroduced and synchronized.

Current stable baseline: **v0.23.26 - Speech Filter Hardening**.

`main` should be protected in GitHub so pull requests and required CI checks are enforced before merges. Repository-side documentation/workflows are not a substitute for GitHub branch protection.

## Priorities

When trade-offs are required, use this order:

1. **Latency**
2. **Speech quality / correctness**
3. **Features**

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
- Editing Gemini key values or `GEMINI_API_KEY_SLOT` in `.env` requires a full bot process restart. `/restarttts` does not reconstruct the runtime key ring from a changed `.env`.

## Provider chain

Keep the normal preference order unless an explicit release changes it:

1. Gemini 3.1 Flash Live
2. Gemini 2.5 Native Audio Live
3. Gemini 3.1 Flash TTS
4. Google Malay TTS fallback

`/ask` is the exception: its already-generated answer skips conversational Live and uses dedicated Gemini 3.1 TTS first, then Google Malay TTS fallback. Provider health may temporarily bypass known-bad/quota-limited providers, but recovery must restore the normal preference order after a successful half-open probe.

A single TTS item keeps one selected Gemini key throughout its Gemini failover chain. The runtime accepts up to ten configured slots and ignores duplicate credentials rather than treating the same key as independent quota/auth capacity.

## Voice / speaker architecture

Gemini voice pool:

- Charon — Male · Informative
- Orus — Male · Firm
- Schedar — Male · Even
- Gacrux — Female · Mature
- Vindemiatrix — Female · Gentle
- Despina — Female · Smooth

Speaker username must **not** be included in Gemini message text. The speaker label is generated separately with Google Malay TTS, cached locally, played first, then the configured short gap, then the user's Gemini message.

Speaker-label work is privacy-sensitive provider work too. It must be lazy/cancellable, must stop on privacy opt-out, and must not write a new cache entry after cancellation.

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
- `bot.log`, `bot-old.log`
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
- verify privacy opt-out cancels queued/current message TTS and active speaker-label provider work
- verify the doctor reports all configured Gemini slots and duplicate-slot warnings without exposing key contents
- build only a CLEAN package
- re-extract the final ZIP and validate it
- verify `.env`, `data/guilds.json`, `node_modules`, `.git`, cache PCM, logs and temp/runtime lock files are absent
- include the newest default `config/settings.json`
- add the portable Node 24 runtime only to the release package, not the repository

## Git workflow

- `main`: latest stable/released source.
- Use focused `feature/...` or `fix/...` branches for substantial changes.
- Open a pull request to `main` and wait for Ubuntu + Windows CI before merging.
- Prefer small, reviewable PRs with a clear latency/correctness/privacy reason.
- Keep release notes for user-visible behavior and operational changes.
- Do not publish a release from an unreviewed direct push.
