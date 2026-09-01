import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  NoSubscriberBehavior,
  StreamType
} from '@discordjs/voice';
import { selectPrefetchCandidates } from './prefetch-plan.js';
import { synthesize } from './tts.js';
import { settings } from './config.js';
import { recordTtsMetrics } from './tts-metrics.js';
import { buildAudioFilters } from './audio-filters.js';
import { shouldRecoverTranscriptTail } from './recovery-evidence.js';
import {
  buildSpeakerPreludePcm,
  getSpeakerLabelOptions,
  getSpeakerLabelPcm,
  waitForSpeakerLabelPcm
} from './speaker-label.js';
import { getFfmpegPath } from './ffmpeg.js';

const states = new Map();
const DEFAULT_MAX_QUEUED_MESSAGES = 10;
const MAX_QUEUE_WARNING_INTERVAL_MS = 30_000;

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}
function clampInteger(value, fallback, min, max) { return Math.floor(clampNumber(value, fallback, min, max)); }

function getAdaptiveQueueOptions() {
  const configured = settings.adaptiveQueue && typeof settings.adaptiveQueue === 'object' ? settings.adaptiveQueue : {};
  return {
    enabled: configured.enabled !== false,
    prefetchIdle: clampInteger(configured.prefetchIdle, 1, 0, 2),
    prefetchBusy: clampInteger(configured.prefetchBusy, 2, 1, 3),
    prefetchBusyThreshold: clampInteger(configured.prefetchBusyThreshold, 2, 1, 10),
    catchUpEnabled: configured.catchUpEnabled !== false,
    catchUpModerateThreshold: clampInteger(configured.catchUpModerateThreshold, 3, 1, 20),
    catchUpBusyThreshold: clampInteger(configured.catchUpBusyThreshold, 6, 2, 30),
    catchUpModerateBacklogMs: clampInteger(configured.catchUpModerateBacklogMs, 6000, 1000, 60_000),
    catchUpBusyBacklogMs: clampInteger(configured.catchUpBusyBacklogMs, 12_000, 2000, 120_000),
    catchUpModerateSpeed: clampNumber(configured.catchUpModerateSpeed, 1.05, 1, 1.12),
    catchUpBusySpeed: clampNumber(configured.catchUpBusySpeed, 1.10, 1, 1.12),
    staleSkipEnabled: configured.staleSkipEnabled === true,
    staleAfterMs: clampInteger(configured.staleAfterMs, 15_000, 5000, 120_000),
    preservePrefetchedOnOverflow: configured.preservePrefetchedOnOverflow !== false
  };
}

export function estimateSpeechDurationMs(text) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  const words = value.split(/\s+/u).filter(Boolean).length;
  const characters = [...value].length;
  const punctuationPauses = Math.min((value.match(/[,.!?;:…]/gu) ?? []).length * 80, 1000);
  const estimate = Math.max(words * 330, characters * 48) + punctuationPauses;
  return Math.max(650, Math.min(Math.round(estimate), 50_000));
}

