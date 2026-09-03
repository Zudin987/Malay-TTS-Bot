export const GEMINI_VOICE_OPTIONS = Object.freeze([
  Object.freeze({ name: 'Charon', gender: 'Male', style: 'Informative' }),
  Object.freeze({ name: 'Orus', gender: 'Male', style: 'Firm' }),
  Object.freeze({ name: 'Schedar', gender: 'Male', style: 'Even' }),
  Object.freeze({ name: 'Gacrux', gender: 'Female', style: 'Mature' }),
  Object.freeze({ name: 'Vindemiatrix', gender: 'Female', style: 'Gentle' }),
  Object.freeze({ name: 'Despina', gender: 'Female', style: 'Smooth' })
]);
export const GEMINI_VOICES = Object.freeze(GEMINI_VOICE_OPTIONS.map((voice) => voice.name));

