import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForWritableDrain } from '../stream-backpressure.js';
import { cancellationError, discardGenerated, raceWithSignal, readResponseBuffer, throwIfAborted } from '../cancellation.js';

const ENDPOINT = 'https://translate.google.com/translate_tts';
const DEFAULT_MAXIMUM_LENGTH = 200;
const DEFAULT_PARALLEL_CHUNKS = 3;

export class GoogleTtsHttpError extends Error {
  constructor(status) {
    super(`Google Malay TTS returned HTTP ${status}.`);
    this.name = 'GoogleTtsHttpError';
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
    this.quotaLike = status === 429;
    this.transportLike = status >= 500;
  }
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function graphemes(value) {
  const text = String(value ?? '');
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((entry) => entry.segment);
  }
  return Array.from(text);
}

function isSpace(unit) { return /^\s$/u.test(unit); }

export function splitGoogleText(input, maximumLength = DEFAULT_MAXIMUM_LENGTH) {
  const text = String(input ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) return [];
  const maxLength = Math.floor(Math.max(40, Math.min(Number(maximumLength) || DEFAULT_MAXIMUM_LENGTH, 200)));
  const remaining = graphemes(text);
  const chunks = [];
  let offset = 0;

  while (remaining.length - offset > maxLength) {
    const end = Math.min(remaining.length, offset + maxLength);
    const floorSentence = offset + Math.floor(maxLength * 0.55);
    const floorPhrase = offset + Math.floor(maxLength * 0.65);
    const floorComma = offset + Math.floor(maxLength * 0.75);
    const floorWord = offset + Math.floor(maxLength * 0.5);
    let sentence = -1, phrase = -1, comma = -1, word = -1;
    for (let i = offset; i < end; i += 1) {
      const current = remaining[i];
      const next = remaining[i + 1] ?? '';
      const boundary = !next || isSpace(next);
      if (boundary && /[.!?]/u.test(current) && i + 1 >= floorSentence) sentence = i + 1;
      if (boundary && /[;:]/u.test(current) && i + 1 >= floorPhrase) phrase = i + 1;
      if (boundary && current === ',' && i + 1 >= floorComma) comma = i + 1;
      if (isSpace(current) && i >= floorWord) word = i;
    }
    const cut = [sentence, phrase, comma, word].find((value) => value >= 0) ?? end;
    const chunk = remaining.slice(offset, cut).join('').trim();
    if (chunk) chunks.push(chunk);
    offset = cut;
    while (offset < remaining.length && isSpace(remaining[offset])) offset += 1;
  }
  const tail = remaining.slice(offset).join('').trim();
  if (tail) chunks.push(tail);
  return chunks;
}

function makeChunkUrl(chunk, index, total) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('ie', 'UTF-8');
  url.searchParams.set('client', 'tw-ob');
  url.searchParams.set('tl', 'ms');
  url.searchParams.set('q', chunk);
  url.searchParams.set('idx', String(index));
  url.searchParams.set('total', String(total));
  url.searchParams.set('textlen', String(graphemes(chunk).length));
  return url;
}

function makeTimeoutError(ms) {
  const error = new Error(`Google Malay TTS exceeded ${ms}ms.`);
  error.name = 'TimeoutError';
  error.retryable = true;
  error.transportLike = true;
  return error;
}

function combineAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let externalAbort = null;
  const abort = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  if (externalSignal) {
    externalAbort = () => abort(externalSignal.reason);
    if (externalSignal.aborted) externalAbort();
    else externalSignal.addEventListener('abort', externalAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => abort(makeTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal, cancel: abort,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (externalSignal && externalAbort) externalSignal.removeEventListener?.('abort', externalAbort);
    }
  };
}

function isRetryableNetworkError(error) {
  if (error?.retryable === true) return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return false;
  return error instanceof TypeError;
}

async function fetchChunk(fetchImpl, url, { signal, maxAudioBytes }) {
  throwIfAborted(signal);
  const response = await raceWithSignal(fetchImpl(url, {
    headers: { Accept: 'audio/mpeg,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 Malay-TTS-Bot/1.0' },
    signal
  }), signal, discardGenerated);
  if (!response.ok) throw new GoogleTtsHttpError(response.status);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('audio')) throw new Error(`Google Malay TTS returned unexpected content type: ${contentType || 'unknown'}`);

  const buffer = await readResponseBuffer(response, { signal, maxBytes: maxAudioBytes });
  if (buffer.length < 200) throw new Error(`Google Malay TTS returned unexpectedly small audio: ${buffer.length} bytes.`);
  return buffer;
}

async function fetchChunkWithRetry(fetchImpl, url, options) {
  const retryCount = Math.floor(Math.max(0, Math.min(finiteNumber(options.retryCount, 1), 3)));
  const retryDelayMs = Math.max(0, Math.min(finiteNumber(options.retryDelayMs, 150), 5000));
  for (let attempt = 0; ; attempt += 1) {
    try { return await fetchChunk(fetchImpl, url, options); }
    catch (error) {
      if (options.signal?.aborted || attempt >= retryCount || !isRetryableNetworkError(error)) throw error;
      console.warn(`[google-ms] Temporary TTS failure (${error.message}); retry ${attempt + 1}/${retryCount}.`);
      if (retryDelayMs > 0) await delay(retryDelayMs, undefined, { signal: options.signal });
    }
  }
}

