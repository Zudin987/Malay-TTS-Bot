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

const stats = { memoryHits: 0, diskHits: 0, misses: 0, generated: 0, failures: 0, waitTimeouts: 0, invalidCacheFiles: 0, prunedFiles: 0 };
function finiteNumber(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

export function getSpeakerLabelOptions() {
  const configured = settings.speakerLabel && typeof settings.speakerLabel === 'object' ? settings.speakerLabel : {};
  return {
    enabled: configured.enabled !== false,
    gapMs: Math.max(0, Math.min(finiteNumber(configured.gapMs, 100), 500)),
    maxWaitMs: Math.max(0, Math.min(finiteNumber(configured.maxWaitMs, 300), 3000)),
    gain: Math.max(0.25, Math.min(finiteNumber(configured.gain, 1.5), 2)),
    memoryCacheEntries: Math.max(0, Math.min(Math.floor(finiteNumber(configured.memoryCacheEntries, 32)), 128)),
    maxCacheAgeDays: Math.max(1, Math.min(Math.floor(finiteNumber(configured.maxCacheAgeDays, 90)), 3650)),
    maxCacheFiles: Math.max(16, Math.min(Math.floor(finiteNumber(configured.maxCacheFiles, 256)), 2048)),
    maxPcmDurationMs: Math.max(500, Math.min(Math.floor(finiteNumber(configured.maxPcmDurationMs, 4000)), 10_000))
  };
}

export function normalizeSpeakerLabelText(value) {
  const cleaned = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, ' ').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim();
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
function googleOptions() {
  const configured = settings.googleTts ?? {};
  return { timeoutMs: configured.timeoutMs, maximumLength: 120, retryCount: configured.retryCount, retryDelayMs: configured.retryDelayMs, parallelChunks: 1, maxAudioBytes: configured.maxAudioBytes };
}

function validPcm(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 100 || pcm.length % 2 !== 0) return false;
  const maxBytes = Math.ceil(getSpeakerLabelOptions().maxPcmDurationMs * PCM_BYTES_PER_MS);
  return pcm.length <= maxBytes;
}

export function decodeAudioToSpeakerPcm(audioBuffer, { spawnImpl = spawn } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return Promise.reject(new Error('Speaker-label decoder received empty audio.'));
  return new Promise((resolve, reject) => {
    const ffmpeg = spawnImpl(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'mp3', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk; });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Speaker-label FFmpeg decode failed (${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      const pcm = Buffer.concat(chunks);
      if (!validPcm(pcm)) return reject(new Error(`Speaker-label FFmpeg decode produced invalid/oversized PCM (${pcm.length} bytes).`));
      resolve(pcm);
    });
    ffmpeg.stdin.on('error', (error) => { if (error?.code !== 'EPIPE') reject(error); });
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

async function generateAndCache(label, key) {
  const speakText = speakerLabelSpeakText(label);
  if (!speakText) return null;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  void pruneSpeakerLabelCache().catch(() => {});
  const target = path.join(CACHE_DIR, `${key}.pcm`);
  const temp = path.join(CACHE_DIR, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  const mp3 = await synthesizeGoogleMalay(speakText, googleOptions());
  const pcm = await decodeAudioToSpeakerPcm(mp3);
  await fs.writeFile(temp, pcm);
  try { await fs.rename(temp, target); } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if (error?.code !== 'EEXIST') throw error;
  }
  stats.generated += 1;
  remember(key, pcm);
  return pcm;
}

export async function getSpeakerLabelPcm(value) {
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
  if (inflight.has(key)) return inflight.get(key);
  stats.misses += 1;
  const promise = generateAndCache(label, key).catch((error) => { stats.failures += 1; console.warn(`[speaker-label] Could not generate "${label}": ${error.message}`); return null; }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
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

export const __test = { validPcm };
