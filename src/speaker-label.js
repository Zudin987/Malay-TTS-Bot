import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir, settings } from './config.js';
import { synthesizeGoogleMalay } from './providers/google.js';
import { getFfmpegPath } from './ffmpeg.js';

const CACHE_VERSION = 'v2-ms-24k-mono-s16le';
const CACHE_DIR = path.join(dataDir, 'speaker-label-cache');
const PCM_BYTES_PER_MS = (24_000 * 1 * 2) / 1000;
const inflight = new Map();
const memoryCache = new Map();
let lastPruneAt = 0;

const stats = { memoryHits: 0, diskHits: 0, misses: 0, generated: 0, failures: 0, waitTimeouts: 0, invalidCacheFiles: 0, prunedFiles: 0, cancellations: 0 };
function finiteNumber(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

function cancellationError(reason, fallback = 'Speaker-label generation cancelled.') {
  const error = reason instanceof Error ? reason : new Error(String(reason || fallback));
  error.cancelled = true;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancellationError(signal.reason);
}

export function getSpeakerLabelOptions() {
  const configured = settings.speakerLabel && typeof settings.speakerLabel === 'object' ? settings.speakerLabel : {};
  return {
    enabled: configured.enabled !== false,
    speed: Math.max(0.8, Math.min(finiteNumber(configured.speed, 1.15), 1.5)),
    gapMs: Math.max(0, Math.min(finiteNumber(configured.gapMs, 75), 500)),
    maxWaitMs: Math.max(0, Math.min(finiteNumber(configured.maxWaitMs, 300), 3000)),
    gain: Math.max(0.25, Math.min(finiteNumber(configured.gain, 1.5), 2)),
    memoryCacheEntries: Math.max(0, Math.min(Math.floor(finiteNumber(configured.memoryCacheEntries, 32)), 128)),
    maxCacheAgeDays: Math.max(1, Math.min(Math.floor(finiteNumber(configured.maxCacheAgeDays, 90)), 3650)),
    maxCacheFiles: Math.max(16, Math.min(Math.floor(finiteNumber(configured.maxCacheFiles, 256)), 2048)),
    maxPcmDurationMs: Math.max(500, Math.min(Math.floor(finiteNumber(configured.maxPcmDurationMs, 4000)), 10_000))
  };
}

export function normalizeSpeakerLabelText(value) {
  const cleaned = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, ' ').replace(/[\u200B\u200C\u2060\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim();
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cleaned)].slice(0, 80).map((entry) => entry.segment).join('');
  }
  return Array.from(cleaned).slice(0, 80).join('');
}
export function speakerLabelCacheKey(value) {
  const label = normalizeSpeakerLabelText(value);
  return createHash('sha256').update(`${CACHE_VERSION}\n${label}`, 'utf8').digest('hex');
}
function speakerLabelSpeakText(value) {
  const label = normalizeSpeakerLabelText(value);
  if (!label) return '';
  return /[.!?…]$/u.test(label) ? label : `${label}.`;
}
function googleOptions(signal = null) {
  const configured = settings.googleTts ?? {};
  return { timeoutMs: configured.timeoutMs, maximumLength: 120, retryCount: configured.retryCount, retryDelayMs: configured.retryDelayMs, parallelChunks: 1, maxAudioBytes: configured.maxAudioBytes, signal };
}

function validPcm(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 100 || pcm.length % 2 !== 0) return false;
  const maxBytes = Math.ceil(getSpeakerLabelOptions().maxPcmDurationMs * PCM_BYTES_PER_MS);
  return pcm.length <= maxBytes;
}

