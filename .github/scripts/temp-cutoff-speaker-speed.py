from pathlib import Path

ROOT = Path('.')

def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# Default/user-facing speaker-label settings.
replace_once('config/settings.json',
'''  "speakerLabel": {
    "enabled": true,
    "gapMs": 100,
    "maxWaitMs": 300,
    "gain": 1.5,''',
'''  "speakerLabel": {
    "enabled": true,
    "speed": 1.15,
    "gapMs": 75,
    "maxWaitMs": 300,
    "gain": 1.5,''')

replace_once('src/config.js',
'''  speakerLabel: {
    enabled: true,
    gapMs: 100,
    maxWaitMs: 300,
    gain: 1.50,''',
'''  speakerLabel: {
    enabled: true,
    speed: 1.15,
    gapMs: 75,
    maxWaitMs: 300,
    gain: 1.50,''')

replace_once('src/config.js',
'''    speakerLabel: {
      enabled: speakerLabel.enabled !== false,
      gapMs: clampInt(speakerLabel.gapMs, defaults.speakerLabel.gapMs, 0, 500),
      maxWaitMs: clampInt(speakerLabel.maxWaitMs, defaults.speakerLabel.maxWaitMs, 0, 3000),
      gain: clamp(speakerLabel.gain, defaults.speakerLabel.gain, 0.25, 2.0),''',
'''    speakerLabel: {
      enabled: speakerLabel.enabled !== false,
      speed: clamp(speakerLabel.speed, defaults.speakerLabel.speed, 0.8, 1.5),
      gapMs: clampInt(speakerLabel.gapMs, defaults.speakerLabel.gapMs, 0, 500),
      maxWaitMs: clampInt(speakerLabel.maxWaitMs, defaults.speakerLabel.maxWaitMs, 0, 3000),
      gain: clamp(speakerLabel.gain, defaults.speakerLabel.gain, 0.25, 2.0),''')

replace_once('src/speaker-label.js',
'''  return {
    enabled: configured.enabled !== false,
    gapMs: Math.max(0, Math.min(finiteNumber(configured.gapMs, 100), 500)),
    maxWaitMs: Math.max(0, Math.min(finiteNumber(configured.maxWaitMs, 300), 3000)),''',
'''  return {
    enabled: configured.enabled !== false,
    speed: Math.max(0.8, Math.min(finiteNumber(configured.speed, 1.15), 1.5)),
    gapMs: Math.max(0, Math.min(finiteNumber(configured.gapMs, 75), 500)),
    maxWaitMs: Math.max(0, Math.min(finiteNumber(configured.maxWaitMs, 300), 3000)),''')

# Preserve any transcript already received when a Live turn is cancelled/fails,
# so the audio layer can recover an exact missing text suffix when possible.
replace_once('src/providers/gemini-live.js',
'''  const attachPartial = (error) => {
    if (chunks.length) error.partialAudioBuffer = Buffer.concat(chunks, audioBytes);
    error.audioBytes = audioBytes;
    error.sampleRate = OUTPUT_SAMPLE_RATE;
    error.channels = OUTPUT_CHANNELS;
    error.audioFormat = 's16le';
    return error;
  };''',
'''  const attachPartial = (error) => {
    if (chunks.length) error.partialAudioBuffer = Buffer.concat(chunks, audioBytes);
    const transcript = transcriptParts.join(' ').replace(/\\s+/gu, ' ').trim();
    if (transcript) error.transcript = transcript;
    error.audioBytes = audioBytes;
    error.sampleRate = OUTPUT_SAMPLE_RATE;
    error.channels = OUTPUT_CHANNELS;
    error.audioFormat = 's16le';
    return error;
  };''')

