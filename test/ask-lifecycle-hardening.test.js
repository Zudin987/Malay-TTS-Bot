import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.GEMINI_API_KEY ||= 'test-gemini-key';

const tts = await import('../src/tts.js');
const audio = await import('../src/audio.js');
const askResponse = await import('../src/ask-response.js');

function cancelled(message = 'cancelled') {
  const error = new Error(message);
  error.cancelled = true;
  return error;
}

function timeoutAfter(ms, message = 'test timed out') {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

test('half-open probe lease cannot be cleared by a stale older request', () => {
  const state = tts.__test.newProviderState();
  state.consecutiveFailures = 1;
  const first = tts.__test.beginHalfOpenProbeLease('livePrimary', state);
  assert.equal(first.allowed, true);
  assert.ok(first.token > 0);
  assert.equal(tts.__test.releaseHalfOpenProbe('livePrimary', state, first.token), true);

  const second = tts.__test.beginHalfOpenProbeLease('livePrimary', state);
  assert.equal(second.allowed, true);
  assert.notEqual(second.token, first.token);
  assert.equal(tts.__test.releaseHalfOpenProbe('livePrimary', state, first.token), false);
  assert.equal(state.halfOpenProbeInFlight, true);
  assert.equal(state.halfOpenProbeToken, second.token);
  assert.equal(tts.__test.releaseHalfOpenProbe('livePrimary', state, second.token), true);
});

test('slower older /ask cannot replace a newer request that was invoked later', async () => {
  const guildId = `g-${Date.now()}-${Math.random()}`;
  const userId = `u-${Date.now()}-${Math.random()}`;
  const older = askResponse.beginAskTtsRequest(guildId, userId);
  const newer = askResponse.beginAskTtsRequest(guildId, userId);
  assert.equal(askResponse.isLatestAskTtsRequest(guildId, userId, older), false);
  assert.equal(askResponse.isLatestAskTtsRequest(guildId, userId, newer), true);

  let enqueueCalls = 0;
  const staleResult = await askResponse.queueAskAnswerTts(
    { guildId, guild: {}, user: { id: userId } },
    'older answer that finished late',
    { enqueue: () => { enqueueCalls += 1; } },
    { requestSequence: older }
  );
  assert.equal(staleResult, 'superseded');
  assert.equal(enqueueCalls, 0);
});

test('accepted latest /ask carries overflow protection and supersedes only older speech', async () => {
  const guildId = `g2-${Date.now()}-${Math.random()}`;
  const userId = `u2-${Date.now()}-${Math.random()}`;
  const sequence = askResponse.beginAskTtsRequest(guildId, userId);
  let supersedeArgs = null;
  let queuedMetadata = null;
  const voiceChannel = { id: 'voice-1', type: ChannelType.GuildVoice };
  const interaction = {
    id: 'interaction-new', guildId, guild: {}, createdTimestamp: Date.now(),
    user: { id: userId }, member: { voice: { channel: voiceChannel } }
  };
  const result = await askResponse.queueAskAnswerTts(interaction, 'latest answer', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => null,
    getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    connect: async () => ({ connection: {} }),
    enqueue: (_guildId, _text, metadata) => { queuedMetadata = metadata; return 'started'; },
    cancel: () => false,
    cancelQueuedAsk: () => { throw new Error('legacy cancellation should not run'); },
    cancelSupersededAsk: (...args) => { supersedeArgs = args; return { cancelledCurrent: false, cancelledQueued: 0 }; }
  }, { requestSequence: sequence });
  assert.equal(result, 'started');
  assert.deepEqual(supersedeArgs, [guildId, userId, sequence]);
  assert.equal(queuedMetadata.protectFromOverflow, true);
  assert.equal(queuedMetadata.noPrefetch, true);
  assert.equal(queuedMetadata.askSequence, sequence);
});

