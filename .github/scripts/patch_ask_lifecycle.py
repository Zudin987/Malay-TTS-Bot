from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_all(text, old, new, minimum, label):
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"{label}: expected at least {minimum} matches, found {count}")
    return text.replace(old, new)


# ---- tts.js: request-owned half-open probe leases ----
path = Path('src/tts.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "    halfOpenProbeInFlight: false,\n",
    "    halfOpenProbeInFlight: false, halfOpenProbeToken: null,\n",
    'provider probe token field'
)
text = replace_once(
    text,
    "let globalHalfOpenProbeKey = null;\n",
    "let globalHalfOpenProbeKey = null;\nlet halfOpenProbeSequence = 0;\n",
    'probe sequence'
)
text = replace_once(
    text,
    """function releaseHalfOpenProbe(key, state) {
  state.halfOpenProbeInFlight = false;
  if (globalHalfOpenProbeKey === key) globalHalfOpenProbeKey = null;
}

function beginHalfOpenProbe(key, state) {
  if (key === 'google' || state.consecutiveFailures <= 0) return true;
  if (state.halfOpenProbeInFlight) return false;
  if (globalHalfOpenProbeKey && globalHalfOpenProbeKey !== key) return false;
  state.halfOpenProbeInFlight = true;
  globalHalfOpenProbeKey = key;
  return true;
}
""",
    """function releaseHalfOpenProbe(key, state, token = undefined) {
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
""",
    'probe lease functions'
)
text = replace_once(
    text,
    "function setProviderFailure(state, error, options = {}, { phase = 'initial', budget = false, key = 'unknown', configSignature = null } = {}) {",
    "function setProviderFailure(state, error, options = {}, { phase = 'initial', budget = false, key = 'unknown', configSignature = null, probeToken = undefined } = {}) {",
    'setProviderFailure token'
)
text = replace_once(
    text,
    "function markCompleted(state, requestStartedAt, geminiProvider = true, key = 'unknown') {",
    "function markCompleted(state, requestStartedAt, geminiProvider = true, key = 'unknown', probeToken = undefined) {",
    'markCompleted token'
)
text = replace_once(
    text,
    "function recordRunawayMidstreamFailure(state, error, key = 'unknown') {",
    "function recordRunawayMidstreamFailure(state, error, key = 'unknown', probeToken = undefined) {",
    'runaway token'
)
text = replace_once(
    text,
    "function recordIsolatedLiveMidstreamFailure(state, error, key = 'unknown') {",
    "function recordIsolatedLiveMidstreamFailure(state, error, key = 'unknown', probeToken = undefined) {",
    'isolated token'
)
text = replace_once(
    text,
    "function observeCompletion(key, state, generated, providerName, requestStartedAt, options, geminiProvider, configSignature) {",
    "function observeCompletion(key, state, generated, providerName, requestStartedAt, options, geminiProvider, configSignature, probeToken = undefined) {",
    'observeCompletion token'
)
# All production releases now carry a request token. Undefined remains available
# only to direct helper tests, so stale async callbacks cannot release a new lease.
text = replace_all(
    text,
    "releaseHalfOpenProbe(key, state);",
    "releaseHalfOpenProbe(key, state, probeToken);",
    8,
    'tokenized probe releases'
)
text = replace_once(
    text,
    "markCompleted(state, requestStartedAt, geminiProvider, key);",
    "markCompleted(state, requestStartedAt, geminiProvider, key, probeToken);",
    'completion without promise token'
)
text = replace_once(
    text,
    "completion.then(() => markCompleted(state, requestStartedAt, geminiProvider, key)).catch((error) => {",
    "completion.then(() => markCompleted(state, requestStartedAt, geminiProvider, key, probeToken)).catch((error) => {",
    'completion promise token'
)
text = replace_once(
    text,
    "recordRunawayMidstreamFailure(state, error, key);",
    "recordRunawayMidstreamFailure(state, error, key, probeToken);",
    'runaway call token'
)
text = replace_once(
    text,
    "recordIsolatedLiveMidstreamFailure(state, error, key);",
    "recordIsolatedLiveMidstreamFailure(state, error, key, probeToken);",
    'isolated call token'
)
text = replace_once(
    text,
    "setProviderFailure(state, error, options, { phase: 'midstream', budget, key, configSignature });",
    "setProviderFailure(state, error, options, { phase: 'midstream', budget, key, configSignature, probeToken });",
    'midstream failure token'
)
text = replace_once(
    text,
    """  if (!beginHalfOpenProbe(key, state)) {
    noteSkipped(state);
    attempts.push({ provider: providerName, outcome: 'half-open-skip', ms: 0 });
    return { result: null, error: null };
  }
""",
    """  const probeLease = beginHalfOpenProbeLease(key, state);
  if (!probeLease.allowed) {
    noteSkipped(state);
    attempts.push({ provider: providerName, outcome: 'half-open-skip', ms: 0 });
    return { result: null, error: null };
  }
  const probeToken = probeLease.token;
""",
    'runAttempt probe lease'
)
text = replace_once(
    text,
    "setProviderFailure(state, error, stateOptions(key), { phase: 'initial', budget, key, configSignature });",
    "setProviderFailure(state, error, stateOptions(key), { phase: 'initial', budget, key, configSignature, probeToken });",
    'initial failure token'
)
text = replace_once(
    text,
    "observeCompletion(key, state, generated, providerName, requestStartedAt, stateOptions(key), geminiProvider, configSignature);",
    "observeCompletion(key, state, generated, providerName, requestStartedAt, stateOptions(key), geminiProvider, configSignature, probeToken);",
    'completion observer token'
)
text = replace_once(
    text,
    "providerReady, acquireGeminiSlot, runAttempt, providerConfigSignature, beginHalfOpenProbe, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError",
    "providerReady, acquireGeminiSlot, runAttempt, providerConfigSignature, beginHalfOpenProbe, beginHalfOpenProbeLease, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError",
    'export probe lease'
)
path.write_text(text, encoding='utf-8')