export function getMaximumQueuedMessages() {
  const configured = Number(settings.maximumQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_QUEUED_MESSAGES;
  return Math.max(1, Math.min(Math.floor(configured), 50));
}

function cancelledError(message) {
  const error = new Error(message);
  error.cancelled = true;
  return error;
}

function createQueueItem(text, metadata = {}) {
  const messageCreatedAt = Number(metadata.messageCreatedAt) || Date.now();
  return {
    text: String(text),
    generation: null,
    abortController: new AbortController(),
    cancelled: false,
    enqueuedAt: performance.now(),
    messageCreatedAt,
    preprocessMs: Number(metadata.preprocessMs) || 0,
    userId: metadata.userId ? String(metadata.userId) : null,
    voice: metadata.voice ? String(metadata.voice) : null,
    speakerLabel: metadata.speakerLabel ? String(metadata.speakerLabel) : null,
    messageId: metadata.messageId ? String(metadata.messageId) : null,
    voiceChannelId: metadata.voiceChannelId ? String(metadata.voiceChannelId) : null,
    speakerResetSeconds: Number(metadata.speakerResetSeconds) || null,
    speakerLabelGeneration: null,
    speakerLabelNeeded: false,
    speakerLabelHeard: false,
    firstAudibleAtEpoch: 0,
    googleText: metadata.googleText ? String(metadata.googleText) : null,
    verificationText: metadata.verificationText ? String(metadata.verificationText) : String(text),
    messageCount: 1,
    estimatedDurationMs: estimateSpeechDurationMs(metadata.verificationText || text),
    playbackStartedAt: 0,
    playbackSpeed: 1,
    forceBuffered: metadata.forceBuffered === true,
    recoveryAttempt: Math.max(0, Number(metadata.recoveryAttempt) || 0),
    isRecovery: metadata.isRecovery === true,
    skipLive: metadata.skipLive === true,
    replayAudioBuffer: Buffer.isBuffer(metadata.replayAudioBuffer) ? metadata.replayAudioBuffer : null,
    replayAudioFormat: metadata.replayAudioFormat ? String(metadata.replayAudioFormat) : null,
    replayMimeType: metadata.replayMimeType ? String(metadata.replayMimeType) : null,
    replaySampleRate: Number(metadata.replaySampleRate) || 24_000,
    replayChannels: Number(metadata.replayChannels) || 1,
    resumeFraction: Math.max(0, Math.min(Number(metadata.resumeFraction) || 0, 0.98)),
    recoveryScheduled: false,
    recoveryEpoch: Math.max(0, Number(metadata.recoveryEpoch) || 0),
    runSerial: Math.max(0, Number(metadata.runSerial) || 0),
    generationMode: null
  };
}

function getState(guildId) {
  let state = states.get(guildId);
  if (state) return state;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  state = {
    player, queue: [], running: false, currentItem: null, ffmpeg: null, disposed: false,
    voiceReady: false, voiceChannelId: null, pendingVoiceChannelId: null, voicePaused: false, lastQueueWarningAt: 0, droppedMessages: 0, staleSkippedMessages: 0,
    streamingPrefetches: 0, cutoffRecoveries: 0, cutoffRecoverySuccesses: 0,
    cutoffRecoveryFailures: 0, suspiciousShortOutputs: 0, transcriptCutoffs: 0,
    playbackCutoffs: 0, mirrorReplays: 0, suppressedCutoffReplays: 0,
    completionGraceTimeouts: 0, pipelineFailures: 0, lastSpeakerAnnouncement: null,
    recoveryEpoch: 0, runSerial: 0
  };
  player.on('error', (error) => console.error(`[player:${guildId}]`, error));
  states.set(guildId, state);
  return state;
}

function speakerResetMs(resetSeconds) { return Math.max(0, Number(resetSeconds) || 0) * 1000; }
export function shouldIncludeSpeakerLabel(guildId, userId, resetSeconds = 30) {
  const state = getState(guildId);
  const id = String(userId ?? '');
  if (!id) return true;
  const last = state.lastSpeakerAnnouncement;
  if (!last || last.userId !== id) return true;
  return Date.now() - Number(last.heardAt || 0) >= speakerResetMs(resetSeconds);
}
function decideSpeakerLabel(state, item, resetSeconds) {
  if (!item?.speakerLabel || !item?.userId) return false;
  const last = state.lastSpeakerAnnouncement;
  if (!last || last.userId !== String(item.userId)) return true;
  return Date.now() - Number(last.heardAt || 0) >= speakerResetMs(resetSeconds);
}
function markSpeakerAnnounced(state, item) {
  if (!item?.userId || !item?.speakerLabel) return;
  item.speakerLabelHeard = true;
  state.lastSpeakerAnnouncement = { userId: String(item.userId), label: String(item.speakerLabel), heardAt: Date.now() };
}

async function cleanupGenerated(generated, { cancel = false } = {}) {
  if (cancel) { try { generated?.cancel?.(cancelledError('Queued TTS item cancelled.')); } catch {} }
  if (generated?.audioStream && !generated.audioStream.destroyed) generated.audioStream.destroy();
  if (generated) { generated.audioStream = null; generated.audioBuffer = null; }
}

function abandonUnclaimedGeneration(item, reason = 'Playback item abandoned before provider handoff.') {
  if (!item?.generation) return false;
  const error = cancelledError(reason);
  if (!item.abortController.signal.aborted) item.abortController.abort(error);
  item.generation.then((result) => cleanupGenerated(result, { cancel: true })).catch(() => {});
  return true;
}

function createPrefetchSpool(generated, signal) {
  if (!generated?.audioStream || typeof generated.audioStream.pipe !== 'function') return generated;
  // The provider's own output is latency-oriented and may use a small
  // highWaterMark. Drain it immediately into a bounded memory spool so an
  // immediate-successor prefetch can finish generating while the current
  // message is still playing. Provider output is already hard-capped; 3 MiB is
  // enough for the configured 45 s mono PCM ceiling with margin.
  const spool = new PassThrough({ highWaterMark: 3 * 1024 * 1024 });
  spool.on('error', () => {});
  const source = generated.audioStream;
  const onError = (error) => { if (!spool.destroyed) spool.destroy(error); };
  source.once('error', onError);
  source.pipe(spool);
  const cancel = generated.cancel;
  let abortListener = null;
  if (signal) {
    abortListener = () => {
      try { cancel?.(signal.reason || cancelledError('Prefetched TTS cancelled.')); } catch {}
      if (!spool.destroyed) spool.destroy();
    };
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  }
  const completion = Promise.resolve(generated.completion).finally(() => {
    source.removeListener?.('error', onError);
    if (signal && abortListener) signal.removeEventListener?.('abort', abortListener);
  });
  completion.catch(() => {});
  return { ...generated, audioStream: spool, completion };
}

function startGeneration(guildId, item, { prefetch = false } = {}) {
  if (item.generation) return item.generation;
  if (item.speakerLabel && !item.speakerLabelGeneration) item.speakerLabelGeneration = getSpeakerLabelPcm(item.speakerLabel);

  if (Buffer.isBuffer(item.replayAudioBuffer) && item.replayAudioBuffer.length > 0) {
    item.generationMode = 'buffered-replay';
    item.generation = Promise.resolve({
      audioBuffer: item.replayAudioBuffer,
      mimeType: item.replayMimeType || `audio/pcm;rate=${item.replaySampleRate || 24_000}`,
      audioFormat: item.replayAudioFormat || 's16le',
      sampleRate: item.replaySampleRate || 24_000,
      channels: item.replayChannels || 1,
      provider: 'safe-audio-tail-replay',
      voice: item.voice,
      metrics: { providerMs: 0, firstAudioTotalMs: 0, attempts: [] }
    });
    return item.generation;
  }

  const buffered = item.forceBuffered;
  item.generationMode = buffered ? 'buffered' : prefetch ? 'streaming-prefetch' : 'streaming';
  const base = synthesize(item.text, {
    guildId, userId: item.userId, voice: item.voice, googleText: item.googleText,
    liveStreamOutput: buffered ? false : undefined,
    skipLive: item.skipLive,
    prefetch,
    signal: item.abortController.signal
  });
  item.generation = prefetch && !buffered
    ? base.then((generated) => createPrefetchSpool(generated, item.abortController.signal))
    : base;
  item.generation.catch(() => {});
  return item.generation;
}

function getPrefetchAhead(state) {
  const options = getAdaptiveQueueOptions();
  if (!options.enabled) return 1;
  return state.queue.length >= options.prefetchBusyThreshold ? options.prefetchBusy : options.prefetchIdle;
}
function prefetchNext(guildId, state) {
  if (state.disposed || state.queue.length === 0) return;
  const options = getAdaptiveQueueOptions();
  const candidates = selectPrefetchCandidates(state.queue, { ahead: getPrefetchAhead(state) });
  for (const item of candidates) {
    const started = Boolean(item.generation);
    startGeneration(guildId, item, { prefetch: true });
    if (!started && item.generationMode === 'streaming-prefetch') state.streamingPrefetches += 1;
  }
}

function cleanupCancelledQueuedItem(item) {
  item.cancelled = true;
  if (!item.abortController.signal.aborted) item.abortController.abort(cancelledError('Queue item dropped.'));
  if (item.generation) item.generation.then((generated) => cleanupGenerated(generated, { cancel: true })).catch(() => {});
}

function dropForQueueOverflow(guildId, state, maximumQueuedMessages) {
  const options = getAdaptiveQueueOptions();
  let dropIndex = 0;
  if (options.enabled && options.preservePrefetchedOnOverflow) {
    const firstUnstarted = state.queue.findIndex((item) => !item.generation);
    if (firstUnstarted >= 0) dropIndex = firstUnstarted;
  }
  const [dropped] = state.queue.splice(dropIndex, 1);
  if (dropped) { state.droppedMessages += 1; cleanupCancelledQueuedItem(dropped); }
  const now = Date.now();
  if (now - state.lastQueueWarningAt >= MAX_QUEUE_WARNING_INTERVAL_MS) {
    state.lastQueueWarningAt = now;
    console.warn(`[queue:${guildId}] Queue limit ${maximumQueuedMessages} reached; dropped one waiting message.`);
  }
}

function getWaitingSpeechMs(state) { return state.queue.reduce((sum, item) => sum + (item.estimatedDurationMs || estimateSpeechDurationMs(item.text)), 0); }
function getCatchUpSpeed(state) {
  const o = getAdaptiveQueueOptions();
  if (!o.enabled || !o.catchUpEnabled) return 1;
  const backlog = getWaitingSpeechMs(state);
  if (state.queue.length >= o.catchUpBusyThreshold || backlog >= o.catchUpBusyBacklogMs) return o.catchUpBusySpeed;
  if (state.queue.length >= o.catchUpModerateThreshold || backlog >= o.catchUpModerateBacklogMs) return o.catchUpModerateSpeed;
  return 1;
}
function isStale(item) {
  const o = getAdaptiveQueueOptions();
  return o.enabled && o.staleSkipEnabled && Date.now() - item.messageCreatedAt > o.staleAfterMs;
}
function takeNextItem(state) {
  while (state.queue.length) {
    const item = state.queue.shift();
    if (item.voiceChannelId && state.voiceChannelId && String(item.voiceChannelId) !== String(state.voiceChannelId)) {
      cleanupCancelledQueuedItem(item);
      continue;
    }
    if (!isStale(item)) return item;
    state.staleSkippedMessages += 1;
    cleanupCancelledQueuedItem(item);
  }
  return null;
}

function getPcmDurationMs(audioBytes, sampleRate = 24_000, channels = 1) {
  return (Math.max(0, Number(audioBytes) || 0) / (Math.max(8000, Number(sampleRate) || 24_000) * Math.max(1, Number(channels) || 1) * 2)) * 1000;
}

function mp3DurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 0;
  let offset = 0;
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  const br1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const br2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const sr = { 3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000] };
  let samples = 0, sampleRate = 0, frames = 0;
  while (offset + 4 <= buffer.length) {
    const h = buffer.readUInt32BE(offset);
    if ((h & 0xffe00000) !== 0xffe00000) { offset += 1; continue; }
    const versionBits = (h >> 19) & 3;
    const layerBits = (h >> 17) & 3;
    const bitrateIndex = (h >> 12) & 0xf;
    const sampleIndex = (h >> 10) & 3;
    const padding = (h >> 9) & 1;
    if (versionBits === 1 || layerBits !== 1 || sampleIndex === 3) { offset += 1; continue; }
    const version = versionBits === 3 ? 3 : versionBits === 2 ? 2 : 0;
    const rate = sr[version]?.[sampleIndex];
    const bitrate = (version === 3 ? br1 : br2)[bitrateIndex];
    if (!rate || !bitrate) { offset += 1; continue; }
    const frameLength = Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate + padding);
    if (frameLength < 4 || offset + frameLength > buffer.length) break;
    sampleRate = rate;
    samples += version === 3 ? 1152 : 576;
    frames += 1;
    offset += frameLength;
  }
  return frames && sampleRate ? samples / sampleRate * 1000 : 0;
}

