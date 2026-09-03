import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { settings, tempDir } from './config.js';
import { getOrAssignUserTtsVoice } from './store.js';
import { GEMINI_VOICES } from './voices.js';
import { resetGeminiLiveSessions, synthesizeGeminiLive } from './providers/gemini-live.js';
import { streamGoogleMalay } from './providers/google.js';
import { cancellationError, deadlineSignal, discardGenerated, raceWithSignal, throwIfAborted } from './cancellation.js';
import {
  disableGeminiApiKeySlot,
  getGeminiApiKeyRoundRobinStatus,
  nextGeminiApiKey,
  resetGeminiApiKeyRoundRobin
} from './gemini-key-config.js';

function newProviderState() {
  return {
    cooldownUntil: 0, cooldownReason: null, startedCount: 0,
    firstAudioSuccessCount: 0, successCount: 0, failureCount: 0,
    initialFailureCount: 0, midstreamFailureCount: 0, skippedCount: 0,
    runawayIncidentCount: 0, budgetMissCount: 0, lastFailureAt: 0, lastError: null,
    lastFailureKind: null, lastAttemptMs: 0, maxAttemptMs: 0, totalAttemptMs: 0,
    consecutiveFailures: 0, consecutiveQuotaFailures: 0,
    halfOpenProbeInFlight: false, halfOpenProbeToken: null,
    disabledUntilConfigChange: false, disabledConfigSignature: null,
    disabledReason: null
  };
}

const providerStates = {
  livePrimary: newProviderState(),
  google: newProviderState()
};
let geminiAuthDisabled = false;
let geminiBurstUntil = 0;
let globalHalfOpenProbeKey = null;
let halfOpenProbeSequence = 0;
let geminiSuccessCount = 0;
let fallbackCount = 0;
let lastProvider = null;
const recentGeminiQuotaFailures = [];

const geminiLimiter = {
  active: 0, queue: [], sequence: 0,
  waitCount: 0, totalWaitMs: 0, maxWaitMs: 0, prefetchDeferredCount: 0
};

export async function cleanupTempDirectory() {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
}

function configuredVoices() { return [...GEMINI_VOICES]; }
export function getOrAssignTtsVoice(guildId, userId) { return getOrAssignUserTtsVoice(guildId, userId, configuredVoices()); }
function chooseVoice(context = {}) {
  const voices = configuredVoices();
  const requested = String(context.voice ?? '').trim();
  if (voices.includes(requested)) return requested;
  if (context.guildId && context.userId) return getOrAssignTtsVoice(context.guildId, context.userId);
  return voices[0];
}

function healthOptions() {
  const raw = settings.providerHealth ?? {};
  return {
    quotaFirstSeconds: Math.max(5, Number(raw.quotaFirstSeconds) || 15),
    quotaSecondSeconds: Math.max(10, Number(raw.quotaSecondSeconds) || 60),
    quotaThirdSeconds: Math.max(30, Number(raw.quotaThirdSeconds) || 300),
    errorFirstSeconds: Math.max(5, Number(raw.errorFirstSeconds) || 8),
    errorSecondSeconds: Math.max(10, Number(raw.errorSecondSeconds) || 30),
    errorThirdSeconds: Math.max(30, Number(raw.errorThirdSeconds) || 120),
    budgetFirstSeconds: Math.max(3, Number(raw.budgetFirstSeconds) || 5),
    budgetSecondSeconds: Math.max(5, Number(raw.budgetSecondSeconds) || 15),
    budgetThirdSeconds: Math.max(15, Number(raw.budgetThirdSeconds) || 60),
    permissionSeconds: Math.max(30, Number(raw.permissionSeconds) || 300),
    burstWindowSeconds: Math.max(5, Number(raw.burstWindowSeconds) || 15),
    burstQuotaFailures: Math.max(2, Math.floor(Number(raw.burstQuotaFailures) || 2)),
    burstBypassSeconds: Math.max(10, Number(raw.burstBypassSeconds) || 45),
    globalGeminiConcurrency: Math.max(1, Math.min(4, Math.floor(Number(raw.globalGeminiConcurrency) || 2))),
    primaryFirstAudioMs: Math.max(800, Number(raw.primaryFirstAudioMs) || 2500),
  };
}

function stepValue(count, first, second, third) {
  if (count <= 1) return first;
  if (count === 2) return second;
  return third;
}

function providerConfigSignature(key) {
  if (key === 'livePrimary') {
    return JSON.stringify({ model: settings.geminiLive?.primaryModel, profile: settings.geminiLive?.profile });
  }
  return 'google';
}

function clearConfigDisableIfChanged(state, signature) {
  if (!state.disabledUntilConfigChange) return;
  if (signature === state.disabledConfigSignature) return;
  state.disabledUntilConfigChange = false;
  state.disabledConfigSignature = null;
  state.disabledReason = null;
  state.cooldownUntil = 0;
  state.cooldownReason = null;
  state.consecutiveFailures = 0;
  state.consecutiveQuotaFailures = 0;
}

