import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';

export const ASK_ALLOWED_MENTIONS = Object.freeze({
  parse: [],
  users: [],
  roles: [],
  repliedUser: false
});

export const ASK_STOP_BUTTON_PREFIX = 'ask-stop:';

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
  const stopped = state === 'stopped';
  const finished = state === 'finished';
  const unavailable = state === 'unavailable';
  const disabled = stopped || finished || unavailable;
  const label = stopped ? 'TTS stopped' : finished ? 'TTS finished' : unavailable ? 'TTS unavailable' : 'STOP TTS';
  const button = new ButtonBuilder()
    .setCustomId(buildAskStopButtonId(interaction.id, interaction.user.id))
    .setLabel(label)
    .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Danger)
    .setDisabled(disabled);
  return [new ActionRowBuilder().addComponents(button)];
}

function setAskStopButtonState(interaction, state) {
  if (typeof interaction?.editReply !== 'function') return;
  void interaction.editReply({ components: buildAskStopComponents(interaction, state) }).catch(() => {});
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
  const owner = { id: parsed.askInteractionId, user: { id: parsed.ownerUserId } };
  await interaction.update({
    components: buildAskStopComponents(owner, cancelled ? 'stopped' : 'finished')
  }).catch(async () => {
    await interaction.reply({
      content: cancelled ? 'TTS stopped.' : 'That TTS already finished or is no longer queued.',
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
  });
  return true;
}

export function buildAskTtsItem(interaction, answer, voiceChannel, voice) {
  const text = String(answer ?? '').trim();
  return {
    text,
    metadata: {
      messageId: `ask:${interaction.id}`,
      voiceChannelId: voiceChannel.id,
      googleText: text,
      verificationText: text,
      messageCreatedAt: interaction.createdTimestamp || Date.now(),
      userId: interaction.user.id,
      voice,
      speakerLabel: null,
      rejectOnOverflow: true,
      // /ask output is already generated text. Do not send it back through the
      // conversational Live model, which can occasionally answer a question in
      // the transcript instead of reading it. Use dedicated Gemini TTS first,
      // then the deterministic Google fallback.
      skipLive: true
    }
  };
}

export async function queueAskAnswerTts(interaction, answer, dependencies) {
  const text = String(answer ?? '').trim();
  if (!text) return 'empty';
  if (!interaction?.guildId || !interaction?.guild || !interaction?.user?.id) return 'invalid-interaction';

  const {
    isOptedOut,
    getRuntimeVoiceChannelId,
    getAudioStatus,
    getVoice,
    connect,
    enqueue,
    cancel
  } = dependencies;

  if (isOptedOut(interaction.guildId, interaction.user.id)) return 'opted-out';

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) return 'not-in-voice';

  const activeChannelId = getRuntimeVoiceChannelId(interaction.guildId);
  if (activeChannelId && String(activeChannelId) !== String(voiceChannel.id)) return 'other-channel';

  const audio = getAudioStatus(interaction.guildId);
  if (audio && Number(audio.queued) >= Number(audio.maximumQueued)) return 'queue-full';

  const voice = getVoice(interaction.guildId, interaction.user.id);
  if (isOptedOut(interaction.guildId, interaction.user.id)) return 'opted-out';

  const item = buildAskTtsItem(interaction, text, voiceChannel, voice);
  const enqueueStatus = enqueue(interaction.guildId, item.text, item.metadata);
  if (String(enqueueStatus).startsWith('rejected-')) return enqueueStatus;

  setAskStopButtonState(interaction, 'ready');

  try {
    const result = await connect(interaction.guild, voiceChannel, { allowMove: false });
    if (!result?.connection) {
      cancel(interaction.guildId, item.metadata.messageId);
      setAskStopButtonState(interaction, 'unavailable');
      return result?.status || 'voice-unavailable';
    }
    return enqueueStatus;
  } catch (error) {
    cancel(interaction.guildId, item.metadata.messageId);
    setAskStopButtonState(interaction, 'unavailable');
    throw error;
  }
}
