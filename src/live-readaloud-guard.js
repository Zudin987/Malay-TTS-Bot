// Gemini Live is a conversational native-audio model. For text that resembles
// a question or assistant command, strict read-aloud fidelity is more important
// than Live voice quality: bypass Live and let exact TTS / Google read the text.
const QUESTION_WORD_ANYWHERE = /\b(?:what|why|who|where|when|which|how|apa|siapa|bila|mana|kenapa|mengapa|bagaimana|camne|camana|macam\s+mana)\b/iu;
const QUESTION_AUXILIARY = /(?:\b(?:can|could|would|will)\s+(?:you|u)\b|\b(?:do|does|did|is|are|was|were|have|has)\s+(?:you|u|we|i|he|she|they|it|this|that)\b|\bboleh\s+(?:tak|x|ke|kau|ko|awak|you|u)\b)/iu;
const COLLOQUIAL_QUESTION_START = /^(?:(?:bro|weh|wei|woi|oi|eh|ey|yo)[\s,:-]+){0,2}(?:(?:dah|sudah|belum|boleh|ada|takde|xde)\b|(?:kau|ko|awak|you|u)\s+(?:dah|sudah|belum|nak|mau|mahu|boleh|ada)\b)/iu;
const MALAY_QUESTION_PARTICLE = /\b(?:takde|xde|ada|boleh|dah|sudah|belum|nak|mau|mahu|betul|serius|event|current|baru)\b[^\n]{0,60}\bke(?:\s+[\p{L}\p{N}_-]{1,32})?\s*[.!…]*$/iu;
const ASSISTANT_DIRECTIVE_PREFIX = /^(?:(?:bro|weh|wei|woi|oi|eh|ey|yo|pls|please)[\s,:-]+){0,3}(?:tell\s+me|answer|explain|summari[sz]e|translate|say|repeat|tolong\b|cuba\b|ignore\s+(?:(?:all|the)\s+)?(?:previous|prior)|(?:system|assistant|developer)\s*:)/iu;
const ASSISTANT_DIRECTIVE_ANYWHERE = /(?:\btell\s+me\b|\bignore\s+(?:(?:all|the)\s+)?(?:previous|prior)\b|\b(?:do\s+not|don't)\s+(?:read|repeat)\b|\binstead\s+say\b|\b(?:system|assistant|developer)\s*:)/iu;

export function shouldBypassGeminiLiveForReadAloud(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /[?？]/u.test(text)
    || QUESTION_WORD_ANYWHERE.test(text)
    || QUESTION_AUXILIARY.test(text)
    || COLLOQUIAL_QUESTION_START.test(text)
    || MALAY_QUESTION_PARTICLE.test(text)
    || ASSISTANT_DIRECTIVE_PREFIX.test(text)
    || ASSISTANT_DIRECTIVE_ANYWHERE.test(text);
}

export const __test = {
  QUESTION_WORD_ANYWHERE, QUESTION_AUXILIARY, COLLOQUIAL_QUESTION_START,
  MALAY_QUESTION_PARTICLE, ASSISTANT_DIRECTIVE_PREFIX, ASSISTANT_DIRECTIVE_ANYWHERE
};
