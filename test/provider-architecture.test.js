import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DISCORD_TOKEN ||= 'test-token';
for (let slot = 1; slot <= 10; slot++) process.env[slot === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${slot}`] = `fixture-key-${slot}`;
const tts = await import('../src/tts.js');
const { settings } = await import('../src/config.js');

function networkFixture({ failLive = false, hangLive = false } = {}) {
  const originalSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const calls = [];
  class Socket {
    constructor(url) { this.readyState = 1; calls.push({ provider: 'live', key: new URL(url).searchParams.get('key') }); queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.setup) {
        calls.push({ setup: message.setup });
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(failLive ? { error: { code: 503, message: 'unavailable' } } : { setupComplete: {} }) }));
      } else if (!hangLive) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ serverContent: {
        modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(1200).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] },
        generationComplete: true, turnComplete: true
      } }) }));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket;
  globalThis.fetch = async (url) => { calls.push({ provider: 'google', text: new URL(url).searchParams.get('q') }); return new Response(Buffer.alloc(250), { headers: { 'content-type': 'audio/mpeg' } }); };
  return { calls, restore() { globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; tts.restartTtsRuntime(); } };
}
async function consume(result) {
  for await (const _ of result.audioStream) { /* drain real provider stream */ }
  await result.completion;
}

test('normal speech uses fresh 3.1 Live turns and cycles all ten configured slots', async () => {
  tts.restartTtsRuntime();
  const fixture = networkFixture();
  try {
    for (let i = 0; i < 11; i++) {
      const generated = await tts.synthesize('aku nak pergi kedai', { voice: 'Charon' });
      assert.equal(generated.provider, 'gemini-3.1-live');
      await consume(generated);
    }
    assert.deepEqual(fixture.calls.filter(x => x.provider === 'live').map(x => x.key), [...Array.from({ length: 10 }, (_, i) => `fixture-key-${i + 1}`), 'fixture-key-1']);
    assert.equal(fixture.calls.filter(x => x.provider === 'google').length, 0);
    assert.ok(fixture.calls.filter(x => x.setup).every(x => x.setup.model === 'models/gemini-3.1-flash-live-preview'));
    assert.equal(settings.providerHealth.primaryFirstAudioMs, 2500);
    assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);
  } finally { fixture.restore(); }
});

test('Live failure starts Google directly; literal answers use only Google', async () => {
  const fixture = networkFixture({ failLive: true });
  try {
    const generated = await tts.synthesize('hello', { voice: 'Charon' });
    assert.equal(generated.provider, 'google-ms');
    await consume(generated);
    assert.deepEqual(fixture.calls.filter(x => x.provider).map(x => x.provider), ['live', 'google']);
    const answer = 'Adakah ini soalan? Jangan jawab lagi.';
    const literal = await tts.synthesize(answer, { voice: 'Orus', skipLive: true, googleText: answer });
    await consume(literal);
    assert.equal(fixture.calls.at(-1).text, answer);
    assert.equal(fixture.calls.filter(x => x.provider === 'live').length, 1);
  } finally { fixture.restore(); }
});

test('cancelling before Live first audio does not start Google and releases the slot', async () => {
  const fixture = networkFixture({ hangLive: true });
  const parent = new AbortController();
  try {
    const waiting = tts.synthesize('hello', { voice: 'Charon', signal: parent.signal });
    await new Promise(resolve => setImmediate(resolve));
    parent.abort(new Error('STOP'));
    await assert.rejects(waiting, /STOP/);
    assert.equal(fixture.calls.filter(x => x.provider === 'google').length, 0);
    assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);
  } finally { fixture.restore(); }
});

test('only the two supported speech providers exist in active code and settings', () => {
  assert.deepEqual(fs.readdirSync(new URL('../src/providers/', import.meta.url)).sort(), ['gemini-live.js', 'google.js']);
  for (const file of ['../src/tts.js', '../src/config.js', '../config/settings.json']) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /gemini-2\.5|flash-tts|exactTts|geminiTts|liveFallback/);
  }
});
