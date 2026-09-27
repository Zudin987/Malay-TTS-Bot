import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';

const {
  buildAudioFilters,
  getProviderGain,
  getProviderPlaybackVolume
} = await import('../src/audio-filters.js');
const configModule = await import('../src/config.js');

test('provider gain defaults calibrate Google MS to the established speaker-label loudness match', () => {
  assert.equal(getProviderGain('gemini-3.1-live'), 1.0);
  assert.equal(getProviderGain('google-ms'), 1.5);
  assert.equal(getProviderGain('safe-audio-tail-replay'), 1.0);

  assert.equal(getProviderPlaybackVolume({ volume: 0.6, provider: 'gemini-3.1-live' }), 0.6);
  assert.ok(Math.abs(getProviderPlaybackVolume({ volume: 0.6, provider: 'google-ms' }) - 0.9) < 1e-12);
});

test('provider gain settings are configurable and safely bounded', () => {
  const normalized = configModule.__test.normalizeSettings({
    providerGain: { geminiLive: -1, googleMs: 9 }
  });
  assert.equal(normalized.providerGain.geminiLive, 0);
  assert.equal(normalized.providerGain.googleMs, 2);

  assert.equal(getProviderPlaybackVolume({
    volume: 1.5,
    provider: 'google-ms',
    providerGain: { googleMs: 2 }
  }), 2);
});

test('provider calibration still feeds the existing peak limiter last', () => {
  const volume = getProviderPlaybackVolume({
    volume: 0.6,
    provider: 'google-ms',
    providerGain: { googleMs: 1.5 }
  });
  const filters = buildAudioFilters({
    volume,
    audioPipeline: {
      peakLimiter: { enabled: true, ceilingDb: -5, attackMs: 1, releaseMs: 60 }
    }
  });

  assert.equal(filters[0], 'volume=0.900');
  assert.match(filters.at(-1), /^alimiter=/);
  assert.match(filters.at(-1), /level=false$/);
});