# ---- audio.js: queue protection, latest-wins cancellation, prompt STOP advance ----
path = Path('src/audio.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "    forceBuffered: metadata.forceBuffered === true,\n    noPrefetch: metadata.noPrefetch === true,\n",
    "    forceBuffered: metadata.forceBuffered === true,\n    noPrefetch: metadata.noPrefetch === true,\n    protectFromOverflow: metadata.protectFromOverflow === true,\n    askSequence: Math.max(0, Number(metadata.askSequence) || 0),\n",
    'queue item ask metadata'
)
text = replace_once(
    text,
    """function abandonUnclaimedGeneration(item, reason = 'Playback item abandoned before provider handoff.') {
  if (!item?.generation) return false;
  const error = cancelledError(reason);
  if (!item.abortController.signal.aborted) item.abortController.abort(error);
  item.generation.then((result) => cleanupGenerated(result, { cancel: true })).catch(() => {});
  return true;
}
""",
    """function abandonUnclaimedGeneration(item, reason = 'Playback item abandoned before provider handoff.') {
  if (!item?.generation) return false;
  const error = cancelledError(reason);
  if (!item.abortController.signal.aborted) item.abortController.abort(error);
  item.generation.then((result) => cleanupGenerated(result, { cancel: true })).catch(() => {});
  return true;
}

function waitForGenerationOrCancellation(item, generation) {
  const signal = item?.abortController?.signal;
  if (!signal) return Promise.resolve(generation);
  if (signal.aborted) return Promise.reject(signal.reason || cancelledError('Queue item cancelled before provider handoff.'));
  let abortListener = null;
  const cancelled = new Promise((_, reject) => {
    abortListener = () => reject(signal.reason || cancelledError('Queue item cancelled before provider handoff.'));
    signal.addEventListener('abort', abortListener, { once: true });
  });
  return Promise.race([generation, cancelled]).finally(() => {
    if (abortListener) signal.removeEventListener?.('abort', abortListener);
  });
}
""",
    'generation cancellation race helper'
)
text = replace_once(
    text,
    """function dropForQueueOverflow(guildId, state, maximumQueuedMessages) {
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
""",
    """function dropForQueueOverflow(guildId, state, maximumQueuedMessages) {
  const options = getAdaptiveQueueOptions();
  const droppable = state.queue
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.protectFromOverflow !== true);
  const now = Date.now();
  if (!droppable.length) {
    state.droppedMessages += 1;
    if (now - state.lastQueueWarningAt >= MAX_QUEUE_WARNING_INTERVAL_MS) {
      state.lastQueueWarningAt = now;
      console.warn(`[queue:${guildId}] Queue limit ${maximumQueuedMessages} reached; all waiting items are protected, so the incoming message was rejected.`);
    }
    return false;
  }
  let dropIndex = droppable[0].index;
  if (options.enabled && options.preservePrefetchedOnOverflow) {
    const firstUnstarted = droppable.find(({ item }) => !item.generation);
    if (firstUnstarted) dropIndex = firstUnstarted.index;
  }
  const [dropped] = state.queue.splice(dropIndex, 1);
  if (dropped) { state.droppedMessages += 1; cleanupCancelledQueuedItem(dropped); }
  if (now - state.lastQueueWarningAt >= MAX_QUEUE_WARNING_INTERVAL_MS) {
    state.lastQueueWarningAt = now;
    console.warn(`[queue:${guildId}] Queue limit ${maximumQueuedMessages} reached; dropped one waiting message.`);
  }
  return Boolean(dropped);
}
""",
    'overflow protection'
)
text = replace_once(
    text,
    """    dropForQueueOverflow(guildId, state, maximum);
  }
  state.queue.push(incoming);
""",
    """    if (!dropForQueueOverflow(guildId, state, maximum)) {
      cleanupCancelledQueuedItem(incoming);
      return 'rejected-queue-full';
    }
  }
  state.queue.push(incoming);
""",
    'overflow reject incoming'
)
text = replace_once(
    text,
    "    generated = await generation;\n",
    "    generated = await waitForGenerationOrCancellation(item, generation);\n",
    'queue generation cancellation barrier'
)
text = replace_once(
    text,
    """function cancelQueuedAskItemsForUser(state, userId) {
  const id = String(userId ?? '');
  if (!state || !id || !Array.isArray(state.queue)) return 0;
  let cancelled = 0;
  const kept = [];
  for (const item of state.queue) {
    const isQueuedAsk = String(item?.messageId ?? '').startsWith('ask:');
    if (isQueuedAsk && String(item?.userId ?? '') === id) {
      cancelled += 1;
      cleanupCancelledQueuedItem(item);
    } else kept.push(item);
  }
  state.queue = kept;
  return cancelled;
}

export function cancelQueuedAskAudioForUser(guildId, userId) {
  const state = states.get(guildId);
  const cancelled = cancelQueuedAskItemsForUser(state, userId);
  if (state && !state.running && state.voiceReady && state.queue.length) void runQueue(guildId, state);
  return cancelled;
}
""",
    """function cancelQueuedAskItemsForUser(state, userId, newerSequence = null) {
  const id = String(userId ?? '');
  if (!state || !id || !Array.isArray(state.queue)) return 0;
  const threshold = Number(newerSequence);
  const onlyOlder = Number.isFinite(threshold) && threshold > 0;
  let cancelled = 0;
  const kept = [];
  for (const item of state.queue) {
    const isQueuedAsk = String(item?.messageId ?? '').startsWith('ask:');
    const sequence = Math.max(0, Number(item?.askSequence) || 0);
    const superseded = !onlyOlder || sequence === 0 || sequence < threshold;
    if (isQueuedAsk && String(item?.userId ?? '') === id && superseded) {
      cancelled += 1;
      cleanupCancelledQueuedItem(item);
    } else kept.push(item);
  }
  state.queue = kept;
  return cancelled;
}

function cancelCurrentAskIfSuperseded(state, userId, newerSequence) {
  const id = String(userId ?? '');
  const threshold = Number(newerSequence);
  const current = state?.currentItem;
  if (!id || !Number.isFinite(threshold) || threshold <= 0 || !current) return false;
  if (!String(current?.messageId ?? '').startsWith('ask:') || String(current?.userId ?? '') !== id) return false;
  // Once the listener has heard any of the old answer, do not interrupt it.
  if (Number(current.firstAudibleAtEpoch) > 0) return false;
  const currentSequence = Math.max(0, Number(current.askSequence) || 0);
  if (currentSequence > 0 && currentSequence >= threshold) return false;
  current.cancelled = true;
  const reason = cancelledError('Superseded by a newer /ask before first audible speech.');
  if (!current.abortController.signal.aborted) current.abortController.abort(reason);
  current.generation?.then((generated) => { try { generated?.cancel?.(reason); } catch {} }).catch(() => {});
  try { state.player?.stop?.(true); } catch {}
  if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill();
  return true;
}

export function cancelSupersededAskAudioForUser(guildId, userId, newerSequence) {
  const state = states.get(guildId);
  if (!state) return { cancelledCurrent: false, cancelledQueued: 0 };
  const cancelledQueued = cancelQueuedAskItemsForUser(state, userId, newerSequence);
  const cancelledCurrent = cancelCurrentAskIfSuperseded(state, userId, newerSequence);
  if (!state.running && state.voiceReady && state.queue.length) void runQueue(guildId, state);
  return { cancelledCurrent, cancelledQueued };
}

export function cancelQueuedAskAudioForUser(guildId, userId) {
  const state = states.get(guildId);
  const cancelled = cancelQueuedAskItemsForUser(state, userId);
  if (state && !state.running && state.voiceReady && state.queue.length) void runQueue(guildId, state);
  return cancelled;
}
""",
    'superseded ask cancellation'
)
text = replace_once(
    text,
    "    verificationText: recoveryText, forceBuffered: true,\n",
    "    verificationText: recoveryText, forceBuffered: true, noPrefetch: item.noPrefetch,\n    protectFromOverflow: item.protectFromOverflow, askSequence: item.askSequence,\n",
    'recovery ask protection'
)
text = replace_once(
    text,
    "cancelQueuedAskItemsForUser, cancelCurrentItemForUser, createPrefetchSpool",
    "cancelQueuedAskItemsForUser, cancelCurrentAskIfSuperseded, cancelCurrentItemForUser, cancelSupersededAskItemsForUser: (state, userId, newerSequence) => ({ cancelledQueued: cancelQueuedAskItemsForUser(state, userId, newerSequence), cancelledCurrent: cancelCurrentAskIfSuperseded(state, userId, newerSequence) }), dropForQueueOverflow, waitForGenerationOrCancellation, createPrefetchSpool",
    'audio test exports'
)
path.write_text(text, encoding='utf-8')


