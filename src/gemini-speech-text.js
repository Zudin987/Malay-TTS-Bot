// Gemini native audio treats square-bracket text as performance/audio-control
// syntax. The official TTS guide also notes that the set of understood tags is
// intentionally open-ended, so a fixed blacklist cannot provide strict
// read-aloud behavior. Neutralize complete single-line bracket spans for Gemini
// only by changing the control punctuation while preserving the lexical text.
export function neutralizeGeminiAudioTags(value) {
  return String(value ?? '').replace(/\[([^\[\]\r\n]{1,160})\]/gu, (match, inner) => {
    const content = String(inner).trim();
    return content ? `(${content})` : match;
  });
}

export const __test = { neutralizeGeminiAudioTags };
