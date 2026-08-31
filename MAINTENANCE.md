# Maintenance Rules

## Source of truth

GitHub is the source of truth for development. `main` is stable/released code and `develop` is the active integration branch. Use focused feature/fix branches and pull requests for non-trivial changes.

Current stable baseline: **v0.23.7 — Discord Setup/Auth Hotfix**.

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

## Provider chain

Keep the normal preference order unless an explicit release changes it:

1. Gemini 3.1 Flash Live
2. Gemini 2.5 Native Audio Live
3. Gemini 3.1 Flash TTS
4. Google Malay TTS fallback

Provider health may temporarily bypass known-bad/quota-limited providers, but recovery must restore the normal preference order after a successful half-open probe.

## Voice / speaker architecture

Gemini voice pool:

- Charon
- Enceladus
- Aoede
- Despina

Speaker username must **not** be included in Gemini message text. The speaker label is generated separately with Google Malay TTS, cached locally, played first, then the configured short gap, then the user's Gemini message.

## Text / profile rules

Gemini preprocessing stays light and deterministic:

- URL -> `hantar link`
- image -> `hantar gambar`
- GIF -> `hantar GIF`
- video -> `hantar video`
- code block -> `hantar code`
- resolve Discord mentions where possible
- lightly remove Discord formatting/control characters

Do **not**:

- restore the 620-word dictionary to Gemini
- grammar-rewrite or translate Gemini input
- guess or complete unfinished sentences
- aggressively remove keyboard smash/noise
- add semantic rewriting

The system/profile must prioritize no invented/extra words. It may expand an existing unambiguous shorthand token for pronunciation (for example `nk` -> `nak`, `idk` -> `I don't know`) but must never add surrounding particles, subjects, objects, answers, or sentence endings (for example `nak` must not become `nak ka`).

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
- build only a CLEAN package
- re-extract the final ZIP and validate it
- verify `.env`, `data/guilds.json`, `node_modules`, `.git`, cache PCM, logs and temp/runtime lock files are absent
- include the newest default `config/settings.json`
- add the portable Node 24 runtime only to the release package, not the repository

## Git workflow

- `main`: latest stable/released source.
- `develop`: integration branch for active work.
- Use `feature/...` or `fix/...` branches for substantial changes.
- Run CI before merging.
- Prefer small, reviewable PRs with a clear latency/correctness reason.
- Keep release notes for user-visible behavior and operational changes.
