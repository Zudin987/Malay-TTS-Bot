import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
const { __test: storeTest } = await import('../src/store.js');

test('privacy opt-out mutation never silently drops users after the old 500-entry cap', () => {
  const ids = Array.from({ length: 650 }, (_, index) => String(10000 + index));
  const added = '999999999999999999';
  const enabled = storeTest.updateOptOutIds(ids, added, true);
  assert.equal(enabled.length, 651);
  assert.equal(enabled.includes(added), true);
  assert.equal(enabled.includes(ids[0]), true);

  const disabled = storeTest.updateOptOutIds(enabled, ids[0], false);
  assert.equal(disabled.length, 650);
  assert.equal(disabled.includes(ids[0]), false);
  assert.equal(disabled.includes(added), true);
});
