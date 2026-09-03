from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/providers/gemini.js',
    "  let completed = false;\n  let firstAudioResolve, firstAudioReject;",
    "  let completed = false;\n  let audioStepStopped = false;\n  const audioStepIndexes = new Set();\n  let firstAudioResolve, firstAudioReject;"
)
replace_once(
    'src/providers/gemini.js',
    "    armIdle();\n    const handleEvent = async (event) => {",
    "    const handleEvent = async (event) => {"
)
replace_once(
    'src/providers/gemini.js',
    "        sampleRate = Math.max(8_000, Math.min(Math.floor(finiteNumber(event.delta.sample_rate ?? event.delta.sampleRate, sampleRate)), 96_000));\n        channels = Math.max(1, Math.min(Math.floor(finiteNumber(event.delta.channels, channels)), 2));\n        resolveFirst();\n        if (!output.write(chunk)) await waitForWritableDrain(output, linked.controller.signal, 'Gemini TTS output stream');",
    "        sampleRate = Math.max(8_000, Math.min(Math.floor(finiteNumber(event.delta.sample_rate ?? event.delta.sampleRate, sampleRate)), 96_000));\n        channels = Math.max(1, Math.min(Math.floor(finiteNumber(event.delta.channels, channels)), 2));\n        const stepIndex = Number(event.index);\n        if (Number.isFinite(stepIndex)) audioStepIndexes.add(stepIndex);\n        resolveFirst();\n        // After first audio, only another real audio chunk proves synthesis is\n        // progressing. Metadata/status SSE traffic must not keep a stalled /ask\n        // request alive for the provider's 54s absolute safety wall.\n        armIdle();\n        if (!output.write(chunk)) await waitForWritableDrain(output, linked.controller.signal, 'Gemini TTS output stream');"
)
replace_once(
    'src/providers/gemini.js',
    "      if (event.event_type === 'interaction.completed') {",
    "      if (event.event_type === 'step.stop' && audioStepIndexes.has(Number(event.index)) && totalBytes > 0) {\n        audioStepStopped = true;\n        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }\n        // step.stop is the documented end of this model_output step. The audio\n        // is complete, so buffered /ask playback must not wait for delayed final\n        // interaction metadata.\n        if (!output.writableEnded && !output.destroyed) output.end();\n      }\n      if (event.event_type === 'interaction.completed') {"
)
replace_once(
    'src/providers/gemini.js',
    "        const result = await reader.read();\n        if (result.done) break;\n        armIdle();\n        pending += decoder.decode(result.value, { stream: true });",
    "        const result = await reader.read();\n        if (result.done) break;\n        pending += decoder.decode(result.value, { stream: true });"
)
replace_once(
    'src/providers/gemini.js',
    "          await handleEvent(parseSseBlock(block));\n        }\n      }\n      pending += decoder.decode();",
    "          await handleEvent(parseSseBlock(block));\n        }\n        if (audioStepStopped) {\n          try { await reader.cancel(); } catch {}\n          break;\n        }\n      }\n      pending += decoder.decode();"
)
replace_once(
    'src/providers/gemini.js',
    "      if (!completed) {\n        const error = new Error('Gemini TTS stream ended before interaction.completed.');\n        error.name = 'GeminiTtsIncompleteError';\n        error.retryable = true;\n        throw error;\n      }\n      output.end();",
    "      if (!completed && !audioStepStopped) {\n        const error = new Error('Gemini TTS stream ended before interaction.completed.');\n        error.name = 'GeminiTtsIncompleteError';\n        error.retryable = true;\n        throw error;\n      }\n      if (!output.writableEnded && !output.destroyed) output.end();"
)

replace_once(
    'src/tts.js',
    "function makeBudgetError(provider, ms) {\n  const error = new Error(`${provider} exceeded the remaining ${Math.max(0, Math.round(ms))}ms end-to-end first-audio budget.`);\n  error.name = 'TtsFailoverBudgetError';\n  error.budgetLike = true;\n  error.transportLike = true;\n  return error;\n}\n",
    "function makeBudgetError(provider, ms) {\n  const error = new Error(`${provider} exceeded the remaining ${Math.max(0, Math.round(ms))}ms end-to-end first-audio budget.`);\n  error.name = 'TtsFailoverBudgetError';\n  error.budgetLike = true;\n  error.transportLike = true;\n  return error;\n}\n\nfunction googleFallbackWindowMs(context = {}, remainingMs = 0) {\n  const remaining = Math.max(0, Number(remainingMs) || 0);\n  if (context?.skipLive !== true) return remaining;\n  // /ask intentionally uses dedicated exact TTS before Google. Buffering exact\n  // audio can outlive the normal 7s first-audio budget, so a failed exact stream\n  // must not starve the deterministic fallback with a 0ms window.\n  return Math.max(500, Math.min(Number(settings.googleTts?.timeoutMs) || 3500, 15_000));\n}\n"
)
replace_once(
    'src/tts.js',
    "  const googleWindow = remaining();",
    "  const googleWindow = googleFallbackWindowMs(context, remaining());"
)
replace_once(
    'src/tts.js',
    "export const __test = { makeBudgetError, setProviderFailure, recordRunawayMidstreamFailure, recordIsolatedLiveMidstreamFailure, shouldIsolateLiveMidstreamFailure, newProviderState, bufferGenerated, healthOptions, exactFirstAudioWindowCap, pacificDailyResetMs, recordGeminiQuotaFailure, providerReady, acquireGeminiSlot, runAttempt, providerConfigSignature, beginHalfOpenProbe, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError };",
    "export const __test = { makeBudgetError, googleFallbackWindowMs, setProviderFailure, recordRunawayMidstreamFailure, recordIsolatedLiveMidstreamFailure, shouldIsolateLiveMidstreamFailure, newProviderState, bufferGenerated, healthOptions, exactFirstAudioWindowCap, pacificDailyResetMs, recordGeminiQuotaFailure, providerReady, acquireGeminiSlot, runAttempt, providerConfigSignature, beginHalfOpenProbe, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError };"
)

replace_once(
    'src/commands.js',
    "            `First-audio budget ${settings.geminiLive?.firstAudioBudgetMs}ms • windows ${settings.providerHealth?.primaryFirstAudioMs}/${settings.providerHealth?.fallbackFirstAudioMs}/${settings.providerHealth?.exactFirstAudioMs}ms • /ask exact ≤${settings.geminiTts?.timeoutMs}ms • Google reserve ${settings.providerHealth?.googleReserveMs}ms`,",
    "            `First-audio budget ${settings.geminiLive?.firstAudioBudgetMs}ms • windows ${settings.providerHealth?.primaryFirstAudioMs}/${settings.providerHealth?.fallbackFirstAudioMs}/${settings.providerHealth?.exactFirstAudioMs}ms • /ask 3.1 first ≤${settings.geminiTts?.timeoutMs}ms • audio stall ≤${settings.geminiTts?.streamIdleTimeoutMs}ms • fresh Google ≤${settings.googleTts?.timeoutMs}ms`,"
)

Path('test/ask-buffered-tts-watchdog.test.js').write_text(r'''import test from 'node:test';
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

test('/ask Google fallback receives a fresh first-audio window after exact TTS exhausts the normal budget', () => {
  assert.equal(tts.__test.googleFallbackWindowMs({ skipLive: true }, 0), 3500);
  assert.equal(tts.__test.googleFallbackWindowMs({ skipLive: false }, 0), 0);
  assert.equal(tts.__test.googleFallbackWindowMs({}, 900), 900);
});
''', encoding='utf-8')
