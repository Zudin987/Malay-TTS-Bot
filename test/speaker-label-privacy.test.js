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

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
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
  assert.equal(await waitUntil(() => synthesizeStarted), true);

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

test('one owner opting out does not cancel another owner label job', async () => {
  const ownerA = { guildId: 'privacy-guild-a', userId: 'privacy-user-a' };
  const ownerB = { guildId: 'privacy-guild-b', userId: 'privacy-user-b' };
  let startedA = false;
  let startedB = false;
  let abortedA = false;
  let finishB;
  const label = `shared-owner-label-${Date.now()}`;
  const missing = async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const one = speaker.__test.getSpeakerLabelPcmNow(label, {
    owner: ownerA, readFileImpl: missing,
    synthesizeImpl: async (_text, { signal }) => {
      startedA = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { abortedA = true; reject(signal.reason); }, { once: true });
      });
    },
    decodeImpl: async () => Buffer.alloc(4800)
  });
  const two = speaker.__test.getSpeakerLabelPcmNow(label, {
    owner: ownerB, readFileImpl: missing,
    synthesizeImpl: async () => {
      startedB = true;
      return new Promise((resolve) => { finishB = resolve; });
    },
    decodeImpl: async () => Buffer.alloc(4800)
  });
  assert.equal(await waitUntil(() => startedA && startedB), true);

  assert.ok(speaker.cancelSpeakerLabelGenerationForOwner(ownerA.guildId, ownerA.userId) >= 1);
  assert.equal(await one, null);
  assert.equal(abortedA, true);
  finishB(Buffer.alloc(512));
  assert.equal((await two).length, 4800);
});

test('owner opt-out invalidates only that owners not-yet-started lazy label', async () => {
  let ownerCalls = 0;
  let otherCalls = 0;
  const owner = { guildId: 'lazy-guild', userId: 'lazy-owner' };
  const other = { guildId: 'lazy-guild', userId: 'lazy-other' };
  const missing = async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const blocked = speaker.getSpeakerLabelPcm(`lazy-owner-${Date.now()}`, {
    owner, readFileImpl: missing,
    synthesizeImpl: async () => { ownerCalls += 1; return Buffer.alloc(512); },
    decodeImpl: async () => Buffer.alloc(4800)
  });
  const allowed = speaker.getSpeakerLabelPcm(`lazy-other-${Date.now()}`, {
    owner: other, readFileImpl: missing,
    synthesizeImpl: async () => { otherCalls += 1; return Buffer.alloc(512); },
    decodeImpl: async () => Buffer.alloc(4800)
  });
  speaker.cancelSpeakerLabelGenerationForOwner(owner.guildId, owner.userId);
  assert.equal(await blocked, null);
  assert.equal(ownerCalls, 0);
  assert.equal((await allowed).length, 4800);
  assert.equal(otherCalls, 1);
});

test('owner opt-out during cache installation cannot publish a new entry', async () => {
  const owner = { guildId: 'install-guild', userId: 'install-owner' };
  let writeStarted = false;
  let finishWrite;
  let renameCalls = 0;
  const pending = speaker.__test.getSpeakerLabelPcmNow(`install-${Date.now()}`, {
    owner,
    readFileImpl: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    mkdirImpl: async () => {},
    synthesizeImpl: async () => Buffer.alloc(512),
    decodeImpl: async () => Buffer.alloc(4800),
    writeFileImpl: () => {
      writeStarted = true;
      return new Promise((resolve) => { finishWrite = resolve; });
    },
    renameImpl: async () => { renameCalls += 1; },
    rmImpl: async () => {}
  });
  assert.equal(await waitUntil(() => writeStarted), true);
  speaker.cancelSpeakerLabelGenerationForOwner(owner.guildId, owner.userId);
  finishWrite();
  assert.equal(await pending, null);
  await nextTick();
  assert.equal(renameCalls, 0);
});

test('per-user cache purge preserves another users identical spoken label', async () => {
  const label = `same-label-${Date.now()}`;
  const ownerA = { guildId: 'cache-guild', userId: 'cache-user-a' };
  const ownerB = { guildId: 'cache-guild', userId: 'cache-user-b' };
  const missing = async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const generate = async (owner) => speaker.__test.getSpeakerLabelPcmNow(label, {
    owner, readFileImpl: missing,
    synthesizeImpl: async () => Buffer.alloc(512),
    decodeImpl: async () => Buffer.alloc(4800)
  });
  assert.equal((await generate(ownerA)).length, 4800);
  assert.equal((await generate(ownerB)).length, 4800);
  const pathA = path.join(cacheDir, `${speaker.speakerLabelCacheKey(label, ownerA)}.pcm`);
  const pathB = path.join(cacheDir, `${speaker.speakerLabelCacheKey(label, ownerB)}.pcm`);
  await fs.access(pathA);
  await fs.access(pathB);

  assert.ok(await speaker.purgeSpeakerLabelCacheForOwner(ownerA.guildId, ownerA.userId) >= 1);
  await assert.rejects(fs.access(pathA));
  await fs.access(pathB);
  assert.equal((await speaker.__test.getSpeakerLabelPcmNow(label, { owner: ownerB })).length, 4800);
});

test('startup legacy purge removes only pre-owner cache filenames', async () => {
  await fs.mkdir(cacheDir, { recursive: true });
  const label = `legacy-${Date.now()}`;
  const legacy = path.join(cacheDir, `${speaker.speakerLabelCacheKey(label)}.pcm`);
  const owned = path.join(cacheDir, `${speaker.speakerLabelCacheKey(label, { guildId: 'legacy-guild', userId: 'legacy-user' })}.pcm`);
  await fs.writeFile(legacy, Buffer.alloc(4800));
  await fs.writeFile(owned, Buffer.alloc(4800));
  assert.ok(await speaker.purgeLegacySpeakerLabelCache() >= 1);
  await assert.rejects(fs.access(legacy));
  await fs.access(owned);
});
