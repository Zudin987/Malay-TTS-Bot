import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const settings = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));

for (const [name, profile] of [
  ['Gemini Live', settings.geminiLive.profile]
]) {
  test(`${name} allows gentle expression without relaxing lexical fidelity`, () => {
    assert.match(profile.stylePrompt, /mild natural conversational expression/i);
    assert.match(profile.stylePrompt, /gentle emphasis/i);
    assert.match(profile.stylePrompt, /modest pitch movement/i);
    assert.match(profile.stylePrompt, /never theatrical, exaggerated, sing-song, or overly dramatic/i);
    assert.match(profile.stylePrompt, /must never add words, fillers, interjections, laughter, sighs/i);

    assert.match(profile.systemInstruction, /Preserve every lexical item and its order|lexical content in order/i);
    assert.match(profile.systemInstruction, /without adding|Never add or invent content/i);
    assert.match(profile.systemInstruction, /Expressiveness may change prosody only/i);
    assert.match(profile.systemInstruction, /Never add filler words, interjections, laughter, sighs, sound effects/i);
  });
}
