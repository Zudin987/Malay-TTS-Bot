import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { settings, tempDir } from './config.js';
import { getOrAssignUserTtsVoice } from './store.js';
import { synthesizeGemini, GEMINI_VOICES } from './providers/gemini.js';
import { resetGeminiLiveSessions, synthesizeGeminiLive } from './providers/gemini-live.js';
import { shouldBypassGeminiLiveForReadAloud } from './live-readaloud-guard.js';
import { streamGoogleMalay } from './providers/google.js';
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
  liveFallback: newProviderState(),
  exactTts: newProviderState(),
  google: newProviderState()
};
let geminiAuthDisabled = false;
let sharedLiveTransportUntil = 0;
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
const FALLBACK_QUOTA_BACKOFF_AFTER = 3;
const FALLBACK_QUOTA_BACKOFF_SECONDS = 30 * 60;
const ASK_EXACT_BUFFERED_TIMEOUT_MS = 10_000;

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
    fallbackFirstAudioMs: Math.max(600, Number(raw.fallbackFirstAudioMs) || 1600),
    exactFirstAudioMs: Math.max(600, Number(raw.exactFirstAudioMs) || 1600),
    googleReserveMs: Math.max(500, Number(raw.googleReserveMs) || 1200)
  };
}

function exactFirstAudioWindowCap(context = {}, health = healthOptions()) {
  // Explicit skipLive is the dedicated exact-TTS path used by /ask. Normal
  // Live-first chat keeps the short exact fallback window for latency.
  return context.skipLive === true
    ? Math.max(500, Number(settings.geminiTts?.timeoutMs) || 4000)
    : health.exactFirstAudioMs;
}

function isBufferedExactContext(context = {}) {
  return context.skipLive === true && context.liveStreamOutput === false;
}

function exactAttemptWindowMs(context = {}, health = healthOptions()) {
  if (isBufferedExactContext(context)) return ASK_EXACT_BUFFERED_TIMEOUT_MS;
  return exactFirstAudioWindowCap(context, health);
}

function stepValue(count, first, second, third) {
  if (count <= 1) return first;
  if (count === 2) return second;
  return third;
}

function providerConfigSignature(key) {
  if (key === 'exactTts') {
    return JSON.stringify({ model: settings.geminiTts?.model, profile: exactProfile() });
  }
  if (key === 'livePrimary') {
    return JSON.stringify({ model: settings.geminiLive?.primaryModel, profile: settings.geminiLive?.profile });
  }
  if (key === 'liveFallback') {
    return JSON.stringify({ model: settings.geminiLive?.fallbackModel, profile: settings.geminiLive?.profile });
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
  if (key === 'exactTts') return settings.geminiTts ?? {};
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
    const persistentFallbackQuota = key === 'liveFallback'
      && state.consecutiveQuotaFailures >= FALLBACK_QUOTA_BACKOFF_AFTER;
    seconds = persistentFallbackQuota
      ? FALLBACK_QUOTA_BACKOFF_SECONDS
      : stepValue(state.consecutiveQuotaFailures, health.quotaFirstSeconds, health.quotaSecondSeconds, health.quotaThirdSeconds);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
    reason = persistentFallbackQuota
      ? `quota/rate limit x${state.consecutiveQuotaFailures} (fallback probe in ${seconds}s)`
      : `quota/rate limit x${state.consecutiveQuotaFailures}`;
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
    geminiLimiter.waitCount += 1;
    geminiLimiter.totalWaitMs += waitMs;
    geminiLimiter.maxWaitMs = Math.max(geminiLimiter.maxWaitMs, waitMs);
    entry.resolve(release);
  }
}

