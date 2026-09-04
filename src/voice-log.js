import { escapeMarkdown, PermissionFlagsBits } from 'discord.js';
import { getExistingGuildSettings, getGuildSettings, updateGuildSettings } from './store.js';

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

export function clearVoiceLogForDeletedChannel(channel, {
  getSettings = getExistingGuildSettings,
  updateSettings = updateGuildSettings
} = {}) {
  const guildId = String(channel?.guild?.id ?? channel?.guildId ?? '').trim();
  const channelId = String(channel?.id ?? '').trim();
  if (!guildId || !channelId) return false;
  const current = getSettings(guildId);
  if (!current?.voiceLogEnabled || String(current.voiceLogChannelId ?? '') !== channelId) return false;
  updateSettings(guildId, { voiceLogEnabled: false, voiceLogUserId: null, voiceLogChannelId: null });
  return true;
}

export async function sendVoiceStateLog(client, oldState, newState, {
  getSettings = getGuildSettings,
  updateSettings = updateGuildSettings
} = {}) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  // Ignore mute/deafen/stream/video changes and bot voice activity.
  if (oldState.channelId === newState.channelId) return;
  // Channel-to-channel moves are intentionally silent.
  if (oldState.channelId && newState.channelId) return;
  const member = newState.member ?? oldState.member;
  if (!member || member.user?.bot) return;

  const guildSettings = getSettings(guild.id);
  if (
    !guildSettings.voiceLogEnabled
    || !guildSettings.voiceLogUserId
    || !guildSettings.voiceLogChannelId
  ) return;

  const eventChannelId = newState.channelId ?? oldState.channelId;
  if (eventChannelId !== guildSettings.voiceLogChannelId) return;

  // Re-fetch from this guild on every event. A global User fetch proves only
  // that the Discord account exists, not that it remains an authorized guild
  // member. Force avoids trusting stale role membership from cache.
  let target;
  try { target = await guild.members.fetch({ user: guildSettings.voiceLogUserId, force: true }); }
  catch (error) {
    // Fail closed: a transient lookup failure can be re-enabled explicitly,
    // whereas retaining a departed recipient can leak future activity.
    updateSettings(guild.id, { voiceLogEnabled: false, voiceLogUserId: null, voiceLogChannelId: null });
    console.warn(`[voicelog:${guild.id}] Subscription disabled because its recipient could not be reauthorized: ${error?.message ?? error}`);
    return;
  }
  if (!target?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    updateSettings(guild.id, { voiceLogEnabled: false, voiceLogUserId: null, voiceLogChannelId: null });
    console.warn(`[voicelog:${guild.id}] Subscription disabled because its recipient is no longer authorized.`);
    return;
  }

  // The setting may have been disabled or reassigned while member lookup was
  // in flight. Never deliver using stale authorization state.
  const current = getSettings(guild.id);
  if (!current.voiceLogEnabled
    || current.voiceLogUserId !== guildSettings.voiceLogUserId
    || current.voiceLogChannelId !== guildSettings.voiceLogChannelId) return;

  const content = buildVoiceLogMessage(oldState, newState);
  if (!content) return;
  try { await target.send({ content }); }
  catch (error) {
    // DM failures should never affect TTS or voice-state handling.
    console.warn(
      `[voicelog:${guild.id}] Could not DM user ${guildSettings.voiceLogUserId}: ${error?.message ?? error}`
    );
  }
}