function remainingSeconds(state) {
  if (state.disabledUntilConfigChange) return null;
  return Math.ceil(Math.max(0, state.cooldownUntil - Date.now()) / 1000);
}

function stateOptions(key) {
  if (key === 'google') return { quotaCooldownSeconds: 30, authCooldownSeconds: 30, errorCooldownSeconds: 8 };
  return settings.geminiLive ?? {};
}

function pacificDailyResetMs(now = Date.now()) {
  const timeZone = 'America/Los_Angeles';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const partsOf = (date) => Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  const offsetAt = (utcMs) => {
    const p = partsOf(new Date(utcMs));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
  };
  const current = partsOf(new Date(now));
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const localUtcGuess = Date.UTC(nextDay.getUTCFullYear(), nextDay.getUTCMonth(), nextDay.getUTCDate(), 0, 5, 0);
  let target = localUtcGuess;
  for (let i = 0; i < 3; i += 1) target = localUtcGuess - offsetAt(target);
  return Math.max(now + 60_000, target);
}

function recordGeminiQuotaFailure(key) {
  const now = Date.now();
  const health = healthOptions();
  const windowMs = health.burstWindowSeconds * 1000;
  recentGeminiQuotaFailures.push({ at: now, key });
  while (recentGeminiQuotaFailures.length && now - recentGeminiQuotaFailures[0].at > windowMs) recentGeminiQuotaFailures.shift();
  if (recentGeminiQuotaFailures.length >= health.burstQuotaFailures) {
    geminiBurstUntil = Math.max(geminiBurstUntil, now + health.burstBypassSeconds * 1000);
  }
}

function releaseHalfOpenProbe(key, state, token = undefined) {
  // Internal async completions pass the lease token they acquired. A late
  // completion from an older request must never clear a newer half-open probe.
  // Undefined is retained only for direct/manual test cleanup compatibility.
  if (token === null) return false;
  if (token !== undefined && state.halfOpenProbeToken !== token) return false;
  state.halfOpenProbeInFlight = false;
  state.halfOpenProbeToken = null;
  if (globalHalfOpenProbeKey === key) globalHalfOpenProbeKey = null;
  return true;
}

function beginHalfOpenProbeLease(key, state) {
  if (key === 'google' || state.consecutiveFailures <= 0) return { allowed: true, token: null };
  if (state.halfOpenProbeInFlight) return { allowed: false, token: null };
  if (globalHalfOpenProbeKey && globalHalfOpenProbeKey !== key) return { allowed: false, token: null };
  const token = ++halfOpenProbeSequence;
  state.halfOpenProbeInFlight = true;
  state.halfOpenProbeToken = token;
  globalHalfOpenProbeKey = key;
  return { allowed: true, token };
}

// Preserve the existing boolean helper for characterization tests and callers.
function beginHalfOpenProbe(key, state) {
  return beginHalfOpenProbeLease(key, state).allowed;
}

function providerReady(key, state, signature = providerConfigSignature(key)) {
  clearConfigDisableIfChanged(state, signature);
  if (state.disabledUntilConfigChange) return false;
  return Date.now() >= state.cooldownUntil;
}

function noteAttempt(state, elapsedMs) {
  const ms = Math.max(0, Number(elapsedMs) || 0);
  state.lastAttemptMs = ms;
  state.maxAttemptMs = Math.max(state.maxAttemptMs, ms);
  state.totalAttemptMs += ms;
}

