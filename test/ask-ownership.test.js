import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { askGemini, getAskOptions, getAskRuntimeStatus } from '../src/ask.js';
import {
  beginAskTtsRequest, isLatestAskTtsRequest, finishAskTtsRequest, queueAskAnswerTts,
  handleAskStopButton, buildAskStopButtonId
} from '../src/ask-response.js';

const options = { ...getAskOptions(), timeoutMs: 30 };
const keyEntry = { slot: 1, key: 'fake-key' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function keepAlive(t) { const timer = setTimeout(() => {}, 2000); t.after(() => clearTimeout(timer)); }

test('/ask deadline covers a stuck response body and releases admission', async (t) => {
  keepAlive(t);
  let cancelled = false;
  await assert.rejects(askGemini('Question?', {
    options, keyEntry,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))
  }), { code: 'timeout' });
  assert.equal(getAskRuntimeStatus().active, 0);
  assert.equal(cancelled, true);
  const result = await askGemini('Next?', {
    options, keyEntry, fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: 'Next answer.' }] } }] })
  });
  assert.equal(result.answer, 'Next answer.');
});

test('/ask also bounds a provider that ignores cancellation before headers', async (t) => {
  keepAlive(t);
  await assert.rejects(askGemini('Question?', { options, keyEntry, fetchImpl: () => new Promise(() => {}) }), { code: 'timeout' });
  assert.equal(getAskRuntimeStatus().active, 0);
});

test('a busy third request cannot supersede or cancel an accepted /ask', async () => {
  const controllers = [new AbortController(), new AbortController()];
  let sequence;
  const first = askGemini('First?', {
    options: { ...options, timeoutMs: 1000 }, keyEntry, signal: controllers[0].signal,
    onAccepted() { sequence = beginAskTtsRequest('busy-g', 'busy-u', { controller: controllers[0] }); },
    fetchImpl: () => new Promise(() => {})
  });
  first.catch(() => {});
  const second = askGemini('Second?', {
    options: { ...options, timeoutMs: 1000 }, keyEntry, signal: controllers[1].signal,
    fetchImpl: () => new Promise(() => {})
  });
  second.catch(() => {});
  await assert.rejects(askGemini('Third?', {
    options, keyEntry,
    onAccepted() { beginAskTtsRequest('busy-g', 'busy-u'); assert.fail('Busy work must not be admitted'); },
    fetchImpl: () => assert.fail('Busy work must not fetch')
  }), { code: 'busy' });
  assert.equal(isLatestAskTtsRequest('busy-g', 'busy-u', sequence), true);
  assert.equal(controllers[0].signal.aborted, false);
  controllers.forEach((controller) => controller.abort());
  await Promise.allSettled([first, second]);
  finishAskTtsRequest('busy-g', 'busy-u', sequence);
  assert.equal(getAskRuntimeStatus().active, 0);
});

test('accepting a newer request aborts older text work and retires only its own sequence', () => {
  const old = new AbortController();
  const first = beginAskTtsRequest('accept-g', 'accept-u', { controller: old });
  const second = beginAskTtsRequest('accept-g', 'accept-u');
  assert.equal(old.signal.aborted, true);
  finishAskTtsRequest('accept-g', 'accept-u', first);
  assert.equal(isLatestAskTtsRequest('accept-g', 'accept-u', second), true);
  finishAskTtsRequest('accept-g', 'accept-u', second);
  assert.equal(isLatestAskTtsRequest('accept-g', 'accept-u', second), false);
});

function fixture(id, editReply) {
  const interaction = {
    id, guildId: 'ui-guild', guild: {}, user: { id: 'ui-user' }, editReply,
    member: { voice: { channel: { id: 'v', type: ChannelType.GuildVoice } } }
  };
  let metadata;
  return {
    interaction, get metadata() { return metadata; },
    deps: {
      isOptedOut: () => false, getRuntimeVoiceChannelId: () => 'v',
      getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }), getVoice: () => 'Charon',
      enqueue: (_g, _text, value) => { metadata = value; return 'queued'; },
      connect: async () => ({ connection: {} }), cancel: () => true
    }
  };
}

test('a delayed ready edit cannot overwrite STOP and the item owns the real reply ID', async () => {
  const writes = [];
  let release;
  const f = fixture('stop-race', async (payload) => {
    const button = payload.components[0].toJSON().components[0];
    if (!button.disabled) await new Promise((resolve) => { release = resolve; });
    writes.push(button);
  });
  await queueAskAnswerTts(f.interaction, 'Answer.', f.deps, { replyMessageId: 'discord-message-7' });
  await tick();
  assert.equal(f.metadata.replyMessageId, 'discord-message-7');
  const stopping = handleAskStopButton({
    guildId: 'ui-guild', user: { id: 'ui-user' }, customId: buildAskStopButtonId('stop-race', 'ui-user'),
    deferUpdate: async () => {}, editReply: async () => assert.fail('Use the answer-owned serialized writer')
  }, () => { f.metadata.onTerminal('stopped'); return true; });
  release();
  await stopping;
  await tick();
  assert.equal(writes.at(-1).label, 'TTS stopped');
  assert.equal(writes.at(-1).disabled, true);
});

test('queue rejection and natural completion publish terminal controls and retire sequence state', async () => {
  const writes = [];
  const f = fixture('queue-rejected', async (p) => writes.push(p.components[0].toJSON().components[0]));
  f.deps.getAudioStatus = () => ({ queued: 10, maximumQueued: 10 });
  let sequence = beginAskTtsRequest('ui-guild', 'ui-user');
  assert.equal(await queueAskAnswerTts(f.interaction, 'Answer.', f.deps, { requestSequence: sequence }), 'queue-full');
  await tick();
  assert.equal(writes.at(-1).label, 'TTS unavailable: queue full');
  assert.equal(writes.at(-1).disabled, true);
  assert.equal(isLatestAskTtsRequest('ui-guild', 'ui-user', sequence), false);
  const next = fixture('natural-finish', async (p) => writes.push(p.components[0].toJSON().components[0]));
  sequence = beginAskTtsRequest('ui-guild', 'ui-user');
  await queueAskAnswerTts(next.interaction, 'Answer.', next.deps, { requestSequence: sequence });
  next.metadata.onTerminal('finished');
  await tick();
  assert.equal(writes.at(-1).label, 'TTS finished');
  assert.equal(isLatestAskTtsRequest('ui-guild', 'ui-user', sequence), false);
});