# Give healthy Live traffic more jitter tolerance without falling all the way
# back to the 2.8 s stream-idle timeout. generationComplete still closes audio
# immediately, so this only affects turns where completion markers are absent.
replace_once('src/providers/gemini-live.js',
'''  const effectiveAudioEndGraceMs = () => {
    // The grace timer is only a fallback for rare turns where Gemini omits or
    // delays generationComplete/turnComplete. A fixed 650 ms gap can clip a
    // healthy next audio event during network jitter. Protect the first gap
    // for at least 900 ms, then adapt to observed cadence, capped at 1200 ms
    // unless the operator explicitly configured a larger base grace.
    if (audioChunkCount <= 1) return Math.max(audioEndGraceMs, 900);
    const observed = maximumObservedAudioGapMs > 0
      ? Math.ceil(maximumObservedAudioGapMs * 1.35 + 120)
      : audioEndGraceMs;
    return Math.max(audioEndGraceMs, Math.min(1200, observed));
  };''',
'''  const effectiveAudioEndGraceMs = () => {
    // This timer is only a fallback for rare turns where Gemini omits or delays
    // generationComplete/turnComplete. Real Live traffic can occasionally have
    // >1 s gaps between healthy audio chunks, so do not mistake normal network
    // jitter for end-of-speech. Keep this well below streamIdleTimeoutMs so a
    // genuinely markerless turn still releases promptly.
    const floorMs = Math.max(audioEndGraceMs, 1300);
    const ceilingMs = Math.max(floorMs, Math.min(1800, Math.max(1300, streamIdleTimeoutMs - 250)));
    if (audioChunkCount <= 1) return floorMs;
    const observed = maximumObservedAudioGapMs > 0
      ? Math.ceil(maximumObservedAudioGapMs * 1.5 + 180)
      : floorMs;
    return Math.max(floorMs, Math.min(ceilingMs, observed));
  };''')

# Queue item bookkeeping for asynchronous recovery and regenerated-tail trim.
replace_once('src/audio.js',
'''    replaySampleRate: Number(metadata.replaySampleRate) || 24_000,
    replayChannels: Number(metadata.replayChannels) || 1,
    generationMode: null''',
'''    replaySampleRate: Number(metadata.replaySampleRate) || 24_000,
    replayChannels: Number(metadata.replayChannels) || 1,
    resumeFraction: Math.max(0, Math.min(Number(metadata.resumeFraction) || 0, 0.98)),
    recoveryScheduled: false,
    generationMode: null''')

# Speaker label speed is playback-only, so old cached PCM automatically follows
# the new speed without cache invalidation/regeneration.
replace_once('src/audio.js',
'''  const fixedVolume = clampNumber(settings.fixedVolume, 0.6, 0, 2);
  const gain = getSpeakerLabelOptions().gain;
  const filters = buildAudioFilters({ volume: Math.min(2, fixedVolume * gain), playbackSpeed: 1, audioPipeline: settings.audioPipeline });''',
'''  const fixedVolume = clampNumber(settings.fixedVolume, 0.6, 0, 2);
  const { gain, speed } = getSpeakerLabelOptions();
  const filters = buildAudioFilters({ volume: Math.min(2, fixedVolume * gain), playbackSpeed: speed, audioPipeline: settings.audioPipeline });''')

replace_once('src/audio.js',
'''    const labelMs = getPcmDurationMs(pcm.length, 24_000, 1);
    const heardThresholdMs = Math.max(80, labelMs * 0.80);''',
'''    const labelMs = getPcmDurationMs(pcm.length, 24_000, 1) / Math.max(0.8, speed);
    const heardThresholdMs = Math.max(80, labelMs * 0.80);''')

