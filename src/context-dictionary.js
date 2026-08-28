import { replaceMalayDictionaryWords, replaceTrailingMalayParticles } from './malay-dictionary.js';
import { replaceGameDictionaryWords } from './game-dictionary.js';

// This is only a safety gate for ambiguous Malay chat shorthand. It is NOT a
// TTS language router: Gemini receives the final mixed-language sentence as one voice.
const MALAY_CONTEXT_PATTERN = /\b(?:aku|kau|korang|kita|kami|dia|diorang|saya|awak|tak|tidak|nak|mahu|dah|sudah|belum|boleh|jangan|kenapa|sebab|kalau|tapi|jadi|nanti|dulu|lepas|masuk|keluar|pergi|balik|tunggu|tengok|cuba|pakai|punya|orang|macam|sangat|lagi|saja|dekat|kat|dengan|untuk|yang|ini|itu|ada|apa|siapa|bagi|buat|makan|tidur|pukul|malam|pagi|petang|sekejap|semua|memang|betul|rasa|faham|tahu|dapat|kena|suruh|tolong|cepat|lambat|senang|susah|bagus|cantik|sedap|lah|weh|kot)\b/iu;
const LEADING_TP_MIXED_PATTERN = /^\s*tp\b(?=\s+(?:i|you|we|they|he|she|it|my|your)\b)/u;

export function hasMalayChatContext(input) {
  const text = String(input ?? '');
  MALAY_CONTEXT_PATTERN.lastIndex = 0;
  return MALAY_CONTEXT_PATTERN.test(text) || LEADING_TP_MIXED_PATTERN.test(text);
}

export function applyContextDictionaries(input) {
  let text = String(input ?? '').trim();
  if (!text) return '';

  const malayContext = hasMalayChatContext(text);
  if (malayContext) text = replaceMalayDictionaryWords(text);
  text = replaceGameDictionaryWords(text, { allowMalayContext: malayContext });
  if (malayContext) text = replaceTrailingMalayParticles(text);
  return text;
}