function acquireGeminiSlot(priority = 0, signal = null) {
  return new Promise((resolve, reject) => {
    const entry = { priority, sequence: geminiLimiter.sequence++, signal, resolve, reject, cleanup: null, enqueuedAt: performance.now() };
    if (signal) {
      const onAbort = () => {
        const index = geminiLimiter.queue.indexOf(entry);
        if (index >= 0) geminiLimiter.queue.splice(index, 1);
        reject(signal.reason || new Error('Gemini limiter wait cancelled.'));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener?.('abort', onAbort);
    }
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

function googleFallbackWindowMs(context = {}, remainingMs = 0) {
  const remaining = Math.max(0, Number(remainingMs) || 0);
  if (context?.skipLive !== true) return remaining;
  // /ask intentionally uses dedicated exact TTS before Google. Buffering exact
  // audio can outlive the normal 7s first-audio budget, so a failed exact stream
  // must not starve the deterministic fallback with a 0ms window.
  return Math.max(500, Math.min(Number(settings.googleTts?.timeoutMs) || 3500, 15_000));
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
  if (key !== 'livePrimary' && key !== 'liveFallback') return false;
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
  if (parentSignal) {
    abortListener = () => { try { generated.cancel?.(parentSignal.reason || new Error('Buffered TTS cancelled.')); } catch {} };
    if (parentSignal.aborted) abortListener();
    else parentSignal.addEventListener('abort', abortListener, { once: true });
  }
  try {
    for await (const chunk of generated.audioStream) {
      const part = Buffer.from(chunk);
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
  } finally {
    if (parentSignal && abortListener) parentSignal.removeEventListener?.('abort', abortListener);
  }
}

function exactProfile() {
  const profile = { ...(settings.geminiTts?.profile ?? {}) };
  // Keep the old top-level overrides working for existing custom installs.
  if (typeof settings.geminiTts?.systemInstruction === 'string' && settings.geminiTts.systemInstruction.trim()) profile.systemInstruction = settings.geminiTts.systemInstruction.trim();
  if (typeof settings.geminiTts?.stylePrompt === 'string' && settings.geminiTts.stylePrompt.trim()) profile.stylePrompt = settings.geminiTts.stylePrompt.trim();
  return profile;
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
    retryCount: 0,
    retryDelayMs: settings.geminiLive?.retryDelayMs,
    profile: settings.geminiLive?.profile,
    maxOutputAudioMs: settings.geminiLive?.maxOutputAudioMs,
    outputAudioTranscription: settings.geminiLive?.outputAudioTranscription !== false,
    mirrorStreamingPcm: settings.audioPipeline?.mirrorStreamingPcm !== false,
    signal
  };
}

function exactOptions(signal, windowMs, apiKey, context = {}) {
  const buffered = isBufferedExactContext(context);
  return {
    apiKey,
    model: settings.geminiTts?.model,
    timeoutMs: Math.max(500, Math.min(Number(settings.geminiTts?.timeoutMs) || 4000, windowMs)),
    bufferedTimeoutMs: buffered ? windowMs : undefined,
    streaming: !buffered,
    streamIdleTimeoutMs: Number(settings.geminiTts?.streamIdleTimeoutMs) || 2500,
    maxOutputAudioMs: Number(settings.geminiTts?.maxOutputAudioMs) || 45_000,
    retryCount: 0,
    retryDelayMs: settings.geminiTts?.retryDelayMs,
    profile: exactProfile(),
    signal
  };
}

function googleOptions(signal, windowMs) {
  const configuredChunk = Number(settings.googleTts?.chunkLength);
  const maximumLength = !Number.isFinite(configuredChunk) || configuredChunk === 180 ? 200 : configuredChunk;
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
  for (const state of [providerStates.livePrimary, providerStates.liveFallback, providerStates.exactTts]) {
    state.cooldownUntil = Number.MAX_SAFE_INTEGER;
    state.cooldownReason = 'API key/access (until restart)';
    state.lastError = sanitizeProviderError(error);
    state.lastFailureKind = 'API key/access';
    state.lastFailureAt = now;
  }
  return true;
}

function shareLiveTransportFailure(error) {
  // Quota/auth/access failures are model/project-specific until proven otherwise.
  // Only genuine shared network/setup failures suppress both Live models.
  if (!error?.setupLike || !error?.transportLike || error?.quotaLike || error?.authLike || error?.permissionLike) return;
  const seconds = Math.max(5, Number(settings.geminiLive?.errorCooldownSeconds) || 15);
  sharedLiveTransportUntil = Math.max(sharedLiveTransportUntil, Date.now() + seconds * 1000);
  const state = providerStates.liveFallback;
  state.cooldownUntil = Math.max(state.cooldownUntil, sharedLiveTransportUntil);
  state.cooldownReason = 'shared Live transport/setup';
  state.lastError = `Skipped after primary Live setup/transport failure: ${sanitizeProviderError(error)}`;
  state.lastFailureKind = 'transport/setup';
  state.lastFailureAt = Date.now();
}

async function runAttempt({
  key, providerName, windowMs, parentSignal, attempts, factory, options,
  geminiProvider = true, priority = 0, apiKeySlot = null,
  deferBudgetUntilGeminiSlot = false, onLimiterWait = null
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
      releaseGemini = await acquireGeminiSlot(priority, parentSignal);
      const limiterWaitMs = Math.max(0, performance.now() - limiterWaitStarted);
      if (limiterWaitMs >= 1) geminiLimiter.prefetchDeferredCount += 1;
      if (typeof onLimiterWait === 'function') onLimiterWait(limiterWaitMs);
      // Speculative prefetch should not burn a remote first-audio window while
      // merely waiting for a local Gemini concurrency slot.
      providerStartedAt = performance.now();
      abortable = attemptSignal(parentSignal, windowMs, providerName);
    } else {
      abortable = attemptSignal(parentSignal, windowMs, providerName);
      if (geminiProvider) releaseGemini = await acquireGeminiSlot(priority, abortable.signal);
    }
    state.startedCount += 1;
    providerStarted = true;
    const generated = await factory(abortable.signal, options);
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
    const error = abortable?.signal?.aborted && abortable.signal.reason instanceof Error ? abortable.signal.reason : rawError;
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
  const value = String(text ?? '').trim();
  if (!value) throw new Error('TTS received empty text.');
  const googleValue = String(context.googleText ?? value).trim() || value;
  const started = performance.now();
  const voice = chooseVoice(context);
  const attempts = [];
  const bypassLiveForReadAloud = context.skipLive !== true && shouldBypassGeminiLiveForReadAloud(value);
  const skipLive = context.skipLive === true || bypassLiveForReadAloud;
  const geminiKey = nextGeminiApiKey();
  const requestApiKey = geminiKey?.key ?? null;
  const requestApiKeySlot = geminiKey?.slot ?? null;
  let requestGeminiUsable = Boolean(requestApiKey) && !geminiAuthDisabled;
  const configuredBudget = Math.max(2500, Math.min(Number(settings.geminiLive?.firstAudioBudgetMs) || 7000, 20_000));
  const deadline = started + configuredBudget;
  let deferredLimiterWaitMs = 0;
  const remaining = () => Math.max(0, deadline - performance.now() + deferredLimiterWaitMs);
  const parentSignal = context.signal;
  const bufferProviders = context.liveStreamOutput === false;
  const attemptPriority = context.prefetch === true ? 1 : 0;
  const deferGeminiBudgetForPrefetch = context.prefetch === true;
  const creditLimiterWait = (ms) => {
    if (deferGeminiBudgetForPrefetch) deferredLimiterWaitMs += Math.max(0, Number(ms) || 0);
  };
  const burstBypass = () => Date.now() < geminiBurstUntil;

  const bufferSelected = async (attempt, providerName) => {
    if (!attempt.result || !bufferProviders) return attempt;
    try {
      return { ...attempt, result: await bufferGenerated(attempt.result, parentSignal) };
    } catch (error) {
      if (parentSignal?.aborted) throw (parentSignal.reason instanceof Error ? parentSignal.reason : error);
      attempts.push({ provider: providerName, outcome: 'buffer-failure', ms: 0, error: String(error?.name || 'Error') });
      return { ...attempt, result: null, error };
    }
  };
  const hasGemini = Boolean(requestApiKey) && !geminiAuthDisabled;
  const health = healthOptions();

  if (bypassLiveForReadAloud) {
    noteSkipped(providerStates.livePrimary);
    noteSkipped(providerStates.liveFallback);
    attempts.push({ provider: 'gemini-3.1-live', outcome: 'literal-readaloud-guard', ms: 0 });
    attempts.push({ provider: 'gemini-2.5-live', outcome: 'literal-readaloud-guard', ms: 0 });
  }

  if (requestGeminiUsable && !burstBypass() && settings.geminiLive?.enabled !== false && skipLive !== true && Date.now() >= sharedLiveTransportUntil) {
    const rem = remaining();
    const window = Math.min(Number(settings.geminiLive?.firstAudioTimeoutMs) || 3500, health.primaryFirstAudioMs, Math.max(500, rem - (health.fallbackFirstAudioMs + health.exactFirstAudioMs + health.googleReserveMs)));
    let primary = await runAttempt({
      key: 'livePrimary', providerName: 'gemini-3.1-live', windowMs: window, parentSignal, attempts,
      factory: (signal) => synthesizeGeminiLive(value, voice, liveOptions(String(settings.geminiLive?.primaryModel || 'gemini-3.1-flash-live-preview'), signal, window, requestApiKey)),
      priority: attemptPriority,
      apiKeySlot: requestApiKeySlot,
      deferBudgetUntilGeminiSlot: deferGeminiBudgetForPrefetch,
      onLimiterWait: creditLimiterWait
    });
    primary = await bufferSelected(primary, 'gemini-3.1-live');
    if (primary.result) return generatedResult(primary.result, 'gemini-3.1-live', primary.elapsed, (primary.firstAudioAt ?? performance.now()) - started, attempts);
    if (primary.error?.authLike) requestGeminiUsable = false;
    if (primary.error?.setupLike && primary.error?.transportLike) shareLiveTransportFailure(primary.error);
    if (primary.error?.runawayLike) sharedLiveTransportUntil = Math.max(sharedLiveTransportUntil, Date.now() + 5000);
  }

  if (requestGeminiUsable && !burstBypass() && !geminiAuthDisabled && settings.geminiLive?.enabled !== false && settings.geminiLive?.fallbackEnabled !== false && skipLive !== true && Date.now() >= sharedLiveTransportUntil) {
    const rem = remaining();
    const window = Math.min(Number(settings.geminiLive?.firstAudioTimeoutMs) || 3500, health.fallbackFirstAudioMs, Math.max(400, rem - (health.exactFirstAudioMs + health.googleReserveMs)));
    let fallbackLive = await runAttempt({
      key: 'liveFallback', providerName: 'gemini-2.5-live', windowMs: window, parentSignal, attempts,
      factory: (signal) => synthesizeGeminiLive(value, voice, liveOptions(String(settings.geminiLive?.fallbackModel || 'gemini-2.5-flash-native-audio-preview-12-2025'), signal, window, requestApiKey)),
      priority: attemptPriority,
      apiKeySlot: requestApiKeySlot,
      deferBudgetUntilGeminiSlot: deferGeminiBudgetForPrefetch,
      onLimiterWait: creditLimiterWait
    });
    fallbackLive = await bufferSelected(fallbackLive, 'gemini-2.5-live');
    if (fallbackLive.result) return generatedResult(fallbackLive.result, 'gemini-2.5-live', fallbackLive.elapsed, (fallbackLive.firstAudioAt ?? performance.now()) - started, attempts);
    if (fallbackLive.error?.authLike) requestGeminiUsable = false;
  } else if (requestGeminiUsable && !burstBypass() && skipLive !== true && settings.geminiLive?.fallbackEnabled !== false && Date.now() < sharedLiveTransportUntil) {
    noteSkipped(providerStates.liveFallback);
    attempts.push({ provider: 'gemini-2.5-live', outcome: 'shared-transport-skip', ms: 0 });
  }

  if (requestGeminiUsable && !burstBypass() && !geminiAuthDisabled && settings.geminiTts?.enabled !== false) {
  const rem = remaining();
  const bufferedExact = isBufferedExactContext(context);
  const exactWindowCap = exactAttemptWindowMs(context, health);
  // /ask already requires complete audio before playback. Use a completed
  // Interactions TTS response instead of streaming SSE into a local buffer.
  // Normal chat's exact fallback remains streaming and keeps its old window.
  const window = bufferedExact
    ? exactWindowCap
    : Math.min(Number(settings.geminiTts?.timeoutMs) || 4000, exactWindowCap, Math.max(350, rem - health.googleReserveMs));
  let exact = await runAttempt({
    key: 'exactTts', providerName: 'gemini-3.1-tts', windowMs: window, parentSignal, attempts,
    factory: (signal) => synthesizeGemini(value, voice, exactOptions(signal, window, requestApiKey, context)),
    priority: attemptPriority,
    apiKeySlot: requestApiKeySlot,
    deferBudgetUntilGeminiSlot: deferGeminiBudgetForPrefetch,
    onLimiterWait: creditLimiterWait
  });
  exact = await bufferSelected(exact, 'gemini-3.1-tts');
  if (exact.result) return generatedResult(exact.result, 'gemini-3.1-tts', exact.elapsed, (exact.firstAudioAt ?? performance.now()) - started, attempts);
}

  if (hasGemini && burstBypass()) {
    // A burst can become active in the middle of this same message after two
    // quota failures. Only count providers that were actually bypassed; do not
    // retroactively mark already-attempted providers as skipped.
    const alreadySeen = new Set(attempts.map((entry) => entry.provider));
    for (const [key, providerName] of [['livePrimary', 'gemini-3.1-live'], ['liveFallback', 'gemini-2.5-live'], ['exactTts', 'gemini-3.1-tts']]) {
      if (alreadySeen.has(providerName)) continue;
      noteSkipped(providerStates[key]);
      attempts.push({ provider: providerName, outcome: 'burst-bypass', ms: 0 });
    }
  }

  const googleWindow = googleFallbackWindowMs(context, remaining());
  if (googleWindow < 250) {
    noteSkipped(providerStates.google, { budget: true });
    attempts.push({ provider: 'google-ms-fallback', outcome: 'budget-skip', ms: 0 });
    const error = makeBudgetError('Google Malay TTS', googleWindow);
    error.attempts = attempts;
    throw error;
  }
  let google = await runAttempt({
    key: 'google', providerName: 'google-ms-fallback', windowMs: googleWindow, parentSignal, attempts, geminiProvider: false,
    factory: (signal) => streamGoogleMalay(googleValue, googleOptions(signal, googleWindow))
  });
  google = await bufferSelected(google, 'google-ms-fallback');
  if (!google.result) {
    const error = google.error || new Error('All TTS providers failed before first audio.');
    error.attempts = attempts;
    throw error;
  }
  const result = generatedResult({ ...google.result, voice: 'Google Malay' }, 'google-ms-fallback', google.elapsed, (google.firstAudioAt ?? performance.now()) - started, attempts);
  result.assignedGeminiVoice = voice;
  return result;
}

function publicProviderState(state) {
  const seconds = remainingSeconds(state);
  const disabled = Boolean(state.disabledUntilConfigChange);
  const displaySeconds = seconds != null && seconds >= 1e9 ? null : seconds;
  return {
    ready: !disabled && (seconds ?? 0) <= 0,
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
  sharedLiveTransportUntil = 0;
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
    geminiExactTtsEnabled: settings.geminiTts?.enabled !== false,
    askExactBufferedTimeoutMs: ASK_EXACT_BUFFERED_TIMEOUT_MS,
    voices: configuredVoices(),
    primaryModel: String(settings.geminiLive?.primaryModel || 'gemini-3.1-flash-live-preview'),
    fallbackLiveModel: String(settings.geminiLive?.fallbackModel || 'gemini-2.5-flash-native-audio-preview-12-2025'),
    exactTtsModel: String(settings.geminiTts?.model || 'gemini-3.1-flash-tts-preview'),
    livePrimary: publicProviderState(providerStates.livePrimary),
    liveFallback: publicProviderState(providerStates.liveFallback),
    exactTts: publicProviderState(providerStates.exactTts),
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


export const __test = { makeBudgetError, googleFallbackWindowMs, setProviderFailure, recordRunawayMidstreamFailure, recordIsolatedLiveMidstreamFailure, shouldIsolateLiveMidstreamFailure, newProviderState, bufferGenerated, healthOptions, exactFirstAudioWindowCap, exactAttemptWindowMs, exactOptions, isBufferedExactContext, pacificDailyResetMs, recordGeminiQuotaFailure, providerReady, acquireGeminiSlot, runAttempt, providerConfigSignature, beginHalfOpenProbe, beginHalfOpenProbeLease, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError };
