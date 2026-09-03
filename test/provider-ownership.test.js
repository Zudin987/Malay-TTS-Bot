import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DISCORD_TOKEN ||= 'test-token';
const tts = await import('../src/tts.js');

test('parent cancellation releases Gemini limiter ownership before remote completion settles', async () => {
  tts.restartTtsRuntime();
  const parent = new AbortController();
  const never = new Promise(() => {});
  const attempts = [];
  const attempt = await tts.__test.runAttempt({
    key: 'livePrimary', providerName: 'fixture-live', windowMs: 1000,
    parentSignal: parent.signal, attempts,
    factory: async () => ({ completion: never }), options: {}, geminiProvider: true
  });
  assert.ok(attempt.result);
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 1);
  const reason = new Error('STOP TTS');
  reason.cancelled = true;
  parent.abort(reason);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);
  tts.restartTtsRuntime();
});
