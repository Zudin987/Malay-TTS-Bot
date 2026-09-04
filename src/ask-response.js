import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import { deadlineSignal, raceWithSignal } from './cancellation.js';

export const ASK_ALLOWED_MENTIONS = Object.freeze({
  parse: [],
  users: [],
  roles: [],
  repliedUser: false
});

export const ASK_STOP_BUTTON_PREFIX = 'ask-stop:';
let askRequestSequence = 0;
const latestAskSequenceByUser = new Map();
const buttonStates = new Map();
const buttonQueue = [];
let pendingButtonWrites = 0;
const MAX_BUTTON_WRITES = 32;
const MAX_BUTTON_WRITE_ATTEMPTS = 3;

function askSequenceKey(guildId, userId) {
  return `${String(guildId ?? '')}:${String(userId ?? '')}`;
}

function getAskSequenceState(guildId, userId, create = false) {
  const key = askSequenceKey(guildId, userId);
  let state = latestAskSequenceByUser.get(key);
  if (!state && create) {
    state = { pending: new Set(), committedSequence: null, active: false };
    latestAskSequenceByUser.set(key, state);
  }
  return { key, state };
}

function cleanAskSequenceState(key, state) {
  if (state && !state.pending.size && !state.active) latestAskSequenceByUser.delete(key);
}

export function beginAskTtsRequest(guildId, userId) {
  // Reserve ordering only after askGemini admits the request. Reservation does
  // not cancel valid older text or speech; commitment happens only after the
  // new answer is visible and its replacement audio can actually be queued.
  const sequence = ++askRequestSequence;
  getAskSequenceState(guildId, userId, true).state.pending.add(sequence);
  return sequence;
}

export function canCommitAskTtsRequest(guildId, userId, sequence) {
  const value = Number(sequence);
  if (!Number.isFinite(value) || value <= 0) return true;
  const { state } = getAskSequenceState(guildId, userId);
  if (!state?.pending.has(value)) return false;
  for (const pending of state.pending) if (pending > value) return false;
  return !state.committedSequence || value > state.committedSequence;
}

export function commitAskTtsRequest(guildId, userId, sequence) {
  const value = Number(sequence);
  if (!Number.isFinite(value) || value <= 0) return true;
  if (!canCommitAskTtsRequest(guildId, userId, value)) return false;
  const { state } = getAskSequenceState(guildId, userId);
  state.pending.delete(value);
  state.committedSequence = value;
  state.active = true;
  return true;
}

export function finishAskTtsRequest(guildId, userId, sequence) {
  const value = Number(sequence);
  if (!Number.isFinite(value) || value <= 0) return;
  const { key, state } = getAskSequenceState(guildId, userId);
  if (!state) return;
  state.pending.delete(value);
  if (state.committedSequence === value) state.active = false;
  cleanAskSequenceState(key, state);
}

export function isLatestAskTtsRequest(guildId, userId, sequence) {
  const value = Number(sequence);
  if (!Number.isFinite(value) || value <= 0) return true;
  const { state } = getAskSequenceState(guildId, userId);
  return state?.committedSequence === value && state.active;
}

export function getAskDisplayName(interaction) {
  const value = interaction?.member?.displayName
    || interaction?.member?.nickname
    || interaction?.user?.globalName
    || interaction?.user?.username
    || 'User';
  return String(value).replace(/[\r\n]+/gu, ' ').trim().slice(0, 100) || 'User';
}

export function buildAskEmbed(interaction, question, answer) {
  return new EmbedBuilder()
    .setTitle(`${getAskDisplayName(interaction)} ask`)
    .addFields(
      { name: 'Question', value: String(question), inline: false },
      { name: 'AI reply', value: String(answer), inline: false }
    );
}

export function buildAskStopButtonId(askInteractionId, ownerUserId) {
  const askId = String(askInteractionId ?? '').trim();
  const userId = String(ownerUserId ?? '').trim();
  if (!askId || askId.includes(':') || !userId || userId.includes(':')) {
    throw new Error('Invalid /ask stop-button identity.');
  }
  return `${ASK_STOP_BUTTON_PREFIX}${askId}:${userId}`;
}

export function parseAskStopButtonId(customId) {
  const value = String(customId ?? '');
  if (!value.startsWith(ASK_STOP_BUTTON_PREFIX)) return null;
  const parts = value.slice(ASK_STOP_BUTTON_PREFIX.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { askInteractionId: parts[0], ownerUserId: parts[1] };
}

export function buildAskStopComponents(interaction, state = 'ready') {
  const disabled = state !== 'ready';
  const label = ({ ready: 'STOP TTS', stopped: 'TTS stopped', finished: 'TTS finished',
    'queue-full': 'TTS unavailable: queue full', 'not-in-voice': 'TTS unavailable: join voice',
    'opted-out': 'TTS disabled by your opt-out', 'other-channel': 'TTS unavailable: another voice channel',
    superseded: 'TTS superseded by your newer request' })[state] || 'TTS unavailable';
  const button = new ButtonBuilder()
    .setCustomId(buildAskStopButtonId(interaction.id, interaction.user.id))
    .setLabel(label)
    .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Danger)
    .setDisabled(disabled);
  return [new ActionRowBuilder().addComponents(button)];
}

