import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';
const { __test } = await import('../src/audio.js');

test('queued /ask items form a prefetch barrier', () => {
  const ask = __test.createQueueItem('answer', { messageId: 'ask:one', userId: 'u1', noPrefetch: true });
  const normal = __test.createQueueItem('normal', { messageId: 'msg:two', userId: 'u2' });
  assert.equal(ask.noPrefetch, true);
  assert.equal(__test.hasPrefetchBarrier([ask, normal]), true);
  ask.generation = Promise.resolve({});
  assert.equal(__test.hasPrefetchBarrier([ask, normal]), false);
});

test('a newer /ask cancels only older queued /ask speech from the same user', () => {
  const oldAsk = __test.createQueueItem('old answer', { messageId: 'ask:old', userId: 'u1', noPrefetch: true });
  const normal = __test.createQueueItem('normal chat', { messageId: 'normal:1', userId: 'u1' });
  const otherAsk = __test.createQueueItem('other answer', { messageId: 'ask:other', userId: 'u2', noPrefetch: true });
  const state = { queue: [oldAsk, normal, otherAsk] };
  assert.equal(__test.cancelQueuedAskItemsForUser(state, 'u1'), 1);
  assert.equal(oldAsk.cancelled, true);
  assert.deepEqual(state.queue.map((item) => item.messageId), ['normal:1', 'ask:other']);
});
