import test from 'node:test';
import assert from 'node:assert/strict';

const {
  getGeminiApiKeySelection,
  createGeminiApiKeyRoundRobin,
  formatGeminiApiKeySelectionLog
} = await import('../src/gemini-key-config.js');

test('Gemini key config keeps legacy GEMINI_API_KEY as slot 1', () => {
  const selection = getGeminiApiKeySelection({ GEMINI_API_KEY: ' key-one ' });
  assert.equal(selection.key, 'key-one');
  assert.equal(selection.selectedSlot, 1);
  assert.equal(selection.configuredCount, 1);
  assert.deepEqual(selection.configuredSlots, [1]);
});

test('Gemini key selection log exposes only the slot number', () => {
  const secret = 'never-log-this-key-material';
  const line = formatGeminiApiKeySelectionLog({ slot: 10, key: secret });
  assert.equal(line, '[gemini-key] slot=10');
  assert.equal(line.includes(secret), false);
  assert.equal(formatGeminiApiKeySelectionLog({ slot: null, key: secret }), null);
  assert.equal(formatGeminiApiKeySelectionLog({ slot: 11, key: secret }), null);
});

test('round robin cycles ten configured keys in slot order', () => {
  const ring = createGeminiApiKeyRoundRobin({
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_2: 'key-two',
    GEMINI_API_KEY_3: 'key-three',
    GEMINI_API_KEY_4: 'key-four',
    GEMINI_API_KEY_5: 'key-five',
    GEMINI_API_KEY_6: 'key-six',
    GEMINI_API_KEY_7: 'key-seven',
    GEMINI_API_KEY_8: 'key-eight',
    GEMINI_API_KEY_9: 'key-nine',
    GEMINI_API_KEY_10: 'key-ten'
  });

  const sequence = Array.from({ length: 12 }, () => ring.next()?.slot);
  assert.deepEqual(sequence, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2]);
  assert.equal(ring.status().lastSlot, 2);
  assert.equal(ring.status().nextSlot, 3);
});

test('GEMINI_API_KEY_SLOT chooses the round-robin starting slot', () => {
  const ring = createGeminiApiKeyRoundRobin({
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_2: 'key-two',
    GEMINI_API_KEY_3: 'key-three',
    GEMINI_API_KEY_SLOT: '3'
  });

  assert.deepEqual([ring.next()?.slot, ring.next()?.slot, ring.next()?.slot, ring.next()?.slot], [3, 1, 2, 3]);
});

test('slot 10 can be selected as the round-robin starting slot', () => {
  const ring = createGeminiApiKeyRoundRobin({
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_10: 'key-ten',
    GEMINI_API_KEY_SLOT: '10'
  });

  assert.deepEqual([ring.next()?.slot, ring.next()?.slot, ring.next()?.slot], [10, 1, 10]);
});

test('round robin skips empty numbered slots without creating phantom keys', () => {
  const ring = createGeminiApiKeyRoundRobin({
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_3: 'key-three',
    GEMINI_API_KEY_10: 'key-ten'
  });

  assert.deepEqual([ring.next()?.slot, ring.next()?.slot, ring.next()?.slot, ring.next()?.slot], [1, 3, 10, 1]);
  assert.deepEqual(ring.status().configuredSlots, [1, 3, 10]);
});

test('single-key round robin remains backward-compatible', () => {
  const ring = createGeminiApiKeyRoundRobin({ GEMINI_API_KEY: 'key-one' });
  assert.deepEqual([ring.next()?.slot, ring.next()?.slot, ring.next()?.slot], [1, 1, 1]);
  assert.equal(ring.status().configuredCount, 1);
  assert.equal(ring.status().availableCount, 1);
});

test('auth-disabled key slots are skipped until the ring is reset', () => {
  const ring = createGeminiApiKeyRoundRobin({
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_2: 'key-two',
    GEMINI_API_KEY_3: 'key-three'
  });

  assert.equal(ring.next()?.slot, 1);
  ring.disable(2);
  assert.deepEqual([ring.next()?.slot, ring.next()?.slot, ring.next()?.slot], [3, 1, 3]);
  assert.deepEqual(ring.status().disabledSlots, [2]);

  ring.reset();
  assert.deepEqual(ring.status().disabledSlots, []);
  assert.equal(ring.next()?.slot, 1);
  assert.equal(ring.next()?.slot, 2);
});

test('invalid or empty start slot safely begins at the first configured key', () => {
  for (const value of ['0', '11', 'abc', '', '-1', '2']) {
    const ring = createGeminiApiKeyRoundRobin({
      GEMINI_API_KEY: 'key-one',
      GEMINI_API_KEY_3: 'key-three',
      GEMINI_API_KEY_SLOT: value
    });
    assert.equal(ring.next()?.slot, 1);
  }
});