# Add helpers for safe late-completion recovery.
replace_once('src/audio.js',
'''function getStreamCutoffRecoveryAttempts() {
  if (settings.audioPipeline?.streamCutoffRecovery === false) return 0;
  return clampInteger(settings.audioPipeline?.streamCutoffRecoveryAttempts, 1, 0, 2);
}
function replayThresholdMs() { return clampInteger(settings.audioPipeline?.replayOnlyBeforeMs, 250, 0, 1000); }
function getCompletionGraceMs() { return clampInteger(settings.audioPipeline?.completionGraceMs, 750, 250, 3000); }

function scheduleRecovery(guildId, state, item, error, { replay = null, fullRetry = false } = {}) {
  const maximum = getStreamCutoffRecoveryAttempts();
  if (item.cancelled || state.disposed || item.recoveryAttempt >= maximum) return false;
  if (!fullRetry && !Buffer.isBuffer(replay?.audioBuffer)) return false;
  const recovery = createQueueItem(item.text, {
    messageCreatedAt: item.messageCreatedAt, preprocessMs: item.preprocessMs, userId: item.userId,
    messageId: item.messageId, voiceChannelId: item.voiceChannelId,
    voice: item.voice, speakerLabel: item.speakerLabel, speakerResetSeconds: item.speakerResetSeconds, googleText: item.googleText,
    verificationText: item.verificationText, forceBuffered: true,
    recoveryAttempt: item.recoveryAttempt + 1, isRecovery: true,
    skipLive: fullRetry ? Boolean(item.skipLive || String(error?.provider || '').includes('live')) : true,
    replayAudioBuffer: replay?.audioBuffer || null, replayAudioFormat: replay?.audioFormat || null,
    replayMimeType: replay?.mimeType || null, replaySampleRate: replay?.sampleRate || 24_000,
    replayChannels: replay?.channels || 1
  });
  state.queue.unshift(recovery);
  state.cutoffRecoveries += 1;
  if (replay?.audioBuffer) state.mirrorReplays += 1;
  console.warn(`[queue:${guildId}] Scheduling conservative ${replay?.audioBuffer ? 'PCM tail' : 'full pre-audible'} recovery (${error?.message || 'playback failure'}).`);
  return true;
}

function scheduleCompletionGraceCancel(guildId, state, generated) {
  const completion = generated?.completion;
  if (!completion || typeof completion.then !== 'function') return false;
  let settled = false;
  const graceMs = getCompletionGraceMs();
  const timer = setTimeout(() => {
    if (settled) return;
    state.completionGraceTimeouts += 1;
    try { generated?.cancel?.(new Error('Completion metadata grace expired after audio playback finished.')); } catch {}
    console.warn(`[queue:${guildId}] Provider completion exceeded ${graceMs}ms after finished audio; cancelled asynchronously without delaying the next message.`);
  }, graceMs);
  timer.unref?.();
  Promise.resolve(completion).finally(() => {
    settled = true;
    clearTimeout(timer);
  }).catch(() => {});
  return true;
}''',
'''function getStreamCutoffRecoveryAttempts() {
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
  const sourceMatches = [...source.matchAll(/[\\p{L}\\p{N}]+/gu)];
  if (outputWords.length >= sourceMatches.length || sourceMatches.length < 3) return null;
  for (let index = 0; index < outputWords.length; index += 1) {
    if (sourceMatches[index][0].toLocaleLowerCase('en') !== outputWords[index]) return null;
  }
  const last = sourceMatches[outputWords.length - 1];
  const tail = source.slice(Number(last.index) + last[0].length).replace(/^[\\s,.;:!?…-]+/u, '').trim();
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
  const coverage = info && audioBytes > 0
    ? getPlaybackCoverage(metadata, { ...info, audioBytes }, { playbackDuration: playedMs }, playbackSpeed)
    : null;
  if (suspiciousDuration) state.suspiciousShortOutputs = (Number(state.suspiciousShortOutputs) || 0) + 1;
  if (suspiciousTranscript) state.transcriptCutoffs = (Number(state.transcriptCutoffs) || 0) + 1;
  if (coverage?.suspicious) state.playbackCutoffs = (Number(state.playbackCutoffs) || 0) + 1;

  const genuineFailure = Boolean(triggerError || (error && !error.cancelled));
  if (playedMs <= replayThresholdMs() && genuineFailure) {
    return scheduleRecovery(guildId, state, item, triggerError || error, { fullRetry: true });
  }

  const tail = buildPcmTail(audioBuffer, metadata, playedMs, playbackSpeed);
  if (tail && (genuineFailure || timedOut || isHardPlaybackCutoff(coverage))) {
    return scheduleRecovery(guildId, state, item, triggerError || error || new Error('Severe local playback cutoff.'), { replay: tail });
  }

  const textTail = buildTranscriptTextTail(item, transcript);
  const actualMs = String(metadata.audioFormat || '').toLowerCase() === 's16le' && audioBytes > 0
    ? getPcmDurationMs(audioBytes, metadata.sampleRate, metadata.channels)
    : 0;
  const expectedMs = Math.max(1, Number(item.estimatedDurationMs) || estimateSpeechDurationMs(item.text));
  const severeShort = actualMs >= 250 && actualMs < expectedMs * 0.75 && expectedMs - actualMs >= 650;

  if (textTail && suspiciousTranscript && (Boolean(info) || genuineFailure || (timedOut && severeShort))) {
    return scheduleRecovery(guildId, state, item, triggerError || error || new Error('Truncated completion transcript.'), { replacementText: textTail });
  }

  if (playedMs > replayThresholdMs() && severeShort && (genuineFailure || timedOut || suspiciousDuration || !transcript)) {
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
}''')