function sanitizeProviderText(value) {
  return String(value ?? '')
    .replace(/([?&](?:key|api[_-]?key|apikey)=)[^&\s)]+/giu, '$1[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, '[redacted-api-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/giu, 'Bearer [redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1200);
}

function sanitizeProviderError(error) {
  return sanitizeProviderText(error?.message || error || 'Unknown provider error.');
}

function logProviderFailure(providerName, error, phase = 'initial') {
  if (error?.cancelled) return;
  const metadata = [
    error?.code != null ? `code=${sanitizeProviderText(error.code)}` : null,
    error?.status != null ? `status=${sanitizeProviderText(error.status)}` : null,
    error?.apiStatus != null ? `apiStatus=${sanitizeProviderText(error.apiStatus)}` : null,
    error?.reason ? `reason=${sanitizeProviderText(error.reason)}` : null
  ].filter(Boolean).join(' ');
  console.warn(`[provider-fail:${providerName}] phase=${phase}${metadata ? ` ${metadata}` : ''} message=${sanitizeProviderError(error)}`);
}

function setProviderFailure(state, error, options = {}, { phase = 'initial', budget = false, key = 'unknown', configSignature = null, probeToken = undefined } = {}) {
  // Budget/deadline failures must affect health even if a downstream provider
  // wrapped the abort as a cancellation. Explicit user/queue cancellation stays neutral.
  if (error?.cancelled && !budget) return;
  const now = Date.now();
  const health = healthOptions();
  state.consecutiveFailures += 1;
  if (error?.quotaLike) state.consecutiveQuotaFailures += 1;
  else state.consecutiveQuotaFailures = 0;

  let seconds = 0;
  let reason = 'temporary error';
  let kind = 'temporary error';

  if (error?.dailyQuotaLike) {
    state.cooldownUntil = pacificDailyResetMs(now);
    reason = 'daily quota (until Pacific reset)';
    kind = 'daily quota';
  } else if (error?.quotaLike) {
    seconds = stepValue(state.consecutiveQuotaFailures, health.quotaFirstSeconds, health.quotaSecondSeconds, health.quotaThirdSeconds);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
    reason = `quota/rate limit x${state.consecutiveQuotaFailures}`;
    kind = 'quota/rate limit';
  } else if (error?.configLike && key !== 'google') {
    state.disabledUntilConfigChange = true;
    state.disabledConfigSignature = configSignature ?? providerConfigSignature(key);
    state.disabledReason = 'request/config error';
    state.cooldownUntil = Number.MAX_SAFE_INTEGER;
    reason = 'request/config error (until restart/settings change)';
    kind = 'request/config';
  } else if (error?.authLike) {
    const authSeconds = Math.max(60, Number(options.authCooldownSeconds) || 300);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + authSeconds * 1000);
    reason = 'API key/auth';
    kind = 'API key/auth';
  } else if (error?.permissionLike) {
    state.cooldownUntil = Math.max(state.cooldownUntil, now + health.permissionSeconds * 1000);
    reason = 'model/project access';
    kind = 'model/project access';
  } else if (budget) {
    seconds = stepValue(state.consecutiveFailures, health.budgetFirstSeconds, health.budgetSecondSeconds, health.budgetThirdSeconds);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
    reason = `first-audio budget x${state.consecutiveFailures}`;
    kind = 'budget/deadline';
  } else {
    seconds = stepValue(state.consecutiveFailures, health.errorFirstSeconds, health.errorSecondSeconds, health.errorThirdSeconds);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
    reason = `${error?.setupLike && error?.transportLike ? 'transport/setup' : 'temporary error'} x${state.consecutiveFailures}`;
    kind = error?.setupLike && error?.transportLike ? 'transport/setup' : 'temporary error';
  }

  state.cooldownReason = reason;
  state.lastError = sanitizeProviderError(error);
  state.lastFailureKind = kind;
  state.failureCount += 1;
  state.lastFailureAt = now;
  if (budget) state.budgetMissCount += 1;
  if (phase === 'midstream') state.midstreamFailureCount += 1;
  else state.initialFailureCount += 1;
  releaseHalfOpenProbe(key, state, probeToken);
  if (key !== 'google' && error?.quotaLike) recordGeminiQuotaFailure(key);
}

function markFirstAudio(state) { state.firstAudioSuccessCount += 1; }
function markCompleted(state, requestStartedAt, geminiProvider = true, key = 'unknown', probeToken = undefined) {
  if (Number(requestStartedAt) >= Number(state.lastFailureAt || 0)) {
    state.cooldownUntil = 0; state.cooldownReason = null; state.lastError = null; state.lastFailureKind = null; state.lastFailureAt = 0;
    state.disabledUntilConfigChange = false; state.disabledConfigSignature = null; state.disabledReason = null;
    state.consecutiveFailures = 0; state.consecutiveQuotaFailures = 0;
  }
  releaseHalfOpenProbe(key, state, probeToken);
  state.successCount += 1;
  if (geminiProvider) geminiSuccessCount += 1;
  else fallbackCount += 1;
}
function noteSkipped(state, { budget = false } = {}) { state.skippedCount += 1; if (budget) state.budgetMissCount += 1; }

function pumpGeminiLimiter() {
  const max = healthOptions().globalGeminiConcurrency;
  geminiLimiter.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  while (geminiLimiter.active < max && geminiLimiter.queue.length) {
    const entry = geminiLimiter.queue.shift();
    if (entry.signal?.aborted) { entry.reject(entry.signal.reason || new Error('Gemini limiter wait cancelled.')); continue; }
    geminiLimiter.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      geminiLimiter.active = Math.max(0, geminiLimiter.active - 1);
      entry.cleanup?.();
      pumpGeminiLimiter();
    };
    const waitMs = Math.max(0, performance.now() - entry.enqueuedAt);
    entry.release = release;
    if (entry.waited) {
      geminiLimiter.waitCount += 1;
      geminiLimiter.totalWaitMs += waitMs;
      geminiLimiter.maxWaitMs = Math.max(geminiLimiter.maxWaitMs, waitMs);
    }
    entry.resolve(release);
  }
}

function acquireGeminiSlot(priority = 0, signal = null, promotionSignal = null) {
  return new Promise((resolve, reject) => {
    const entry = { priority, sequence: geminiLimiter.sequence++, signal, resolve, reject, enqueuedAt: performance.now(), waited: geminiLimiter.active >= healthOptions().globalGeminiConcurrency };
    const promote = () => { entry.priority = 0; pumpGeminiLimiter(); };
    const onAbort = () => {
      const index = geminiLimiter.queue.indexOf(entry);
      if (index >= 0) geminiLimiter.queue.splice(index, 1);
      entry.release?.();
      entry.cleanup();
      reject(signal.reason || cancellationError());
    };
    entry.cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      promotionSignal?.removeEventListener('abort', promote);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (promotionSignal?.aborted) entry.priority = 0;
    else promotionSignal?.addEventListener('abort', promote, { once: true });
    geminiLimiter.queue.push(entry);
    pumpGeminiLimiter();
  });
}

