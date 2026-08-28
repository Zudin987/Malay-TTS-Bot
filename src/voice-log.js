import { escapeMarkdown } from 'discord.js';
import { getGuildSettings } from './store.js';

function displayMemberName(state) {
  const member = state.member;
  if (member?.displayName) return escapeMarkdown(member.displayName);
  if (member?.user?.globalName) return escapeMarkdown(member.user.globalName);
  if (member?.user?.username) return escapeMarkdown(member.user.username);
  return `User ${state.id}`;
}

function buildVoiceLogMessage(oldState, newState) {
  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;
  if (oldChannelId === newChannelId) return null;

  const memberName = displayMemberName(newState.member ? newState : oldState);
  const guildName = escapeMarkdown((newState.guild ?? oldState.guild).name);
  const timestamp = Math.floor(Date.now() / 1000);

  let action;
  if (!oldChannelId && newChannelId) {
    action = `**${memberName}** entered <#${newChannelId}> in **${guildName}**.`;
  } else if (oldChannelId && !newChannelId) {
    action = `**${memberName}** left <#${oldChannelId}> in **${guildName}**.`;
  } else return null;

  return `🔊 **Voice chat log**\n${action}\n<t:${timestamp}:F>`;
}

export async function sendVoiceStateLog(client, oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  // Ignore mute/deafen/stream/video changes and bot voice activity.
  if (oldState.channelId === newState.channelId) return;
  // Channel-to-channel moves are intentionally silent.
  if (oldState.channelId && newState.channelId) return;
  const member = newState.member ?? oldState.member;
  if (!member || member.user?.bot) return;

  const guildSettings = getGuildSettings(guild.id);
  if (
    !guildSettings.voiceLogEnabled
    || !guildSettings.voiceLogUserId
    || !guildSettings.voiceLogChannelId
  ) return;

  const eventChannelId = newState.channelId ?? oldState.channelId;
  if (eventChannelId !== guildSettings.voiceLogChannelId) return;

  const content = buildVoiceLogMessage(oldState, newState);
  if (!content) return;

  try {
    const target = await client.users.fetch(guildSettings.voiceLogUserId);
    await target.send({ content });
  } catch (error) {
    // DM failures should never affect TTS or voice-state handling.
    console.warn(
      `[voicelog:${guild.id}] Could not DM user ${guildSettings.voiceLogUserId}: ${error?.message ?? error}`
    );
  }
}
