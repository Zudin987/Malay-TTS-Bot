import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { synthesizeGemini } from '../src/providers/gemini.js';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';

test('Gemini 3.1 TTS uses the documented streaming Interactions request shape', async () => {
  const apiKey = 'fixture-secret-key-value';
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      error: { status: 'INVALID_ARGUMENT', message: `fixture request rejected; key=${apiKey}` }
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  };

  await assert.rejects(
    synthesizeGemini('windows ke linux bagus', 'Charon', { apiKey, fetchImpl }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.apiStatus, 'INVALID_ARGUMENT');
      assert.match(error.message, /fixture request rejected/i);
      assert.doesNotMatch(error.message, /fixture-secret-key-value/);
      return true;
    }
  );

  assert.equal(captured.url, endpoint);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Api-Revision'], '2026-05-20');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'gemini-3.1-flash-tts-preview');
  assert.equal(body.system_instruction, undefined);
  assert.match(body.input, /strict speech-synthesis engine/i);
  assert.match(body.input, /without adding, omitting, answering, translating, completing, paraphrasing, or rewriting/i);
  assert.match(body.input, /windows ke linux bagus/);
  assert.deepEqual(body.response_format, { type: 'audio' });
  assert.deepEqual(body.generation_config, { speech_config: [{ voice: 'Charon' }] });
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
});

test('Gemini 3.1 TTS supports completed-audio Interactions for buffered /ask', async () => {
  const apiKey = 'fixture-unary-key';
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      id: 'int_fixture',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{
        type: 'audio', data: pcm.toString('base64'), mime_type: 'audio/l16', sample_rate: 24000, channels: 1
      }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const generated = await synthesizeGemini('baca jawapan ini', 'Gacrux', {
    apiKey, fetchImpl, streaming: false, bufferedTimeoutMs: 2500
  });

  assert.equal(captured.url, endpoint);
  assert.equal(captured.init.headers.Accept, 'application/json');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.deepEqual(body.response_format, { type: 'audio' });
  assert.deepEqual(generated.audioBuffer, pcm);
  assert.equal(generated.audioStream, undefined);
  assert.equal(generated.mimeType, 'audio/l16');
  assert.equal(generated.audioFormat, 's16le');
  assert.equal(generated.sampleRate, 24000);
  assert.equal(generated.channels, 1);
  assert.equal(generated.streamed, false);
});

test('Gemini TTS surfaces sanitized plain-text HTTP 400 details', async () => {
  const apiKey = 'another-fixture-secret';
  const fetchImpl = async () => new Response(
    `INVALID_ARGUMENT: unsupported request field; api_key=${apiKey}`,
    { status: 400, headers: { 'content-type': 'text/plain' } }
  );
  await assert.rejects(
    synthesizeGemini('test', 'Despina', { apiKey, fetchImpl }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /INVALID_ARGUMENT: unsupported request field/i);
      assert.doesNotMatch(error.message, /another-fixture-secret/);
      return true;
    }
  );
});

test('startup wording says Gemini TTS is configured, not preflight-ready', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /Gemini TTS configured with Google Malay fallback/);
  assert.doesNotMatch(source, /Gemini TTS ready with Google Malay fallback/);
});