# ---- ask-response.js: request order and protected queue metadata ----
path = Path('src/ask-response.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "export const ASK_STOP_BUTTON_PREFIX = 'ask-stop:';\n",
    """export const ASK_STOP_BUTTON_PREFIX = 'ask-stop:';
let askRequestSequence = 0;
const latestAskSequenceByUser = new Map();

function askSequenceKey(guildId, userId) {
  return `${String(guildId ?? '')}:${String(userId ?? '')}`;
}

export function beginAskTtsRequest(guildId, userId) {
  const key = askSequenceKey(guildId, userId);
  const sequence = ++askRequestSequence;
  latestAskSequenceByUser.set(key, sequence);
  return sequence;
}

export function isLatestAskTtsRequest(guildId, userId, sequence) {
  const value = Number(sequence);
  if (!Number.isFinite(value) || value <= 0) return true;
  return latestAskSequenceByUser.get(askSequenceKey(guildId, userId)) === value;
}
""",
    'ask request sequence'
)
text = replace_once(
    text,
    "export function buildAskTtsItem(interaction, answer, voiceChannel, voice) {",
    "export function buildAskTtsItem(interaction, answer, voiceChannel, voice, requestSequence = null) {",
    'build ask sequence arg'
)
text = replace_once(
    text,
    """      forceBuffered: false,
      // Do not synthesize queued /ask answers speculatively. Repeated /ask calls
      // should not occupy Gemini slots for audio that cannot play yet.
      noPrefetch: true
""",
    """      forceBuffered: false,
      // Do not synthesize queued /ask answers speculatively. Repeated /ask calls
      // should not occupy Gemini slots for audio that cannot play yet.
      noPrefetch: true,
      // Once /ask has been accepted into the queue, normal-chat overflow must
      // not silently discard it after the visible AI answer/STOP button exists.
      protectFromOverflow: true,
      askSequence: Math.max(0, Number(requestSequence) || 0)
""",
    'ask protected metadata'
)
text = replace_once(
    text,
    "export async function queueAskAnswerTts(interaction, answer, dependencies) {",
    "export async function queueAskAnswerTts(interaction, answer, dependencies, { requestSequence = null } = {}) {",
    'queue ask sequence arg'
)
text = replace_once(
    text,
    """  if (!text) return 'empty';
  if (!interaction?.guildId || !interaction?.guild || !interaction?.user?.id) return 'invalid-interaction';

  const {
""",
    """  if (!text) return 'empty';
  if (!interaction?.guildId || !interaction?.guild || !interaction?.user?.id) return 'invalid-interaction';
  if (!isLatestAskTtsRequest(interaction.guildId, interaction.user.id, requestSequence)) return 'superseded';

  const {
""",
    'stale ask early return'
)
text = replace_once(
    text,
    """    enqueue,
    cancel,
    cancelQueuedAsk
  } = dependencies;
""",
    """    enqueue,
    cancel,
    cancelQueuedAsk,
    cancelSupersededAsk
  } = dependencies;
""",
    'supersede dependency'
)
text = replace_once(
    text,
    """  // A newer /ask from the same user supersedes only their older queued
  // /ask speech. Never interrupt the answer that is already speaking, and never
  // touch normal message TTS. This prevents stale /ask answers building a long
  // FIFO backlog during rapid follow-up questions.
  cancelQueuedAsk?.(interaction.guildId, interaction.user.id);
""",
    """  // A newer /ask from the same user supersedes older queued speech and
  // may cancel an older current /ask only while it is still pre-audible. Once
  // speech has started, preserve it. Sequence ordering prevents a slower older
  // text-generation request from winning merely because it finished later.
  if (Number(requestSequence) > 0 && typeof cancelSupersededAsk === 'function') {
    cancelSupersededAsk(interaction.guildId, interaction.user.id, Number(requestSequence));
  } else {
    cancelQueuedAsk?.(interaction.guildId, interaction.user.id);
  }
""",
    'latest-wins cancellation call'
)
text = replace_once(
    text,
    "  const item = buildAskTtsItem(interaction, text, voiceChannel, voice);\n",
    "  const item = buildAskTtsItem(interaction, text, voiceChannel, voice, requestSequence);\n",
    'build item sequence'
)
path.write_text(text, encoding='utf-8')


