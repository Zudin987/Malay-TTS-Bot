// Gemini Live is a conversational native-audio model. For text that strongly
// resembles a question or assistant command, strict read-aloud fidelity is more
// important than Live voice quality: bypass Live and let exact TTS / Google read
// the literal text instead of risking an answer or instruction execution.
const ASSISTANT_LIKE_PREFIX = /^(?:(?:what|why|who|where|when|which|how|apa|siapa|bila|mana|kenapa|mengapa|bagaimana|macam\s+mana)\b|(?:tell\s+me|answer|explain|summari[sz]e|translate|say|repeat|ignore\s+(?:(?:all|the)\s+)?(?:previous|prior)|system\s*:|assistant\s*:))/iu;

export function shouldBypassGeminiLiveForReadAloud(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /[?？]/u.test(text) || ASSISTANT_LIKE_PREFIX.test(text);
}

export const __test = { ASSISTANT_LIKE_PREFIX };
