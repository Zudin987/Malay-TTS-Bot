import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { selectPrefetchCandidates } from '../src/prefetch-plan.js';
import { cancelDeletedMessage, cancelDeletedMessages } from '../src/message-cancellation.js';
process.env.DISCORD_TOKEN ||= 'test-token';
const audio = await import('../src/audio.js');
const tts = await import('../src/tts.js');
const { settings } = await import('../src/config.js');

test('STOP interrupts Buffering and label Playing waits and removes their listeners', async () => {
  for (const timeout of [5000, 10000]) {
    const player = new EventEmitter();
    player.state = { status: 'buffering' };
    const item = audio.__test.createQueueItem('hello');
    const waiting = audio.__test.waitForPlaying({ player }, item, timeout);
    item.abortController.abort(new Error('STOP'));
    await assert.rejects(waiting, /STOP/);
    assert.equal(player.listenerCount('playing'), 0);
    assert.equal(player.listenerCount('error'), 0);
    // The next item's independent wait still succeeds.
    const next = audio.__test.waitForPlaying({ player }, audio.__test.createQueueItem('next'), timeout);
    player.state = { status: 'playing' };
    player.emit('playing');
    await next;
  }
});

test('STOP while Buffering advances the actual queue to the next item', { timeout: 2000 }, async () => {
  const guildId = 'buffering-next';
  const state = audio.__test.getState(guildId);
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  const transition = status => { const old = player.state; player.state = { status }; player.emit('stateChange', old, player.state); player.emit(status); };
  let began;
  const buffering = new Promise(resolve => { began = resolve; });
  let finished;
  const nextFinished = new Promise(resolve => { finished = resolve; });
  let plays = 0;
  player.play = resource => {
    plays++;
    if (plays === 1) { transition('buffering'); began(); }
    else { transition('playing'); setImmediate(() => { resource.playbackDuration = 1000; transition('idle'); }); }
  };
  player.stop = () => { transition('idle'); return true; };
  state.player = player;
  state.voiceReady = true;
  const first = audio.__test.createQueueItem('first', { messageId: 'first' });
  const second = audio.__test.createQueueItem('second', { messageId: 'second', onTerminal: finished });
  for (const item of [first, second]) item.generation = Promise.resolve({ audioBuffer: Buffer.alloc(48000), audioFormat: 's16le', sampleRate: 24000, channels: 1, provider: 'fixture' });
  state.queue = [first, second];
  const pipeline = () => ({ resource: { playbackDuration: 0 }, failure: new Promise(() => {}), stopMonitoring() {}, ffmpegStartedAt: performance.now(), getFirstEncodedAt: () => 0 });
  try {
    const run = audio.__test.runQueue(guildId, state, pipeline);
    await buffering;
    assert.equal(audio.getAudioStatus(guildId).playing, false);
    assert.equal(audio.cancelMessageAudio(guildId, 'first'), true);
    await run;
    await nextFinished;
    assert.equal(plays, 2);
    assert.equal(second.cancelled, false);
    assert.equal(state.running, false);
    assert.equal(player.listenerCount('playing'), 0);
  } finally { audio.releaseAudio(guildId); }
});

test('deletion cancels a current item, its queued recovery and pending metadata by real reply id', async () => {
  const guildId = 'delete-logical';
  const state = audio.__test.getState(guildId);
  const parent = audio.__test.createQueueItem('answer', { messageId: 'ask:command', replyMessageId: 'real-reply', userId: 'user' });
  const recovery = audio.__test.createQueueItem('answer tail', { messageId: parent.messageId, replyMessageId: parent.replyMessageId, logicalJob: parent.logicalJob });
  const other = audio.__test.createQueueItem('other', { messageId: 'other' });
  state.currentItem = parent;
  state.queue = [recovery, other];
  state.pendingCompletions.add(parent);
  assert.equal(cancelDeletedMessage({ id: 'real-reply', guildId }, audio.cancelMessageAudio), true);
  assert.equal(parent.abortController.signal.aborted, true);
  assert.equal(recovery.abortController.signal.aborted, true);
  assert.deepEqual(state.queue, [other]);
  assert.equal(other.abortController.signal.aborted, false);
  audio.releaseAudio(guildId);
});

test('deleting retired speech prevents a late completion from resurrecting recovery', async () => {
  const guildId = 'delete-retired';
  const state = audio.__test.getState(guildId);
  const item = audio.__test.createQueueItem('aku nak pergi ke kedai membeli beras', { messageId: 'retired' });
  let resolve;
  const generated = { audioFormat: 's16le', sampleRate: 24000, channels: 1, completion: new Promise(done => { resolve = done; }), cancel() {} };
  audio.__test.scheduleCompletionGraceCancel(guildId, state, generated, { item, playedMs: 600, playbackSpeed: 1 });
  assert.equal(audio.cancelMessageAudio(guildId, 'retired'), true);
  resolve({ audioBytes: 28800, audioBuffer: Buffer.alloc(28800), transcript: 'aku nak' });
  await new Promise(done => setImmediate(done));
  assert.equal(state.queue.length, 0);
  assert.equal(state.pendingCompletions.size, 0);
  audio.releaseAudio(guildId);
});