# Apply regenerated-tail trim before volume/tempo/limiter. This works for both
# PCM and MP3 because FFmpeg trims after decoding the input.
replace_once('src/audio.js',
'''  const volume = clampNumber(settings.fixedVolume, 0.6, 0, 2);
  const filters = buildAudioFilters({ volume, playbackSpeed, audioPipeline: settings.audioPipeline });
  const ffmpegStartedAt = performance.now();''',
'''  const volume = clampNumber(settings.fixedVolume, 0.6, 0, 2);
  const filters = buildAudioFilters({ volume, playbackSpeed, audioPipeline: settings.audioPipeline });
  const recoveryResumeStartMs = getRecoveryResumeStartMs(item, generated);
  if (recoveryResumeStartMs > 0) {
    filters.unshift(`atrim=start=${(recoveryResumeStartMs / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
  }
  const ffmpegStartedAt = performance.now();''')

# If a regenerated utterance is no longer than the already-heard fraction,
# suppress it instead of replaying an already-heard ending.
replace_once('src/audio.js',
'''    messagePlaybackSpeed = getCatchUpSpeed(state);
    item.playbackSpeed = messagePlaybackSpeed;
    pipeline = createMessagePipeline(guildId, state, item, generated, messagePlaybackSpeed);''',
'''    if (item.resumeFraction > 0) {
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
    pipeline = createMessagePipeline(guildId, state, item, generated, messagePlaybackSpeed);''')

# Replace the synchronous-only completion decision with the shared recovery
# analyzer and an asynchronous grace watcher.
old_completion = '''    const completionResult = await brieflyResolveCompletion(generated, 1);
    if (completionResult.error && !item.cancelled && !state.disposed) {
      const partial = completionResult.error.partialAudioBuffer;
      const tail = buildPcmTail(partial, { ...generated, audioFormat: completionResult.error.audioFormat || generated?.audioFormat, sampleRate: completionResult.error.sampleRate || generated?.sampleRate, channels: completionResult.error.channels || generated?.channels }, playedMs, messagePlaybackSpeed);
      if (playedMs <= replayThresholdMs()) {
        if (!scheduleRecovery(guildId, state, item, completionResult.error, { fullRetry: true })) state.suppressedCutoffReplays += 1;
      } else if (tail) {
        scheduleRecovery(guildId, state, item, completionResult.error, { replay: tail });
      } else {
        state.suppressedCutoffReplays += 1;
        console.warn(`[queue:${guildId}] Midstream provider failure occurred after ${Math.round(playedMs)}ms; unsafe full replay suppressed.`);
      }
    } else if (completionResult.info) {
      const info = completionResult.info;
      const suspiciousDuration = String(generated?.audioFormat || '').toLowerCase() === 's16le' && isSuspiciouslyShortPcm(item, generated, info.audioBytes);
      const suspiciousTranscript = isSuspiciousTranscript(item, info.transcript);
      const coverage = getPlaybackCoverage(generated, info, messageResource, messagePlaybackSpeed);
      if (suspiciousDuration) state.suspiciousShortOutputs += 1;
      if (suspiciousTranscript) state.transcriptCutoffs += 1;
      if (coverage?.suspicious) state.playbackCutoffs += 1;
      if (isHardPlaybackCutoff(coverage)) {
        const tail = buildPcmTail(info.audioBuffer, generated, playedMs, messagePlaybackSpeed);
        if (tail) scheduleRecovery(guildId, state, item, new Error('Severe local playback cutoff.'), { replay: tail });
        else state.suppressedCutoffReplays += 1;
      }
    } else {
      scheduleCompletionGraceCancel(guildId, state, generated);
    }'''
new_completion = '''    const completionResult = await brieflyResolveCompletion(generated, 1);
    if ((completionResult.error || completionResult.info) && !item.cancelled && !state.disposed) {
      const recovered = handleCompletionRecovery(guildId, state, item, generated, playedMs, messagePlaybackSpeed, completionResult);
      if (!recovered && completionResult.error) {
        state.suppressedCutoffReplays += 1;
        console.warn(`[queue:${guildId}] Midstream provider failure occurred after ${Math.round(playedMs)}ms; no safe tail was available.`);
      }
    } else {
      scheduleCompletionGraceCancel(guildId, state, generated, { item, playedMs, playbackSpeed: messagePlaybackSpeed });
    }'''
replace_once('src/audio.js', old_completion, new_completion)