function estimateRecoveryDurationMs(text) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  const words = value.split(/\s+/u).filter(Boolean).length;
  const lexicalCharacters = [...value.replace(/[^\p{L}\p{N}]/gu, '')].length;
  const estimate = Math.max(words * 330, lexicalCharacters * 48);
  return Math.max(650, Math.min(Math.round(estimate), 50_000));
}

function isSuspiciouslyShortPcm(item, generated, audioBytes) {
  const reference = String(item.verificationText || item.text || '').trim();
  const words = reference.split(/\s+/u).filter(Boolean).length;
  const characters = [...reference].length;
  if (words < 5 || characters < 20) return false;
  const actual = getPcmDurationMs(audioBytes, generated?.sampleRate, generated?.channels);
  // Recovery must not inherit punctuation pause inflation from the queue ETA.
  // A message full of ellipses can be spoken completely much faster than the
  // display-oriented estimate without being truncated.
  const expected = estimateRecoveryDurationMs(item.verificationText || item.text);
  return actual >= 250 && actual < expected * 0.35 && expected - actual >= 900;
}
function normalizeTranscriptWords(value) { return String(value ?? '').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []; }
function isSuspiciousTranscript(item, transcript) {
  if (settings.audioPipeline?.transcriptCutoffGuard === false) return false;
  const input = normalizeTranscriptWords(item.verificationText || item.text);
  const output = normalizeTranscriptWords(transcript);
  if (input.length < 2 || output.length === 0) return false;
  const inputChars = input.join('').length, outputChars = output.join('').length;
  if (inputChars < 5) return false;
  const minimum = clampNumber(settings.audioPipeline?.transcriptMinCoverage, 0.60, 0.35, 0.95);
  return output.length / input.length < minimum && outputChars / inputChars < minimum && inputChars - outputChars >= 3;
}

export function getPlaybackCoverage(generated, completionInfo, resource, playbackSpeed, speakerPreludeSourceMs = 0) {
  if (settings.audioPipeline?.verifyStreamingPlayback === false) return null;
  const totalBytes = Number(completionInfo?.audioBytes) || 0;
  const format = String(generated?.audioFormat || '').toLowerCase();
  if (!totalBytes || format !== 's16le') return null;
  const pcmMs = getPcmDurationMs(totalBytes, generated?.sampleRate, generated?.channels);
  if (pcmMs < 500) return null;
  const expectedPlaybackMs = pcmMs / Math.max(1, Number(playbackSpeed) || 1);
  const totalPlaybackMs = Math.max(0, Number(resource?.playbackDuration) || 0);
  const actualPlaybackMs = totalPlaybackMs;
  const missingMs = expectedPlaybackMs - actualPlaybackMs;
  const coverage = expectedPlaybackMs > 0 ? actualPlaybackMs / expectedPlaybackMs : 1;
  const minimumCoverage = clampNumber(settings.audioPipeline?.playbackCoverageMin, 0.82, 0.60, 0.97);
  const toleranceMs = clampNumber(settings.audioPipeline?.playbackMissingToleranceMs, 350, 150, 1500);
  return { pcmMs, expectedPlaybackMs, actualPlaybackMs, totalPlaybackMs, preludePlaybackMs: 0, missingMs, coverage, suspicious: missingMs >= toleranceMs && coverage < minimumCoverage };
}
function isHardPlaybackCutoff(c) {
  return Boolean(c?.suspicious && c.coverage <= clampNumber(settings.audioPipeline?.hardPlaybackCoverageMax, 0.55, 0.20, 0.80) && c.missingMs >= clampNumber(settings.audioPipeline?.hardPlaybackMissingMs, 1200, 500, 5000));
}

function buildPcmTail(buffer, generated, playedMs, playbackSpeed) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const format = String(generated?.audioFormat || '').toLowerCase();
  if (format !== 's16le') return null;
  const sampleRate = Math.max(8000, Number(generated?.sampleRate) || 24_000);
  const channels = Math.max(1, Number(generated?.channels) || 1);
  const frameBytes = channels * 2;
  const overlapMs = clampNumber(settings.audioPipeline?.playbackResumeOverlapMs, 120, 0, 400);
  const sourcePlayedMs = Math.max(0, Number(playedMs) || 0) * Math.max(1, Number(playbackSpeed) || 1);
  const resumeMs = Math.max(0, sourcePlayedMs - overlapMs);
  let offset = Math.floor(resumeMs / 1000 * sampleRate * frameBytes);
  offset -= offset % frameBytes;
  offset = Math.max(0, Math.min(offset, buffer.length));
  const tail = buffer.subarray(offset);
  if (getPcmDurationMs(tail.length, sampleRate, channels) < 300) return null;
  return { audioBuffer: Buffer.from(tail), audioFormat: 's16le', mimeType: generated?.mimeType || `audio/pcm;rate=${sampleRate}`, sampleRate, channels };
}

function getStreamCutoffRecoveryAttempts() {
  if (settings.audioPipeline?.streamCutoffRecovery === false) return 0;
  return clampInteger(settings.audioPipeline?.streamCutoffRecoveryAttempts, 1, 0, 2);
}
function replayThresholdMs() { return clampInteger(settings.audioPipeline?.replayOnlyBeforeMs, 250, 0, 1000); }
function getCompletionGraceMs() { return clampInteger(settings.audioPipeline?.completionGraceMs, 750, 250, 3000); }

function getGeneratedAudioDurationMs(generated) {
  if (!Buffer.isBuffer(generated?.audioBuffer)) return 0;
  const format = String(generated?.audioFormat || '').toLowerCase();
  if (format === 's16le') return getPcmDurationMs(generated.audioBuffer.length, generated?.sampleRate, generated?.channels);
  if (format === 'mp3') return mp3DurationMs(generated.audioBuffer);
  return 0;
}

function getRecoveryResumeStartMs(item, generated) {
  const fraction = Math.max(0, Math.min(Number(item?.resumeFraction) || 0, 0.98));
  const durationMs = getGeneratedAudioDurationMs(generated);
  if (fraction <= 0 || durationMs <= 0) return 0;
  const overlapMs = clampNumber(settings.audioPipeline?.playbackResumeOverlapMs, 120, 0, 400);
  return Math.max(0, durationMs * fraction - overlapMs);
}

function buildTranscriptTextTail(item, transcript) {
  const source = String(item?.text || '').trim();
  const outputWords = normalizeTranscriptWords(transcript);
  if (!source || outputWords.length < 2) return null;
  const sourceMatches = [...source.matchAll(/[\p{L}\p{N}]+/gu)];
  if (outputWords.length >= sourceMatches.length || sourceMatches.length < 3) return null;
  for (let index = 0; index < outputWords.length; index += 1) {
    if (sourceMatches[index][0].toLocaleLowerCase('en') !== outputWords[index]) return null;
  }
  const last = sourceMatches[outputWords.length - 1];
  const tail = source.slice(Number(last.index) + last[0].length).replace(/^[\s,.;:!?…-]+/u, '').trim();
  return tail || null;
}

