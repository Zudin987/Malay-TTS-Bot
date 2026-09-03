import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir, settings } from './config.js';
import { synthesizeGoogleMalay } from './providers/google.js';
import { getFfmpegPath } from './ffmpeg.js';
import { cancellationError, deadlineSignal, raceWithSignal, throwIfAborted } from './cancellation.js';

const CACHE_VERSION = 'v2-ms-24k-mono-s16le';
const CACHE_DIR = path.join(dataDir, 'speaker-label-cache');
const PCM_BYTES_PER_MS = (24_000 * 1 * 2) / 1000;
const inflight = new Map();
const memoryCache = new Map();
let lastPruneAt = 0;
let privacyEpoch = 0;
const MAX_LABEL_JOBS = 4;

const stats = { memoryHits: 0, diskHits: 0, misses: 0, generated: 0, failures: 0, waitTimeouts: 0, invalidCacheFiles: 0, prunedFiles: 0, cancellations: 0 };
function finiteNumber(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

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
  return { timeoutMs: configured.timeoutMs, maximumLength: 120, retryCount: configured.retryCount, retryDelayMs: configured.retryDelayMs, parallelChunks: 1, maxAudioBytes: Math.min(Number(configured.maxAudioBytes) || 512 * 1024, 512 * 1024), signal };
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
    let bytes = 0;
    const maxBytes = Math.ceil(getSpeakerLabelOptions().maxPcmDurationMs * PCM_BYTES_PER_MS);
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
    ffmpeg.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        try { ffmpeg.kill?.(); } catch {}
        finish(reject, new Error('Speaker-label decoder exceeded its PCM limit.'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => { if (!settled) stderr = (stderr + chunk).slice(-4096); });
    ffmpeg.on('error', (error) => finish(reject, error));
    ffmpeg.on('close', (code) => {
      if (settled) return;
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

async function generateAndCache(label, key, signal, { synthesizeImpl = synthesizeGoogleMalay, decodeImpl = decodeAudioToSpeakerPcm, mkdirImpl = fs.mkdir } = {}) {
  const speakText = speakerLabelSpeakText(label);
  if (!speakText) return null;
  throwIfAborted(signal);
  await raceWithSignal(mkdirImpl(CACHE_DIR, { recursive: true }), signal);
  throwIfAborted(signal);
  void pruneSpeakerLabelCache().catch(() => {});
  const target = path.join(CACHE_DIR, `${key}.pcm`);
  const temp = path.join(CACHE_DIR, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  let installedTarget = false;
  try {
    const mp3 = await raceWithSignal(synthesizeImpl(speakText, googleOptions(signal)), signal);
    throwIfAborted(signal);
    const pcm = await raceWithSignal(decodeImpl(mp3, { signal }), signal);
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
  if (!enabled || !label || options.signal?.aborted) return null;
  const key = speakerLabelCacheKey(label);
  const memory = memoryCache.get(key);
  if (memory && validPcm(memory)) { stats.memoryHits += 1; remember(key, memory); return memory; }
  let entry = inflight.get(key);
  if (entry?.deadline.signal.aborted) { inflight.delete(key); entry = null; }
  if (!entry) {
    if (inflight.size >= MAX_LABEL_JOBS) return null;
    const deadline = deadlineSignal(null, 12_000, new Error('Speaker-label job deadline exceeded.'));
    entry = { controller: { signal: deadline.signal, abort: deadline.cancel }, deadline, consumers: new Set(), promise: null };
    // Register ownership synchronously, BEFORE the first filesystem await.
    inflight.set(key, entry);
    const owned = entry;
    entry.promise = raceWithSignal((async () => {
      const signal = deadline.signal;
      const target = path.join(CACHE_DIR, `${key}.pcm`);
      try {
        const read = options.readFileImpl || fs.readFile;
        const pcm = await raceWithSignal(read(target, { signal }), signal);
        throwIfAborted(signal);
        if (validPcm(pcm)) { stats.diskHits += 1; remember(key, pcm); return pcm; }
        stats.invalidCacheFiles += 1;
        await fs.rm(target, { force: true }).catch(() => {});
      } catch (error) {
        throwIfAborted(signal);
        if (error?.code !== 'ENOENT') console.warn(`[speaker-label] Cache read failed: ${error.message}`);
      }
      throwIfAborted(signal);
      stats.misses += 1;
      return generateAndCache(label, key, signal, options);
    })(), deadline.signal).catch((error) => {
      if (error?.cancelled || deadline.signal.aborted) { stats.cancellations += 1; return null; }
      stats.failures += 1;
      console.warn(`[speaker-label] Could not generate label: ${error.message}`);
      return null;
    }).finally(() => {
      deadline.cleanup();
      if (inflight.get(key) === owned) inflight.delete(key);
    });
  }
  const consumer = Symbol('label-consumer');
  entry.consumers.add(consumer);
  try { return await raceWithSignal(entry.promise, options.signal); }
  catch (error) { if (options.signal?.aborted) return null; throw error; }
  finally {
    entry.consumers.delete(consumer);
    if (!entry.consumers.size && inflight.get(key) === entry) entry.deadline.cancel(cancellationError('No speech item owns this label.'));
  }
}

function lazySpeakerLabel(value, options) {
  let started = null;
  const epoch = privacyEpoch;
  const start = () => {
    started ||= epoch === privacyEpoch ? getSpeakerLabelPcmNow(value, options) : Promise.resolve(null);
    return started;
  };
  return {
    then(onFulfilled, onRejected) { return start().then(onFulfilled, onRejected); },
    catch(onRejected) { return start().catch(onRejected); },
    finally(onFinally) { return start().finally(onFinally); }
  };
}

// Queue construction is lazy; no Google request begins before playback awaits it.
export function getSpeakerLabelPcm(value, options = {}) {
  return lazySpeakerLabel(value, options);
}

export function cancelAllSpeakerLabelGeneration(reason = new Error('Speaker-label generation cancelled by privacy/runtime change.')) {
  privacyEpoch += 1;
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
