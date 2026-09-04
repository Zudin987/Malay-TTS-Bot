import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test-token';
for (let slot = 1; slot <= 10; slot += 1) {
  process.env[slot === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${slot}`] = `ask-routing-key-${slot}`;
}

const tts = await import('../src/tts.js');
const {
  beginAskTtsRequest,
  buildAskTtsItem,
  finishAskTtsRequest,
  queueAskAnswerTts
} = await import('../src/ask-response.js');

function askItem(answer, id = 'ask-provider') {
  return buildAskTtsItem(
    { id, createdTimestamp: 1234, user: { id: 'ask-user' } },
    answer,
    { id: 'voice-1' },
    'Charon'
  );
}

function providerFixture({ failLive = false } = {}) {
  const originalSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const calls = [];

  class Socket {
    constructor(url) {
      this.readyState = 1;
      calls.push({ provider: 'live', key: new URL(url).searchParams.get('key') });
      queueMicrotask(() => this.onopen?.());
    }

    send(raw) {
      const message = JSON.parse(raw);
      if (message.setup) {
        calls.push({ setup: message.setup });
        queueMicrotask(() => this.onmessage?.({
          data: JSON.stringify(failLive
            ? { error: { code: 503, message: 'fixture unavailable' } }
            : { setupComplete: {} })
        }));
        return;
      }
      if (message.realtimeInput?.text) {
        calls.push({ provider: 'live-text', text: message.realtimeInput.text });
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ serverContent: {
          modelTurn: { parts: [{ inlineData: {
            data: Buffer.alloc(1200).toString('base64'),
            mimeType: 'audio/pcm;rate=24000'
          } }] },
          generationComplete: true,
          turnComplete: true
        } }) }));
      }
    }

    close() { this.readyState = 3; }
  }

  globalThis.WebSocket = Socket;
  globalThis.fetch = async (url) => {
    calls.push({ provider: 'google', text: new URL(url).searchParams.get('q') });
    return new Response(Buffer.alloc(250), { headers: { 'content-type': 'audio/mpeg' } });
  };

  return {
    calls,
    restore() {
      globalThis.WebSocket = originalSocket;
      globalThis.fetch = originalFetch;
      tts.restartTtsRuntime();
    }
  };
}

async function consume(generated) {
  if (generated.audioStream) {
    for await (const _ of generated.audioStream) { /* drain provider stream */ }
  }
  await generated.completion;
}

function speechContext(item) {
  return {
    guildId: 'ask-guild',
    userId: item.metadata.userId,
    voice: item.metadata.voice,
    googleText: item.metadata.googleText,
    skipLive: item.metadata.skipLive
  };
}

test('/ask exact displayed answer routes to Gemini 3.1 Live first and records provider metrics', async () => {
  tts.restartTtsRuntime();
  const fixture = providerFixture();
  const answer = 'Ini jawapan final. Jangan tambah atau ubah perkataan ini.';
  const item = askItem(answer, 'ask-primary');
  const before = tts.getTtsProviderStatus();
  try {
    const generated = await tts.synthesize(item.text, speechContext(item));
    assert.equal(generated.provider, 'gemini-3.1-live');
    await consume(generated);

    const liveText = fixture.calls.find((entry) => entry.provider === 'live-text')?.text;
    assert.ok(liveText, 'Gemini Live must receive a read-aloud turn');
    const lines = liveText.split('\n');
    assert.equal(lines.slice(1, -1).join('\n'), answer);
    assert.equal(fixture.calls.filter((entry) => entry.provider === 'google').length, 0);

    const after = tts.getTtsProviderStatus();
    assert.equal(after.livePrimary.startedCount, before.livePrimary.startedCount + 1);
    assert.equal(after.livePrimary.firstAudioSuccessCount, before.livePrimary.firstAudioSuccessCount + 1);
    assert.equal(after.livePrimary.successCount, before.livePrimary.successCount + 1);
    assert.equal(after.geminiSuccessCount, before.geminiSuccessCount + 1);
    assert.equal(after.lastProvider, 'gemini-3.1-live');
  } finally {
    fixture.restore();
  }
});

test('/ask Live failure falls back once to Google MS with the exact same answer and metrics', async () => {
  tts.restartTtsRuntime();
  const fixture = providerFixture({ failLive: true });
  const answer = 'Fallback mesti baca ayat ini tepat.';
  const item = askItem(answer, 'ask-fallback');
  const before = tts.getTtsProviderStatus();
  try {
    const generated = await tts.synthesize(item.text, speechContext(item));
    assert.equal(generated.provider, 'google-ms');
    await consume(generated);

    assert.equal(fixture.calls.filter((entry) => entry.provider === 'live').length, 1);
    const googleCalls = fixture.calls.filter((entry) => entry.provider === 'google');
    assert.equal(googleCalls.length, 1);
    assert.equal(googleCalls[0].text, answer);

    const after = tts.getTtsProviderStatus();
    assert.equal(after.livePrimary.failureCount, before.livePrimary.failureCount + 1);
    assert.equal(after.google.startedCount, before.google.startedCount + 1);
    assert.equal(after.google.successCount, before.google.successCount + 1);
    assert.equal(after.fallbackCount, before.fallbackCount + 1);
    assert.equal(after.lastProvider, 'google-ms');
  } finally {
    fixture.restore();
  }
});

test('/ask speech rotates deterministically through all ten Gemini key slots', async () => {
  tts.restartTtsRuntime();
  const fixture = providerFixture();
  try {
    for (let slot = 1; slot <= 10; slot += 1) {
      const answer = `Jawapan ${slot}.`;
      const item = askItem(answer, `ask-key-${slot}`);
      const generated = await tts.synthesize(item.text, speechContext(item));
      assert.equal(generated.provider, 'gemini-3.1-live');
      await consume(generated);
    }

    assert.deepEqual(
      fixture.calls.filter((entry) => entry.provider === 'live').map((entry) => entry.key),
      Array.from({ length: 10 }, (_, index) => `ask-routing-key-${index + 1}`)
    );
    const keyStatus = tts.getTtsProviderStatus().geminiKeyRoundRobin;
    assert.equal(keyStatus.configuredCount, 10);
    assert.deepEqual(keyStatus.configuredSlots, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(keyStatus.lastSlot, 10);
    assert.equal(keyStatus.nextSlot, 1);
  } finally {
    fixture.restore();
  }
});

test('/ask queue owns one logical playback item and never duplicates an accepted answer', async () => {
  const guildId = `ask-no-duplicate-${Date.now()}-${Math.random()}`;
  const userId = 'ask-owner';
  const sequence = beginAskTtsRequest(guildId, userId);
  const interaction = {
    id: 'ask-one-playback',
    guildId,
    guild: {},
    createdTimestamp: 1234,
    user: { id: userId },
    member: { voice: { channel: { id: 'voice-1', type: ChannelType.GuildVoice } } }
  };
  const enqueued = [];
  let supersedeCalls = 0;
  const status = await queueAskAnswerTts(interaction, 'Satu jawapan sahaja.', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => 'voice-1',
    getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    connect: async () => ({ connection: {}, status: 'already-connected' }),
    enqueue: (queuedGuild, text, metadata) => {
      enqueued.push({ queuedGuild, text, metadata });
      return 'started';
    },
    cancel: () => assert.fail('Accepted item must not cancel itself'),
    cancelSupersededAsk: () => { supersedeCalls += 1; }
  }, { requestSequence: sequence, replyMessageId: 'reply-1' });

  assert.equal(status, 'started');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].text, 'Satu jawapan sahaja.');
  assert.equal(enqueued[0].metadata.messageId, 'ask:ask-one-playback');
  assert.equal(enqueued[0].metadata.replyMessageId, 'reply-1');
  assert.equal(enqueued[0].metadata.skipLive, false);
  assert.equal(supersedeCalls, 1);
  enqueued[0].metadata.onTerminal('finished');
  finishAskTtsRequest(guildId, userId, sequence);
});
