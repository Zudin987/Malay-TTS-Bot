import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { pauseAudioForVoice, releaseAudio, resumeAudioForVoice, subscribePlayer } from './audio.js';
import { settings } from './config.js';

const leaveTimers = new Map();
const voiceStates = new Map();
const guildLocks = new Map();
const NORMAL_RECOVERY_WAIT_MS = 8_000;
const FRESH_RETRY_DELAYS_MS = [1_000, 3_000];
const FRESH_READY_TIMEOUT_MS = 15_000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function stateFor(guildId) {
  let state = voiceStates.get(guildId);
  if (!state) {
    state = { desiredChannelId: null, connection: null, epoch: 0, recoveryPromise: null };
    voiceStates.set(guildId, state);
  }
  return state;
}
function withGuildLock(guildId, fn) {
  const previous = guildLocks.get(guildId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  let tail;
  tail = next.finally(() => {
    if (guildLocks.get(guildId) === tail) guildLocks.delete(guildId);
  }).catch(() => {});
  guildLocks.set(guildId, tail);
  return next;
}
function safeDestroy(connection) {
  if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) return;
  try { connection.destroy(); } catch (error) { if (!/already been destroyed/iu.test(error?.message ?? '')) throw error; }
}
function stillOwns(state, channelId, epoch, connection = null) {
  return state.epoch === epoch && state.desiredChannelId === channelId && (!connection || state.connection === connection);
}

function makeConnection(guild, channel, state, epoch) {
  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, selfMute: false
    });
  } catch (error) {
    error.voiceSetupLike = true;
    throw error;
  }
  state.connection = connection;
  attachHandlers(guild, channel.id, connection, state, epoch);
  return connection;
}

function attachHandlers(guild, channelId, connection, state, epoch) {
  connection.on('stateChange', (_oldState, newState) => {
    if (!stillOwns(state, channelId, epoch, connection)) return;
    if (newState.status === VoiceConnectionStatus.Disconnected || newState.status === VoiceConnectionStatus.Destroyed) {
      // Stop local playback from advancing while Discord has no subscriber.
      pauseAudioForVoice(guild.id);
      void scheduleRecovery(guild, channelId, connection, epoch, newState.status.toLowerCase());
    }
  });
}

function trackRecovery(state, factory) {
  if (state.recoveryPromise) return state.recoveryPromise;
  let job;
  job = Promise.resolve()
    .then(factory)
    .finally(() => { if (state.recoveryPromise === job) state.recoveryPromise = null; });
  state.recoveryPromise = job;
  return job;
}

function scheduleRecovery(guild, channelId, failedConnection, epoch, reason) {
  const state = stateFor(guild.id);
  return trackRecovery(state, () => withGuildLock(guild.id, () => recoverLocked(guild, channelId, failedConnection, epoch, reason)));
}

async function recoverLocked(guild, channelId, failedConnection, epoch, reason) {
  const state = stateFor(guild.id);
  if (!stillOwns(state, channelId, epoch, failedConnection)) return false;
  console.warn(`[voice:${guild.id}] Connection ${reason}; playback paused and recovery started.`);

  if (failedConnection.state?.status !== VoiceConnectionStatus.Destroyed) {
    try {
      await entersState(failedConnection, VoiceConnectionStatus.Ready, NORMAL_RECOVERY_WAIT_MS);
      if (!stillOwns(state, channelId, epoch, failedConnection)) return false;
      subscribePlayer(guild.id, failedConnection, channelId);
      resumeAudioForVoice(guild.id);
      evaluateAutoLeave(guild);
      console.log(`[voice:${guild.id}] Existing voice connection recovered.`);
      return true;
    } catch {}
  }

  if (!stillOwns(state, channelId, epoch, failedConnection)) return false;
  state.connection = null;
  safeDestroy(failedConnection);

  for (let attempt = 0; attempt < FRESH_RETRY_DELAYS_MS.length; attempt += 1) {
    await sleep(FRESH_RETRY_DELAYS_MS[attempt]);
    if (state.epoch !== epoch || state.desiredChannelId !== channelId) return false;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) break;

    let fresh;
    try { fresh = makeConnection(guild, channel, state, epoch); }
    catch (error) {
      console.warn(`[voice:${guild.id}] Fresh reconnect ${attempt + 1} could not start: ${error.message}`);
      continue;
    }
    console.warn(`[voice:${guild.id}] Fresh reconnect attempt ${attempt + 1}/${FRESH_RETRY_DELAYS_MS.length}.`);
    try {
      await entersState(fresh, VoiceConnectionStatus.Ready, FRESH_READY_TIMEOUT_MS);
      if (!stillOwns(state, channelId, epoch, fresh)) { safeDestroy(fresh); return false; }
      subscribePlayer(guild.id, fresh, channelId);
      resumeAudioForVoice(guild.id);
      evaluateAutoLeave(guild);
      console.log(`[voice:${guild.id}] Fresh reconnect succeeded.`);
      return true;
    } catch (error) {
      if (stillOwns(state, channelId, epoch, fresh)) state.connection = null;
      safeDestroy(fresh);
      console.warn(`[voice:${guild.id}] Fresh reconnect attempt ${attempt + 1} failed: ${error.message}`);
    }
  }

  if (state.epoch === epoch && state.desiredChannelId === channelId) {
    state.connection = null;
    state.desiredChannelId = null;
    cancelAutoLeave(guild.id);
    releaseAudio(guild.id);
    console.error(`[voice:${guild.id}] Recovery failed; voice connection released.`);
  }
  return false;
}