function buttonKey(interaction) {
  return `${interaction.guildId}:${interaction.id}`;
}

// Coalesce edits per answer. A terminal state wins over a delayed ready edit,
// including a REST call that finishes after our local write deadline.
export function setAskStopButtonState(interaction, state) {
  if (typeof interaction?.editReply !== 'function' || !interaction.id) return Promise.resolve();
  const key = buttonKey(interaction);
  let entry = buttonStates.get(key);
  if (!entry) {
    entry = { interaction, state, version: 0, terminal: false, dirty: false, queued: false, inFlight: false, attempts: 0, waiters: new Set() };
    buttonStates.set(key, entry);
  }
  if (!entry.terminal) {
    entry.state = state;
    entry.terminal = state !== 'ready';
    entry.version += 1;
    entry.dirty = true;
    entry.attempts = 0;
  }
  const version = entry.version;
  queueButtonWrite(entry, key);
  return waitForButtonVersion(entry, version);
}

function settleButtonWaiters(entry, version) {
  for (const waiter of [...entry.waiters]) {
    if (waiter.version > version) continue;
    entry.waiters.delete(waiter);
    waiter.resolve();
  }
}

function waitForButtonVersion(entry, version) {
  const deadline = deadlineSignal(null, 5000, new Error('Discord button update timed out.'));
  let waiter;
  const completion = new Promise((resolve) => {
    waiter = { version, resolve };
    entry.waiters.add(waiter);
  });
  return raceWithSignal(completion, deadline.signal).catch(() => {}).finally(() => {
    deadline.cleanup();
    entry.waiters.delete(waiter);
  });
}

function queueButtonWrite(entry, key) {
  if (!entry.dirty || entry.queued || entry.inFlight) return;
  entry.queued = true;
  buttonQueue.push({ entry, key });
  pumpButtonWrites();
}

function pumpButtonWrites() {
  while (pendingButtonWrites < MAX_BUTTON_WRITES && buttonQueue.length) {
    const { entry, key } = buttonQueue.shift();
    entry.queued = false;
    if (!entry.dirty || entry.inFlight || buttonStates.get(key) !== entry) continue;

    // Dirty intent is consumed only after a real capacity slot is owned.
    entry.dirty = false;
    entry.inFlight = true;
    pendingButtonWrites += 1;
    const version = entry.version;
    const state = entry.state;
    const write = Promise.resolve().then(() => entry.interaction.editReply({
      components: buildAskStopComponents(entry.interaction, state), allowedMentions: ASK_ALLOWED_MENTIONS
    }));

    write.then(() => finishButtonWrite(true), () => finishButtonWrite(false));
    function finishButtonWrite(succeeded) {
      entry.inFlight = false;
      pendingButtonWrites = Math.max(0, pendingButtonWrites - 1);
      if (succeeded) {
        entry.attempts = 0;
        settleButtonWaiters(entry, version);
        if (version !== entry.version) entry.dirty = true;
        else if (entry.terminal && buttonStates.get(key) === entry) buttonStates.delete(key);
      } else if (version !== entry.version) {
        entry.dirty = true;
      } else if (++entry.attempts < MAX_BUTTON_WRITE_ATTEMPTS) {
        entry.dirty = true;
      } else {
        // Discord's own REST layer has already rejected the write. Bound local
        // retries, release all callers, and allow a later terminal update to try.
        settleButtonWaiters(entry, version);
        if (entry.terminal && buttonStates.get(key) === entry) buttonStates.delete(key);
      }
      queueButtonWrite(entry, key);
      pumpButtonWrites();
    }
  }
}

