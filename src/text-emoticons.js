// Text emoticons / kaomoji are visual reactions. Speaking their punctuation or
// an "emote name" makes chat TTS noisy, so strip them silently just like the
// bot already does for Discord custom emoji and Unicode emoji.
//
// Keep all matchers compiled at module load. The aggressive fallback below is
// deliberately bounded and linear-time: it never tries to parse arbitrary
// nested text and it never builds regular expressions per message.

// Exported Discord logs (and occasionally pasted chat) can contain custom
// emoji as :name: rather than Discord's live <:name:id> representation.
const COLON_EMOTE_ALIAS_PATTERN = /(?<![\p{L}\p{N}_]):[\p{L}\p{N}_]{2,32}:(?![\p{L}\p{N}_])/gu;

// Common Asian / ASCII reaction faces. Keep this explicit rather than
// deleting every symbol-only token, because things like 1+1=2 or == can carry
// meaning and should not be silently removed.
const COMMON_TEXT_EMOTICON_PATTERN = /(?<![\p{L}\p{N}_])(?:=\.=|=_=|=_{2,}=|-_-|-_{2,}-|\._\.|\.-\.|-\.-|>\.<|<\.<|>_>|<_<|\^_\^|\^\.\^|\^[oOwW3-]\^|[oO0xX]_[oO0xX]|[oOxX]\.[oOxX]|@_@|\?-\?|T_T|T\.T|T-T|Q_Q|Q\.Q|Q-Q|;_;|;-;|ಥ_ಥ|ಠ_ಠ|<3|<\/3)(?![\p{L}\p{N}_])/giu;

