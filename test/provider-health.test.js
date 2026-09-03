import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';

const tts = await import('../src/tts.js');

test('provider diagnostics redact credentials while preserving useful quota context', () => {
  const fakeKey = 'AIzaSyTHIS_IS_A_FAKE_TEST_KEY_123456789';
  const value = `socket wss://example.test/live?key=${fakeKey} quota exceeded ${fakeKey} Bearer abc.def.ghi`;
  const safe = tts.__test.sanitizeProviderText(value);

  assert.equal(safe.includes(fakeKey), false);
  assert.equal(safe.includes('Bearer abc.def.ghi'), false);
  assert.ok(safe.includes('key=[redacted]'));
  assert.ok(safe.includes('[redacted-api-key]'));
  assert.ok(safe.includes('quota exceeded'));
});

test('provider status stores sanitized provider errors', () => {
  const state = tts.__test.newProviderState();
  const fakeKey = 'AIzaSyTHIS_IS_A_FAKE_TEST_KEY_123456789';
  const error = Object.assign(new Error(`quota exceeded https://example.test?key=${fakeKey}`), { quotaLike: true });

  tts.__test.setProviderFailure(state, error, {}, { key: 'livePrimary' });

  assert.equal(state.lastError.includes(fakeKey), false);
  assert.ok(state.lastError.includes('key=[redacted]'));
  assert.ok(state.lastError.includes('quota exceeded'));
});

