from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Preserve U+200D ZERO WIDTH JOINER so emoji grapheme clusters remain intact.
replace_once(
    'src/speaker-label.js',
    "replace(/[\\u200B-\\u200D\\u2060\\uFEFF]/gu, '')",
    "replace(/[\\u200B\\u200C\\u2060\\uFEFF]/gu, '')"
)

# The missing-metadata fallback now intentionally protects the first gap for
# 900 ms; generationComplete still closes audio immediately on normal turns.
replace_once(
    'test/regression.test.js',
    "assert.ok(elapsed >= 250 && elapsed < 700, `audio-end grace elapsed=${elapsed}ms`);",
    "assert.ok(elapsed >= 850 && elapsed < 1200, `adaptive audio-end grace elapsed=${elapsed}ms`);"
)
