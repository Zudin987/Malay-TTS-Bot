const histories = new Map();
const terminalHistories = new Map();
const MAX_SAMPLES = 60;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function average(samples, field) {
  if (!samples.length) return 0;
  return samples.reduce((sum, sample) => sum + finite(sample[field]), 0) / samples.length;
}

function percentile(samples, field, p) {
  if (!samples.length) return 0;
  const values = samples.map((sample) => finite(sample[field])).sort((a, b) => a - b);
  const index = Math.max(0, Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1));
  return values[index];
}

function max(samples, field) {
  return samples.length ? Math.max(...samples.map((sample) => finite(sample[field]))) : 0;
}

function normalizeAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((attempt) => ({
    provider: String(attempt?.provider || 'unknown'),
    outcome: String(attempt?.outcome || 'unknown'),
    ms: finite(attempt?.ms)
  }));
}

export function recordTtsMetrics(guildId, sample) {
  const normalized = {
    at: Date.now(),
    preprocessMs: finite(sample.preprocessMs),
    speakerLabelWaitMs: finite(sample.speakerLabelWaitMs),
    queueMs: finite(sample.queueMs),
    providerMs: finite(sample.providerMs),
    ffmpegMs: finite(sample.ffmpegMs),
    ffmpegFirstPacketMs: finite(sample.ffmpegFirstPacketMs),
    discordBufferMs: finite(sample.discordBufferMs),
    playbackSpeed: finite(sample.playbackSpeed) || 1,
    // These are local pipeline timestamps. They are not a claim that a remote
    // Discord client physically heard the sample at this exact millisecond.
    timeToSpeechMs: finite(sample.timeToSpeechMs),
    timeToMessageSpeechMs: finite(sample.timeToMessageSpeechMs) || finite(sample.timeToSpeechMs),
    provider: String(sample.provider || 'unknown'),
    providerAttempts: normalizeAttempts(sample.providerAttempts)
  };

  let history = histories.get(guildId);
  if (!history) {
    if (histories.size >= 256) histories.delete(histories.keys().next().value);
    history = [];
    histories.set(guildId, history);
  }
  history.push(normalized);
  if (history.length > MAX_SAMPLES) history.splice(0, history.length - MAX_SAMPLES);
  return normalized;
}

function providerBreakdown(samples) {
  const out = Object.create(null);
  for (const sample of samples) {
    const key = sample.provider;
    const current = out[key] ?? { count: 0, totalMessageMs: 0, maxMessageMs: 0 };
    current.count += 1;
    current.totalMessageMs += sample.timeToMessageSpeechMs;
    current.maxMessageMs = Math.max(current.maxMessageMs, sample.timeToMessageSpeechMs);
    out[key] = current;
  }
  for (const value of Object.values(out)) {
    value.averageMessageMs = value.count ? value.totalMessageMs / value.count : 0;
    delete value.totalMessageMs;
  }
  return out;
}

function attemptBreakdown(samples) {
  const out = Object.create(null);
  for (const attempt of samples.flatMap((sample) => sample.providerAttempts)) {
    const key = `${attempt.provider}:${attempt.outcome}`;
    const current = out[key] ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += attempt.ms;
    current.maxMs = Math.max(current.maxMs, attempt.ms);
    out[key] = current;
  }
  for (const value of Object.values(out)) {
    value.averageMs = value.count ? value.totalMs / value.count : 0;
    delete value.totalMs;
  }
  return out;
}

export function getTtsMetrics(guildId, slowThresholdMs = 1500) {
  const samples = histories.get(guildId) ?? [];
  const terminalSamples = terminalHistories.get(guildId) ?? [];
  const outcomes = Object.fromEntries(['finished', 'stopped', 'unavailable'].map((outcome) => [outcome, terminalSamples.filter((sample) => sample.outcome === outcome).length]));
  outcomes.sampleSize = terminalSamples.length;
  if (!samples.length) {
    return {
      count: 0, last: null, average: null, percentiles: null, maxima: null,
      slowCount: 0, sampleSize: 0, providers: {}, attempts: {}, outcomes
    };
  }

  const fields = [
    'preprocessMs', 'speakerLabelWaitMs', 'queueMs', 'providerMs', 'ffmpegMs',
    'ffmpegFirstPacketMs', 'discordBufferMs', 'playbackSpeed', 'timeToSpeechMs',
    'timeToMessageSpeechMs'
  ];
  const averageValues = Object.fromEntries(fields.map((field) => [field, average(samples, field)]));

  return {
    count: samples.length,
    outcomes,
    sampleSize: samples.length,
    last: samples.at(-1),
    average: averageValues,
    percentiles: {
      firstSoundP50Ms: percentile(samples, 'timeToSpeechMs', 50),
      firstSoundP95Ms: percentile(samples, 'timeToSpeechMs', 95),
      messageP50Ms: percentile(samples, 'timeToMessageSpeechMs', 50),
      messageP95Ms: percentile(samples, 'timeToMessageSpeechMs', 95)
    },
    maxima: {
      firstSoundMs: max(samples, 'timeToSpeechMs'),
      messageMs: max(samples, 'timeToMessageSpeechMs')
    },
    slowCount: samples.filter((sample) => sample.timeToMessageSpeechMs >= slowThresholdMs).length,
    providers: providerBreakdown(samples),
    attempts: attemptBreakdown(samples)
  };
}

export function clearTtsMetrics(guildId) {
  histories.delete(guildId);
  terminalHistories.delete(guildId);
}

export function recordTtsOutcome(guildId, outcome) {
  if (!guildId) return;
  if (!terminalHistories.has(guildId) && terminalHistories.size >= 256) terminalHistories.delete(terminalHistories.keys().next().value);
  const samples = terminalHistories.get(guildId) ?? [];
  samples.push({ at: Date.now(), outcome });
  if (samples.length > MAX_SAMPLES) samples.shift();
  terminalHistories.set(guildId, samples);
}

export const __test = { percentile, providerBreakdown, attemptBreakdown };
