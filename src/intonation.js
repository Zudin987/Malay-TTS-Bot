const START_LAUGHTER_PATTERN = /^((?:(?:ha|he|hi){2,})|(?:w?k){3,})\s+/iu;
const END_LAUGHTER_PATTERN = /(?<![.!?…,:;])\s+((?:(?:ha|he|hi){2,})|(?:w?k){3,})$/iu;
const CONTRAST_CONNECTOR_PATTERN = /(?<![,.;!?…])\s+(tapi|tetapi)\s+/giu;
const LEADING_CONNECTOR_PATTERN = /^(jadi|so|pastu|lepas tu|kemudian|then)\s+(?![,.;!?])/iu;
const QUESTION_START_PATTERN = /^(?:apa|kenapa|mengapa|siapa|bila|mana|berapa|macam mana)\b/iu;
const QUESTION_END_PATTERN = /\b(?:ke|kah)\s*$/iu;
const TERMINAL_PUNCTUATION = /[.!?…]["')\]]*$/u;

function capitalizeSentences(text) {
  return text.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_, prefix, letter) => {
    return prefix + letter.toLocaleUpperCase('ms-MY');
  });
}

/**
 * Adds only light punctuation cues for Google TTS.
 * It deliberately does not translate, paraphrase, infer emotion, or change meaning.
 */
export function addIntonationCues(input) {
  let text = input.trim();
  if (!text) return '';

  // Preserve the actual laughter text; only add a natural pause around it.
  text = text.replace(START_LAUGHTER_PATTERN, '$1, ');
  text = text.replace(END_LAUGHTER_PATTERN, ', $1');

  // A small pause before common contrast/reason connectors is usually natural in Malay chat.
  text = text.replace(CONTRAST_CONNECTOR_PATTERN, ', $1 ');

  // Discourse starters benefit from a short pause after them.
  text = text.replace(LEADING_CONNECTOR_PATTERN, '$1, ');

  text = text
    .replace(/\s+([,.;!?])/gu, '$1')
    .replace(/,{2,}/gu, ',')
    .replace(/,([.!?])/gu, '$1')
    .replace(/\.{4,}/gu, '...')
    .replace(/\s+/gu, ' ')
    .trim();

  text = capitalizeSentences(text);
  text = text.replace(/,\s*$/u, '');

  if (text && !TERMINAL_PUNCTUATION.test(text)) {
    const soundsLikeQuestion = QUESTION_START_PATTERN.test(text) || QUESTION_END_PATTERN.test(text);
    text += soundsLikeQuestion ? '?' : '.';
  }

  return text;
}
