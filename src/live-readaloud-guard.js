// Runtime policy: every normal Discord message gets Gemini Live first.
//
// `src/tts.js` still honors an explicit context.skipLive flag for internal
// recovery/fallback work, where replaying a recovered tail through Live could
// create another conversational or duplicate response. User-authored text itself
// is never classified by wording, punctuation, question form, or Malay particles.
// Fidelity is enforced by the strict read-aloud prompt instead of provider routing.
export function shouldBypassGeminiLiveForReadAloud(_value) {
  return false;
}
