import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const settings = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));
const configSource = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

test('Gemini Live midstream idle timeout is 3500ms without changing exact TTS timeout', () => {
  assert.equal(settings.geminiLive.streamIdleTimeoutMs, 3500);
  assert.equal(settings.geminiTts.streamIdleTimeoutMs, 2500);
  assert.match(configSource, /geminiLive:[\s\S]*?streamIdleTimeoutMs: 3500,/);
  assert.match(configSource, /geminiTts:[\s\S]*?streamIdleTimeoutMs: 2500,/);
});