export async function handleAskStopButton(interaction, cancelMessageAudio) {
  const parsed = parseAskStopButtonId(interaction?.customId);
  if (!parsed) return false;

  if (!interaction?.guildId || !interaction?.user?.id) {
    await interaction.reply({
      content: 'This TTS button only works inside the server.',
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
    return true;
  }

  if (String(interaction.user.id) !== parsed.ownerUserId) {
    await interaction.reply({
      content: 'Only the person who used /ask can stop this TTS.',
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
    return true;
  }

  const cancelled = Boolean(cancelMessageAudio(interaction.guildId, `ask:${parsed.askInteractionId}`));
  const owner = { guildId: interaction.guildId, id: parsed.askInteractionId, user: { id: parsed.ownerUserId } };
  if (typeof interaction.deferUpdate === 'function') {
    await interaction.deferUpdate().catch(() => {});
    owner.editReply = (payload) => interaction.editReply(payload);
  } else {
    owner.editReply = (payload) => interaction.update(payload);
  }
  await setAskStopButtonState(owner, cancelled ? 'stopped' : 'finished');
  return true;
}

export function buildAskTtsItem(interaction, answer, voiceChannel, voice, requestSequence = null, replyMessageId = null) {
  const text = String(answer ?? '').trim();
  return {
    text,
    metadata: {
      messageId: `ask:${interaction.id}`,
      replyMessageId,
      voiceChannelId: voiceChannel.id,
      googleText: text,
      verificationText: text,
      messageCreatedAt: interaction.createdTimestamp || Date.now(),
      userId: interaction.user.id,
      voice,
      speakerLabel: null,
      rejectOnOverflow: true,
      // The displayed answer is already final. Route that exact text through
      // the strict read-aloud Gemini Live turn; Google keeps the same text as
      // the deterministic fallback. No rewriting stage is introduced here.
      skipLive: false,
      forceBuffered: false,
      // Do not synthesize queued /ask answers speculatively. Repeated /ask calls
      // should not occupy Gemini slots for audio that cannot play yet.
      noPrefetch: true,
      // Once /ask has been accepted into the queue, normal-chat overflow must
      // not silently discard it after the visible AI answer/STOP button exists.
      protectFromOverflow: true,
      askSequence: Math.max(0, Number(requestSequence) || 0)
    }
  };
}

export async function queueAskAnswerTts(interaction, answer, dependencies, { requestSequence = null, replyMessageId = null } = {}) {
  let completed = false;
  const terminal = (outcome) => {
    if (completed) return outcome;
    completed = true;
    finishAskTtsRequest(interaction?.guildId, interaction?.user?.id, requestSequence);
    void setAskStopButtonState(interaction, String(outcome).startsWith('rejected-') ? 'queue-full' : outcome);
    return outcome;
  };
  const text = String(answer ?? '').trim();
  if (!text) return terminal('empty');
  if (!interaction?.guildId || !interaction?.guild || !interaction?.user?.id) return terminal('invalid-interaction');
  if (!canCommitAskTtsRequest(interaction.guildId, interaction.user.id, requestSequence)) return terminal('superseded');

  const {
    isOptedOut,
    getRuntimeVoiceChannelId,
    getAudioStatus,
    getVoice,
    connect,
    enqueue,
    cancel,
    cancelQueuedAsk,
    cancelSupersededAsk
  } = dependencies;

  if (isOptedOut(interaction.guildId, interaction.user.id)) return terminal('opted-out');

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) return terminal('not-in-voice');

  const activeChannelId = getRuntimeVoiceChannelId(interaction.guildId);
  if (activeChannelId && String(activeChannelId) !== String(voiceChannel.id)) return terminal('other-channel');

  const audio = getAudioStatus(interaction.guildId);
  if (audio && Number(audio.queued) >= Number(audio.maximumQueued)) return terminal('queue-full');

  // Prove the replacement path first. A failed voice connection, full queue,
  // or failed enqueue must leave valid older speech untouched.
  let result;
  try {
    result = await connect(interaction.guild, voiceChannel, { allowMove: false });
  } catch (error) {
    terminal('unavailable');
    throw error;
  }
  if (!result?.connection) return terminal(result?.status || 'voice-unavailable');

  if (isOptedOut(interaction.guildId, interaction.user.id)) return terminal('opted-out');
  const latestChannelId = getRuntimeVoiceChannelId(interaction.guildId);
  if (latestChannelId && String(latestChannelId) !== String(voiceChannel.id)) return terminal('other-channel');
  const latestAudio = getAudioStatus(interaction.guildId);
  if (latestAudio && Number(latestAudio.queued) >= Number(latestAudio.maximumQueued)) return terminal('queue-full');
  if (!canCommitAskTtsRequest(interaction.guildId, interaction.user.id, requestSequence)) return terminal('superseded');

  const voice = getVoice(interaction.guildId, interaction.user.id);
  if (isOptedOut(interaction.guildId, interaction.user.id)) return terminal('opted-out');

  const item = buildAskTtsItem(interaction, text, voiceChannel, voice, requestSequence, replyMessageId);
  item.metadata.onTerminal = terminal;
  const enqueueStatus = enqueue(interaction.guildId, item.text, item.metadata);
  if (String(enqueueStatus).startsWith('rejected-')) return terminal(enqueueStatus);

  if (!commitAskTtsRequest(interaction.guildId, interaction.user.id, requestSequence)) {
    cancel(interaction.guildId, item.metadata.messageId);
    return terminal('superseded');
  }
  // The newer answer is visible, connected and queued. Only now may it cancel
  // older pre-audible speech; already audible speech remains protected by audio.js.
  try {
    if (Number(requestSequence) > 0 && typeof cancelSupersededAsk === 'function') {
      cancelSupersededAsk(interaction.guildId, interaction.user.id, Number(requestSequence));
    } else {
      cancelQueuedAsk?.(interaction.guildId, interaction.user.id);
    }
  } catch (error) {
    // Cleanup is best effort after commitment. A cleanup defect must not make
    // callers treat the already accepted replacement item as a failed enqueue.
    console.warn('Unable to cancel superseded /ask audio:', error?.message || error);
  }

  void setAskStopButtonState(interaction, 'ready');
  return enqueueStatus;
}

export const __test = {
  latestAskSequenceByUser,
  buttonStates,
  buttonQueue,
  get pendingButtonWrites() { return pendingButtonWrites; },
  get maximumButtonWrites() { return MAX_BUTTON_WRITES; }
};