function scheduleRecovery(guildId, state, item, error, { replay = null, fullRetry = false, replacementText = null, resumeFraction = 0 } = {}) {
  const maximum = getStreamCutoffRecoveryAttempts();
  const recoveryText = String(replacementText || item.text || '').trim();
  const safeResumeFraction = Math.max(0, Math.min(Number(resumeFraction) || 0, 0.98));
  if (item.cancelled || state.disposed || item.recoveryScheduled || item.recoveryAttempt >= maximum || !recoveryText) return false;
  if (!fullRetry && !Buffer.isBuffer(replay?.audioBuffer) && !replacementText && safeResumeFraction <= 0) return false;
  const regeneratedTail = Boolean(replacementText || safeResumeFraction > 0);
  const recovery = createQueueItem(recoveryText, {
    messageCreatedAt: item.messageCreatedAt, preprocessMs: item.preprocessMs, userId: item.userId,
    messageId: item.messageId, voiceChannelId: item.voiceChannelId,
    voice: item.voice, speakerLabel: item.speakerLabel, speakerResetSeconds: item.speakerResetSeconds,
    googleText: replacementText ? recoveryText : item.googleText,
    verificationText: recoveryText, forceBuffered: true,
    recoveryAttempt: item.recoveryAttempt + 1, isRecovery: true,
    recoveryEpoch: item.recoveryEpoch,
    skipLive: regeneratedTail ? true : fullRetry ? Boolean(item.skipLive || String(error?.provider || '').includes('live')) : true,
    replayAudioBuffer: replay?.audioBuffer || null, replayAudioFormat: replay?.audioFormat || null,
    replayMimeType: replay?.mimeType || null, replaySampleRate: replay?.sampleRate || 24_000,
    replayChannels: replay?.channels || 1, resumeFraction: safeResumeFraction
  });
  item.recoveryScheduled = true;
  state.queue.unshift(recovery);
  state.cutoffRecoveries = (Number(state.cutoffRecoveries) || 0) + 1;
  if (replay?.audioBuffer) state.mirrorReplays = (Number(state.mirrorReplays) || 0) + 1;
  const kind = replay?.audioBuffer ? 'PCM tail' : replacementText ? 'text tail' : safeResumeFraction > 0 ? 'regenerated tail' : 'full pre-audible';
  console.warn(`[queue:${guildId}] Scheduling conservative ${kind} recovery (${error?.message || 'playback failure'}).`);
  if (!state.running && state.voiceReady && !state.disposed) queueMicrotask(() => { if (canRunQueue(state)) void runQueue(guildId, state); });
  return true;
}

function handleCompletionRecovery(guildId, state, item, generated, playedMs, playbackSpeed, { info = null, error = null, timedOut = false, triggerError = null } = {}) {
  if (!item || item.cancelled || state.disposed || item.recoveryScheduled) return false;
  const staleEpoch = Number(item.recoveryEpoch ?? 0) !== Number(state.recoveryEpoch ?? item.recoveryEpoch ?? 0);
  const staleSerial = Number(item.runSerial || 0) > 0 && Number(state.runSerial || 0) > Number(item.runSerial || 0);
  if (staleEpoch || staleSerial) {
    state.suppressedCutoffReplays = (Number(state.suppressedCutoffReplays) || 0) + 1;
    return false;
  }
  const metadata = {
    ...generated,
    audioFormat: error?.audioFormat || generated?.audioFormat,
    sampleRate: error?.sampleRate || generated?.sampleRate,
    channels: error?.channels || generated?.channels
  };
  const audioBuffer = info?.audioBuffer || error?.partialAudioBuffer || (Buffer.isBuffer(generated?.audioBuffer) ? generated.audioBuffer : null);
  const audioBytes = Number(info?.audioBytes ?? error?.audioBytes ?? audioBuffer?.length) || 0;
  const transcript = String(info?.transcript ?? error?.transcript ?? generated?.transcript ?? '').trim();
  const suspiciousDuration = String(metadata.audioFormat || '').toLowerCase() === 's16le' && audioBytes > 0 && isSuspiciouslyShortPcm(item, metadata, audioBytes);
  const suspiciousTranscript = isSuspiciousTranscript(item, transcript);
  // Coverage is useful for both successful completion metadata and provider
  // errors carrying a mirrored partialAudioBuffer. Do not discard that objective
  // playback signal merely because the completion promise rejected.
  const coverage = audioBytes > 0
    ? getPlaybackCoverage(metadata, { ...(info || {}), audioBytes }, { playbackDuration: playedMs }, playbackSpeed)
    : null;
  if (suspiciousDuration) state.suspiciousShortOutputs = (Number(state.suspiciousShortOutputs) || 0) + 1;
  if (suspiciousTranscript) state.transcriptCutoffs = (Number(state.transcriptCutoffs) || 0) + 1;
  if (coverage?.suspicious) state.playbackCutoffs = (Number(state.playbackCutoffs) || 0) + 1;

  // Keep local playback failures distinct from provider-completion failures.
  // A completion promise can reject after the audio stream already ended cleanly;
  // that metadata-only failure is not, by itself, proof that speech was cut off.
  const playbackFailure = Boolean(triggerError);
  const completionFailure = Boolean(error && !error.cancelled);
  const hardPlaybackCutoff = isHardPlaybackCutoff(coverage);
  if (playedMs <= replayThresholdMs() && playbackFailure) {
    return scheduleRecovery(guildId, state, item, triggerError, { fullRetry: true });
  }

  const textTail = buildTranscriptTextTail(item, transcript);
  const actualMs = String(metadata.audioFormat || '').toLowerCase() === 's16le' && audioBytes > 0
    ? getPcmDurationMs(audioBytes, metadata.sampleRate, metadata.channels)
    : 0;
  const expectedMs = Math.max(1, estimateRecoveryDurationMs(item.verificationText || item.text));
  const severeShort = actualMs >= 250 && actualMs < expectedMs * 0.75 && expectedMs - actualMs >= 650;
  // Strong-short is deliberately much stricter than severeShort. It is never
  // sufficient on its own for generic recovery; it only corroborates another
  // independent signal such as a partial transcript or provider failure. The
  // 58% boundary preserves confirmed ~1.3s/1.1s cutoffs while rejecting normal
  // fast complete speech that merely beats the duration estimator.
  const strongShort = actualMs >= 250 && actualMs < expectedMs * 0.58 && expectedMs - actualMs >= 800;

  const tail = buildPcmTail(audioBuffer, metadata, playedMs, playbackSpeed);
  const pcmTailEvidence = playbackFailure
    || hardPlaybackCutoff
    || (timedOut && Boolean(coverage?.suspicious))
    || (completionFailure && strongShort);
  if (tail && pcmTailEvidence) {
    return scheduleRecovery(guildId, state, item, triggerError || error || new Error('Severe local playback cutoff.'), { replay: tail });
  }

  const transcriptTailRecovery = shouldRecoverTranscriptTail({
    suspiciousTranscript,
    strongShort,
    playbackFailure,
    timedOut,
    suspiciousDuration,
    playbackSuspicious: Boolean(coverage?.suspicious),
    hardPlaybackCutoff
  });
  if (textTail && suspiciousTranscript && !transcriptTailRecovery) {
    state.suppressedCutoffReplays = (Number(state.suppressedCutoffReplays) || 0) + 1;
  }
  if (textTail && transcriptTailRecovery) {
    return scheduleRecovery(guildId, state, item, triggerError || error || new Error('Truncated completion transcript.'), { replacementText: textTail });
  }

  const regeneratedTailEvidence = hardPlaybackCutoff
    || (playbackFailure && severeShort)
    || (timedOut && (strongShort || Boolean(coverage?.suspicious)))
    || (completionFailure && strongShort);
  if (playedMs > replayThresholdMs() && severeShort && regeneratedTailEvidence) {
    const heardSourceMs = Math.max(0, Number(playedMs) || 0) * Math.max(1, Number(playbackSpeed) || 1);
    const resumeFraction = Math.max(0.10, Math.min(heardSourceMs / expectedMs, 0.95));
    return scheduleRecovery(guildId, state, item, triggerError || error || new Error('Severely short streamed output.'), { resumeFraction });
  }
  return false;
}