# On a playback/pipeline exception, arm the same bounded watcher if the first
# 120 ms check cannot yet see enough mirrored audio to resume safely.
old_catch = '''      const fullMirror = brief.info?.audioBuffer || (Buffer.isBuffer(generated?.audioBuffer) ? generated.audioBuffer : null);
      const partial = brief.error?.partialAudioBuffer || null;
      const tail = buildPcmTail(fullMirror || partial, generated || {}, playedMs, messagePlaybackSpeed);
      let recovered = false;
      if (playedMs <= replayThresholdMs()) {
        let replay = null;
        if (Buffer.isBuffer(fullMirror) && String(generated?.audioFormat || '').toLowerCase() === 's16le') {
          replay = { audioBuffer: Buffer.from(fullMirror), audioFormat: generated.audioFormat, mimeType: generated.mimeType, sampleRate: generated.sampleRate, channels: generated.channels };
        }
        recovered = scheduleRecovery(guildId, state, item, error, replay ? { replay } : { fullRetry: true });
      } else if (tail) {
        recovered = scheduleRecovery(guildId, state, item, error, { replay: tail });
      } else {
        state.suppressedCutoffReplays += 1;
        console.warn(`[queue:${guildId}] Playback/provider failure after ${Math.round(playedMs)}ms; full replay suppressed to avoid duplicate speech.`);
      }
      if (!recovered && item.isRecovery) state.cutoffRecoveryFailures += 1;
      if (!recovered) console.error(`[queue:${guildId}]`, error);'''
new_catch = '''      let recovered = handleCompletionRecovery(guildId, state, item, generated || {}, playedMs, messagePlaybackSpeed, {
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
      }'''
replace_once('src/audio.js', old_catch, new_catch)

replace_once('src/audio.js',
'''export const __test = { mp3DurationMs, decideSpeakerLabel, buildPcmTail, createQueueItem, cancelQueuedItemsForUser, cancelCurrentItemForUser, createPrefetchSpool, wireProviderToInput, scheduleRecovery, scheduleCompletionGraceCancel, canRunQueue, takeNextItem, abandonUnclaimedGeneration };''',
'''export const __test = { mp3DurationMs, decideSpeakerLabel, buildPcmTail, buildTranscriptTextTail, handleCompletionRecovery, getGeneratedAudioDurationMs, getRecoveryResumeStartMs, createQueueItem, cancelQueuedItemsForUser, cancelCurrentItemForUser, createPrefetchSpool, wireProviderToInput, scheduleRecovery, scheduleCompletionGraceCancel, canRunQueue, takeNextItem, abandonUnclaimedGeneration };''')

# Regression tests: new defaults/speed clamp, wider healthy jitter gap, updated
# markerless grace expectation, and the user's exact missing-tail scenario.
replace_once('test/regression.test.js',
'''    speakerLabel: { maxWaitMs: 99999, gain: 9, maxPcmDurationMs: 1 },''',
'''    speakerLabel: { speed: 9, maxWaitMs: 99999, gain: 9, maxPcmDurationMs: 1 },''')
replace_once('test/regression.test.js',
'''  assert.equal(normalized.speakerLabel.maxWaitMs, 3000);
  assert.equal(normalized.speakerLabel.gain, 2);''',
'''  assert.equal(normalized.speakerLabel.speed, 1.5);
  assert.equal(normalized.speakerLabel.maxWaitMs, 3000);
  assert.equal(normalized.speakerLabel.gain, 2);''')

replace_once('test/regression.test.js',
'''    streamIdleTimeoutMs: 1200, audioEndGraceMs: 300, maxOutputAudioMs: 6000, retryCount: 0
  });
  let bytes = 0;
  const keepAlive = setTimeout(() => {}, 800);''',
'''    streamIdleTimeoutMs: 2200, audioEndGraceMs: 300, maxOutputAudioMs: 6000, retryCount: 0
  });
  let bytes = 0;
  const keepAlive = setTimeout(() => {}, 1800);''')
replace_once('test/regression.test.js',
'''  assert.ok(elapsed >= 850 && elapsed < 1200, `adaptive audio-end grace elapsed=${elapsed}ms`);''',
'''  assert.ok(elapsed >= 1200 && elapsed < 1900, `adaptive audio-end grace elapsed=${elapsed}ms`);''')

