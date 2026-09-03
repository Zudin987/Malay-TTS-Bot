import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import { cancellationError, deadlineSignal, raceWithSignal } from './cancellation.js';

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
let pendingButtonWrites = 0;

function askSequenceKey(guildId, userId) {
  return `${String(guildId ?? '')}:${String(userId ?? '')}`;
}

export function beginAskTtsRequest(guildId, userId, { controller = null } = {}) {
  const key = askSequenceKey(guildId, userId);
  const sequence = ++askRequestSequence;
  latestAskSequenceByUser.get(key)?.controller?.abort(cancellationError('Superseded by a newer /ask request.'));
  latestAskSequenceByUser.set(key, { sequence, controller });
  return sequence;
}

export function finishAskTtsRequest(guildId, userId, sequence) {
  const key = askSequenceKey(guildId, userId);
  if (latestAskSequenceByUser.get(key)?.sequence === sequence) latestAskSequenceByUser.delete(key);
}

export function isLatestAskTtsRequest(guildId, userId, sequence) {
  const value = Number(sequence);
  if (!Number.isFinite(value) || value <= 0) return true;
  return latestAskSequenceByUser.get(askSequenceKey(guildId, userId))?.sequence === value;
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
    entry = { interaction, state, version: 0, terminal: false, dirty: false, running: null };
    buttonStates.set(key, entry);
  }
  if (!entry.terminal) {
    entry.state = state;
    entry.terminal = state !== 'ready';
    entry.version += 1;
    entry.dirty = true;
  }
  return writeButton(entry, key);
}

function writeButton(entry, key) {
  if (entry.running) return entry.running;
  entry.running = Promise.resolve().then(async () => {
    while (entry.dirty) {
      entry.dirty = false;
      if (pendingButtonWrites >= 32) break;
      const version = entry.version;
      const state = entry.state;
      const deadline = deadlineSignal(null, 5000, new Error('Discord button update timed out.'));
      pendingButtonWrites += 1;
      const write = Promise.resolve().then(() => entry.interaction.editReply({
        components: buildAskStopComponents(entry.interaction, state), allowedMentions: ASK_ALLOWED_MENTIONS
      }));
      write.then(() => {
        // Reapply the terminal state if an old request arrived out of order.
        if (version !== entry.version) { entry.dirty = true; void writeButton(entry, key); }
      }, () => {}).finally(() => { pendingButtonWrites -= 1; });
      try { await raceWithSignal(write, deadline.signal); } catch {} finally { deadline.cleanup(); }
    }
  }).finally(() => {
    entry.running = null;
    if (entry.dirty) void writeButton(entry, key);
    else if (entry.terminal && buttonStates.get(key) === entry) buttonStates.delete(key);
  });
  return entry.running;
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
      // The displayed answer is already final. Google reads it literally;
      // Live's self-transcription cannot independently verify lexical fidelity.
      skipLive: true,
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
  if (!isLatestAskTtsRequest(interaction.guildId, interaction.user.id, requestSequence)) return terminal('superseded');

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

  // A newer /ask from the same user supersedes older queued speech and
  // may cancel an older current /ask only while it is still pre-audible. Once
  // speech has started, preserve it. Sequence ordering prevents a slower older
  // text-generation request from winning merely because it finished later.
  if (Number(requestSequence) > 0 && typeof cancelSupersededAsk === 'function') {
    cancelSupersededAsk(interaction.guildId, interaction.user.id, Number(requestSequence));
  } else {
    cancelQueuedAsk?.(interaction.guildId, interaction.user.id);
  }

  const audio = getAudioStatus(interaction.guildId);
  if (audio && Number(audio.queued) >= Number(audio.maximumQueued)) return terminal('queue-full');

  const voice = getVoice(interaction.guildId, interaction.user.id);
  if (isOptedOut(interaction.guildId, interaction.user.id)) return terminal('opted-out');

  const item = buildAskTtsItem(interaction, text, voiceChannel, voice, requestSequence, replyMessageId);
  item.metadata.onTerminal = terminal;
  const enqueueStatus = enqueue(interaction.guildId, item.text, item.metadata);
  if (String(enqueueStatus).startsWith('rejected-')) return terminal(enqueueStatus);

  setAskStopButtonState(interaction, 'ready');

  try {
    const result = await connect(interaction.guild, voiceChannel, { allowMove: false });
    if (!result?.connection) {
      terminal('unavailable');
      cancel(interaction.guildId, item.metadata.messageId);
      return result?.status || 'voice-unavailable';
    }
    return enqueueStatus;
  } catch (error) {
    terminal('unavailable');
    cancel(interaction.guildId, item.metadata.messageId);
    throw error;
  }
}

export const __test = { latestAskSequenceByUser, buttonStates };
