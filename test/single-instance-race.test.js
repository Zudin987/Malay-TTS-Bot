import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../src/single-instance.js');

test('stale lock deletion requires the exact inspected record to remain unchanged', () => {
  const before = { raw: '{"pid":123,"nonce":"old"}\n' };
  assert.equal(__test.lockRecordUnchanged(before, { raw: before.raw }), true);
  assert.equal(__test.lockRecordUnchanged(before, { raw: '{"pid":456,"nonce":"new"}\n' }), false);
  assert.equal(__test.lockRecordUnchanged(before, { raw: null }), false);
});
