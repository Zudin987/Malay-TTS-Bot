import test from 'node:test';
import assert from 'node:assert/strict';

import { GEMINI_VOICE_OPTIONS, GEMINI_VOICES } from '../src/providers/gemini.js';

const expected = [
  { name: 'Charon', gender: 'Male', style: 'Informative' },
  { name: 'Orus', gender: 'Male', style: 'Firm' },
  { name: 'Schedar', gender: 'Male', style: 'Even' },
  { name: 'Gacrux', gender: 'Female', style: 'Mature' },
  { name: 'Vindemiatrix', gender: 'Female', style: 'Gentle' },
  { name: 'Despina', gender: 'Female', style: 'Smooth' }
];

test('Gemini voice pool is the approved six voices in order', () => {
  assert.deepEqual(GEMINI_VOICES, expected.map((voice) => voice.name));
  assert.deepEqual(GEMINI_VOICE_OPTIONS.map((voice) => ({ ...voice })), expected);
  assert.equal(new Set(GEMINI_VOICES).size, 6);
});
