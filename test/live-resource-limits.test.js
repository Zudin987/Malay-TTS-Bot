import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeGeminiLive } from '../src/providers/gemini-live.js';

function fixture(options = {}) {
  const socket = { readyState: 1, send() {}, close() { this.readyState = 3; } };
  const work = synthesizeGeminiLive('hello', 'Charon', { apiKey: 'fake', webSocketFactory: () => socket, ...options });
  work.catch(() => {});
  return { socket, work };
}
test('Live rejects oversized frames before decoding and releases socket callbacks', async () => {
  const { socket, work } = fixture();
  socket.onmessage({ data: 'A'.repeat(4 * 1024 * 1024 + 1) });
  await assert.rejects(work, /resource limit/);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.onmessage, null);
  assert.equal(socket.onopen, null);
});
test('Live bounds queued frames even while one conversion is stuck', async () => {
  const { socket, work } = fixture();
  const onmessage = socket.onmessage;
  onmessage({ data: { size: 1, text: () => new Promise(() => {}) } });
  for (let i = 0; i < 65; i++) onmessage({ data: '{}' });
  await assert.rejects(work, /resource limit/);
  assert.equal(socket.readyState, 3);
});
test('Live has an independent total deadline and bounds transcription', async (t) => {
  const keeper = setTimeout(() => {}, 1500); t.after(() => clearTimeout(keeper));
  const first = fixture({ lifetimeMs: 30 });
  first.socket.onmessage({ data: { size: 1, text: () => new Promise(() => {}) } });
  await assert.rejects(first.work, /total lifetime/);
  const second = fixture();
  second.socket.onmessage({ data: JSON.stringify({ serverContent: { outputTranscription: { text: 'x'.repeat(16385) } } }) });
  await assert.rejects(second.work, /transcription exceeded/);
});
