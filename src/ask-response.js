import { ChannelType, EmbedBuilder } from 'discord.js';

export const ASK_ALLOWED_MENTIONS = Object.freeze({
  parse: [],
  users: [],
  roles: [],
  repliedUser: false
});

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
      rejectOnOverflow: true
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

  try {
    const result = await connect(interaction.guild, voiceChannel, { allowMove: false });
    if (!result?.connection) {
      cancel(interaction.guildId, item.metadata.messageId);
      return result?.status || 'voice-unavailable';
    }
    return enqueueStatus;
  } catch (error) {
    cancel(interaction.guildId, item.metadata.messageId);
    throw error;
  }
}