function scheduleCompletionGraceCancel(guildId, state, generated, context = {}) {
  const completion = generated?.completion;
  if (!completion || typeof completion.then !== 'function') return false;
  let settled = false;
  let timedOut = false;
  const graceMs = getCompletionGraceMs();
  const timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    state.completionGraceTimeouts = (Number(state.completionGraceTimeouts) || 0) + 1;
    try { generated?.cancel?.(new Error('Completion metadata grace expired after audio playback finished.')); } catch {}
    console.warn(`[queue:${guildId}] Provider completion exceeded ${graceMs}ms after finished audio; cancelled asynchronously and checked for a recoverable tail.`);
  }, graceMs);
  timer.unref?.();
  Promise.resolve(completion).then((info) => {
    settled = true;
    clearTimeout(timer);
    if (context.item) handleCompletionRecovery(guildId, state, context.item, generated, context.playedMs, context.playbackSpeed, { info, triggerError: context.triggerError || null });
  }).catch((error) => {
    settled = true;
    clearTimeout(timer);
    if (context.item) handleCompletionRecovery(guildId, state, context.item, generated, context.playedMs, context.playbackSpeed, { error, timedOut, triggerError: context.triggerError || null });
  });
  return true;
}

function expectedPlaybackTimeoutMs(item, generated, speed) {
  const safety = clampInteger(settings.audioPipeline?.playbackSafetyMs, 10_000, 3000, 30_000);
  const hardMax = clampInteger(settings.audioPipeline?.playbackHardMaxMs, 60_000, 15_000, 60_000);
  let sourceMs = item.estimatedDurationMs || estimateSpeechDurationMs(item.text);
  const format = String(generated?.audioFormat || '').toLowerCase();
  if (Buffer.isBuffer(generated?.audioBuffer)) {
    if (format === 's16le') sourceMs = getPcmDurationMs(generated.audioBuffer.length, generated?.sampleRate, generated?.channels);
    else if (format === 'mp3') sourceMs = mp3DurationMs(generated.audioBuffer) || sourceMs;
  } else if (generated?.audioStream && String(generated?.provider || '').startsWith('gemini')) {
    sourceMs = Number(settings.geminiLive?.maxOutputAudioMs) || 45_000;
  }
  return Math.min(hardMax, Math.max(15_000, Math.round(sourceMs / Math.max(1, speed) + safety)));
}

function waitForIdleWithActiveTimeout(state, timeoutMs) {
  const maximumActiveMs = Math.max(1000, Number(timeoutMs) || 1000);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let activeMs = 0;
    let lastAt = Date.now();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      state.player.removeListener('stateChange', onStateChange);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onStateChange = (_oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle) finish();
    };
    const tick = () => {
      if (settled) return;
      const now = Date.now();
      const status = state.player.state.status;
      const paused = state.voicePaused || status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused;
      if (!paused) activeMs += Math.max(0, now - lastAt);
      lastAt = now;
      if (status === AudioPlayerStatus.Idle) { finish(); return; }
      if (activeMs >= maximumActiveMs) {
        const error = new Error(`Audio playback exceeded ${Math.round(maximumActiveMs)}ms of active time.`);
        error.name = 'PlaybackTimeoutError';
        finish(error);
        return;
      }
      timer = setTimeout(tick, 100);
      timer.unref?.();
    };

    state.player.on('stateChange', onStateChange);
    if (state.player.state.status === AudioPlayerStatus.Idle) { finish(); return; }
    timer = setTimeout(tick, 100);
    timer.unref?.();
  });
}