test('bulk deletion handles partial messages and preserves unrelated items', () => {
  const cancelled = [];
  assert.equal(cancelDeletedMessages(new Map([['a', { id: 'a' }], ['b', { id: 'b' }]]), (guild, id) => { cancelled.push([guild, id]); return true; }, { guildId: 'guild' }), 2);
  assert.deepEqual(cancelled, [['guild', 'a'], ['guild', 'b']]);
});

test('metadata observers retire after grace even when cancel and completion never settle', async () => {
  const prior = settings.audioPipeline.completionGraceMs;
  settings.audioPipeline.completionGraceMs = 250;
  const guildId = 'metadata-never';
  const state = audio.__test.getState(guildId);
  const item = audio.__test.createQueueItem('hello');
  try {
    audio.__test.scheduleCompletionGraceCancel(guildId, state, { completion: new Promise(() => {}), cancel: () => new Promise(() => {}) }, { item });
    await delay(300);
    assert.equal(state.pendingCompletions.size, 0);
    assert.equal(item.logicalJob.terminal, true);
  } finally { settings.audioPipeline.completionGraceMs = prior; audio.releaseAudio(guildId); }
});

test('a failed late completion terminalizes unavailable when no recovery remains', async () => {
  const guildId = 'failed-late-completion';
  const state = audio.__test.getState(guildId);
  const outcomes = [];
  const item = audio.__test.createQueueItem('hello', { recoveryAttempt: 2, onTerminal: (outcome) => outcomes.push(outcome) });
  audio.__test.scheduleCompletionGraceCancel(guildId, state, { completion: Promise.reject(new Error('provider completion failed')), cancel() {} }, { item, playedMs: 2000, playbackSpeed: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outcomes, ['unavailable']);
  assert.equal(state.pendingCompletions.size, 0);
  audio.releaseAudio(guildId);
});

test('prefetch does not cross a noPrefetch item behind a normal candidate', () => {
  const first = { generation: null };
  const barrier = { generation: null, noPrefetch: true };
  const later = { generation: null };
  assert.deepEqual(selectPrefetchCandidates([first, barrier, later], { ahead: 3 }), [first]);
});

test('promotion moves an existing queued Gemini request ahead of speculative work', async () => {
  const one = await tts.__test.acquireGeminiSlot();
  const two = await tts.__test.acquireGeminiSlot();
  const order = [];
  const promotion = new AbortController();
  const first = tts.__test.acquireGeminiSlot(1).then(release => { order.push('prefetch'); return release; });
  const second = tts.__test.acquireGeminiSlot(1, null, promotion.signal).then(release => { order.push('foreground'); return release; });
  promotion.abort();
  one();
  const foregroundRelease = await second;
  assert.deepEqual(order, ['foreground']);
  foregroundRelease();
  (await first)();
  two();
});

test('valid MP3 frames have a positive duration for playback and recovery guards', () => {
  // MPEG-1 Layer III, 128 kbit/s, 44100 Hz: 417 bytes and 1152 samples/frame.
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame);
  const milliseconds = audio.__test.mp3DurationMs(Buffer.concat(Array.from({ length: 50 }, () => frame)));
  assert.ok(Math.abs(milliseconds - 50 * 1152 / 44100 * 1000) < 1);
});

test('/ask has a bounded post-provider audibility window while normal chat keeps the existing start timeout', () => {
  const prior = settings.audioPipeline.askAudibilityTimeoutMs;
  settings.audioPipeline.askAudibilityTimeoutMs = 1234;
  try {
    const ask = audio.__test.createQueueItem('answer', { messageId: 'ask:bounded' });
    const normal = audio.__test.createQueueItem('chat', { messageId: 'chat:normal' });
    assert.equal(audio.__test.isAskQueueItem(ask), true);
    assert.equal(audio.__test.getPlayerStartTimeoutMs(ask), 1234);
    assert.equal(audio.__test.getPlayerStartTimeoutMs(normal), 10_000);
  } finally { settings.audioPipeline.askAudibilityTimeoutMs = prior; }
});

