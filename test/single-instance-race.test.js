import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../src/single-instance.js');

test('stale lock deletion requires the exact inspected record to remain unchanged', () => {
  const before = { raw: '{"pid":123,"nonce":"old"}\n' };
  assert.equal(__test.lockRecordUnchanged(before, { raw: before.raw }), true);
  assert.equal(__test.lockRecordUnchanged(before, { raw: '{"pid":456,"nonce":"new"}\n' }), false);
  assert.equal(__test.lockRecordUnchanged(before, { raw: null }), false);
});

test('corrupt stale lock content remains comparable for safe cleanup', () => {
  const corrupt = '{not valid json';
  const parsed = __test.parseLockData(corrupt);
  assert.equal(parsed.raw, corrupt);
  assert.equal(Number.isNaN(parsed.pid), true);
  assert.equal(__test.lockRecordUnchanged(parsed, __test.parseLockData(corrupt)), true);
});