function createProgressWatchdog(state, resource) {
  const threshold = clampInteger(settings.audioPipeline?.progressWatchdogMs, 12_000, 3000, 30_000);
  let stopped = false, timer = null, lastValue = 0, lastProgressAt = Date.now(), rejectPromise;
  const promise = new Promise((_, reject) => { rejectPromise = reject; });
  promise.catch(() => {});
  const tick = () => {
    if (stopped) return;
    const current = Math.max(0, Number(resource?.playbackDuration) || 0);
    if (state.voicePaused || state.player.state.status === AudioPlayerStatus.Paused || state.player.state.status === AudioPlayerStatus.AutoPaused) {
      lastProgressAt = Date.now();
    } else if (current > lastValue + 5) {
      lastValue = current; lastProgressAt = Date.now();
    } else if (state.player.state.status === AudioPlayerStatus.Playing && Date.now() - lastProgressAt >= threshold) {
      const error = new Error(`Audio playback made no progress for ${threshold}ms.`);
      error.name = 'PlaybackProgressTimeoutError';
      rejectPromise(error); return;
    }
    timer = setTimeout(tick, 250); timer.unref?.();
  };
  timer = setTimeout(tick, 250); timer.unref?.();
  return { promise, stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

function spawnFfmpeg(args) {
  return spawn(getFfmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function playSpeakerLabel(guildId, state, item) {
  if (!item.speakerLabelNeeded || !item.speakerLabel || item.cancelled || state.disposed) return { waitMs: 0, playedMs: 0 };
  const waitStarted = performance.now();
  const pcm = await waitForSpeakerLabelPcm(item.speakerLabelGeneration);
  const waitMs = performance.now() - waitStarted;
  if (!pcm || item.cancelled || state.disposed) return { waitMs, playedMs: 0 };
  const prelude = buildSpeakerPreludePcm(pcm);
  if (!prelude) return { waitMs, playedMs: 0 };

  const fixedVolume = clampNumber(settings.fixedVolume, 0.6, 0, 2);
  const { gain, speed } = getSpeakerLabelOptions();
  const filters = buildAudioFilters({ volume: Math.min(2, fixedVolume * gain), playbackSpeed: speed, audioPipeline: settings.audioPipeline });
  const ffmpeg = spawnFfmpeg([
    '-hide_banner','-loglevel','error','-nostdin','-f','s16le','-ar','24000','-ac','1','-i','pipe:0',
    '-map','0:a:0','-vn','-af',filters.join(','),'-ac','2','-ar','48000','-c:a','libopus','-b:a','96k','-application','audio','-frame_duration','20','-page_duration','20000','-flush_packets','1','-f','ogg','pipe:1'
  ]);
  state.ffmpeg = ffmpeg;
  let failReject;
  const failure = new Promise((_, reject) => { failReject = reject; }); failure.catch(() => {});
  const fail = (error) => failReject(error instanceof Error ? error : new Error(String(error)));
  ffmpeg.on('error', fail);
  ffmpeg.on('close', (code) => { if (code !== 0 && code !== null && !item.cancelled) fail(new Error(`Speaker-label FFmpeg exited with code ${code}.`)); });
  ffmpeg.stderr.resume();
  ffmpeg.stdin.on('error', (error) => { if (error?.code !== 'EPIPE') fail(error); });
  ffmpeg.stdin.end(prelude);
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, metadata: { speakerLabel: item.speakerLabel } });
  const onError = (error) => fail(error);
  state.player.once('error', onError);
  try {
    state.player.play(resource);
    await Promise.race([entersState(state.player, AudioPlayerStatus.Playing, 5000), failure]);
    item.firstAudibleAtEpoch ||= Date.now();
    const labelMs = getPcmDurationMs(pcm.length, 24_000, 1) / Math.max(0.8, speed);
    const heardThresholdMs = Math.max(80, labelMs * 0.80);
    let heardTimer = null;
    const commitWhenHeard = () => {
      if (item.speakerLabelHeard || item.cancelled || state.disposed) return;
      const played = Math.max(0, Number(resource.playbackDuration) || 0);
      if (played >= heardThresholdMs) markSpeakerAnnounced(state, item);
      else { heardTimer = setTimeout(commitWhenHeard, 20); heardTimer.unref?.(); }
    };
    commitWhenHeard();
    const watchdog = createProgressWatchdog(state, resource);
    try { await Promise.race([waitForIdleWithActiveTimeout(state, 12_000), failure, watchdog.promise]); }
    finally { watchdog.stop(); if (heardTimer) clearTimeout(heardTimer); }
    const played = Math.max(0, Number(resource.playbackDuration) || 0);
    if (!item.speakerLabelHeard && played >= heardThresholdMs) markSpeakerAnnounced(state, item);
    return { waitMs, playedMs: played };
  } finally {
    state.player.removeListener('error', onError);
    if (!ffmpeg.killed) ffmpeg.kill();
    if (state.ffmpeg === ffmpeg) state.ffmpeg = null;
  }
}

function wireProviderToInput(generated, input, onFailure) {
  const source = generated?.audioStream;
  let stopped = false;
  let audioEnded = Boolean(!source && Buffer.isBuffer(generated?.audioBuffer));
  const fail = (error) => {
    if (stopped) return;
    try { source?.unpipe?.(input); } catch {}
    try { if (input && !input.destroyed) input.destroy(); } catch {}
    onFailure(error instanceof Error ? error : new Error(String(error)));
  };
  const onSourceEnd = () => { audioEnded = true; };
  const onSourceError = (error) => fail(error);
  if (source?.once) {
    source.once('end', onSourceEnd);
    source.once('error', onSourceError);
  }
  if (generated?.completion && typeof generated.completion.then === 'function') {
    generated.completion.catch((error) => {
      // A rejected completion while audio is still open is a true midstream
      // provider failure and must stop FFmpeg immediately. If the audio stream
      // already ended cleanly, the failure is metadata-only (for example a
      // missing/late turnComplete) and must not truncate already-received audio.
      if (!audioEnded && !source?.readableEnded) fail(error);
    });
  }
  if (source && typeof source.pipe === 'function') source.pipe(input);
  else if (Buffer.isBuffer(generated?.audioBuffer)) input.end(generated.audioBuffer);
  else fail(new Error('TTS provider returned no playable audio.'));
  return () => {
    stopped = true;
    if (source?.removeListener) {
      source.removeListener('end', onSourceEnd);
      source.removeListener('error', onSourceError);
    }
  };
}

function createMessagePipeline(guildId, state, item, generated, playbackSpeed) {
  const format = String(generated?.audioFormat || '').toLowerCase();
  const mime = String(generated?.mimeType || '').toLowerCase();
  const raw = format === 's16le' || mime === 'audio/l16' || mime === 'audio/pcm' || mime.startsWith('audio/pcm;');
  const sampleRate = Math.max(8000, Math.min(Number(generated?.sampleRate) || 24_000, 96_000));
  const channels = Math.max(1, Math.min(Number(generated?.channels) || 1, 2));
  const liveRaw = raw && generated?.audioStream && typeof generated.audioStream.pipe === 'function';
  const lowLatency = liveRaw && settings.audioPipeline?.lowLatencyFfmpeg !== false;
  let input = [];
  if (raw) {
    input = ['-f','s16le','-ar',String(Math.round(sampleRate)),'-ac',String(Math.round(channels))];
    if (lowLatency) input.push('-probesize','32','-analyzeduration','0');
  } else if (format === 'mp3' || mime.includes('mpeg') || mime.includes('mp3')) input = ['-f','mp3'];
  else if (format === 'ogg' || mime.includes('ogg')) input = ['-f','ogg'];

  const volume = clampNumber(settings.fixedVolume, 0.6, 0, 2);
  const filters = buildAudioFilters({ volume, playbackSpeed, audioPipeline: settings.audioPipeline });
  const recoveryResumeStartMs = getRecoveryResumeStartMs(item, generated);
  if (recoveryResumeStartMs > 0) {
    filters.unshift(`atrim=start=${(recoveryResumeStartMs / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
  }
  const ffmpegStartedAt = performance.now();
  let firstEncodedAt = 0;
  const ffmpeg = spawnFfmpeg([
    '-hide_banner','-loglevel','error','-nostdin',...input,'-i','pipe:0','-map','0:a:0','-vn','-af',filters.join(','),
    '-ac','2','-ar','48000','-c:a','libopus','-b:a','96k','-application','audio','-frame_duration','20',
    ...(lowLatency ? ['-page_duration','20000','-flush_packets','1'] : []),'-f','ogg','pipe:1'
  ]);
  state.ffmpeg = ffmpeg;
  ffmpeg.stdout.once('readable', () => { if (!firstEncodedAt) firstEncodedAt = performance.now(); });
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; }); failure.catch(() => {});
  let monitoring = true;
  let unwireProvider = () => {};
  const terminatePipeline = () => {
    const source = generated?.audioStream;
    try { source?.unpipe?.(ffmpeg.stdin); } catch {}
    try { if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.destroy(); } catch {}
    try { if (!ffmpeg.killed) ffmpeg.kill(); } catch {}
  };
  const fail = (error) => {
    if (!monitoring || item.cancelled || state.disposed) return;
    monitoring = false;
    state.pipelineFailures += 1;
    terminatePipeline();
    rejectFailure(error instanceof Error ? error : new Error(String(error)));
  };
  ffmpeg.on('error', fail);
  ffmpeg.on('close', (code, signal) => { if (code !== 0 && code !== null && !item.cancelled && !state.disposed) fail(new Error(`FFmpeg exited with code ${code}${signal ? ` (${signal})` : ''}.`)); });
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk) => { const output = chunk.trim(); if (output) console.error(`[ffmpeg:${guildId}] ${output}`); });
  ffmpeg.stdin.on('error', (error) => { if (error?.code !== 'EPIPE' && !item.cancelled && !state.disposed) fail(error); });
  unwireProvider = wireProviderToInput(generated, ffmpeg.stdin, fail);
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, metadata: { text: item.text } });
  return {
    ffmpeg, resource, failure, ffmpegStartedAt,
    getFirstEncodedAt: () => firstEncodedAt,
    stopMonitoring: () => { monitoring = false; unwireProvider(); }
  };
}

async function brieflyResolveCompletion(generated, maxWaitMs = 120) {
  const completion = generated?.completion;
  if (!completion || typeof completion.then !== 'function') return { info: null, error: null };
  const timeout = Symbol('timeout');
  let timer;
  try {
    const result = await Promise.race([
      completion.then((info) => ({ info, error: null })).catch((error) => ({ info: null, error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), maxWaitMs); timer.unref?.(); })
    ]);
    return result === timeout ? { info: null, error: null } : result;
  } finally { if (timer) clearTimeout(timer); }
}

export function subscribePlayer(guildId, connection, channelId = null) {
  const state = getState(guildId);
  state.disposed = false;
  state.voicePaused = false;
  const subscription = connection.subscribe(state.player);
  if (!subscription) {
    state.voiceReady = false;
    throw new Error('Failed to subscribe audio player.');
  }
  state.voiceReady = true;
  state.voiceChannelId = channelId ? String(channelId) : state.voiceChannelId;
  state.pendingVoiceChannelId = null;
  console.log(`[audio:${guildId}] Ready.`);
  if (!state.running && state.queue.length) void runQueue(guildId, state);
}

export function pauseAudioForVoice(guildId) {
  const state = states.get(guildId);
  if (!state) return false;
  state.voiceReady = false;
  state.voicePaused = true;
  try { return state.player.pause(true); } catch { return false; }
}
export function resumeAudioForVoice(guildId) {
  const state = states.get(guildId);
  if (!state) return false;
  state.voiceReady = true;
  state.voicePaused = false;
  let resumed = false;
  try { resumed = state.player.unpause(); } catch {}
  if (!state.running && state.queue.length) void runQueue(guildId, state);
  return resumed;
}

export function enqueue(guildId, text, metadata = {}) {
  const state = getState(guildId);
  const maximum = getMaximumQueuedMessages();
  const incoming = createQueueItem(text, metadata);
  incoming.recoveryEpoch = Number(state.recoveryEpoch) || 0;
  // During a cold voice handshake the first queued channel owns the pending
  // startup. Reject cross-channel arrivals before provider work begins so the
  // new voice/TTS overlap cannot waste quota on audio that can never play.
  if (!state.voiceReady && incoming.voiceChannelId) {
    const channelId = String(incoming.voiceChannelId);
    if (!state.pendingVoiceChannelId) state.pendingVoiceChannelId = channelId;
    else if (String(state.pendingVoiceChannelId) !== channelId) {
      cleanupCancelledQueuedItem(incoming);
      return 'rejected-other-channel';
    }
  }
  // One Discord message is always one queue/TTS item. While a cold Discord
  // voice connection is still handshaking, start FIFO TTS prefetch immediately
  // but defer actual playback until subscribePlayer marks voiceReady.
  if (state.queue.length >= maximum) dropForQueueOverflow(guildId, state, maximum);
  state.queue.push(incoming);
  if (state.running || !state.voiceReady) {
    prefetchNext(guildId, state);
    return state.voiceReady ? 'queued' : 'prefetching-for-voice';
  }
  void runQueue(guildId, state);
  return 'started';
}

function canRunQueue(state) {
  return Boolean(state && !state.disposed && !state.running && state.voiceReady && state.queue?.length);
}

async function runQueue(guildId, state) {
  if (!canRunQueue(state)) return;
  const item = takeNextItem(state);
  if (!item) return;
  item.runSerial = (Number(state.runSerial) || 0) + 1;
  state.runSerial = item.runSerial;
  state.running = true;
  state.currentItem = item;
  const queueMs = Math.max(0, performance.now() - item.enqueuedAt);
  let generated = null;
  let pipeline = null;
  let playerErrorListener = null;
  let messageResource = null;
  let messagePlaybackSpeed = 1;

  try {
    item.speakerLabelNeeded = decideSpeakerLabel(state, item, metadataResetSeconds(item));
    const generation = startGeneration(guildId, item);
    prefetchNext(guildId, state);

    let speakerLabelWaitMs = 0;
    if (item.speakerLabelNeeded) {
      const labelResult = await playSpeakerLabel(guildId, state, item);
      speakerLabelWaitMs = labelResult.waitMs;
    }

    generated = await generation;
    if (item.cancelled || state.disposed) return;

    // Buffered raw outputs can be checked before playback; a clearly truncated
    // Live result is failed over before the listener hears it.
    if (item.generationMode === 'buffered' && Buffer.isBuffer(generated?.audioBuffer) && String(generated?.audioFormat || '').toLowerCase() === 's16le') {
      const completionCheck = await brieflyResolveCompletion(generated, 0);
      const shortDuration = isSuspiciouslyShortPcm(item, generated, generated.audioBuffer.length);
      const shortTranscript = isSuspiciousTranscript(item, completionCheck.info?.transcript || generated?.transcript);
      if (shortDuration || shortTranscript) {
        if (shortDuration) state.suspiciousShortOutputs += 1;
        if (shortTranscript) state.transcriptCutoffs += 1;
        await cleanupGenerated(generated, { cancel: true });
        item.generation = null; item.skipLive = true;
        generated = await startGeneration(guildId, item);
      }
    }

    if (item.resumeFraction > 0) {
      const durationMs = getGeneratedAudioDurationMs(generated);
      const resumeStartMs = getRecoveryResumeStartMs(item, generated);
      if (durationMs > 0 && durationMs - resumeStartMs < 300) {
        state.suppressedCutoffReplays += 1;
        console.warn(`[queue:${guildId}] Regenerated recovery contained no meaningful unheard tail; replay suppressed.`);
        return;
      }
    }

    messagePlaybackSpeed = getCatchUpSpeed(state);
    item.playbackSpeed = messagePlaybackSpeed;
    pipeline = createMessagePipeline(guildId, state, item, generated, messagePlaybackSpeed);
    messageResource = pipeline.resource;
    const onPlayerError = (error) => { throwIntoPromise(error); };
    let rejectPlayer;
    const playerFailure = new Promise((_, reject) => { rejectPlayer = reject; }); playerFailure.catch(() => {});
    function throwIntoPromise(error) { rejectPlayer(error); }
    playerErrorListener = onPlayerError;
    state.player.once('error', onPlayerError);
    state.player.play(messageResource);
    await Promise.race([entersState(state.player, AudioPlayerStatus.Playing, 10_000), pipeline.failure, playerFailure]);
    item.playbackStartedAt = performance.now();
    const messageAudibleEpoch = Date.now();
    item.firstAudibleAtEpoch ||= messageAudibleEpoch;

    const firstEncodedAt = pipeline.getFirstEncodedAt();
    const ffmpegFirstPacketMs = firstEncodedAt ? Math.max(0, firstEncodedAt - pipeline.ffmpegStartedAt) : Math.max(0, item.playbackStartedAt - pipeline.ffmpegStartedAt);
    const discordBufferMs = firstEncodedAt ? Math.max(0, item.playbackStartedAt - firstEncodedAt) : 0;
    const timeToSpeechMs = Math.max(0, item.firstAudibleAtEpoch - item.messageCreatedAt);
    const timeToMessageSpeechMs = Math.max(0, messageAudibleEpoch - item.messageCreatedAt);
    const sample = recordTtsMetrics(guildId, {
      preprocessMs: item.preprocessMs, speakerLabelWaitMs, queueMs,
      providerMs: generated?.metrics?.providerMs ?? 0,
      provider: generated?.provider ?? 'unknown',
      ffmpegMs: item.playbackStartedAt - pipeline.ffmpegStartedAt,
      ffmpegFirstPacketMs, discordBufferMs, playbackSpeed: messagePlaybackSpeed,
      timeToSpeechMs, timeToMessageSpeechMs,
      providerAttempts: generated?.metrics?.attempts ?? []
    });
    const slowThreshold = Math.max(250, Number(settings.diagnostics?.slowTtsMs) || 1800);
    if (sample.timeToMessageSpeechMs >= slowThreshold) {
      console.warn(`[slow-tts:${guildId}] first-sound=${sample.timeToSpeechMs.toFixed(0)}ms message=${sample.timeToMessageSpeechMs.toFixed(0)}ms provider=${sample.providerMs.toFixed(0)}ms (${sample.provider}) queue=${sample.queueMs.toFixed(0)}ms ffmpeg-first=${sample.ffmpegFirstPacketMs.toFixed(0)}ms discord=${sample.discordBufferMs.toFixed(0)}ms speed=${sample.playbackSpeed.toFixed(2)}x`);
    }

    const watchdog = createProgressWatchdog(state, messageResource);
    try {
      await Promise.race([
        waitForIdleWithActiveTimeout(state, expectedPlaybackTimeoutMs(item, generated, messagePlaybackSpeed)),
        pipeline.failure, playerFailure, watchdog.promise
      ]);
    } finally { watchdog.stop(); }
    state.player.removeListener('error', onPlayerError); playerErrorListener = null;
    pipeline.stopMonitoring();

    const playedMs = Math.max(0, Number(messageResource.playbackDuration) || 0);
    // Audio completion controls queue progression. Completion metadata is useful
    // for diagnostics/health, but must never add hundreds of milliseconds of
    // dead air after the listener already heard the whole message. Check only
    // what is already settled; otherwise observe/cancel it in the background.
    const completionResult = await brieflyResolveCompletion(generated, 1);
    if ((completionResult.error || completionResult.info) && !item.cancelled && !state.disposed) {
      const recovered = handleCompletionRecovery(guildId, state, item, generated, playedMs, messagePlaybackSpeed, completionResult);
      if (!recovered && completionResult.error) {
        state.suppressedCutoffReplays += 1;
        console.warn(`[queue:${guildId}] Midstream provider failure occurred after ${Math.round(playedMs)}ms; no safe tail was available.`);
      }
    } else {
      scheduleCompletionGraceCancel(guildId, state, generated, { item, playedMs, playbackSpeed: messagePlaybackSpeed });
    }

    if (item.isRecovery && !item.cancelled && !state.disposed) state.cutoffRecoverySuccesses += 1;
  } catch (error) {
    if (!generated) {
      // Speaker-label/voice/playback setup can fail while the overlapped TTS
      // request is still generating. Abort that unclaimed provider work before
      // scheduling recovery so one failed prelude cannot leave duplicate API
      // work running in the background.
      abandonUnclaimedGeneration(item, 'Playback failed before provider handoff.');
    }
    if (!item.cancelled && !state.disposed) {
      const playedMs = Math.max(0, Number(messageResource?.playbackDuration) || 0);
      const brief = await brieflyResolveCompletion(generated, 120);
      let recovered = handleCompletionRecovery(guildId, state, item, generated || {}, playedMs, messagePlaybackSpeed, {
        info: brief.info, error: brief.error, triggerError: error
      });
      if (!recovered) {
        recovered = scheduleCompletionGraceCancel(guildId, state, generated, {
          item, playedMs, playbackSpeed: messagePlaybackSpeed, triggerError: error
        });
      }
      if (!recovered) {
        state.suppressedCutoffReplays += 1;
        console.warn(`[queue:${guildId}] Playback/provider failure after ${Math.round(playedMs)}ms; no safe immediate or late recovery source was available.`);
        if (item.isRecovery) state.cutoffRecoveryFailures += 1;
        console.error(`[queue:${guildId}]`, error);
      }
    }
  } finally {
    if (playerErrorListener) state.player.removeListener('error', playerErrorListener);
    pipeline?.stopMonitoring?.();
    if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill();
    state.ffmpeg = null;
    await cleanupGenerated(generated, { cancel: item.cancelled });
    state.currentItem = null; state.running = false;
    if (!state.disposed) void runQueue(guildId, state);
  }
}

function metadataResetSeconds(item) {
  return Number(item?.speakerResetSeconds ?? settings.speakerResetSeconds ?? 30);
}


function cancelQueuedItemsForUser(state, userId) {
  const id = String(userId ?? '');
  if (!state || !id || !Array.isArray(state.queue)) return 0;
  let cancelled = 0;
  const kept = [];
  for (const item of state.queue) {
    if (String(item.userId ?? '') === id) {
      cancelled += 1;
      cleanupCancelledQueuedItem(item);
    } else {
      kept.push(item);
    }
  }
  state.queue = kept;
  return cancelled;
}

function cancelCurrentItemForUser(state, userId) {
  const id = String(userId ?? '');
  const current = state?.currentItem;
  if (!id || !current || String(current.userId ?? '') !== id) return false;
  current.cancelled = true;
  if (!current.abortController.signal.aborted) current.abortController.abort(cancelledError('User opted out of TTS.'));
  current.generation?.then((generated) => { try { generated?.cancel?.(cancelledError('User opted out of TTS.')); } catch {} }).catch(() => {});
  try { state.player?.stop?.(true); } catch {}
  if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill();
  return true;
}

export function cancelUserAudio(guildId, userId) {
  const state = states.get(guildId);
  const id = String(userId ?? '');
  if (!state || !id) return { cancelledCurrent: false, cancelledQueued: 0 };
  const cancelledQueued = cancelQueuedItemsForUser(state, id);
  const cancelledCurrent = cancelCurrentItemForUser(state, id);
  if (!state.running && state.voiceReady && state.queue.length) void runQueue(guildId, state);
  return { cancelledCurrent, cancelledQueued };
}

export function cancelMessageAudio(guildId, messageId) {
  const state = states.get(guildId);
  const id = String(messageId ?? '');
  if (!state || !id) return false;
  if (state.currentItem && String(state.currentItem.messageId ?? '') === id) {
    const item = state.currentItem;
    item.cancelled = true;
    if (!item.abortController.signal.aborted) item.abortController.abort(cancelledError('Message TTS cancelled.'));
    item.generation?.then((generated) => { try { generated?.cancel?.(cancelledError('Message TTS cancelled.')); } catch {} }).catch(() => {});
    try { state.player.stop(true); } catch {}
    if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill();
    return true;
  }
  const index = state.queue.findIndex((item) => String(item.messageId ?? '') === id);
  if (index < 0) return false;
  const [item] = state.queue.splice(index, 1);
  cleanupCancelledQueuedItem(item);
  return true;
}

export function clearAudio(guildId) {
  const state = states.get(guildId);
  if (!state) return;
  // Invalidate post-playback completion observers from the pre-clear queue.
  // Otherwise a late metadata callback could resurrect audio after /clear.
  state.recoveryEpoch = (Number(state.recoveryEpoch) || 0) + 1;
  if (state.currentItem) {
    state.currentItem.cancelled = true;
    if (!state.currentItem.abortController.signal.aborted) state.currentItem.abortController.abort(cancelledError('Audio cleared.'));
    state.currentItem.generation?.then((generated) => { try { generated?.cancel?.(cancelledError('Audio cleared.')); } catch {} }).catch(() => {});
  }
  for (const item of state.queue) cleanupCancelledQueuedItem(item);
  state.queue.length = 0;
  state.player.stop(true);
  if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill();
}

export function releaseAudio(guildId) {
  const state = states.get(guildId);
  if (!state) return;
  state.disposed = true;
  clearAudio(guildId);
  states.delete(guildId);
}

function estimateBacklogMs(state) {
  let total = 0;
  const now = performance.now();
  if (state.currentItem) {
    const speed = Math.max(1, Number(state.currentItem.playbackSpeed) || 1);
    const full = (state.currentItem.estimatedDurationMs || estimateSpeechDurationMs(state.currentItem.text)) / speed;
    total += state.currentItem.playbackStartedAt > 0 ? Math.max(0, full - (now - state.currentItem.playbackStartedAt)) : full;
  }
  total += getWaitingSpeechMs(state) / Math.max(1, getCatchUpSpeed(state));
  return Math.round(total);
}

export function getAudioStatus(guildId) {
  const state = states.get(guildId);
  const empty = {
    queued: 0, playing: false, voiceReady: false, pausedForVoice: false, maximumQueued: getMaximumQueuedMessages(), estimatedBacklogMs: 0,
    oldestWaitingMs: 0, prefetched: 0, prefetchTarget: 1, catchUpSpeed: 1, queueMode: 'normal',
    droppedMessages: 0, staleSkippedMessages: 0, streamingPrefetches: 0,
    cutoffRecoveries: 0, cutoffRecoverySuccesses: 0, cutoffRecoveryFailures: 0,
    suspiciousShortOutputs: 0, transcriptCutoffs: 0, playbackCutoffs: 0, mirrorReplays: 0,
    suppressedCutoffReplays: 0, completionGraceTimeouts: 0, pipelineFailures: 0
  };
  if (!state) return empty;
  const prefetched = state.queue.filter((item) => Boolean(item.generation)).length;
  const speed = state.currentItem?.playbackSpeed || getCatchUpSpeed(state);
  const oldest = state.queue.length ? Math.max(0, Date.now() - Math.min(...state.queue.map((item) => item.messageCreatedAt))) : 0;
  return {
    ...empty,
    queued: state.queue.length, playing: Boolean(state.running && state.currentItem), voiceReady: state.voiceReady, pausedForVoice: state.voicePaused,
    estimatedBacklogMs: estimateBacklogMs(state), oldestWaitingMs: oldest, prefetched,
    prefetchTarget: getPrefetchAhead(state), catchUpSpeed: speed, queueMode: speed > 1.0001 ? 'catch-up' : 'normal',
    droppedMessages: state.droppedMessages, staleSkippedMessages: state.staleSkippedMessages,
    streamingPrefetches: state.streamingPrefetches, cutoffRecoveries: state.cutoffRecoveries,
    cutoffRecoverySuccesses: state.cutoffRecoverySuccesses, cutoffRecoveryFailures: state.cutoffRecoveryFailures,
    suspiciousShortOutputs: state.suspiciousShortOutputs, transcriptCutoffs: state.transcriptCutoffs,
    playbackCutoffs: state.playbackCutoffs, mirrorReplays: state.mirrorReplays,
    suppressedCutoffReplays: state.suppressedCutoffReplays, completionGraceTimeouts: state.completionGraceTimeouts,
    pipelineFailures: state.pipelineFailures
  };
}

export const __test = { mp3DurationMs, decideSpeakerLabel, buildPcmTail, buildTranscriptTextTail, handleCompletionRecovery, getGeneratedAudioDurationMs, getRecoveryResumeStartMs, createQueueItem, cancelQueuedItemsForUser, cancelCurrentItemForUser, createPrefetchSpool, wireProviderToInput, scheduleRecovery, scheduleCompletionGraceCancel, canRunQueue, takeNextItem, abandonUnclaimedGeneration };
