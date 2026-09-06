## v0.24.4

Second corpus-driven Google fallback pronunciation audit. This release keeps the v0.24.3 `/ask` audibility/queue hardening unchanged and improves how the deterministic Google Translate TTS fallback handles short gamer-English, Malay/Manglish shorthand, and game/technical initials.

### Short gamer-English routing

- Google fallback remains Malay-first on ambiguity, but short clearly-English gaming/technical messages can now use English TTS instead of being forced through Malay pronunciation.
- Covered real-chat shapes include `server down`, `carry me`, `raid gear`, `skill issue`, `server reset`, `max level`, `world boss in 27 minute`, and normalized `gg` / `good game`.
- A small curated set of safe one-word English gaming/technical messages may route to English. Unknown single words, usernames, nicknames, new game names and other uncertain text still default to Malay/literal handling.
- Any credible Malay/Manglish marker wins before English evidence, so mixed lines remain one coherent Malay voice. There is still no per-word language switching.

### Malay shorthand and typo coverage

- Added only high-confidence forms observed in the supplied NeverRun exports: contextual `jd` -> `jadi`, `ksh` -> `kasih`, `kjp` -> `sekejap`, `skl` -> `sekali`, and `memng` -> `memang`.
- Existing context-gated aliases from v0.24.3 remain, including `x`, `ko`, `acaner`, `kiteorg`/`kteorg`, and the Indonesian `gak` collision guard.
- Short ambiguous forms are not promoted to blind global replacements. Unknown text is still preserved instead of guessed through edit-distance/fuzzy autocorrect.

### Acronym and game-name pronunciation

- Added deterministic readings for observed all-caps game/technical initials that could otherwise be damaged by ordinary shouting-case normalization: `SAO`, `NTE`, `RYL`, `GPT`, `URL`, and `UX`.
- Added context-scoped readings for `ML`, `HSR`, `WWM`, and `SSR`, with `game`, `gaming`, and `play` available as game-context signals.
- Ambiguous forms such as `AS`, `TO`, `IT`, `US`, `MY`, `MT`, and `DP` remain untouched globally.

### Safety boundaries preserved

- Normal MessageCreate speech still strips raw/autolink/masked links and bare domains before dictionary preprocessing, so URL/domain text is not rewritten as chat abbreviations.
- No fuzzy autocorrect, semantic rewriting, translation, grammar correction, or text completion was added.
- Gemini Live input remains light and strict; the fallback pronunciation dictionaries are not restored to Gemini.
- `/ask` keeps the v0.24.3 3500 ms post-provider audibility guard, exactly one Google-only retry after a zero-progress Gemini handoff, no Google retry loop, and no full-answer restart after any real playback progress.

### Regression and release hygiene

- Added real-chat regressions for the second-audit Malay forms, short gamer-English routing, Malay-marker precedence, exact Google `tl=en` / `tl=ms` request selection, and deterministic acronym readings.
- `package.json` and root `package-lock.json` are both aligned to **0.24.4**; dependency versions are otherwise unchanged.
- Fresh npm advisory validation for the v0.24.4 dependency files reports zero vulnerabilities.
- Existing ten-key rotation, provider cancellation/failover, privacy/cache ownership, graceful shutdown, clean-package exclusions, checksum-pinned runtimes, Windows SYSTEM lifecycle, full-tree ACL sealing and standard-user write-denial gates remain preserved.

### CLEAN installation or upgrade

1. Stop the existing bot using `stop-bot.vbs`.
2. Back up only `.env` and `data\guilds.json`.
3. Extract `Malay-TTS-Bot-v0.24.4-CLEAN.zip` into an empty `C:\Malay-TTS-Bot` installation. Restore only those two user files; keep the new `config\settings.json`.
4. Run `setup-clean.cmd` as administrator, then start the **Malay TTS Bot** SYSTEM task or use `restart-bot.vbs`.

The ZIP includes portable **Node 24.19.0 with npm** and **FFmpeg 9.0.1**, a per-file checksum manifest and fresh defaults. It contains no user `.env`, guild state, application `node_modules`, logs, caches or lock files.

### Validation and limits

Publishing remains gated on five consecutive full-suite passes on Linux and Windows, source/JSON validation, a mandatory dependency audit, real CLEAN ZIP re-extraction, bundled-runtime checks, and Windows proof of SYSTEM starts/stops, ten-key rotation, deferred-store persistence, the PCM/filter/Opus/decode path, packaged hashes, full application/private-state ACLs, protected data logs and standard-user write denial. The release includes `verification.json` and the CLEAN ZIP SHA-256.

CI uses fixture credentials and does not use a production Discord token or Gemini key. Gemini Live speech remains generative, so strict prompting materially constrains lexical behavior but cannot provide an independent absolute acoustic-fidelity guarantee. The Google fallback remains the existing unofficial Translate TTS endpoint; routing is deterministic and conservative rather than a general language-identification service.
