import test from 'node:test';
import assert from 'node:assert/strict';

const { getGeminiApiKeySelection, applyGeminiApiKeySelection } = await import('../src/gemini-key-config.js');

test('Gemini key selector keeps legacy GEMINI_API_KEY as slot 1', () => {
  const selection = getGeminiApiKeySelection({ GEMINI_API_KEY: ' key-one ' });
  assert.equal(selection.key, 'key-one');
  assert.equal(selection.selectedSlot, 1);
  assert.equal(selection.configuredCount, 1);
  assert.deepEqual(selection.configuredSlots, [1]);
});

test('Gemini key selector supports up to five numbered slots and manual selection', () => {
  const env = {
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_2: 'key-two',
    GEMINI_API_KEY_3: 'key-three',
    GEMINI_API_KEY_4: 'key-four',
    GEMINI_API_KEY_5: 'key-five',
    GEMINI_API_KEY_SLOT: '4'
  };
  const selection = getGeminiApiKeySelection(env);
  assert.equal(selection.key, 'key-four');
  assert.equal(selection.selectedSlot, 4);
  assert.equal(selection.configuredCount, 5);
  assert.deepEqual(selection.configuredSlots, [1, 2, 3, 4, 5]);
});

test('empty requested slot falls back to slot 1, then first configured slot', () => {
  const withPrimary = getGeminiApiKeySelection({
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_3: 'key-three',
    GEMINI_API_KEY_SLOT: '2'
  });
  assert.equal(withPrimary.selectedSlot, 1);

  const withoutPrimary = getGeminiApiKeySelection({
    GEMINI_API_KEY_3: 'key-three',
    GEMINI_API_KEY_5: 'key-five',
    GEMINI_API_KEY_SLOT: '2'
  });
  assert.equal(withoutPrimary.selectedSlot, 3);
});

test('invalid slot selection safely defaults to slot 1', () => {
  for (const value of ['0', '6', 'abc', '', '-1']) {
    const selection = getGeminiApiKeySelection({ GEMINI_API_KEY: 'key-one', GEMINI_API_KEY_SLOT: value });
    assert.equal(selection.requestedSlot, 1);
    assert.equal(selection.selectedSlot, 1);
  }
});

test('applying a selection exposes only the active key through legacy runtime variable', () => {
  const env = {
    GEMINI_API_KEY: 'key-one',
    GEMINI_API_KEY_2: 'key-two',
    GEMINI_API_KEY_SLOT: '2'
  };
  const selection = applyGeminiApiKeySelection(env);
  assert.equal(selection.selectedSlot, 2);
  assert.equal(env.GEMINI_API_KEY, 'key-two');
  assert.equal(env.GEMINI_API_KEY_ACTIVE_SLOT, '2');
  assert.equal(env.GEMINI_API_KEY_CONFIGURED_COUNT, '2');
});