# ---- commands.js: assign sequence at invocation, not completion ----
path = Path('src/commands.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { cancelMessageAudio, cancelQueuedAskAudioForUser, cancelUserAudio, enqueue, getAudioStatus } from './audio.js';",
    "import { cancelMessageAudio, cancelQueuedAskAudioForUser, cancelSupersededAskAudioForUser, cancelUserAudio, enqueue, getAudioStatus } from './audio.js';",
    'audio ask supersede import'
)
text = replace_once(
    text,
    "import { ASK_ALLOWED_MENTIONS, buildAskEmbed, queueAskAnswerTts } from './ask-response.js';",
    "import { ASK_ALLOWED_MENTIONS, beginAskTtsRequest, buildAskEmbed, queueAskAnswerTts } from './ask-response.js';",
    'ask sequence import'
)
text = replace_once(
    text,
    """  cancel: cancelMessageAudio,
  cancelQueuedAsk: cancelQueuedAskAudioForUser
};
""",
    """  cancel: cancelMessageAudio,
  cancelQueuedAsk: cancelQueuedAskAudioForUser,
  cancelSupersededAsk: cancelSupersededAskAudioForUser
};
""",
    'ask dependencies'
)
text = replace_once(
    text,
    """  async execute(interaction) {
    const question = interaction.options.getString('question', true);
    await interaction.deferReply();
""",
    """  async execute(interaction) {
    const question = interaction.options.getString('question', true);
    const askTtsSequence = beginAskTtsRequest(interaction.guildId, interaction.user.id);
    await interaction.deferReply();
""",
    'sequence assigned before ask generation'
)
text = replace_once(
    text,
    "void queueAskAnswerTts(interaction, answer, askTtsDependencies).catch((error) => {",
    "void queueAskAnswerTts(interaction, answer, askTtsDependencies, { requestSequence: askTtsSequence }).catch((error) => {",
    'queue latest sequence'
)
path.write_text(text, encoding='utf-8')