function makeBudgetError(provider, ms) {
  const error = new Error(`${provider} exceeded the remaining ${Math.max(0, Math.round(ms))}ms end-to-end first-audio budget.`);
  error.name = 'TtsFailoverBudgetError';
  error.budgetLike = true;
  error.transportLike = true;
  return error;
}

function googleFallbackWindowMs(_context = {}, remainingMs = 0) {
  return Math.min(Math.max(0, Number(remainingMs) || 0), Number(settings.googleTts?.timeoutMs) || 3500);
}

function attemptSignal(parentSignal, maxMs, providerName) {
  const controller = new AbortController();
  let timer = null;
  let parentAbort = null;
  const abort = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  if (parentSignal) {
    parentAbort = () => abort(parentSignal.reason);
    if (parentSignal.aborted) parentAbort();
    else parentSignal.addEventListener('abort', parentAbort, { once: true });
  }
  if (Number.isFinite(maxMs) && maxMs > 0) {
    timer = setTimeout(() => abort(makeBudgetError(providerName, maxMs)), Math.max(1, maxMs));
    timer.unref?.();
  }
  return {
    signal: controller.signal, abort,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parentSignal && parentAbort) parentSignal.removeEventListener?.('abort', parentAbort);
    }
  };
}

function recordRunawayMidstreamFailure(state, error, key = 'unknown', probeToken = undefined) {
  const now = Date.now();
  state.runawayIncidentCount += 1;
  state.failureCount += 1;
  state.midstreamFailureCount += 1;
  state.lastFailureAt = now;
  state.lastError = sanitizeProviderError(error);
  state.lastFailureKind = 'runaway/model-behavior';
  // First audio was healthy; runaway extra speech is model behavior, not
  // evidence that the provider cannot serve the next message. Do not apply
  // the normal provider cooldown or increment consecutive health failures.
  releaseHalfOpenProbe(key, state, probeToken);
}

function shouldIsolateLiveMidstreamFailure(error, key) {
  if (key !== 'livePrimary') return false;
  // Quota, credentials, access and invalid request/config errors describe a
  // real condition that can affect the next fresh Live turn. Temporary errors
  // after first audio do not: each Discord message opens a new one-turn session.
  return !error?.cancelled
    && !error?.budgetLike
    && !error?.dailyQuotaLike
    && !error?.quotaLike
    && !error?.authLike
    && !error?.permissionLike
    && !error?.configLike;
}

function recordIsolatedLiveMidstreamFailure(state, error, key = 'unknown', probeToken = undefined) {
  state.failureCount += 1;
  state.midstreamFailureCount += 1;
  state.lastFailureAt = Date.now();
  state.lastError = sanitizeProviderError(error);
  state.lastFailureKind = error?.transportLike ? 'midstream/transport' : 'midstream/temporary';
  // Do not increment consecutiveFailures or apply a provider cooldown. Recovery
  // still handles the current audio; the next message gets a fresh Live turn.
  releaseHalfOpenProbe(key, state, probeToken);
}

function observeCompletion(key, state, generated, providerName, requestStartedAt, options, geminiProvider, configSignature, probeToken = undefined) {
  const completion = generated?.completion;
  if (!completion || typeof completion.then !== 'function') {
    markCompleted(state, requestStartedAt, geminiProvider, key, probeToken);
    return;
  }
  completion.then(() => markCompleted(state, requestStartedAt, geminiProvider, key, probeToken)).catch((error) => {
    if (error?.runawayLike) {
      recordRunawayMidstreamFailure(state, error, key, probeToken);
      console.warn(`[provider-runaway:${providerName}] phase=midstream isolated=true message=${sanitizeProviderError(error)}`);
      return;
    }
    if (shouldIsolateLiveMidstreamFailure(error, key)) {
      recordIsolatedLiveMidstreamFailure(state, error, key, probeToken);
      console.warn(`[provider-midstream:${providerName}] isolated=true message=${sanitizeProviderError(error)}`);
      return;
    }
    const budget = Boolean(error?.budgetLike || error?.name === 'TtsFailoverBudgetError');
    if (error?.cancelled && !budget) { releaseHalfOpenProbe(key, state, probeToken); return; }
    setProviderFailure(state, error, options, { phase: 'midstream', budget, key, configSignature, probeToken });
    logProviderFailure(providerName, error, 'midstream');
  });
}

function generatedResult(generated, provider, attemptMs, totalMs, attempts) {
  return {
    audioBuffer: generated.audioBuffer,
    audioStream: generated.audioStream,
    mimeType: generated.mimeType,
    audioFormat: generated.audioFormat,
    sampleRate: generated.sampleRate,
    channels: generated.channels,
    provider,
    voice: generated.voice,
    usage: generated.usage,
    completion: generated.completion,
    cancel: generated.cancel,
    metrics: { providerMs: attemptMs, firstAudioTotalMs: totalMs, attempts: attempts.map((item) => ({ ...item })) }
  };
}

