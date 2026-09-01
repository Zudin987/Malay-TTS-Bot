import test from 'node:test';
import assert from 'node:assert/strict';
import { askGemini, getAskOptions } from '../src/ask.js';

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

function makeKeyManager(entries) {
  const available = [...entries];
  const disabled = [];
  let cursor = 0;
  return {
    disabled,
    next() {
      while (cursor < available.length && disabled.includes(available[cursor].slot)) cursor += 1;
      const value = available[cursor] ?? null;
      cursor += 1;
      return value ? { ...value } : null;
    },
    disable(slot) {
      if (!disabled.includes(slot)) disabled.push(slot);
      return { availableCount: available.filter((entry) => !disabled.includes(entry.slot)).length };
    },
    status() {
      return { availableCount: available.filter((entry) => !disabled.includes(entry.slot)).length };
    }
  };
}

function response({ ok, status, body }) {
  return {
    ok,
    status,
    async json() { return body; }
  };
}

test('/ask disables a credential-bad key and immediately retries the next healthy configured key', async () => {
  const keys = makeKeyManager([
    { slot: 1, key: 'bad-test-key' },
    { slot: 2, key: 'healthy-test-key' }
  ]);
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.headers['x-goog-api-key']);
    if (calls.length === 1) {
      return response({
        ok: false,
        status: 401,
        body: { error: { status: 'UNAUTHENTICATED', message: 'API key is invalid' } }
      });
    }
    return response({
      ok: true,
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'Healthy key answered.' }] } }] }
    });
  };

  const result = await askGemini('hello?', { fetchImpl, keyManager: keys, options });
  assert.deepEqual(calls, ['bad-test-key', 'healthy-test-key']);
  assert.deepEqual(keys.disabled, [1]);
  assert.equal(result.keySlot, 2);
  assert.equal(result.answer, 'Healthy key answered.');
});

test('/ask does not rotate keys for quota or model/project permission failures', async () => {
  for (const failure of [
    { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }, code: 'quota' },
    { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'model access denied' } }, code: 'auth' }
  ]) {
    const keys = makeKeyManager([
      { slot: 1, key: 'first-test-key' },
      { slot: 2, key: 'second-test-key' }
    ]);
    let calls = 0;
    await assert.rejects(
      askGemini('hello?', {
        options,
        keyManager: keys,
        fetchImpl: async () => {
          calls += 1;
          return response({ ok: false, status: failure.status, body: failure.body });
        }
      }),
      (error) => error?.code === failure.code
    );
    assert.equal(calls, 1);
    assert.deepEqual(keys.disabled, []);
  }
});

test('/ask explicit keyEntry remains single-key and does not mutate the runtime key manager', async () => {
  const keys = makeKeyManager([{ slot: 2, key: 'unused-test-key' }]);
  let calls = 0;
  await assert.rejects(
    askGemini('hello?', {
      options,
      keyEntry: { slot: 1, key: 'explicit-bad-key' },
      keyManager: keys,
      fetchImpl: async () => {
        calls += 1;
        return response({
          ok: false,
          status: 401,
          body: { error: { status: 'UNAUTHENTICATED', message: 'API key is invalid' } }
        });
      }
    }),
    (error) => error?.code === 'auth' && error?.keyAuthLike === true
  );
  assert.equal(calls, 1);
  assert.deepEqual(keys.disabled, []);
});
