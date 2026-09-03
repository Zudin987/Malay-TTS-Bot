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

test('privacy opt-out during cache lookup prevents a later Google request', async () => {
  let finishRead;
  let remoteCalls = 0;
  const pending = speaker.__test.getSpeakerLabelPcmNow(`lookup-${Date.now()}`, {
    readFileImpl: () => new Promise(resolve => { finishRead = resolve; }),
    synthesizeImpl: async () => { remoteCalls++; return Buffer.alloc(512); },
    decodeImpl: async () => Buffer.alloc(4800)
  });
  assert.ok(speaker.getSpeakerLabelStatus().inflight > 0);
  speaker.cancelAllSpeakerLabelGeneration(new Error('opt-out during read'));
  finishRead(null);
  assert.equal(await pending, null);
  assert.equal(remoteCalls, 0);
  assert.equal(speaker.getSpeakerLabelStatus().inflight, 0);
});

test('cancellation during cache directory creation cannot start remote synthesis', async () => {
  let mkdirStarted;
  const started = new Promise(resolve => { mkdirStarted = resolve; });
  let finishMkdir;
  let remoteCalls = 0;
  const label = `mkdir-${Date.now()}`;
  const pending = speaker.__test.getSpeakerLabelPcmNow(label, {
    readFileImpl: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    mkdirImpl: () => { mkdirStarted(); return new Promise(resolve => { finishMkdir = resolve; }); },
    synthesizeImpl: async () => { remoteCalls++; return Buffer.alloc(512); }
  });
  await started;
  speaker.cancelAllSpeakerLabelGeneration(new Error('opt-out during mkdir'));
  finishMkdir();
  assert.equal(await pending, null);
  assert.equal(remoteCalls, 0);
  await assert.rejects(fs.access(path.join(cacheDir, `${speaker.speakerLabelCacheKey(label)}.pcm`)));
});

test('lazy handles created before privacy cancellation cannot start afterwards', async () => {
  let remoteCalls = 0;
  const handle = speaker.getSpeakerLabelPcm(`old-lazy-${Date.now()}`, { synthesizeImpl: async () => { remoteCalls++; } });
  speaker.cancelAllSpeakerLabelGeneration();
  assert.equal(await handle, null);
  assert.equal(remoteCalls, 0);
});

test('one cancelled label consumer does not abort another active consumer', async () => {
  const label = `shared-${Date.now()}`;
  const first = new AbortController();
  let finishRead;
  const options = { readFileImpl: () => new Promise(resolve => { finishRead = resolve; }) };
  const one = speaker.__test.getSpeakerLabelPcmNow(label, { ...options, signal: first.signal });
  const two = speaker.__test.getSpeakerLabelPcmNow(label, options);
  first.abort(new Error('one stopped'));
  assert.equal(await one, null);
  finishRead(Buffer.alloc(4800));
  assert.equal((await two).length, 4800);
});