async function bufferGenerated(generated, parentSignal = null) {
  if (!generated?.audioStream || typeof generated.audioStream[Symbol.asyncIterator] !== 'function') return generated;
  const parts = [];
  let bytes = 0;
  let abortListener = null;
  const lifetime = deadlineSignal(parentSignal, 65_000, makeBudgetError('Buffered speech completion', 65_000));
  const signal = lifetime.signal;
  abortListener = () => discardGenerated(generated, signal.reason);
  if (signal.aborted) abortListener();
  else signal.addEventListener('abort', abortListener, { once: true });
  try {
    throwIfAborted(signal);
    const iterator = generated.audioStream[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await raceWithSignal(iterator.next(), signal);
      throwIfAborted(signal);
      if (done) break;
      const part = Buffer.from(value);
      if (bytes + part.length > 8 * 1024 * 1024) throw new Error('Buffered speech exceeded 8 MiB.');
      parts.push(part);
      bytes += part.length;
    }
    // Audio-stream end is sufficient to make a prefetched/buffered item ready
    // for playback. Do not wait here for delayed turnComplete metadata; keep the
    // original completion promise so audio.js can observe it under its separate
    // completionGraceMs without adding dead silence to the queue.
    return {
      ...generated,
      audioStream: null,
      audioBuffer: Buffer.concat(parts, bytes),
      completion: generated.completion,
      cancel: generated.cancel
    };
  } catch (error) {
    discardGenerated(generated, error);
    throw error;
  } finally {
    signal.removeEventListener('abort', abortListener);
    lifetime.cleanup();
  }
}

function liveOptions(model, signal, windowMs, apiKey) {
  const configuredSetup = Number(settings.geminiLive?.setupTimeoutMs) || 2500;
  const configuredFirst = Number(settings.geminiLive?.firstAudioTimeoutMs) || 3500;
  return {
    apiKey,
    model,
    firstAudioTimeoutMs: Math.max(500, Math.min(configuredFirst, windowMs)),
    streamIdleTimeoutMs: Number(settings.geminiLive?.streamIdleTimeoutMs) || 2800,
    audioEndGraceMs: Number(settings.geminiLive?.audioEndGraceMs) || 650,
    setupTimeoutMs: Math.max(500, Math.min(configuredSetup, Math.max(500, windowMs * 0.55))),
    profile: settings.geminiLive?.profile,
    maxOutputAudioMs: settings.geminiLive?.maxOutputAudioMs,
    outputAudioTranscription: settings.geminiLive?.outputAudioTranscription !== false,
    mirrorStreamingPcm: settings.audioPipeline?.mirrorStreamingPcm !== false,
    signal
  };
}

function googleOptions(signal, windowMs) {
  const configuredChunk = Number(settings.googleTts?.chunkLength);
  const maximumLength = !Number.isFinite(configuredChunk) ? 200 : configuredChunk;
  return {
    timeoutMs: Math.max(250, Math.min(Number(settings.googleTts?.timeoutMs) || 3500, windowMs)),
    completionTimeoutMs: Number(settings.googleTts?.completionTimeoutMs) || 12_000,
    maximumLength,
    retryCount: windowMs >= 1200 ? settings.googleTts?.retryCount : 0,
    retryDelayMs: settings.googleTts?.retryDelayMs,
    parallelChunks: settings.googleTts?.parallelChunks,
    maxAudioBytes: settings.googleTts?.maxAudioBytes,
    signal
  };
}

function maybeDisableGeminiAuth(error, apiKeySlot = null) {
  if (!error?.authLike) return false;
  if (apiKeySlot != null) {
    const keyStatus = disableGeminiApiKeySlot(apiKeySlot);
    if (keyStatus.availableCount > 0) {
      console.warn(`[gemini-keys] Disabled slot ${apiKeySlot} after API-key auth failure; ${keyStatus.availableCount} configured key(s) remain available.`);
      return false;
    }
  }

  geminiAuthDisabled = true;
  const now = Date.now();
  for (const state of [providerStates.livePrimary]) {
    state.cooldownUntil = Number.MAX_SAFE_INTEGER;
    state.cooldownReason = 'API key/access (until restart)';
    state.lastError = sanitizeProviderError(error);
    state.lastFailureKind = 'API key/access';
    state.lastFailureAt = now;
  }
  return true;
}