export function getRuntimeVoiceChannelId(guildId) { return stateFor(guildId).desiredChannelId ?? null; }
export function isVoiceRecovering(guildId) { return Boolean(stateFor(guildId).recoveryPromise); }

export async function connectToVoiceChannel(guild, channel, { allowMove = false } = {}) {
  return withGuildLock(guild.id, async () => {
    const state = stateFor(guild.id);
    const external = getVoiceConnection(guild.id);
    if (!state.connection && external && state.desiredChannelId === channel.id) state.connection = external;
    const current = state.connection;
    const currentId = state.desiredChannelId;

    if (current && currentId === channel.id) {
      if (current.state?.status === VoiceConnectionStatus.Ready) {
        cancelAutoLeave(guild.id);
        resumeAudioForVoice(guild.id);
        return { connection: current, status: 'already-connected' };
      }
      const epoch = state.epoch;
      const recovered = await trackRecovery(state, () => recoverLocked(guild, channel.id, current, epoch, 'not-ready'));
      if (recovered && state.connection) return { connection: state.connection, status: 'recovered' };
    }

    if (current && currentId !== channel.id && !allowMove) return { connection: null, status: 'busy-other-channel' };

    state.epoch += 1;
    const epoch = state.epoch;
    if (current) { state.connection = null; safeDestroy(current); releaseAudio(guild.id); }
    state.desiredChannelId = channel.id;

    let connection;
    try { connection = makeConnection(guild, channel, state, epoch); }
    catch (error) {
      if (state.epoch === epoch && state.desiredChannelId === channel.id) state.desiredChannelId = null;
      releaseAudio(guild.id);
      throw error;
    }
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      if (stillOwns(state, channel.id, epoch, connection)) { state.connection = null; state.desiredChannelId = null; }
      safeDestroy(connection);
      if (state.epoch === epoch && !state.desiredChannelId) releaseAudio(guild.id);
      throw error;
    }
    if (!stillOwns(state, channel.id, epoch, connection)) { safeDestroy(connection); throw new Error('Voice connection was superseded before becoming ready.'); }
    try {
      subscribePlayer(guild.id, connection, channel.id);
      resumeAudioForVoice(guild.id);
    } catch (error) {
      if (stillOwns(state, channel.id, epoch, connection)) { state.connection = null; state.desiredChannelId = null; }
      safeDestroy(connection);
      releaseAudio(guild.id);
      throw error;
    }
    cancelAutoLeave(guild.id);
    return { connection, status: 'connected' };
  });
}

export function disconnectGuild(guildId) {
  cancelAutoLeave(guildId);
  const state = stateFor(guildId);
  state.epoch += 1;
  const connection = state.connection || getVoiceConnection(guildId);
  state.connection = null;
  state.desiredChannelId = null;
  safeDestroy(connection);
  releaseAudio(guildId);
}

export function disconnectAllGuilds() {
  const guildIds = new Set([...voiceStates.keys(), ...leaveTimers.keys()]);
  for (const guildId of guildIds) disconnectGuild(guildId);
  for (const timer of leaveTimers.values()) clearTimeout(timer);
  leaveTimers.clear();
}

export function evaluateAutoLeave(guild) {
  const state = stateFor(guild.id);
  const channelId = state.desiredChannelId;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) { disconnectGuild(guild.id); return; }
  const humanCount = channel.members.filter((member) => !member.user.bot).size;
  if (humanCount > 0) { cancelAutoLeave(guild.id); return; }
  if (leaveTimers.has(guild.id)) return;
  const autoLeaveSeconds = Math.max(1, Number(settings.autoLeaveSeconds) || 60);
  const timer = setTimeout(() => {
    leaveTimers.delete(guild.id);
    const latestState = stateFor(guild.id);
    if (latestState.desiredChannelId !== channelId) return;
    const latest = guild.channels.cache.get(channelId);
    const stillEmpty = !latest?.isVoiceBased() || latest.members.filter((member) => !member.user.bot).size === 0;
    if (stillEmpty) { console.log(`[voice:${guild.id}] Empty for ${autoLeaveSeconds}s; disconnecting.`); disconnectGuild(guild.id); }
  }, autoLeaveSeconds * 1000);
  timer.unref?.();
  leaveTimers.set(guild.id, timer);
}

function cancelAutoLeave(guildId) {
  const timer = leaveTimers.get(guildId);
  if (timer) clearTimeout(timer);
  leaveTimers.delete(guildId);
}

export const __test = { trackRecovery };