# ---- deterministic regression coverage for the six lifecycle findings ----
test_path = Path('test/ask-lifecycle-hardening.test.js')
test_path.write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.GEMINI_API_KEY ||= 'test-gemini-key';

const tts = await import('../src/tts.js');
const audio = await import('../src/audio.js');
const askResponse = await import('../src/ask-response.js');

function cancelled(message = 'cancelled') {
  const error = new Error(message);
  error.cancelled = true;
  return error;
}

function timeoutAfter(ms, message = 'test timed out') {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

test('half-open probe lease cannot be cleared by a stale older request', () => {
  const state = tts.__test.newProviderState();
  state.consecutiveFailures = 1;
  const first = tts.__test.beginHalfOpenProbeLease('exactTts', state);
  assert.equal(first.allowed, true);
  assert.ok(first.token > 0);
  assert.equal(tts.__test.releaseHalfOpenProbe('exactTts', state, first.token), true);

  const second = tts.__test.beginHalfOpenProbeLease('exactTts', state);
  assert.equal(second.allowed, true);
  assert.notEqual(second.token, first.token);
  assert.equal(tts.__test.releaseHalfOpenProbe('exactTts', state, first.token), false);
  assert.equal(state.halfOpenProbeInFlight, true);
  assert.equal(state.halfOpenProbeToken, second.token);
  assert.equal(tts.__test.releaseHalfOpenProbe('exactTts', state, second.token), true);
});

test('slower older /ask cannot replace a newer request that was invoked later', async () => {
  const guildId = `g-${Date.now()}-${Math.random()}`;
  const userId = `u-${Date.now()}-${Math.random()}`;
  const older = askResponse.beginAskTtsRequest(guildId, userId);
  const newer = askResponse.beginAskTtsRequest(guildId, userId);
  assert.equal(askResponse.isLatestAskTtsRequest(guildId, userId, older), false);
  assert.equal(askResponse.isLatestAskTtsRequest(guildId, userId, newer), true);

  let enqueueCalls = 0;
  const staleResult = await askResponse.queueAskAnswerTts(
    { guildId, guild: {}, user: { id: userId } },
    'older answer that finished late',
    { enqueue: () => { enqueueCalls += 1; } },
    { requestSequence: older }
  );
  assert.equal(staleResult, 'superseded');
  assert.equal(enqueueCalls, 0);
});

test('accepted latest /ask carries overflow protection and supersedes only older speech', async () => {
  const guildId = `g2-${Date.now()}-${Math.random()}`;
  const userId = `u2-${Date.now()}-${Math.random()}`;
  const sequence = askResponse.beginAskTtsRequest(guildId, userId);
  let supersedeArgs = null;
  let queuedMetadata = null;
  const voiceChannel = { id: 'voice-1', type: ChannelType.GuildVoice };
  const interaction = {
    id: 'interaction-new', guildId, guild: {}, createdTimestamp: Date.now(),
    user: { id: userId }, member: { voice: { channel: voiceChannel } }
  };
  const result = await askResponse.queueAskAnswerTts(interaction, 'latest answer', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => null,
    getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    connect: async () => ({ connection: {} }),
    enqueue: (_guildId, _text, metadata) => { queuedMetadata = metadata; return 'started'; },
    cancel: () => false,
    cancelQueuedAsk: () => { throw new Error('legacy cancellation should not run'); },
    cancelSupersededAsk: (...args) => { supersedeArgs = args; return { cancelledCurrent: false, cancelledQueued: 0 }; }
  }, { requestSequence: sequence });
  assert.equal(result, 'started');
  assert.deepEqual(supersedeArgs, [guildId, userId, sequence]);
  assert.equal(queuedMetadata.protectFromOverflow, true);
  assert.equal(queuedMetadata.noPrefetch, true);
  assert.equal(queuedMetadata.askSequence, sequence);
});