// Western smileys such as :) :( ;) :D :P :/ :| :0, crying faces, devil
// faces, and reversed D:. Boundaries prevent pieces of normal words/paths
// from being consumed.
const WESTERN_TEXT_EMOTICON_PATTERN = /(?<![\p{L}\p{N}_])(?:[>O0]?[=:;][\-^'`]?['"]?[)(/\\|DPpOo038vVsScCxX]|8[\-^'`]?['"]?[)]|[:;=][\-^'`]?'[)(DPp]|[DPpOo03][\-^'`]?[:;]|D[:;])(?![\p{L}\p{N}_])/gu;

// Reaction words that Google may try to pronounce as letters/words.
const WORDLIKE_TEXT_EMOTICON_PATTERN = /(?<![\p{L}\p{N}_])(?:[xX]+[dD]+|[uU]+[wW]+[uU]+|[oO]+[wW]+[oO]+)(?![\p{L}\p{N}_])/gu;

// Strongly-identifying kaomoji wrappers / ASCII art families.
const SHRUG_KAOMOJI_PATTERN = /¯\\_\(ツ\)_\/¯/gu;
const TABLE_FLIP_KAOMOJI_PATTERN = /(?:[（(][^()（）\n]{0,64}[)）]|[^\s]{1,24})\s*(?:彡\s*)?[┻┬][━─][┻┬]/gu;
const TABLE_ART_REMAINDER_PATTERN = /[┻┬][━─][┻┬]/gu;
const TIBETAN_WRAPPED_KAOMOJI_PATTERN = /༼[^༼༽\n]{0,80}༽(?:つ|ノ|ﾉ)?/gu;
const BEAR_KAOMOJI_PATTERN = /ʕ[^ʕʔ\n]{0,64}ʔ/gu;
const CAT_KAOMOJI_PATTERN = /ฅ[^ฅ\n]{0,64}ฅ/gu;

// Candidate parenthesized faces. A callback validates each candidate so plain
// prose such as "(test)" and technical text such as "(v2.0)" are untouched.
// Optional arm glyphs cover forms such as ლ(ಠ益ಠლ), ヽ(°〇°)ﾉ and
// (づ｡◕‿‿◕｡)づ.
const BRACKETED_CANDIDATE_PATTERN = /(?:[ლヽノﾉづつง╯╰]?\s*)?[（(][^()（）\n]{1,80}[)）](?:\s*[ლヽノﾉづつง╯╰])?/gu;
const NONSPACE_TOKEN_PATTERN = /\S+/gu;

const HIGH_CONFIDENCE_FACE_GLYPH_PATTERN = /[ಠಥ◕ᴥ༼༽╥﹏≖◡◠▽；｡ﾟ°︿]/u;
const DECORATIVE_FACE_GLYPH_PATTERN = /[ツωДд‿╯づง＾≧≦ノﾉヽ・益つ╭╮¬￣´｀っʕʔฅﻌ๑눈彡]/u;
const ASCII_FACE_SHAPE_PATTERN = /^(?:[=xXoO0TQ@<>^][-_.=~^'`]{1,24}[=xXoO0TQ@<>^]|[oO0][wWvV3][oO0]|\^[oOwW3-]\^|[>^][._-]{1,12}[<^])$/u;
const MATH_OR_TECH_PATTERN = /(?:\d\s*[+*/%=<>-]\s*\d|\b\w+={1,3}\w+\b|^[A-Za-z]:[\\/]|\w+\.\w{1,8}$)/u;
const URLISH_PATTERN = /(?:https?:\/\/|www\.|<[@#:]|:\/\/)/iu;

function countMatchesByChar(text, pattern) {
  let count = 0;
  for (const char of text) {
    if (pattern.test(char)) count += 1;
  }
  return count;
}

function looksLikeKaomoji(candidate, { bracketed = false } = {}) {
  if (!candidate) return false;

  const text = candidate.trim();
  if (text.length < 2 || text.length > 96) return false;
  if (URLISH_PATTERN.test(text) || MATH_OR_TECH_PATTERN.test(text)) return false;

  if (ASCII_FACE_SHAPE_PATTERN.test(text)) return true;

  let lettersOrNumbers = 0;
  let punctuationOrSymbols = 0;
  for (const char of text) {
    if (/^[\p{L}\p{N}]$/u.test(char)) lettersOrNumbers += 1;
    else if (!/^\s$/u.test(char)) punctuationOrSymbols += 1;
  }

  const highConfidence = countMatchesByChar(text, HIGH_CONFIDENCE_FACE_GLYPH_PATTERN);
  const decorative = countMatchesByChar(text, DECORATIVE_FACE_GLYPH_PATTERN);
  const visibleLength = lettersOrNumbers + punctuationOrSymbols;
  const symbolRatio = visibleLength > 0 ? punctuationOrSymbols / visibleLength : 0;

  // Strong eye/face glyph combinations such as ಠ益ಠノ, ಥ﹏ಥ, ◕_◕,
  // ʕ•ᴥ•ʔ and similar forms. Requiring combinations avoids deleting ordinary
  // Japanese text containing a single ツ/ノ/ω character.
  if (highConfidence >= 2) return true;
  if (highConfidence >= 1 && decorative >= 1 && punctuationOrSymbols >= 1) return true;
  if (highConfidence >= 1 && punctuationOrSymbols >= 2 && lettersOrNumbers <= 8) return true;

  if (bracketed) {
    // Parenthesized symbol-heavy faces such as (¬_¬), (°〇°), (・_・;),
    // (￣▽￣), while preserving ordinary parenthetical prose.
    if (decorative >= 2 && symbolRatio >= 0.25 && lettersOrNumbers <= 8) return true;

    const inner = text
      .replace(/^[^（(]{0,3}[（(]/u, '')
      .replace(/[)）][^\s]{0,3}$/u, '');
    if (ASCII_FACE_SHAPE_PATTERN.test(inner)) return true;
  }

  // Aggressive token fallback: only symbol-heavy, short tokens with known
  // kaomoji decoration qualify. Plain punctuation, C++, 50%, 1+1=2, etc. do
  // not contain the required face glyphs and therefore survive.
  if (decorative >= 2 && punctuationOrSymbols >= 1 && symbolRatio >= 0.25 && lettersOrNumbers <= 8) {
    return true;
  }

  return false;
}

function stripBracketedKaomoji(input) {
  return input.replace(BRACKETED_CANDIDATE_PATTERN, (candidate) =>
    looksLikeKaomoji(candidate, { bracketed: true }) ? ' ' : candidate
  );
}

function stripAggressiveKaomojiTokens(input) {
  return input.replace(NONSPACE_TOKEN_PATTERN, (token) =>
    looksLikeKaomoji(token) ? ' ' : token
  );
}

export function stripTextEmoticons(input) {
  if (!input) return '';

  // Strip complete wrappers before their inner face can be consumed by one of
  // the small ASCII patterns (which would otherwise leave empty brackets).
  const wrapperCleaned = stripBracketedKaomoji(
    input
      .replace(COLON_EMOTE_ALIAS_PATTERN, ' ')
      .replace(SHRUG_KAOMOJI_PATTERN, ' ')
      .replace(TABLE_FLIP_KAOMOJI_PATTERN, ' ')
      .replace(TABLE_ART_REMAINDER_PATTERN, ' ')
      .replace(TIBETAN_WRAPPED_KAOMOJI_PATTERN, ' ')
      .replace(BEAR_KAOMOJI_PATTERN, ' ')
      .replace(CAT_KAOMOJI_PATTERN, ' ')
  );

  const explicitlyCleaned = wrapperCleaned
    .replace(COMMON_TEXT_EMOTICON_PATTERN, ' ')
    .replace(WESTERN_TEXT_EMOTICON_PATTERN, ' ')
    .replace(WORDLIKE_TEXT_EMOTICON_PATTERN, ' ');

  return stripAggressiveKaomojiTokens(explicitlyCleaned);
}