async function runAttempt({
  key, providerName, windowMs, parentSignal, attempts, factory, options,
  geminiProvider = true, priority = 0, apiKeySlot = null,
  deferBudgetUntilGeminiSlot = false, onLimiterWait = null, promotionSignal = null
}) {
  const state = providerStates[key];
  const configSignature = providerConfigSignature(key);
  if (!providerReady(key, state, configSignature)) {
    noteSkipped(state);
    attempts.push({ provider: providerName, outcome: state.disabledUntilConfigChange ? 'config-disabled-skip' : 'cooldown-skip', ms: 0 });
    return { result: null, error: null };
  }
  const probeLease = beginHalfOpenProbeLease(key, state);
  if (!probeLease.allowed) {
    noteSkipped(state);
    attempts.push({ provider: providerName, outcome: 'half-open-skip', ms: 0 });
    return { result: null, error: null };
  }
  const probeToken = probeLease.token;
  if (windowMs < 250) {
    releaseHalfOpenProbe(key, state, probeToken);
    noteSkipped(state, { budget: true });
    attempts.push({ provider: providerName, outcome: 'budget-skip', ms: 0 });
    return { result: null, error: makeBudgetError(providerName, windowMs) };
  }
  const requestStartedAt = Date.now();
  const started = performance.now();
  let providerStartedAt = started;
  let abortable = null;
  let releaseGemini = null;
  let releaseOwnedByCompletion = false;
  let providerStarted = false;
  try {
    if (geminiProvider && deferBudgetUntilGeminiSlot) {
      const limiterWaitStarted = performance.now();
      const wait = deadlineSignal(parentSignal, 15_000, makeBudgetError(providerName, 15_000));
      let promotionTimer;
      const promote = () => {
        promotionTimer = setTimeout(() => wait.cancel(makeBudgetError(providerName, windowMs)), windowMs);
        promotionTimer.unref?.();
      };
      if (promotionSignal?.aborted) promote();
      else promotionSignal?.addEventListener('abort', promote, { once: true });
      try { releaseGemini = await acquireGeminiSlot(priority, wait.signal, promotionSignal); }
      finally { wait.cleanup(); clearTimeout(promotionTimer); promotionSignal?.removeEventListener('abort', promote); }
      const limiterWaitMs = Math.max(0, performance.now() - limiterWaitStarted);
      if (limiterWaitMs >= 1) geminiLimiter.prefetchDeferredCount += 1;
      if (typeof onLimiterWait === 'function') onLimiterWait(limiterWaitMs);
      // Speculative prefetch should not burn a remote first-audio window while
      // merely waiting for a local Gemini concurrency slot.
      providerStartedAt = performance.now();
      abortable = attemptSignal(parentSignal, windowMs, providerName);
    } else {
      abortable = attemptSignal(parentSignal, windowMs, providerName);
      if (geminiProvider) releaseGemini = await acquireGeminiSlot(priority, abortable.signal, promotionSignal);
    }
    throwIfAborted(abortable.signal);
    state.startedCount += 1;
    providerStarted = true;
    const generated = await raceWithSignal(factory(abortable.signal, options), abortable.signal, discardGenerated);
    throwIfAborted(abortable.signal);
    // Keep ownership bounded after first audio, including providers whose
    // completion promise never responds to remote cancellation.
    const lifetime = deadlineSignal(parentSignal, 65_000, makeBudgetError(`${providerName} completion`, 65_000));
    const cancelGenerated = () => { abortable.abort(lifetime.signal.reason); discardGenerated(generated, lifetime.signal.reason); };
    lifetime.signal.addEventListener('abort', cancelGenerated, { once: true });
    if (lifetime.signal.aborted) cancelGenerated();
    generated.completion = raceWithSignal(generated.completion, lifetime.signal).finally(() => {
      lifetime.signal.removeEventListener('abort', cancelGenerated);
      lifetime.cleanup();
    });
    generated.completion.catch(() => {});
    const elapsed = performance.now() - providerStartedAt;
    noteAttempt(state, elapsed);
    markFirstAudio(state);
    attempts.push({ provider: providerName, outcome: 'first-audio', ms: elapsed });
    if (releaseGemini) {
      const release = releaseGemini;
      releaseOwnedByCompletion = true;
      // Explicit queue/user cancellation must release local Gemini ownership
      // immediately. Waiting for a remote streaming body to notice abort can
      // otherwise make the next TTS inherit a stale busy limiter/probe state.
      // release() is idempotent, so normal completion can safely call it again.
      let parentCancelRelease = null;
      if (parentSignal) {
        parentCancelRelease = () => {
          release();
          releaseHalfOpenProbe(key, state, probeToken);
        };
        if (parentSignal.aborted) parentCancelRelease();
        else parentSignal.addEventListener('abort', parentCancelRelease, { once: true });
      }
      Promise.resolve(generated?.completion).finally(() => {
        if (parentSignal && parentCancelRelease) parentSignal.removeEventListener?.('abort', parentCancelRelease);
        release();
      }).catch(() => {});
    }
    observeCompletion(key, state, generated, providerName, requestStartedAt, stateOptions(key), geminiProvider, configSignature, probeToken);
    lastProvider = providerName;
    return { result: generated, error: null, elapsed, firstAudioAt: performance.now() };
  } catch (rawError) {
    const error = parentSignal?.aborted ? cancellationError(parentSignal.reason)
      : abortable?.signal?.aborted && abortable.signal.reason instanceof Error ? abortable.signal.reason : rawError;
    const elapsed = performance.now() - providerStartedAt;
    noteAttempt(state, elapsed);
    const budget = Boolean(error?.budgetLike || error?.name === 'TtsFailoverBudgetError');
    if (!providerStarted) {
      releaseHalfOpenProbe(key, state, probeToken);
      noteSkipped(state, { budget });
      attempts.push({ provider: providerName, outcome: budget ? 'limiter-budget-skip' : 'limiter-cancelled', ms: elapsed, error: String(error?.name || 'Error') });
      return { result: null, error, elapsed };
    }
    if (budget || !error?.cancelled) {
      setProviderFailure(state, error, stateOptions(key), { phase: 'initial', budget, key, configSignature, probeToken });
      if (!budget && !error?.cancelled) logProviderFailure(providerName, error, 'initial');
    } else releaseHalfOpenProbe(key, state, probeToken);

    const authGateDisabled = maybeDisableGeminiAuth(geminiProvider ? error : null, apiKeySlot);
    if (geminiProvider && error?.authLike && !authGateDisabled) {
      // A bad key slot should not cool down the provider for the other configured
      // keys. The failing slot is removed from the round-robin until /restarttts.
      state.cooldownUntil = 0;
      state.cooldownReason = null;
      state.consecutiveFailures = 0;
      state.consecutiveQuotaFailures = 0;
    }

    attempts.push({ provider: providerName, outcome: budget ? 'budget-fail' : error?.cancelled ? 'cancelled' : error?.configLike ? 'config-fail' : 'failure', ms: elapsed, error: String(error?.name || 'Error') });
    return { result: null, error, elapsed };
  } finally {
    if (releaseGemini && !releaseOwnedByCompletion) releaseGemini();
    abortable?.cleanup();
  }
}

