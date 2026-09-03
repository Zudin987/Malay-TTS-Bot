import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { streamGoogleMalay } from '../src/providers/google.js';
import { synthesizeGeminiLive } from '../src/providers/gemini-live.js';
import { raceWithSignal, discardGenerated } from '../src/cancellation.js';

test('pre-aborted Google and Live requests settle without any network allocation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before admission'));
  let calls = 0;
  await assert.rejects(streamGoogleMalay('hello', { signal: controller.signal, fetchImpl() { calls++; } }), /cancelled/);
  await assert.rejects(synthesizeGeminiLive('hello', 'Charon', { apiKey: 'fixture', signal: controller.signal, webSocketFactory() { calls++; } }), /cancelled/);
  assert.equal(calls, 0);
});

test('Google deadline releases a stalled body even if read and cancel ignore abort', async () => {
  let released = 0;
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    await assert.rejects(streamGoogleMalay('hello', {
      timeoutMs: 250, retryCount: 0,
      fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/mpeg' }), body: {
        getReader: () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock() { released++; } })
      } })
    }), /exceeded/);
    assert.equal(released, 1);
  } finally { clearTimeout(keepAlive); }
});

test('late provider results are cancelled and their streams destroyed', async () => {
  const controller = new AbortController();
  let resolve;
  let cancellations = 0;
  const source = new Promise((done) => { resolve = done; });
  const waiting = raceWithSignal(source, controller.signal, discardGenerated);
  controller.abort(new Error('stop'));
  await assert.rejects(waiting, /stop/);
  const stream = new PassThrough();
  resolve({ audioStream: stream, cancel() { cancellations++; } });
  await delay(0);
  assert.equal(cancellations, 1);
  assert.equal(stream.destroyed, true);
});