replace_once('test/regression.test.js',
'''test('v0.23.5 defaults keep adaptive Live audio-end grace and current speaker/message gain', () => {
  const normalized = configTest.normalizeSettings({});
  assert.equal(normalized.geminiLive.audioEndGraceMs, 650);
  assert.equal(normalized.speakerLabel.gain, 1.5);
  assert.equal(normalized.fixedVolume, 0.6);
});''',
'''test('current defaults keep adaptive Live grace and faster cached speaker labels', () => {
  const normalized = configTest.normalizeSettings({});
  assert.equal(normalized.geminiLive.audioEndGraceMs, 650);
  assert.equal(normalized.speakerLabel.speed, 1.15);
  assert.equal(normalized.speakerLabel.gapMs, 75);
  assert.equal(normalized.speakerLabel.gain, 1.5);
  assert.equal(normalized.fixedVolume, 0.6);
});''')

replace_once('test/regression.test.js',
'''test('Gemini Live tolerates a healthy 700ms inter-chunk gap without clipping', async () => {''',
'''test('Gemini Live tolerates a healthy 1100ms inter-chunk gap without clipping', async () => {''')
replace_once('test/regression.test.js',
'''        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: two, mimeType: 'audio/pcm;rate=24000' } }] } } }) }), 710);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { generationComplete: true } }) }), 730);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { turnComplete: true } }) }), 750);''',
'''        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: two, mimeType: 'audio/pcm;rate=24000' } }] } } }) }), 1110);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { generationComplete: true } }) }), 1130);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { turnComplete: true } }) }), 1150);''')
replace_once('test/regression.test.js',
'''    streamIdleTimeoutMs: 1600, audioEndGraceMs: 650, maxOutputAudioMs: 6000, retryCount: 0''',
'''    streamIdleTimeoutMs: 2200, audioEndGraceMs: 650, maxOutputAudioMs: 6000, retryCount: 0''')

# Insert focused recovery tests after the existing PCM-tail test.
marker = '''test('Discord cleanup resolves role/channel markers without fixed placeholder collisions', () => {'''
insert = '''test('late completion transcript recovers only the missing spoken suffix', async () => {
  const text = 'aku nak pergi ke kedai membeli beras';
  const item = audio.__test.createQueueItem(text, { verificationText: text });
  const state = {
    disposed: false, running: true, voiceReady: false, queue: [], cutoffRecoveries: 0, mirrorReplays: 0,
    suspiciousShortOutputs: 0, transcriptCutoffs: 0, playbackCutoffs: 0, completionGraceTimeouts: 0
  };
  const pcm = Buffer.alloc(Math.round(24_000 * 2 * 1.3));
  const generated = {
    audioFormat: 's16le', sampleRate: 24_000, channels: 1,
    completion: Promise.resolve({ audioBytes: pcm.length, audioBuffer: pcm, transcript: 'aku nak pergi ke' }),
    cancel() {}
  };
  assert.equal(audio.__test.scheduleCompletionGraceCancel('test-guild', state, generated, { item, playedMs: 1300, playbackSpeed: 1 }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].text, 'kedai membeli beras');
  assert.equal(state.queue[0].isRecovery, true);
  assert.equal(state.queue[0].skipLive, true);
});

test('late severe cutoff without transcript schedules a trimmed regenerated tail', () => {
  const text = 'aku nak pergi ke kedai membeli beras';
  const item = audio.__test.createQueueItem(text, { verificationText: text });
  const state = {
    disposed: false, running: true, voiceReady: false, queue: [], cutoffRecoveries: 0, mirrorReplays: 0,
    suspiciousShortOutputs: 0, transcriptCutoffs: 0, playbackCutoffs: 0
  };
  const partial = Buffer.alloc(Math.round(24_000 * 2 * 1.1));
  const error = Object.assign(new Error('late Live cutoff'), {
    audioFormat: 's16le', sampleRate: 24_000, channels: 1, audioBytes: partial.length, partialAudioBuffer: partial
  });
  const recovered = audio.__test.handleCompletionRecovery('test-guild', state, item, {
    audioFormat: 's16le', sampleRate: 24_000, channels: 1
  }, 1100, 1, { error });
  assert.equal(recovered, true);
  assert.equal(state.queue.length, 1);
  assert.ok(state.queue[0].resumeFraction > 0 && state.queue[0].resumeFraction < 0.95);
  assert.equal(state.queue[0].text, text);
});

'''
path = ROOT / 'test/regression.test.js'
text = path.read_text(encoding='utf-8')
if text.count(marker) != 1:
    raise RuntimeError('test/regression.test.js: insertion marker not unique')
path.write_text(text.replace(marker, insert + marker, 1), encoding='utf-8')

print('Applied speaker-label speed and cutoff-recovery hardening.')
