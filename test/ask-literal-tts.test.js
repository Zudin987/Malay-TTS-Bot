import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAskTtsItem } from '../src/ask-response.js';

test('/ask TTS skips conversational Gemini Live and preserves the displayed answer', () => {
  const interaction = {
    id: 'interaction-literal',
    createdTimestamp: 1234,
    user: { id: 'user-1' }
  };
  const voiceChannel = { id: 'voice-1' };
  const answer = 'Jabber, kalau kita ni macam buku, awak ni bab paling best yang saya tak nak habis baca. Nak tak kita tulis bab seterusnya sama-sama?';

  const item = buildAskTtsItem(interaction, answer, voiceChannel, 'Charon');

  assert.equal(item.text, answer);
  assert.equal(item.metadata.googleText, answer);
  assert.equal(item.metadata.verificationText, answer);
  assert.equal(item.metadata.skipLive, true);
  assert.equal(item.metadata.messageId, 'ask:interaction-literal');
});
