// Remove random symbol-noise tokens before dictionary/TTS. This is separate
// from the dictionary because tokens like "&^%&^s" are not words, and from
// the emoticon filter because they are not meaningful reaction faces.
//
// The cleaner is intentionally conservative around technical/mathematical text:
// keep C++, 1+1=2, 50%, A/B, 1920x1080, v2.0, file paths, URLs, email-like
// forms, and normal sentence punctuation.

const NONSPACE_TOKEN_PATTERN = /\S+/gu;
const URLISH_PATTERN = /^(?:https?:\/\/|www\.|discord\.gg\/)/iu;
const FILE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\.\.?[\\/]|[/\\])|[\\/]/u;
const EMAILISH_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const VERSIONISH_PATTERN = /^v?\d+(?:[._-]\d+)+(?:[A-Za-z-]+)?$/u;
const DIMENSIONISH_PATTERN = /^\d{2,5}x\d{2,5}$/iu;
const SIMPLE_RATIO_OR_UNIT_PATTERN = /^\d+(?:\.\d+)?(?:%|ms|s|m|mb|gb|tb|hz|fps|kbps)$/iu;
const MATHISH_PATTERN = /^(?:[A-Za-z]?\d+(?:\.\d+)?(?:[+\-*/=<>]+\d+(?:\.\d+)?)+|\d+(?:\.\d+)?%|[A-Za-z]\+\+|\w+(?:={1,3}|>=|<=)\w+|\d+m)$/u;
const BENIGN_PUNCT_ONLY_PATTERN = /^[.,!?;:'"()\[\]{}-]+$/u;
const UNUSUAL_SYMBOL_PATTERN = /[~`^|\\*@#$%&]/u;
const LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;


const ALPHA_CORE_PATTERN = /^[A-Za-z]{7,28}$/u;
const SIMPLE_OUTER_PUNCT_PATTERN = /^[.,!?;:'"()\[\]{}-]+|[.,!?;:'"()\[\]{}-]+$/gu;
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

function collapseRepeatedLetters(text) {
  return text.replace(/([a-z])\1{2,}/giu, '$1');
}

function repeatedChunkCoverage(text) {
  let best = 0;
  for (let size = 2; size <= 4; size += 1) {
    for (let start = 0; start < Math.min(size, text.length); start += 1) {
      const chunk = text.slice(start, start + size);
      if (chunk.length !== size) continue;
      let count = 0;
      let offset = 0;
      while (offset <= text.length - size) {
        const found = text.indexOf(chunk, offset);
        if (found < 0) break;
        count += 1;
        offset = found + size;
      }
      best = Math.max(best, (count * size) / text.length);
    }
  }
  return best;
}

function isKeyboardRowRun(text) {
  const lower = text.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    const reversed = [...row].reverse().join('');
    for (let length = Math.min(row.length, lower.length); length >= 6; length -= 1) {
      for (let start = 0; start <= row.length - length; start += 1) {
        const piece = row.slice(start, start + length);
        const reversePiece = reversed.slice(start, start + length);
        if (lower.includes(piece) || lower.includes(reversePiece)) return true;
      }
    }
  }
  return false;
}

function keyboardPosition(char) {
  for (let row = 0; row < KEYBOARD_ROWS.length; row += 1) {
    const column = KEYBOARD_ROWS[row].indexOf(char);
    if (column >= 0) return { row, column };
  }
  return null;
}

function longestKeyboardWalk(text) {
  let longest = 1;
  let current = 1;
  for (let index = 1; index < text.length; index += 1) {
    const a = keyboardPosition(text[index - 1]);
    const b = keyboardPosition(text[index]);
    if (
      a && b &&
      !(a.row === b.row && a.column === b.column) &&
      Math.abs(a.row - b.row) <= 1 &&
      Math.abs(a.column - b.column) <= 1
    ) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }
  return longest;
}

function looksLikeKeyboardSmash(rawToken) {
  // Ignore ordinary punctuation around a candidate, e.g. "sdasdaswd...".
  const text = rawToken.replace(SIMPLE_OUTER_PUNCT_PATTERN, '').toLowerCase();
  if (!ALPHA_CORE_PATTERN.test(text)) return false;

  const length = text.length;
  const unique = new Set(text).size;
  const vowelCount = [...text].filter((char) => VOWELS.has(char)).length;
  const vowelRatio = vowelCount / length;
  const collapsed = collapseRepeatedLetters(text);

  // Preserve obvious expressive elongations/laughter. The later normalizer
  // already shortens long repeated letters, and these are meaningful in chat.
  if (/^(?:ha|he|hi|ho|hu|ah|eh|w?k)+$/u.test(text)) return false;
  if (/^(?:w?k){3,}w?$/u.test(text)) return false;
  if (/^h+m+$/u.test(text)) return false;
  if (collapsed.length <= 5 && /[aeiou]/u.test(collapsed)) return false;
  if (/^[a-z]{2,6}([a-z])\1{3,}$/u.test(text)) return false;

  // Classic keyboard-row smashes: qwertyui, asdfghj, zxcvbnm (or reverse).
  if (isKeyboardRowRun(text)) return true;

  // Repeated low-vowel chunks such as sdasdaswd / brbrbrbr. High-vowel
  // repeated names/words such as bilibili and nokonoko are preserved.
  if (
    repeatedChunkCoverage(text) >= 0.62 &&
    unique <= 4 &&
    vowelRatio <= 0.23
  ) return true;

  // A long walk across adjacent keyboard keys is another strong signal.
  if (longestKeyboardWalk(text) >= 7 && vowelRatio <= 0.15) return true;

  // Long consonant soup: fdndhdgdgnsfsg. Keep this threshold deliberately
  // strict so normal English/Malay/game terms are not guessed away.
  if (length >= 10 && vowelRatio <= 0.08 && unique >= 5) return true;

  // Low-diversity repeated noise with little vowel structure.
  if (length >= 9 && unique <= 4 && vowelRatio <= 0.25) return true;

  return false;
}

function countByChar(text, predicate) {
  let count = 0;
  for (const char of text) {
    if (predicate.test(char)) count += 1;
  }
  return count;
}

function isClearlyMeaningfulToken(token) {
  return (
    URLISH_PATTERN.test(token) ||
    FILE_PATH_PATTERN.test(token) ||
    EMAILISH_PATTERN.test(token) ||
    VERSIONISH_PATTERN.test(token) ||
    DIMENSIONISH_PATTERN.test(token) ||
    SIMPLE_RATIO_OR_UNIT_PATTERN.test(token) ||
    MATHISH_PATTERN.test(token) ||
    BENIGN_PUNCT_ONLY_PATTERN.test(token)
  );
}

function stripEdgeNoise(token) {
  return token
    .replace(/^[~`^|\\*@#$%&]{2,}/u, '')
    .replace(/[~`^|\\*@#$%&]{2,}$/u, '');
}

function shouldDropToken(rawToken) {
  if (!rawToken) return false;
  if (isClearlyMeaningfulToken(rawToken)) return false;

  const lettersOrNumbers = countByChar(rawToken, LETTER_OR_NUMBER_PATTERN);
  const unusual = countByChar(rawToken, UNUSUAL_SYMBOL_PATTERN);
  const visible = [...rawToken].filter((char) => !/^\s$/u.test(char)).length;
  const unusualRatio = visible > 0 ? unusual / visible : 0;

  // Pure or almost-pure symbol noise, e.g. @#$%^ or ^^&&.
  if (lettersOrNumbers === 0 && unusual >= 2) return true;

  // Mixed garbage such as &^%&^s or a$#b$# where unusual symbols dominate.
  if (unusual >= 3 && unusual > lettersOrNumbers) return true;
  if (unusual >= 4 && lettersOrNumbers <= 3) return true;
  if (unusual >= 2 && lettersOrNumbers <= 2 && unusualRatio >= 0.45) return true;

  return false;
}

export function stripSymbolNoise(input) {
  if (!input) return '';

  return input.replace(NONSPACE_TOKEN_PATTERN, (token) => {
    if (isClearlyMeaningfulToken(token)) return token;

    const trimmed = stripEdgeNoise(token);
    if (trimmed !== token) {
      if (!trimmed) return ' ';
      const coreLettersOrNumbers = countByChar(trimmed, LETTER_OR_NUMBER_PATTERN);
      const rawUnusual = countByChar(token, UNUSUAL_SYMBOL_PATTERN);
      if (coreLettersOrNumbers <= 2 && rawUnusual >= 3) return ' ';
      if (shouldDropToken(trimmed) || looksLikeKeyboardSmash(trimmed)) return ' ';
      return trimmed;
    }

    if (shouldDropToken(token) || looksLikeKeyboardSmash(token)) return ' ';
    return token;
  });
}