export async function streamGoogleMalay(text, options = {}) {
  throwIfAborted(options.signal);
  const chunks = splitGoogleText(text, options.maximumLength ?? DEFAULT_MAXIMUM_LENGTH);
  if (!chunks.length) throw new Error('Google Malay TTS received empty text.');

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // timeoutMs is the first-ordered-chunk deadline. Once audio can begin, allow
  // the already-parallel later chunks a separate bounded completion window so
  // a healthy long utterance is not truncated by the first-audio budget.
  const timeoutMs = Math.max(250, Math.min(finiteNumber(options.timeoutMs, 3500), 60_000));
  const completionTimeoutMs = Math.max(timeoutMs, Math.min(finiteNumber(options.completionTimeoutMs, 12_000), 30_000));
  const maxAudioBytes = Math.max(64 * 1024, Math.min(finiteNumber(options.maxAudioBytes, 4 * 1024 * 1024), 32 * 1024 * 1024));
  const deadline = combineAbortSignal(options.signal, completionTimeoutMs);
  let firstChunkTimer = setTimeout(() => deadline.cancel(makeTimeoutError(timeoutMs)), timeoutMs);
  firstChunkTimer.unref?.();
  const clearFirstChunkTimer = () => { if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; } };
  const parallel = Math.floor(Math.max(1, Math.min(finiteNumber(options.parallelChunks, DEFAULT_PARALLEL_CHUNKS), 3)));
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  // Provider completion carries the real failure. Keep an internal stream error
  // observer so a later parallel-chunk failure cannot become an uncaught
  // EventEmitter 'error' before the playback consumer attaches its listener.
  output.on('error', () => {});
  const ready = new Array(chunks.length);
  let nextIndex = 0;
  let totalBytes = 0;
  let receivedBytes = 0;

  const promises = chunks.map((_, i) => {
    const promise = new Promise((resolve, reject) => { ready[i] = { resolve, reject }; });
    // Later chunks may fail before the ordered writer reaches them. Attach a
    // rejection observer now so Node never treats that expected failure as an
    // unhandled rejection; awaiting the original promise still throws later.
    promise.catch(() => {});
    return promise;
  });
  const rejectPending = () => {
    const error = deadline.signal.reason || cancellationError();
    for (const entry of ready) entry.reject(error);
  };
  deadline.signal.addEventListener('abort', rejectPending, { once: true });
  if (deadline.signal.aborted) rejectPending();
  async function worker() {
    while (!deadline.signal.aborted) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      try {
        const part = await fetchChunkWithRetry(fetchImpl, makeChunkUrl(chunks[index], index, chunks.length), {
          signal: deadline.signal,
          retryCount: options.retryCount,
          retryDelayMs: options.retryDelayMs,
          maxAudioBytes
        });
        throwIfAborted(deadline.signal);
        receivedBytes += part.length;
        if (receivedBytes > maxAudioBytes) throw new Error(`Google Malay TTS exceeded ${maxAudioBytes} total audio bytes.`);
        ready[index].resolve(part);
      } catch (error) {
        ready[index].reject(error);
        if (!deadline.signal.aborted) deadline.cancel(error);
        throw error;
      }
    }
  }

  const workerCount = Math.min(parallel, chunks.length);
  const workers = Array.from({ length: workerCount }, () => {
    const promise = worker();
    promise.catch(() => {});
    return promise;
  });
  // Await only the first ordered chunk: this is the latency-critical point.
  let first;
  try {
    first = await raceWithSignal(promises[0], deadline.signal);
    clearFirstChunkTimer();
  } catch (error) {
    clearFirstChunkTimer();
    deadline.cleanup();
    deadline.signal.removeEventListener('abort', rejectPending);
    output.destroy();
    throw error;
  }

  const completion = (async () => {
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const part = i === 0 ? first : await raceWithSignal(promises[i], deadline.signal);
        throwIfAborted(deadline.signal);
        totalBytes += part.length;
        if (totalBytes > maxAudioBytes) throw new Error(`Google Malay TTS exceeded ${maxAudioBytes} total audio bytes.`);
        if (!output.write(part)) await waitForWritableDrain(output, deadline.signal, 'Google TTS output stream');
      }
      await raceWithSignal(Promise.all(workers), deadline.signal);
      output.end();
      return { audioBytes: totalBytes };
    } catch (error) {
      if (!deadline.signal.aborted) deadline.cancel(error);
      output.destroy(error);
      throw error;
    } finally {
      clearFirstChunkTimer();
      deadline.cleanup();
      deadline.signal.removeEventListener('abort', rejectPending);
    }
  })();
  completion.catch(() => {});

  return {
    audioStream: output,
    audioFormat: 'mp3',
    mimeType: 'audio/mpeg',
    completion,
    cancel: (reason) => deadline.cancel(cancellationError(reason)),
    firstChunkBytes: first.length
  };
}

export async function synthesizeGoogleMalay(text, options = {}) {
  const generated = await streamGoogleMalay(text, options);
  const parts = [];
  for await (const chunk of generated.audioStream) parts.push(Buffer.from(chunk));
  await generated.completion;
  return Buffer.concat(parts);
}
