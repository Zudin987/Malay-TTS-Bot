import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';

const speaker = await import('../src/speaker-label.js');
const { dataDir } = await import('../src/config.js');
const cacheDir = path.join(dataDir, 'speaker-label-cache');

test.after(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('speaker-label handle is lazy until playback awaits it', async () => {
  let synthesizeStarted = false;
  const label = `lazy-${Date.now()}-${Math.random()}`;
  const handle = speaker.getSpeakerLabelPcm(label, {
    synthesizeImpl: async () => {
      synthesizeStarted = true;
      return Buffer.alloc(512);
    },
    decodeImpl: async () => Buffer.alloc(4800)
  });

  assert.equal(typeof handle?.then, 'function');
  await nextTick();
  assert.equal(synthesizeStarted, false);
});

test('privacy cancellation aborts active speaker-label provider work', async () => {
  let synthesizeStarted = false;
  let providerAborted = false;
  const label = `privacy-${Date.now()}-${Math.random()}`;

  const handle = speaker.getSpeakerLabelPcm(label, {
    synthesizeImpl: async (_text, options = {}) => {
      synthesizeStarted = true;
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          providerAborted = true;
          reject(signal?.reason || new Error('aborted'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
    decodeImpl: async () => Buffer.alloc(4800)
  });

  const pending = Promise.resolve(handle);
  for (let i = 0; i < 20 && !synthesizeStarted; i += 1) await nextTick();
  assert.equal(synthesizeStarted, true);

  const cancelled = speaker.cancelAllSpeakerLabelGeneration(new Error('privacy test'));
  assert.ok(cancelled >= 1);
  assert.equal(await pending, null);
  assert.equal(providerAborted, true);
});
