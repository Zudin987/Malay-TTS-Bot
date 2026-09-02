import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';

const tts = await import('../src/tts.js');
const audio = await import('../src/audio.js');

test('runaway Live completion is counted but does not cool down provider health', () => {
  const state = tts.__test.newProviderState();
  const error = Object.assign(new Error('Gemini Live runaway-audio guard stopped output.'), { runawayLike: true });
  tts.__test.recordRunawayMidstreamFailure(state, error, 'livePrimary');
  assert.equal(state.runawayIncidentCount, 1);
  assert.equal(state.failureCount, 1);
  assert.equal(state.midstreamFailureCount, 1);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.cooldownUntil, 0);
  assert.equal(state.cooldownReason, null);
  assert.equal(state.lastFailureKind, 'runaway/model-behavior');
});

test('runaway Live output never schedules cutoff recovery', () => {
  const item = audio.__test.createQueueItem('hello world', { verificationText: 'hello world' });
  item.runSerial = 1;
  item.recoveryEpoch = 0;
  const state = { disposed: false, recoveryEpoch: 0, runSerial: 1, suppressedCutoffReplays: 0, runawayRecoveriesSuppressed: 0 };
  const error = Object.assign(new Error('runaway'), { runawayLike: true });
  const recovered = audio.__test.handleCompletionRecovery(
    'test-guild', state, item,
    { audioFormat: 's16le', sampleRate: 24_000, channels: 1 },
    1200, 1, { error, triggerError: error }
  );
  assert.equal(recovered, false);
  assert.equal(item.recoveryScheduled, false);
  assert.equal(state.runawayRecoveriesSuppressed, 1);
  assert.equal(state.suppressedCutoffReplays, 1);
});

test('prefetch limiter waiting does not consume provider first-audio window', async () => {
  tts.restartTtsRuntime();
  const release1 = await tts.__test.acquireGeminiSlot(0, null);
  const release2 = await tts.__test.acquireGeminiSlot(0, null);
  let creditedWaitMs = 0;
  const attempts = [];
  try {
    const pending = tts.__test.runAttempt({
      key: 'livePrimary', providerName: 'test-live', windowMs: 300,
      parentSignal: null, attempts,
      factory: async () => ({ completion: Promise.resolve({}) }),
      options: {}, geminiProvider: true, priority: 1,
      deferBudgetUntilGeminiSlot: true,
      onLimiterWait: (ms) => { creditedWaitMs += ms; }
    });
    const timer = setTimeout(() => release1(), 360);
    const result = await pending;
    clearTimeout(timer);
    assert.ok(result.result);
    assert.ok(creditedWaitMs >= 300, `expected limiter wait >=300ms, got ${creditedWaitMs}`);
    assert.equal(attempts.at(-1)?.outcome, 'first-audio');
  } finally {
    release1();
    release2();
  }
});
