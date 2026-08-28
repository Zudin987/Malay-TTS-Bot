// Google Malay TTS can spell fully-capitalized ordinary words letter-by-letter.
// Normalize only strong "shouting" word shapes after exact acronyms and the
// acronym and dictionary layers have already had a chance to expand real initials.
//
// Examples:
//   HELLO -> hello
//   FITNAH -> fitnah
//   MIDI -> midi
//   DON'T -> don't
// while consonant-heavy unknown initials such as PDF / CRT / VO stay intact.

// Include apostrophe contractions as one token. Without this, DON'T could be
// partially normalized into the ugly "don'T" form.
const ALL_CAPS_WORD_PATTERN = /(?<![\p{L}\p{N}_])(?:\p{Lu}+(?:['’]\p{Lu}+)+|\p{Lu}{2,})(?![\p{L}\p{N}_])/gu;
const WORDLIKE_VOWEL_PATTERN = /[AEIOUY]/u;
const LETTER_PATTERN = /\p{Lu}/gu;

// Two-letter words need an allow-list because many genuine initials are also
// two letters (PC, HR, VO, KL...). Exact acronyms are expanded before this pass.
const COMMON_TWO_LETTER_WORDS = new Set([
  'AH', 'AM', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'EH', 'GO', 'HE', 'HI',
  'IF', 'IN', 'IS', 'IT', 'JE', 'KE', 'ME', 'MY', 'NI', 'NO', 'OF', 'OH',
  'OI', 'ON', 'OR', 'SO', 'TO', 'TU', 'UP', 'US', 'WE', 'YA'
]);

const COMMON_CONSONANT_INTERJECTIONS = new Set(['HMM', 'HM', 'SHH']);

export function normalizeShoutingCase(input) {
  if (!input) return '';

  return input.replace(ALL_CAPS_WORD_PATTERN, (word) => {
    const letters = word.match(LETTER_PATTERN) ?? [];
    const letterCount = letters.length;

    // Uppercase contractions are overwhelmingly words, not initialisms.
    if (/['’]/u.test(word)) return word.toLocaleLowerCase('en-US');

    if (letterCount === 2) {
      return COMMON_TWO_LETTER_WORDS.has(word) ? word.toLocaleLowerCase('en-US') : word;
    }

    if (COMMON_CONSONANT_INTERJECTIONS.has(word)) {
      return word.toLocaleLowerCase('en-US');
    }

    // Most real words have at least one vowel (Y included for WHY/TRY/etc.).
    // Genuine initialisms with vowels should live in acronyms.json, where they
    // are expanded before this function runs.
    if (WORDLIKE_VOWEL_PATTERN.test(word)) {
      return word.toLocaleLowerCase('en-US');
    }

    return word;
  });
}