test('overflow drops normal waiting speech before an accepted protected /ask', () => {
  const protectedAsk = audio.__test.createQueueItem('ask answer', {
    messageId: 'ask:protected', userId: 'u', askSequence: 2, protectFromOverflow: true, noPrefetch: true
  });
  const normal = audio.__test.createQueueItem('normal message', { messageId: 'normal:1', userId: 'other' });
  const state = { queue: [protectedAsk, normal], droppedMessages: 0, lastQueueWarningAt: Date.now() };
  assert.equal(audio.__test.dropForQueueOverflow('guild', state, 2), true);
  assert.deepEqual(state.queue.map((item) => item.messageId), ['ask:protected']);
  assert.equal(normal.cancelled, true);
  assert.equal(protectedAsk.cancelled, false);

  const protectedAsk2 = audio.__test.createQueueItem('ask answer 2', {
    messageId: 'ask:protected2', userId: 'u2', askSequence: 3, protectFromOverflow: true, noPrefetch: true
  });
  state.queue = [protectedAsk, protectedAsk2];
  assert.equal(audio.__test.dropForQueueOverflow('guild', state, 2), false);
  assert.equal(state.queue.length, 2);
});

test('newer /ask cancels older current answer only before first audible speech', () => {
  const current = audio.__test.createQueueItem('old answer', {
    messageId: 'ask:old', userId: 'same-user', askSequence: 1, protectFromOverflow: true
  });
  const oldQueued = audio.__test.createQueueItem('older queued', {
    messageId: 'ask:older-queued', userId: 'same-user', askSequence: 1, protectFromOverflow: true
  });
  const normal = audio.__test.createQueueItem('normal', { messageId: 'normal', userId: 'other' });
  let stopCalls = 0;
  const state = {
    currentItem: current, queue: [oldQueued, normal], running: true, voiceReady: true,
    player: { stop: () => { stopCalls += 1; return true; } }, ffmpeg: null
  };
  const result = audio.__test.cancelSupersededAskItemsForUser(state, 'same-user', 2);
  assert.equal(result.cancelledCurrent, true);
  assert.equal(result.cancelledQueued, 1);
  assert.equal(current.cancelled, true);
  assert.equal(stopCalls, 1);
  assert.deepEqual(state.queue.map((item) => item.messageId), ['normal']);

  const audible = audio.__test.createQueueItem('already speaking', {
    messageId: 'ask:audible', userId: 'same-user', askSequence: 2, protectFromOverflow: true
  });
  audible.firstAudibleAtEpoch = Date.now();
  state.currentItem = audible;
  const afterAudible = audio.__test.cancelSupersededAskItemsForUser(state, 'same-user', 3);
  assert.equal(afterAudible.cancelledCurrent, false);
  assert.equal(audible.cancelled, false);
});

