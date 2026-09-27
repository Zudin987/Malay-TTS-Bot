function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function getPeakLimiterOptions(audioPipeline = {}) {
  const raw = audioPipeline?.peakLimiter && typeof audioPipeline.peakLimiter === 'object'
    ? audioPipeline.peakLimiter
    : {};

  const enabled = raw.enabled !== false;
  const ceilingDb = clampNumber(raw.ceilingDb, -5.0, -18, -0.1);
  const attackMs = clampNumber(raw.attackMs, 1, 0.1, 80);
  const releaseMs = clampNumber(raw.releaseMs, 60, 1, 8000);
  const limitLinear = Math.pow(10, ceilingDb / 20);

  return {
    enabled,
    ceilingDb,
    attackMs,
    releaseMs,
    limitLinear
  };
}

export function getProviderGain(provider, providerGain = {}) {
  const name = String(provider ?? '').trim().toLowerCase();
  if (name === 'google-ms') return clampNumber(providerGain?.googleMs, 1.5, 0, 2);
  if (name.startsWith('gemini')) return clampNumber(providerGain?.geminiLive, 1.0, 0, 2);
  return 1;
}

export function getProviderPlaybackVolume({ volume = 0.6, provider = '', providerGain = {} } = {}) {
  const safeVolume = clampNumber(volume, 0.6, 0, 2);
  return Math.min(2, safeVolume * getProviderGain(provider, providerGain));
}

export function buildAudioFilters({ volume = 0.6, playbackSpeed = 1, audioPipeline = {} } = {}) {
  const safeVolume = clampNumber(volume, 0.6, 0, 2);
  const safeSpeed = clampNumber(playbackSpeed, 1, 0.5, 2);
  const filters = [`volume=${safeVolume.toFixed(3)}`];

  if (safeSpeed > 1.0001 || safeSpeed < 0.9999) {
    filters.push(`atempo=${safeSpeed.toFixed(3)}`);
  }

  const limiter = getPeakLimiterOptions(audioPipeline);
  if (limiter.enabled) {
    // Limiter runs last so the configured ceiling applies to the signal that
    // actually reaches the Opus encoder, after volume and catch-up speed.
    // level=false is important: do not add makeup gain after limiting.
    filters.push(
      `alimiter=limit=${limiter.limitLinear.toFixed(6)}` +
      `:attack=${limiter.attackMs.toFixed(1)}` +
      `:release=${limiter.releaseMs.toFixed(1)}` +
      ':level=false'
    );
  }

  return filters;
}