test('overflow drops normal waiting speech before an accepted protected /ask', () => {
  const protectedAsk = audio.__test.createQueueItem('ask answer', {
    messageId: 'ask:protected', userId: 'u', askSequence: 2, protectFromOverflow: true, noPrefetch: true
  });
  const normal = audio.__test.createQueueItem('normal message', { messageId: 'normal:1', userId: 'other' });
  const state = { queue: [protectedAsk, normal], droppedMessages: 0, lastQueueWarningAt: Date.now() };
  assert.equal(audio.__test.dropForQueueOverflow('guild', state, 2), true);
  assert.deepEqual(state.queue.map((item) => item.messageId), ['ask:protected']);
  assert.equal(normal.cancelled, true);
  assert.equal(protectedAsk.cancelled, false);

  const protectedAsk2 = audio.__test.createQueueItem('ask answer 2', {
    messageId: 'ask:protected2', userId: 'u2', askSequence: 3, protectFromOverflow: true, noPrefetch: true
  });
  state.queue = [protectedAsk, protectedAsk2];
  assert.equal(audio.__test.dropForQueueOverflow('guild', state, 2), false);
  assert.equal(state.queue.length, 2);
});

test('newer /ask cancels older current answer only before first audible speech', () => {
  const current = audio.__test.createQueueItem('old answer', {
    messageId: 'ask:old', userId: 'same-user', askSequence: 1, protectFromOverflow: true
  });
  const oldQueued = audio.__test.createQueueItem('older queued', {
    messageId: 'ask:older-queued', userId: 'same-user', askSequence: 1, protectFromOverflow: true
  });
  const normal = audio.__test.createQueueItem('normal', { messageId: 'normal', userId: 'other' });
  let stopCalls = 0;
  const state = {
    currentItem: current, queue: [oldQueued, normal], running: true, voiceReady: true,
    player: { stop: () => { stopCalls += 1; return true; } }, ffmpeg: null
  };
  const result = audio.__test.cancelSupersededAskItemsForUser(state, 'same-user', 2);
  assert.equal(result.cancelledCurrent, true);
  assert.equal(result.cancelledQueued, 1);
  assert.equal(current.cancelled, true);
  assert.equal(stopCalls, 1);
  assert.deepEqual(state.queue.map((item) => item.messageId), ['normal']);

  const audible = audio.__test.createQueueItem('already speaking', {
    messageId: 'ask:audible', userId: 'same-user', askSequence: 2, protectFromOverflow: true
  });
  audible.firstAudibleAtEpoch = Date.now();
  state.currentItem = audible;
  const afterAudible = audio.__test.cancelSupersededAskItemsForUser(state, 'same-user', 3);
  assert.equal(afterAudible.cancelledCurrent, false);
  assert.equal(audible.cancelled, false);
});

test('STOP can advance the queue even when provider generation promise never settles', async () => {
  const item = audio.__test.createQueueItem('ask waiting for first audio', {
    messageId: 'ask:waiting', userId: 'u', askSequence: 1
  });
  const never = new Promise(() => {});
  const waiting = audio.__test.waitForGenerationOrCancellation(item, never);
  item.cancelled = true;
  item.abortController.abort(cancelled('STOP TTS'));
  await assert.rejects(Promise.race([waiting, timeoutAfter(250)]), /STOP TTS/);
});

test('STOP releases two stuck /ask Gemini slots so next normal 3.1 Live attempt starts immediately', async () => {
  tts.restartTtsRuntime();
  const never = new Promise(() => {});
  const makeGenerated = () => ({ completion: never, cancel: () => {} });
  const a = new AbortController();
  const b = new AbortController();

  const first = await tts.__test.runAttempt({
    key: 'livePrimary', providerName: 'gemini-3.1-live', windowMs: 1000,
    parentSignal: a.signal, attempts: [], factory: async () => makeGenerated()
  });
  const second = await tts.__test.runAttempt({
    key: 'livePrimary', providerName: 'gemini-3.1-live', windowMs: 1000,
    parentSignal: b.signal, attempts: [], factory: async () => makeGenerated()
  });
  assert.ok(first.result && second.result);
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 2);

  a.abort(cancelled('stop-a'));
  b.abort(cancelled('stop-b'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);

  const live = await Promise.race([
    tts.__test.runAttempt({
      key: 'livePrimary', providerName: 'gemini-3.1-live', windowMs: 1000,
      parentSignal: null, attempts: [], factory: async () => ({ completion: Promise.resolve(), cancel: () => {} })
    }),
    timeoutAfter(250, 'next normal 3.1 Live attempt remained blocked after STOP')
  ]);
  assert.ok(live.result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);
});