export function decodeAudioToSpeakerPcm(audioBuffer, { spawnImpl = spawn, timeoutMs = 5000, signal = null } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return Promise.reject(new Error('Speaker-label decoder received empty audio.'));
  if (signal?.aborted) return Promise.reject(cancellationError(signal.reason));
  const boundedTimeoutMs = Math.max(500, Math.min(finiteNumber(timeoutMs, 5000), 30_000));
  return new Promise((resolve, reject) => {
    const ffmpeg = spawnImpl(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'mp3', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    let settled = false;
    let timer = null;
    let abortListener = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener?.('abort', abortListener);
      callback(value);
    };
    ffmpeg.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk; });
    ffmpeg.on('error', (error) => finish(reject, error));
    ffmpeg.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`Speaker-label FFmpeg decode failed (${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      const pcm = Buffer.concat(chunks);
      if (!validPcm(pcm)) return finish(reject, new Error(`Speaker-label FFmpeg decode produced invalid/oversized PCM (${pcm.length} bytes).`));
      finish(resolve, pcm);
    });
    ffmpeg.stdin.on('error', (error) => { if (error?.code !== 'EPIPE') finish(reject, error); });
    abortListener = () => {
      try { ffmpeg.kill?.(); } catch {}
      finish(reject, cancellationError(signal?.reason));
    };
    if (signal) signal.addEventListener?.('abort', abortListener, { once: true });
    timer = setTimeout(() => {
      try { ffmpeg.kill?.(); } catch {}
      finish(reject, new Error(`Speaker-label FFmpeg decode timed out after ${boundedTimeoutMs}ms.`));
    }, boundedTimeoutMs);
    timer.unref?.();
    if (signal?.aborted) { abortListener(); return; }
    ffmpeg.stdin.end(audioBuffer);
  });
}

function remember(key, pcm) {
  const { memoryCacheEntries } = getSpeakerLabelOptions();
  if (memoryCacheEntries <= 0 || !validPcm(pcm)) return;
  if (memoryCache.has(key)) memoryCache.delete(key);
  memoryCache.set(key, pcm);
  while (memoryCache.size > memoryCacheEntries) memoryCache.delete(memoryCache.keys().next().value);
}

export async function pruneSpeakerLabelCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastPruneAt < 6 * 60 * 60_000) return 0;
  lastPruneAt = now;
  const { maxCacheAgeDays, maxCacheFiles } = getSpeakerLabelOptions();
  const maxAgeMs = maxCacheAgeDays * 86_400_000;
  let entries;
  try { entries = await fs.readdir(CACHE_DIR, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.pcm')) continue;
    const full = path.join(CACHE_DIR, entry.name);
    try { const stat = await fs.stat(full); files.push({ full, mtimeMs: stat.mtimeMs }); } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  for (let i = 0; i < files.length; i += 1) {
    if (now - files[i].mtimeMs > maxAgeMs || i >= maxCacheFiles) {
      try { await fs.rm(files[i].full, { force: true }); removed += 1; } catch {}
    }
  }
  stats.prunedFiles += removed;
  return removed;
}

async function generateAndCache(label, key, signal, { synthesizeImpl = synthesizeGoogleMalay, decodeImpl = decodeAudioToSpeakerPcm } = {}) {
  const speakText = speakerLabelSpeakText(label);
  if (!speakText) return null;
  throwIfAborted(signal);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  void pruneSpeakerLabelCache().catch(() => {});
  const target = path.join(CACHE_DIR, `${key}.pcm`);
  const temp = path.join(CACHE_DIR, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  let installedTarget = false;
  try {
    const mp3 = await synthesizeImpl(speakText, googleOptions(signal));
    throwIfAborted(signal);
    const pcm = await decodeImpl(mp3, { signal });
    throwIfAborted(signal);
    await fs.writeFile(temp, pcm);
    throwIfAborted(signal);
    try {
      await fs.rename(temp, target);
      installedTarget = true;
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
    }
    throwIfAborted(signal);
    stats.generated += 1;
    remember(key, pcm);
    return pcm;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if (installedTarget && signal?.aborted) await fs.rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

async function getSpeakerLabelPcmNow(value, options = {}) {
  const { enabled } = getSpeakerLabelOptions();
  const label = normalizeSpeakerLabelText(value);
  if (!enabled || !label) return null;
  const key = speakerLabelCacheKey(label);
  const memory = memoryCache.get(key);
  if (memory && validPcm(memory)) { stats.memoryHits += 1; remember(key, memory); return memory; }
  const target = path.join(CACHE_DIR, `${key}.pcm`);
  try {
    const pcm = await fs.readFile(target);
    if (validPcm(pcm)) { stats.diskHits += 1; remember(key, pcm); return pcm; }
    stats.invalidCacheFiles += 1;
    await fs.rm(target, { force: true }).catch(() => {});
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[speaker-label] Cache read failed: ${error.message}`);
  }
  const existing = inflight.get(key);
  if (existing) return existing.promise;
  stats.misses += 1;
  const controller = new AbortController();
  const entry = { controller, promise: null };
  entry.promise = generateAndCache(label, key, controller.signal, options)
    .catch((error) => {
      if (error?.cancelled || controller.signal.aborted) {
        stats.cancellations += 1;
        return null;
      }
      stats.failures += 1;
      console.warn(`[speaker-label] Could not generate "${label}": ${error.message}`);
      return null;
    })
    .finally(() => { if (inflight.get(key) === entry) inflight.delete(key); });
  inflight.set(key, entry);
  return entry.promise;
}

