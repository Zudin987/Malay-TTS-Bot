import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { synthesizeGemini } from '../src/providers/gemini.js';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';
const tts = await import('../src/tts.js');

const encoder = new TextEncoder();
function sse(value) {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}
function audioDelta(index = 0, bytes = Buffer.from([1, 2, 3, 4])) {
  return {
    event_type: 'step.delta',
    index,
    delta: {
      type: 'audio',
      data: bytes.toString('base64'),
      mime_type: 'audio/l16',
      sample_rate: 24000,
      channels: 1
    }
  };
}

test('Gemini exact TTS step.stop releases buffered audio without waiting for delayed interaction.completed', async () => {
  let delayedCompletionSent = false;
  let delayedTimer = null;
  const fetchImpl = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(sse({ event_type: 'step.start', index: 0, step: { type: 'model_output' } }));
      controller.enqueue(sse(audioDelta(0)));
      controller.enqueue(sse({ event_type: 'step.stop', index: 0 }));
      delayedTimer = setTimeout(() => {
        delayedCompletionSent = true;
        try {
          controller.enqueue(sse({ event_type: 'interaction.completed', interaction: { status: 'completed' } }));
          controller.close();
        } catch {}
      }, 900);
      init.signal.addEventListener('abort', () => {
        clearTimeout(delayedTimer);
        try { controller.error(init.signal.reason); } catch {}
      }, { once: true });
    },
    cancel() { clearTimeout(delayedTimer); }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const started = performance.now();
  const generated = await synthesizeGemini('jawapan pendek', 'Charon', {
    apiKey: 'fixture-key', fetchImpl, timeoutMs: 500, streamIdleTimeoutMs: 500, maxOutputAudioMs: 5000
  });
  const chunks = [];
  for await (const chunk of generated.audioStream) chunks.push(Buffer.from(chunk));
  await generated.completion;
  const elapsed = performance.now() - started;

  assert.equal(Buffer.concat(chunks).length, 4);
  assert.equal(delayedCompletionSent, false);
  assert.ok(elapsed < 700, `audio completion took ${Math.round(elapsed)}ms`);
});

test('non-audio SSE traffic cannot keep a stalled exact TTS stream alive after first audio', async () => {
  let chatterTimer = null;
  const fetchImpl = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(sse({ event_type: 'step.start', index: 0, step: { type: 'model_output' } }));
      controller.enqueue(sse(audioDelta(0)));
      chatterTimer = setInterval(() => {
        try { controller.enqueue(sse({ event_type: 'interaction.status_update', status: 'in_progress' })); } catch {}
      }, 60);
      init.signal.addEventListener('abort', () => {
        clearInterval(chatterTimer);
        try { controller.error(init.signal.reason); } catch {}
      }, { once: true });
    },
    cancel() { clearInterval(chatterTimer); }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const started = performance.now();
  const generated = await synthesizeGemini('jangan tunggu metadata', 'Despina', {
    apiKey: 'fixture-key', fetchImpl, timeoutMs: 500, streamIdleTimeoutMs: 500, maxOutputAudioMs: 5000
  });
  await assert.rejects(generated.completion, /stream inactivity timeout after 500ms/i);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `stalled exact TTS survived ${Math.round(elapsed)}ms`);
});

test('/ask exact TTS uses the streaming first-audio path while explicit buffered mode remains available for recovery', () => {
  assert.equal(tts.__test.isBufferedExactContext({ skipLive: true }), false);
  assert.equal(tts.__test.exactAttemptWindowMs({ skipLive: true }), 4000);
  const askStreaming = tts.__test.exactOptions(null, 4000, 'fixture-key', { skipLive: true });
  const explicitBuffered = tts.__test.exactOptions(null, 10000, 'fixture-key', { skipLive: true, liveStreamOutput: false });
  const normal = tts.__test.exactOptions(null, 1600, 'fixture-key', {});
  assert.equal(askStreaming.streaming, true);
  assert.equal(askStreaming.bufferedTimeoutMs, undefined);
  assert.equal(explicitBuffered.streaming, false);
  assert.equal(explicitBuffered.bufferedTimeoutMs, 10000);
  assert.equal(normal.streaming, true);
});

test('/ask Google fallback receives a fresh first-audio window after exact TTS exhausts the normal budget', () => {
  assert.equal(tts.__test.googleFallbackWindowMs({ skipLive: true }, 0), 3500);
  assert.equal(tts.__test.googleFallbackWindowMs({ skipLive: false }, 0), 0);
  assert.equal(tts.__test.googleFallbackWindowMs({}, 900), 900);
});