test('STOP can advance the queue even when provider generation promise never settles', async () => {
  const item = audio.__test.createQueueItem('ask waiting for first audio', {
    messageId: 'ask:waiting', userId: 'u', askSequence: 1
  });
  const never = new Promise(() => {});
  const waiting = audio.__test.waitForGenerationOrCancellation(item, never);
  item.cancelled = true;
  item.abortController.abort(cancelled('STOP TTS'));
  await assert.rejects(Promise.race([waiting, timeoutAfter(250)]), /STOP TTS/);
});

test('STOP releases two stuck /ask Gemini slots so next normal 3.1 Live attempt starts immediately', async () => {
  tts.restartTtsRuntime();
  const never = new Promise(() => {});
  const makeGenerated = () => ({ completion: never, cancel: () => {} });
  const a = new AbortController();
  const b = new AbortController();

  const first = await tts.__test.runAttempt({
    key: 'exactTts', providerName: 'gemini-3.1-tts', windowMs: 1000,
    parentSignal: a.signal, attempts: [], factory: async () => makeGenerated()
  });
  const second = await tts.__test.runAttempt({
    key: 'exactTts', providerName: 'gemini-3.1-tts', windowMs: 1000,
    parentSignal: b.signal, attempts: [], factory: async () => makeGenerated()
  });
  assert.ok(first.result && second.result);
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 2);

  a.abort(cancelled('stop-a'));
  b.abort(cancelled('stop-b'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);

  const live = await Promise.race([
    tts.__test.runAttempt({
      key: 'livePrimary', providerName: 'gemini-3.1-live', windowMs: 1000,
      parentSignal: null, attempts: [], factory: async () => ({ completion: Promise.resolve(), cancel: () => {} })
    }),
    timeoutAfter(250, 'next normal 3.1 Live attempt remained blocked after STOP')
  ]);
  assert.ok(live.result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tts.getTtsProviderStatus().geminiLimiter.active, 0);
});
''', encoding='utf-8')

print('Applied /ask lifecycle hardening patches and regression tests.')