function lazySpeakerLabel(value, options) {
  let started = null;
  const start = () => {
    started ||= getSpeakerLabelPcmNow(value, options);
    return started;
  };
  return {
    then(onFulfilled, onRejected) { return start().then(onFulfilled, onRejected); },
    catch(onRejected) { return start().catch(onRejected); },
    finally(onFinally) { return start().finally(onFinally); }
  };
}

// Intentionally lazy: queue prefetch and /speaker warm-up calls may obtain a
// handle, but no Google request begins until playback actually awaits the label.
export function getSpeakerLabelPcm(value, options = {}) {
  return lazySpeakerLabel(value, options);
}

export function cancelAllSpeakerLabelGeneration(reason = new Error('Speaker-label generation cancelled by privacy/runtime change.')) {
  let cancelled = 0;
  for (const entry of inflight.values()) {
    if (entry?.controller && !entry.controller.signal.aborted) {
      cancelled += 1;
      entry.controller.abort(cancellationError(reason));
    }
  }
  return cancelled;
}

export async function waitForSpeakerLabelPcm(promise) {
  if (!promise || typeof promise.then !== 'function') return null;
  const { maxWaitMs } = getSpeakerLabelOptions();
  // Explicit zero means zero waiting, not an accidental infinite wait.
  if (maxWaitMs <= 0) { stats.waitTimeouts += 1; return null; }
  const timeout = Symbol('speaker-label-timeout');
  let timer;
  try {
    const result = await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), maxWaitMs); timer.unref?.(); })]);
    if (result === timeout) { stats.waitTimeouts += 1; return null; }
    return validPcm(result) ? result : null;
  } finally { if (timer) clearTimeout(timer); }
}

export function buildSpeakerPreludePcm(pcm, gapMs = getSpeakerLabelOptions().gapMs) {
  if (!validPcm(pcm)) return null;
  const safeGapMs = Math.max(0, Math.min(finiteNumber(gapMs, 100), 500));
  const silenceBytes = Math.round(PCM_BYTES_PER_MS * safeGapMs);
  return silenceBytes > 0 ? Buffer.concat([pcm, Buffer.alloc(silenceBytes)]) : pcm;
}

export function getSpeakerLabelStatus() {
  return { ...getSpeakerLabelOptions(), provider: 'Google Malay', cache: 'disk + tiny memory LRU', memoryEntries: memoryCache.size, inflight: inflight.size, ...stats };
}

export const __test = { validPcm, getSpeakerLabelPcmNow };
