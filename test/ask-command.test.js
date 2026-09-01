import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AskError,
  askGemini,
  buildAskRequest,
  compactAskAnswer,
  describeAskError,
  getAskOptions
} from '../src/ask.js';

const options = getAskOptions({
  enabled: true,
  model: 'gemini-3.1-flash-lite',
  timeoutMs: 5000,
  maxQuestionCharacters: 1000,
  maxOutputTokens: 160,
  maxAnswerCharacters: 450,
  temperature: 0.35,
  thinkingLevel: 'minimal'
});

test('/ask registration is present without loading Discord config', () => {
  const source = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  assert.match(source, /\.setName\('ask'\)/u);
  assert.match(source, /\.setName\('question'\)/u);
  assert.match(source, /askCommand,/u);
});

test('ask request is text-only, concise, and minimal-thinking', () => {
  const request = buildAskRequest('apa beza RAM dengan storage?', options);
  assert.equal(request.contents[0].parts[0].text, 'apa beza RAM dengan storage?');
  assert.equal(request.generationConfig.responseMimeType, 'text/plain');
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(request.generationConfig.maxOutputTokens, 160);
  assert.equal('tools' in request, false);
  assert.match(request.systemInstruction.parts[0].text, /one to three short sentences/i);
  assert.match(request.systemInstruction.parts[0].text, /Do not generate or request images/i);
});

test('ask answer compaction removes article/list/image formatting', () => {
  const source = '# Answer\n- First point\n- Second point\n![pic](https://example.com/a.png)\nDone.';
  assert.equal(compactAskAnswer(source, 450), 'Answer First point Second point Done.');
});

test('ask answer hard cap prefers a clean boundary', () => {
  const source = `${'A'.repeat(90)}. ${'B'.repeat(120)}. ${'C'.repeat(120)}.`;
  const compact = compactAskAnswer(source, 120);
  assert.ok(Array.from(compact).length <= 121);
  assert.match(compact, /…$/u);
});

test('askGemini makes one request and returns compact text', async () => {
  let calls = 0;
  let captured = null;
  const fetchImpl = async (url, init) => {
    calls += 1;
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: 'RAM is temporary working memory. Storage keeps files long-term.' }] } }] };
      }
    };
  };
  const result = await askGemini('RAM vs storage?', {
    fetchImpl,
    keyEntry: { slot: 2, key: 'test-key' },
    options
  });
  assert.equal(calls, 1);
  assert.match(captured.url, /gemini-3\.1-flash-lite:generateContent$/u);
  assert.equal(captured.init.headers['x-goog-api-key'], 'test-key');
  assert.equal(result.keySlot, 2);
  assert.equal(result.answer, 'RAM is temporary working memory. Storage keeps files long-term.');
});

test('quota failure does not retry another key inside /ask', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      async json() { return { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }; }
    };
  };
  await assert.rejects(
    askGemini('hello?', { fetchImpl, keyEntry: { slot: 1, key: 'test-key' }, options }),
    (error) => error instanceof AskError && error.code === 'quota'
  );
  assert.equal(calls, 1);
  assert.equal(describeAskError(new AskError('quota', 'x')), 'Gemini is rate-limited right now. Try again later.');
});


test('config normalization retains the /ask settings block', () => {
  const source = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(source, /const ask = isObject\(parsed\.ask\)/u);
  assert.match(source, /model: String\(ask\.model/u);
  assert.match(source, /maxAnswerCharacters: clampInt\(ask\.maxAnswerCharacters/u);
});
