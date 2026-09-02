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

  tts.__test.setProviderFailure(state, error, {}, { key: 'liveFallback' });

  assert.equal(state.lastError.includes(fakeKey), false);
  assert.ok(state.lastError.includes('key=[redacted]'));
  assert.ok(state.lastError.includes('quota exceeded'));
});

test('repeated 2.5 Live quota failures get a 30-minute probe backoff without penalizing 3.1', () => {
  const quotaError = Object.assign(new Error('You exceeded your current quota.'), { quotaLike: true });
  const health = tts.__test.healthOptions();

  const fallback = tts.__test.newProviderState();
  tts.__test.setProviderFailure(fallback, quotaError, {}, { key: 'liveFallback' });
  tts.__test.setProviderFailure(fallback, quotaError, {}, { key: 'liveFallback' });
  const beforeFallbackThird = Date.now();
  tts.__test.setProviderFailure(fallback, quotaError, {}, { key: 'liveFallback' });

  const fallbackDelay = fallback.cooldownUntil - beforeFallbackThird;
  assert.ok(fallbackDelay >= 1_799_000 && fallbackDelay <= 1_801_000);
  assert.match(fallback.cooldownReason, /fallback probe in 1800s/u);

  const primary = tts.__test.newProviderState();
  tts.__test.setProviderFailure(primary, quotaError, {}, { key: 'livePrimary' });
  tts.__test.setProviderFailure(primary, quotaError, {}, { key: 'livePrimary' });
  const beforePrimaryThird = Date.now();
  tts.__test.setProviderFailure(primary, quotaError, {}, { key: 'livePrimary' });

  const primaryDelay = primary.cooldownUntil - beforePrimaryThird;
  assert.ok(primaryDelay >= health.quotaThirdSeconds * 1000 - 1000);
  assert.ok(primaryDelay <= health.quotaThirdSeconds * 1000 + 1000);
  assert.equal(primary.cooldownReason, 'quota/rate limit x3');
});

test('/ask exact TTS gets the full configured timeout while normal chat keeps the short fallback window', () => {
  const health = tts.__test.healthOptions();

  assert.equal(health.exactFirstAudioMs, 1600);
  assert.equal(tts.__test.exactFirstAudioWindowCap({}, health), 1600);
  assert.equal(tts.__test.exactFirstAudioWindowCap({ skipLive: true }, health), 4000);
});