export async function synthesize(text, context = {}) {
  throwIfAborted(context.signal);
  const value = String(text ?? '').trim();
  if (!value) throw new Error('TTS received empty text.');
  const googleValue = String(context.googleText ?? value).trim() || value;
  const started = performance.now();
  const voice = chooseVoice(context);
  const attempts = [];
  // Generated answers and recovery tails require literal speech. Live has no
  // independent lexical guarantee, so these use the deterministic fallback.
  const skipLive = context.skipLive === true || context.literal === true;
  const geminiKey = !skipLive && settings.geminiLive?.enabled !== false ? nextGeminiApiKey() : null;
  const configuredBudget = Number(settings.geminiLive?.firstAudioBudgetMs) || 7000;
  const deadline = started + configuredBudget;
  let deferredLimiterWaitMs = 0;
  const remaining = () => Math.max(0, deadline - performance.now() + deferredLimiterWaitMs);
  const parentSignal = context.signal;
  const health = healthOptions();
  const bufferSelected = async (attempt, providerName) => {
    if (!attempt.result || context.liveStreamOutput !== false) return attempt;
    try {
      return { ...attempt, result: await bufferGenerated(attempt.result, parentSignal) };
    } catch (error) {
      throwIfAborted(parentSignal);
      discardGenerated(attempt.result, error);
      attempts.push({ provider: providerName, outcome: 'buffer-failure', ms: 0, error: String(error?.name || 'Error') });
      return { ...attempt, result: null, error };
    }
  };
  if (geminiKey?.key && !geminiAuthDisabled && Date.now() >= geminiBurstUntil) {
    // Preserve the working 2500ms Live first window and setup cap. Removing
    // intermediate providers leaves Google its complete configured window.
    const window = Math.min(Number(settings.geminiLive?.firstAudioTimeoutMs) || 3500, health.primaryFirstAudioMs,
      Math.max(0, remaining() - (Number(settings.googleTts?.timeoutMs) || 3500)));
    let primary = await runAttempt({
      key: 'livePrimary', providerName: 'gemini-3.1-live', windowMs: window, parentSignal, attempts,
      factory: (signal) => synthesizeGeminiLive(value, voice, liveOptions(settings.geminiLive.primaryModel, signal, window, geminiKey.key)),
      priority: context.prefetch === true ? 1 : 0,
      apiKeySlot: geminiKey.slot,
      deferBudgetUntilGeminiSlot: context.prefetch === true,
      promotionSignal: context.promotionSignal,
      onLimiterWait: (ms) => { deferredLimiterWaitMs += Math.max(0, Number(ms) || 0); }
    });
    throwIfAborted(parentSignal);
    primary = await bufferSelected(primary, 'gemini-3.1-live');
    if (primary.result) return generatedResult(primary.result, 'gemini-3.1-live', primary.elapsed, (primary.firstAudioAt ?? performance.now()) - started, attempts);
  } else if (geminiKey?.key && Date.now() < geminiBurstUntil) {
    noteSkipped(providerStates.livePrimary);
    attempts.push({ provider: 'gemini-3.1-live', outcome: 'burst-bypass', ms: 0 });
  }

  throwIfAborted(parentSignal);
  const googleWindow = googleFallbackWindowMs(context, remaining());
  let google = await runAttempt({
    key: 'google', providerName: 'google-ms', windowMs: googleWindow, parentSignal, attempts, geminiProvider: false,
    factory: (signal) => streamGoogleMalay(googleValue, googleOptions(signal, googleWindow))
  });
  throwIfAborted(parentSignal);
  google = await bufferSelected(google, 'google-ms');
  if (!google.result) {
    const error = google.error || new Error('All TTS providers failed before first audio.');
    error.attempts = attempts;
    throw error;
  }
  const result = generatedResult({ ...google.result, voice: 'Google Malay' }, 'google-ms', google.elapsed, (google.firstAudioAt ?? performance.now()) - started, attempts);
  result.assignedGeminiVoice = voice;
  return result;
}

