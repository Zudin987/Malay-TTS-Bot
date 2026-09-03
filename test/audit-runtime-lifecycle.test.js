import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';

const ask = await import('../src/ask.js');
const voice = await import('../src/voice.js');

function okAskResponse(text = 'ok') {
  return {
    ok: true,
    status: 200,
    async json() {
      return { candidates: [{ content: { parts: [{ text }] } }] };
    }
  };
}

test('/ask rejects a third simultaneous request instead of creating unbounded work', async () => {
  const resolvers = [];
  const fetchImpl = async () => new Promise((resolve) => resolvers.push(resolve));
  const options = ask.getAskOptions({ timeoutMs: 5000 });
  const keyEntry = { key: 'test-key', slot: 1 };

  const first = ask.askGemini('one', { fetchImpl, keyEntry, options });
  const second = ask.askGemini('two', { fetchImpl, keyEntry, options });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ask.getAskRuntimeStatus(), { active: 2, maximum: 2 });
  await assert.rejects(
    () => ask.askGemini('three', { fetchImpl, keyEntry, options }),
    (error) => error?.code === 'busy'
  );

  resolvers.shift()(okAskResponse('first'));
  resolvers.shift()(okAskResponse('second'));
  assert.equal((await first).answer, 'first');
  assert.equal((await second).answer, 'second');
  assert.deepEqual(ask.getAskRuntimeStatus(), { active: 0, maximum: 2 });
});

test('voice recovery tracker exposes direct recovery and de-duplicates concurrent recovery work', async () => {
  const state = { recoveryPromise: null };
  let runs = 0;
  let release;
  const first = voice.__test.trackRecovery(state, async () => {
    runs += 1;
    return new Promise((resolve) => { release = resolve; });
  });
  const second = voice.__test.trackRecovery(state, async () => {
    runs += 1;
    return false;
  });

  assert.equal(first, second);
  assert.equal(runs, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(state.recoveryPromise, first);
  release(true);
  assert.equal(await first, true);
  assert.equal(state.recoveryPromise, null);
});

test('Discord MessageDelete is wired to cancel the matching message TTS item', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /client\.on\(Events\.MessageDelete/);
  assert.match(source, /cancelMessageAudio\(message\.guild\.id, message\.id\)/);
});