test('/ask Gemini with zero playback progress cancels stale Live and schedules exactly one Google-only retry', () => {
  const guildId = 'ask-audibility-gemini';
  const state = audio.__test.getState(guildId);
  const item = audio.__test.createQueueItem('Jawapan tepat ini.', {
    messageId: 'ask:gemini-zero', googleText: 'Jawapan tepat ini.', verificationText: 'Jawapan tepat ini.'
  });
  let cancelledWith = null;
  const generated = {
    provider: 'gemini-3.1-live',
    audioFormat: 's16le', sampleRate: 24_000, channels: 1,
    cancel: (reason) => { cancelledWith = reason; }
  };
  try {
    const recovered = audio.__test.handleCompletionRecovery(
      guildId, state, item, generated, 0, 1,
      { triggerError: new Error('player never became audible') }
    );
    assert.equal(recovered, true);
    assert.equal(item.recoveryScheduled, true);
    assert.equal(state.queue.length, 1);
    assert.equal(state.queue[0].text, item.text);
    assert.equal(state.queue[0].googleText, item.googleText);
    assert.equal(state.queue[0].skipLive, true);
    assert.equal(state.queue[0].recoveryAttempt, 1);
    assert.match(String(cancelledWith?.message || ''), /never became audible/i);
  } finally { audio.releaseAudio(guildId); }
});

test('/ask never restarts the full answer after any playback progress', () => {
  const guildId = 'ask-no-duplicate-after-progress';
  const state = audio.__test.getState(guildId);
  const item = audio.__test.createQueueItem('Do not repeat this answer.', { messageId: 'ask:heard' });
  let cancelCalls = 0;
  try {
    const recovered = audio.__test.handleCompletionRecovery(
      guildId, state, item,
      { provider: 'gemini-3.1-live', cancel: () => { cancelCalls += 1; } },
      20, 1,
      { triggerError: new Error('local playback stopped after progress') }
    );
    assert.equal(recovered, false);
    assert.equal(state.queue.length, 0);
    assert.equal(cancelCalls, 0);
  } finally { audio.releaseAudio(guildId); }
});

test('/ask Google audibility failure does not loop and leaves the following normal chat at the front of the queue', () => {
  const guildId = 'ask-google-no-loop';
  const state = audio.__test.getState(guildId);
  const normal = audio.__test.createQueueItem('normal chat', { messageId: 'normal-after-ask' });
  state.queue = [normal];
  const ask = audio.__test.createQueueItem('fallback answer', { messageId: 'ask:google-zero', skipLive: true, recoveryAttempt: 1 });
  try {
    const recovered = audio.__test.handleCompletionRecovery(
      guildId, state, ask, { provider: 'google-ms' }, 0, 1,
      { triggerError: new Error('Google player never became audible') }
    );
    assert.equal(recovered, false);
    assert.deepEqual(state.queue, [normal]);
  } finally { state.queue = []; audio.releaseAudio(guildId); }
});

test('/ask audibility requires real playbackDuration progress, not only Playing state', async () => {
  const item = audio.__test.createQueueItem('audibility check', { messageId: 'ask:progress' });
  const resource = { playbackDuration: 0 };
  const state = { player: { state: { status: 'playing' } } };
  const progress = audio.__test.waitForAudiblePlaybackProgress(state, item, resource, 200);
  setTimeout(() => { resource.playbackDuration = 20; }, 30).unref?.();
  await progress;

  const stalled = audio.__test.createQueueItem('stalled', { messageId: 'ask:stalled' });
  await assert.rejects(
    audio.__test.waitForAudiblePlaybackProgress(state, stalled, { playbackDuration: 0 }, 60),
    /no audible progress/i
  );
});

test('provider failure on /ask cannot leave running=true or block a following normal chat item', { timeout: 2000 }, async () => {
  const guildId = 'ask-provider-failure-next-chat';
  const state = audio.__test.getState(guildId);
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  const transition = status => { const old = player.state; player.state = { status }; player.emit('stateChange', old, player.state); player.emit(status); };
  player.play = resource => {
    transition('playing');
    setImmediate(() => { resource.playbackDuration = 1000; transition('idle'); });
  };
  player.stop = () => { transition('idle'); return true; };
  state.player = player;
  state.voiceReady = true;

  const ask = audio.__test.createQueueItem('failed ask', { messageId: 'ask:all-failed' });
  ask.generation = Promise.reject(new Error('All TTS providers failed before first audio.'));
  let normalFinished;
  const normalDone = new Promise(resolve => { normalFinished = resolve; });
  const normal = audio.__test.createQueueItem('normal chat still works', { messageId: 'normal-next', onTerminal: normalFinished });
  normal.generation = Promise.resolve({ audioBuffer: Buffer.alloc(48_000), audioFormat: 's16le', sampleRate: 24_000, channels: 1, provider: 'fixture' });
  state.queue = [ask, normal];
  const pipeline = () => ({ resource: { playbackDuration: 0 }, failure: new Promise(() => {}), stopMonitoring() {}, ffmpegStartedAt: performance.now(), getFirstEncodedAt: () => 0 });
  try {
    await audio.__test.runQueue(guildId, state, pipeline);
    await normalDone;
    assert.equal(normal.cancelled, false);
    assert.equal(state.currentItem, null);
    assert.equal(state.running, false);
    assert.equal(state.queue.length, 0);
  } finally { audio.releaseAudio(guildId); }
});