function publicProviderState(state, unavailableReason = null) {
  const seconds = remainingSeconds(state);
  const disabled = Boolean(state.disabledUntilConfigChange);
  const displaySeconds = seconds != null && seconds >= 1e9 ? null : seconds;
  return {
    ready: !unavailableReason && !disabled && !state.halfOpenProbeInFlight && (seconds ?? 0) <= 0,
    unavailableReason,
    disabled,
    disabledReason: disabled ? state.disabledReason : null,
    cooldownActive: !disabled && (seconds ?? 0) > 0,
    cooldownRemainingSeconds: disabled ? null : displaySeconds,
    cooldownReason: disabled ? state.cooldownReason : ((seconds ?? 0) > 0 ? state.cooldownReason : null),
    halfOpenProbeInFlight: state.halfOpenProbeInFlight,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveQuotaFailures: state.consecutiveQuotaFailures,
    firstAudioSuccessCount: state.firstAudioSuccessCount,
    successCount: state.successCount,
    failureCount: state.failureCount,
    startedCount: state.startedCount,
    initialFailureCount: state.initialFailureCount,
    midstreamFailureCount: state.midstreamFailureCount,
    skippedCount: state.skippedCount,
    budgetMissCount: state.budgetMissCount,
    runawayIncidentCount: state.runawayIncidentCount,
    lastError: state.lastError,
    lastFailureKind: state.lastFailureKind,
    lastAttemptMs: state.lastAttemptMs,
    averageAttemptMs: state.startedCount ? state.totalAttemptMs / state.startedCount : 0,
    maxAttemptMs: state.maxAttemptMs
  };
}

export function restartTtsRuntime() {
  resetGeminiLiveSessions();
  resetGeminiApiKeyRoundRobin();
  geminiAuthDisabled = false;
  geminiBurstUntil = 0;
  globalHalfOpenProbeKey = null;
  recentGeminiQuotaFailures.length = 0;
  geminiLimiter.waitCount = 0;
  geminiLimiter.totalWaitMs = 0;
  geminiLimiter.maxWaitMs = 0;
  geminiLimiter.prefetchDeferredCount = 0;
  for (const state of Object.values(providerStates)) {
    const fresh = newProviderState();
    for (const key of Object.keys(fresh)) state[key] = fresh[key];
  }
}

export function getTtsProviderStatus() {
  const geminiKeys = getGeminiApiKeyRoundRobinStatus();
  return {
    geminiConfigured: geminiKeys.configuredCount > 0,
    geminiKeyRoundRobin: geminiKeys,
    geminiAuthDisabled,
    geminiLiveEnabled: settings.geminiLive?.enabled !== false,
    voices: configuredVoices(),
    primaryModel: String(settings.geminiLive?.primaryModel || 'gemini-3.1-flash-live-preview'),
    livePrimary: publicProviderState(providerStates.livePrimary,
      settings.geminiLive?.enabled === false ? 'disabled in settings'
        : !geminiKeys.availableCount ? 'no usable key'
          : geminiAuthDisabled ? 'authentication disabled'
            : Date.now() < geminiBurstUntil ? 'quota burst bypass' : null),
    google: publicProviderState(providerStates.google),
    geminiSuccessCount,
    fallbackCount,
    burstBypassActive: Date.now() < geminiBurstUntil,
    burstBypassRemainingSeconds: Math.ceil(Math.max(0, geminiBurstUntil - Date.now()) / 1000),
    halfOpenProbeKey: globalHalfOpenProbeKey,
    geminiLimiter: {
      active: geminiLimiter.active, queued: geminiLimiter.queue.length, max: healthOptions().globalGeminiConcurrency,
      waitCount: geminiLimiter.waitCount, totalWaitMs: geminiLimiter.totalWaitMs,
      maxWaitMs: geminiLimiter.maxWaitMs, prefetchDeferredCount: geminiLimiter.prefetchDeferredCount
    },
    lastProvider
  };
}


export const __test = { makeBudgetError, googleFallbackWindowMs, setProviderFailure, recordRunawayMidstreamFailure, recordIsolatedLiveMidstreamFailure, shouldIsolateLiveMidstreamFailure, newProviderState, bufferGenerated, healthOptions, pacificDailyResetMs, recordGeminiQuotaFailure, providerReady, acquireGeminiSlot, runAttempt, providerConfigSignature, beginHalfOpenProbe, beginHalfOpenProbeLease, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError };
