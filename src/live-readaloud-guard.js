// Fidelity policy: normal Discord chat is user-authored text that must be read
// literally. Gemini Live is a conversational model and can occasionally treat a
// question, comparison, or instruction-like sentence as something to answer.
//
// Do not classify by wording or punctuation: a phrase such as
// "windows ke linux bagus" is still conversational even without a question mark.
// Dedicated Gemini TTS is the safe primary read-aloud provider; Google Malay TTS
// remains the deterministic fallback. Gemini Live stays available in the codebase
// for non-read-aloud uses, but normal user text must not be routed through it.
export function shouldBypassGeminiLiveForReadAloud(_value) {
  return true;
}
