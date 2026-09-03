import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';

import {
  addDictionaryEntry,
  getCustomDictionarySize,
  getDictionarySize,
  removeDictionaryEntry
} from './dictionary.js';

import {
  getGuildSettings,
  getTtsVoiceAllocation,
  getUserTtsVoice,
  isUserTtsOptedOut,
  removeUserAlias,
  setUserAlias,
  setUserTtsOptOut,
  setUserTtsVoice,
  updateGuildSettings
} from './store.js';

import {
  connectToVoiceChannel,
  disconnectGuild,
  getRuntimeVoiceChannelId,
  isVoiceRecovering
} from './voice.js';

import { getLastSettingsError, loadSettings, settings } from './config.js';
import { cancelMessageAudio, cancelQueuedAskAudioForUser, cancelSupersededAskAudioForUser, cancelUserAudio, enqueue, getAudioStatus } from './audio.js';
import { getPeakLimiterOptions } from './audio-filters.js';
import { getAcronymSize } from './acronyms.js';
import { getMalayDictionarySize } from './malay-dictionary.js';
import { getGameDictionarySize } from './game-dictionary.js';
import { getTtsMetrics } from './tts-metrics.js';
import { getOrAssignTtsVoice, getTtsProviderStatus, restartTtsRuntime } from './tts.js';
import { GEMINI_VOICES, GEMINI_VOICE_OPTIONS } from './voices.js';
import { getSpeakerLabelPcm, getSpeakerLabelStatus } from './speaker-label.js';
import { getFfmpegPath } from './ffmpeg.js';
import { askGemini, describeAskError, getAskOptions } from './ask.js';
import { ASK_ALLOWED_MENTIONS, beginAskTtsRequest, buildAskEmbed, queueAskAnswerTts } from './ask-response.js';
import { describeTtsRestartBlockers, getTtsRestartBlockers } from './restart-guard.js';

const ephemeral = MessageFlags.Ephemeral;
function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


function formatMilliseconds(value, decimals = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0 ms';
  return `${number.toFixed(decimals)} ms`;
}

function formatDelay(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1000) return `${Math.round(number)}ms`;
  return `${(number / 1000).toFixed(1)}s`;
}

function formatUptime(totalSeconds) {
  let seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}


const askTtsDependencies = {
  isOptedOut: isUserTtsOptedOut,
  getRuntimeVoiceChannelId,
  getAudioStatus,
  getVoice: getOrAssignTtsVoice,
  connect: connectToVoiceChannel,
  enqueue,
  cancel: cancelMessageAudio,
  cancelQueuedAsk: cancelQueuedAskAudioForUser,
  cancelSupersededAsk: cancelSupersededAskAudioForUser
};

const askCommand = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Gemini for a short chat-style answer')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('What you want to ask')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(1000)
    ),

  async execute(interaction) {
    const question = interaction.options.getString('question', true);
    const askTtsSequence = beginAskTtsRequest(interaction.guildId, interaction.user.id);
    await interaction.deferReply();
    try {
      const { answer } = await askGemini(question, { options: getAskOptions(settings.ask) });
      const embed = buildAskEmbed(interaction, question, answer);
      await interaction.editReply({
        content: null,
        embeds: [embed],
        allowedMentions: ASK_ALLOWED_MENTIONS
      });
      void queueAskAnswerTts(interaction, answer, askTtsDependencies, { requestSequence: askTtsSequence }).catch((error) => {
        console.warn('[ask-tts]', error?.message || error);
      });
    } catch (error) {
      console.warn('[ask]', error?.code || error?.name || 'error', error?.status || '');
      await interaction.editReply({
        content: describeAskError(error),
        embeds: [],
        allowedMentions: ASK_ALLOWED_MENTIONS
      });
    }
  }
};

const ttsOptOutCommand = {
  data: new SlashCommandBuilder()
    .setName('ttsoptout')
    .setDescription('Choose whether your voice-channel messages may be sent to TTS providers')
    .addBooleanOption((option) =>
      option.setName('enabled').setDescription('True = do not read/send my messages').setRequired(true)
    ),

  async execute(interaction) {
    const enabled = interaction.options.getBoolean('enabled', true);
    setUserTtsOptOut(interaction.guildId, interaction.user.id, enabled);
    const cancelled = enabled ? cancelUserAudio(interaction.guildId, interaction.user.id) : null;
    await interaction.reply({
      content: enabled
        ? `TTS opt-out **enabled**. Your eligible voice-channel messages will not be sent to Gemini or Google TTS.${cancelled && (cancelled.cancelledCurrent || cancelled.cancelledQueued) ? ' Your current/queued TTS items were cancelled.' : ''}`
        : 'TTS opt-out **disabled**. Eligible voice-channel messages may be sent to Gemini/Google TTS for speech generation.',
      flags: ephemeral
    });
  }
};

const ttsPrivacyCommand = {
  data: new SlashCommandBuilder()
    .setName('ttsprivacy')
    .setDescription('Show the TTS data-processing notice and your opt-out status'),

  async execute(interaction) {
    const optedOut = isUserTtsOptedOut(interaction.guildId, interaction.user.id);
    await interaction.reply({
      content: [
        'Eligible messages typed in the active Discord voice-channel chat are sent to the selected TTS provider to generate speech.',
        'Gemini Live and the unofficial Google Malay endpoint process submitted speech text under their applicable terms.',
        `Your TTS opt-out is currently **${optedOut ? 'enabled' : 'disabled'}**. Use \`/ttsoptout\` to change it.`
      ].join('\n'),
      flags: ephemeral
    });
  }
};

const joinCommand = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Manually join or move to your current voice channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: 'Join a normal voice channel first. Stage channels are not supported for TTS playback.', flags: ephemeral });
      return;
    }

    await interaction.deferReply({ flags: ephemeral });
    await connectToVoiceChannel(interaction.guild, channel, { allowMove: true });
    await interaction.editReply(`Joined **${channel.name}**.`);
  }
};

const leaveCommand = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop TTS and disconnect')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    disconnectGuild(interaction.guildId);
    await interaction.reply({ content: 'Disconnected.', flags: ephemeral });
  }
};

const speakerCommand = {
  data: new SlashCommandBuilder()
    .setName('speaker')
    .setDescription('Configure username announcements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Announcement style')
        .setRequired(true)
        .addChoices(
          { name: 'Username cakap', value: 'cakap' },
          { name: 'Username only', value: 'username' },
          { name: 'No username', value: 'none' }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName('reset_seconds')
        .setDescription('5 to 300 seconds')
        .setMinValue(5)
        .setMaxValue(300)
    ),

  async execute(interaction) {
    const mode = interaction.options.getString('mode', true);
    const reset = interaction.options.getInteger('reset_seconds');
    const patch = { speakerMode: mode };
    if (reset !== null) patch.speakerResetSeconds = reset;
    updateGuildSettings(interaction.guildId, patch);

    if (mode !== 'none') {
      const latest = getGuildSettings(interaction.guildId);
      const labels = new Set(Object.values(latest.userAliases ?? {}).filter(Boolean));
      const currentChannelId = getRuntimeVoiceChannelId(interaction.guildId);
      const voiceChannel = currentChannelId ? interaction.guild.channels.cache.get(currentChannelId) : null;
      for (const member of voiceChannel?.members?.values?.() ?? []) {
        if (!member.user?.bot) labels.add(latest.userAliases?.[member.id] || member.displayName || member.user?.username);
      }
      for (const value of [...labels].filter(Boolean).slice(0, 20)) {
        void getSpeakerLabelPcm(mode === 'cakap' ? `${value} cakap` : value);
      }
    }

    await interaction.reply({
      content: `Speaker mode: **${mode}**${reset !== null ? `; reset: **${reset}s**` : ''}`,
      flags: ephemeral
    });
  }
};

const changeVoiceCommand = {
  data: new SlashCommandBuilder()
    .setName('changevoice')
    .setDescription('Choose your Gemini TTS voice')
    .addStringOption((option) =>
      option
        .setName('voice')
        .setDescription('Your TTS voice')
        .setRequired(true)
        .addChoices(
          ...GEMINI_VOICE_OPTIONS.map((voice) => ({
            name: `${voice.gender === 'Female' ? 'F' : 'M'} · ${voice.name} — ${voice.style.toLowerCase()}`,
            value: voice.name
          }))
        )
    ),

  async execute(interaction) {
    const voice = interaction.options.getString('voice', true);
    if (!GEMINI_VOICES.includes(voice)) {
      await interaction.reply({ content: 'That voice is not available.', flags: ephemeral });
      return;
    }

    setUserTtsVoice(interaction.guildId, interaction.user.id, voice);
    const details = GEMINI_VOICE_OPTIONS.find((item) => item.name === voice);
    await interaction.reply({
      content: `Your TTS voice is now **${voice}**${details ? ` (${details.gender.toLowerCase()} · ${details.style.toLowerCase()})` : ''}.`,
      flags: ephemeral
    });
  }
};

const nameCommand = {
  data: new SlashCommandBuilder()
    .setName('name')
    .setDescription('Manage TTS-only names')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add or update a TTS name for a member')
        .addUserOption((option) =>
          option.setName('user').setDescription('Member to rename for TTS').setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Name the bot should speak')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(32)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a member\'s custom TTS name')
        .addUserOption((option) =>
          option.setName('user').setDescription('Member whose TTS name should be removed').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user', true);

    if (subcommand === 'add') {
      const alias = interaction.options.getString('name', true).trim();
      setUserAlias(interaction.guildId, user.id, alias);
      // Speaker-label generation may be lazy; these calls opportunistically
      // create handles without forcing privacy-sensitive provider work.
      void getSpeakerLabelPcm(alias);
      void getSpeakerLabelPcm(`${alias} cakap`);
      await interaction.reply({
        content: `TTS name for ${user} is now **${alias}**.`,
        flags: ephemeral
      });
      return;
    }

    const removed = removeUserAlias(interaction.guildId, user.id);
    await interaction.reply({
      content: removed
        ? `Removed the custom TTS name for ${user}.`
        : `${user} did not have a custom TTS name.`,
      flags: ephemeral
    });
  }
};

const dictionaryCommand = {
  data: new SlashCommandBuilder()
    .setName('dictionary')
    .setDescription('Manage Google fallback word replacements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add or update a word')
        .addStringOption((option) =>
          option.setName('shortform').setDescription('Example: esk').setRequired(true)
        )
        .addStringOption((option) =>
          option.setName('expansion').setDescription('Example: esok').setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a word')
        .addStringOption((option) =>
          option.setName('shortform').setDescription('Word to remove').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const shortform = interaction.options.getString('shortform', true);

    if (subcommand === 'add') {
      const expansion = interaction.options.getString('expansion', true);
      addDictionaryEntry(interaction.guildId, shortform, expansion);
      await interaction.reply({
        content: `Added for Google fallback: \`${shortform.toLowerCase()}\` -> **${expansion}**`,
        flags: ephemeral
      });
      return;
    }

    const removed = removeDictionaryEntry(interaction.guildId, shortform);
    await interaction.reply({
      content: removed ? `Removed Google fallback entry \`${shortform.toLowerCase()}\`.` : 'Entry not found.',
      flags: ephemeral
    });
  }
};

const voiceLogCommand = {
  data: new SlashCommandBuilder()
    .setName('voicelog')
    .setDescription('Choose one voice channel for private join/leave logs')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('DM me when someone joins or leaves one voice channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Voice channel to monitor')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('disable').setDescription('Stop voice join/leave DMs')
    ),

  async execute(interaction) {
    const enabled = interaction.options.getSubcommand() === 'enable';

    if (enabled) {
      const channel = interaction.options.getChannel('channel', true);
      updateGuildSettings(interaction.guildId, {
        voiceLogEnabled: true,
        voiceLogUserId: interaction.user.id,
        voiceLogChannelId: channel.id
      });
      await interaction.reply({
        content: `Voice chat log **enabled** for ${channel}. Join and leave events will be sent to your DM; channel moves are ignored.`,
        flags: ephemeral
      });
      return;
    }

    updateGuildSettings(interaction.guildId, {
      voiceLogEnabled: false,
      voiceLogUserId: null,
      voiceLogChannelId: null
    });
    await interaction.reply({
      content: 'Voice chat log **disabled**.',
      flags: ephemeral
    });
  }
};


const restartTtsCommand = {
  data: new SlashCommandBuilder()
    .setName('restarttts')
    .setDescription('Reload settings.json and restart Gemini TTS sessions')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const guildIds = new Set([String(interaction.guildId)]);
    for (const guildId of interaction.client?.guilds?.cache?.keys?.() ?? []) guildIds.add(String(guildId));
    const blockers = getTtsRestartBlockers({
      guildIds: [...guildIds],
      getAudioStatus,
      getProviderStatus: getTtsProviderStatus
    });
    if (!blockers.safe) {
      await interaction.reply({
        content: `TTS runtime is busy across the process (${describeTtsRestartBlockers(blockers)}). Run /restarttts again after all queues/provider work are idle so another guild is not interrupted.`,
        flags: ephemeral
      });
      return;
    }

    const changed = loadSettings();
    const settingsError = getLastSettingsError();
    if (settingsError) {
      await interaction.reply({
        content: `Could not apply config/settings.json: **${String(settingsError).slice(0, 300)}**. The bot kept the previous working settings.`,
        flags: ephemeral
      });
      return;
    }

    restartTtsRuntime();
    const profile = settings.geminiLive?.profile ?? {};
    const thinking = String(profile.thinkingLevel || 'MINIMAL').toUpperCase();
    await interaction.reply({
      content: `TTS profile ${changed ? 'reloaded from config/settings.json' : 're-applied from the current settings'} and Gemini Live sessions restarted. Thinking: **${thinking}**. Your next message will open a fresh Live session with the new profile. Changes to Gemini keys or GEMINI_API_KEY_SLOT in .env still require a full bot process restart.`,
      flags: ephemeral
    });
  }
};

const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current TTS settings'),

  async execute(interaction) {
    const current = getGuildSettings(interaction.guildId);
    const channelId = getRuntimeVoiceChannelId(interaction.guildId);
    const memory = process.memoryUsage();
    const audio = getAudioStatus(interaction.guildId);
    const slowThresholdMs = Math.max(250, Number(settings.diagnostics?.slowTtsMs) || 1500);
    const timing = getTtsMetrics(interaction.guildId, slowThresholdMs);
    const voiceState = isVoiceRecovering(interaction.guildId) ? 'recovering' : (channelId ? 'ready' : 'disconnected');
    const provider = getTtsProviderStatus();
    const peakLimiter = getPeakLimiterOptions(settings.audioPipeline);
    const personalVoice = getUserTtsVoice(interaction.guildId, interaction.user.id);
    const voiceAllocation = getTtsVoiceAllocation(interaction.guildId, GEMINI_VOICES);
    const speakerLabel = getSpeakerLabelStatus();
    const settingsError = getLastSettingsError();
    const keyRing = provider.geminiKeyRoundRobin ?? {};

    const providerLine = (name, state, standby = false) => {
      const availability = state.unavailableReason ? state.unavailableReason : state.disabled
        ? `disabled (${state.disabledReason || 'request/config error'})`
        : state.halfOpenProbeInFlight
          ? 'half-open probe'
          : state.cooldownActive
            ? `cooldown ${state.cooldownRemainingSeconds ?? '∞'}s (${state.cooldownReason || 'error'})`
            : (standby ? 'standby' : 'ready');
      const runaway = state.runawayIncidentCount > 0 ? ` • runaway ${state.runawayIncidentCount}` : '';
      return `${name}: ${availability} • first ${state.firstAudioSuccessCount}/${state.startedCount} • done ${state.successCount} • fail ${state.failureCount} • skip ${state.skippedCount} • budget ${state.budgetMissCount}${runaway}`;
    };

    const timingText = timing.last ? [
      `Local first sound: ${formatMilliseconds(timing.last.timeToSpeechMs)} • actual message start: ${formatMilliseconds(timing.last.timeToMessageSpeechMs)}`,
      `p50/p95 message: ${formatMilliseconds(timing.percentiles.messageP50Ms)}/${formatMilliseconds(timing.percentiles.messageP95Ms)} • max ${formatMilliseconds(timing.maxima.messageMs)}`,
      `Last provider: ${timing.last.provider} ${formatMilliseconds(timing.last.providerMs)} • queue ${formatMilliseconds(timing.last.queueMs)} • speaker wait ${formatMilliseconds(timing.last.speakerLabelWaitMs)}`,
      `FFmpeg first ${formatMilliseconds(timing.last.ffmpegFirstPacketMs)} • local Discord buffer ${formatMilliseconds(timing.last.discordBufferMs)} • preprocess ${formatMilliseconds(timing.last.preprocessMs, 1)}`,
      `Slow: ${timing.slowCount}/${timing.sampleSize} (≥ ${Math.round(slowThresholdMs)}ms). Timings are local pipeline measurements, not proof of remote client audibility.`
    ].join('\n') : 'No playback samples yet.';

    const runtimeEmbed = new EmbedBuilder()
      .setTitle('Malay TTS Bot — Runtime')
      .addFields(
        {
          name: 'Voice & speaker',
          value: [
            `${channelId ? `<#${channelId}>` : 'Not connected'} • ${voiceState}${audio.pausedForVoice ? ' • playback paused for recovery' : ''}`,
            `Speaker: ${current.speakerMode} • reset ${current.speakerResetSeconds}s • label gain ${speakerLabel.gain.toFixed(2)}× • gap ${speakerLabel.gapMs}ms • cold wait ≤${speakerLabel.maxWaitMs}ms`,
            `Cache: ${speakerLabel.memoryEntries} memory • ${speakerLabel.memoryHits + speakerLabel.diskHits} hits • ${speakerLabel.generated} generated • ${speakerLabel.prunedFiles} pruned • ${speakerLabel.failures} failures`
          ].join('\n')
        },
        {
          name: 'Providers',
          value: [
            provider.geminiAuthDisabled ? 'Gemini auth disabled for this runtime; /restarttts resets provider state, but .env key edits require a full bot restart.' : 'Gemini auth gate: enabled',
            `Gemini keys: ${keyRing.configuredCount ?? 0} unique${Number(keyRing.configuredEnvCount) > Number(keyRing.configuredCount) ? ` / ${keyRing.configuredEnvCount} populated slots` : ''}${keyRing.duplicateSlots?.length ? ` • duplicate slots ${keyRing.duplicateSlots.map((entry) => `${entry.slot}->${entry.duplicateOf}`).join(', ')}` : ''}`,
            providerLine('3.1 Live', provider.livePrimary),
            providerLine('Google ms', provider.google, true),
            provider.burstBypassActive ? `Burst bypass: Google-first for ${provider.burstBypassRemainingSeconds}s` : 'Burst bypass: inactive',
            `Gemini concurrency: ${provider.geminiLimiter.active}/${provider.geminiLimiter.max} active • ${provider.geminiLimiter.queued} waiting${provider.halfOpenProbeKey ? ` • probe ${provider.halfOpenProbeKey}` : ''}`,
            provider.geminiLimiter.waitCount > 0
              ? `Limiter waits: ${provider.geminiLimiter.waitCount} • avg ${Math.round(provider.geminiLimiter.totalWaitMs / provider.geminiLimiter.waitCount)}ms • max ${Math.round(provider.geminiLimiter.maxWaitMs)}ms • prefetch deferred ${provider.geminiLimiter.prefetchDeferredCount}`
              : 'Limiter waits: none',
            `Completed totals: Gemini ${provider.geminiSuccessCount} • Google ${provider.fallbackCount} • last ${provider.lastProvider ?? 'none'}`
          ].join('\n')
        },
        {
          name: 'Queue & recovery',
          value: [
            `${audio.phase} • ${audio.queued}/${audio.maximumQueued} queued • backlog ~${formatDelay(audio.estimatedBacklogMs)} • prefetch ${audio.prefetched}/${audio.prefetchTarget}`,
            `Speed ${Math.round(audio.catchUpSpeed * 100)}% • dropped ${audio.droppedMessages} • stale skipped ${audio.staleSkippedMessages}`,
            `Recovery ${audio.cutoffRecoverySuccesses}/${audio.cutoffRecoveries} • PCM-tail ${audio.mirrorReplays} • duplicate replay prevented ${audio.suppressedCutoffReplays} • runaway recovery suppressed ${audio.runawayRecoveriesSuppressed} • pipeline failures ${audio.pipelineFailures}`,
            `One Discord message = one TTS item. Message combining removed.`
          ].join('\n')
        },
        { name: 'Latency (last 60 local samples)', value: timingText }
      );

    const configEmbed = new EmbedBuilder()
      .setTitle('Malay TTS Bot — Configuration')
      .addFields(
        {
          name: 'Profile & voice',
          value: [
            `Voice: ${personalVoice ?? 'balanced on first TTS'} • pool ${voiceAllocation.totalVoices} • occupied ${voiceAllocation.occupiedVoices} by ${voiceAllocation.assignedUsers} saved users`,
            `Thinking ${String(settings.geminiLive?.profile?.thinkingLevel || 'MINIMAL').toUpperCase()} • fresh one-turn Live sessions only`,
            `First-audio budget ${settings.geminiLive?.firstAudioBudgetMs}ms • Live window ${settings.providerHealth?.primaryFirstAudioMs}ms • Google ≤${settings.googleTts?.timeoutMs}ms • /ask uses literal Google speech`,
            `Preprocess: light-clean • max ${settings.maximumCharacters} graphemes • no Gemini dictionary/grammar rewrite • no merge`
          ].join('\n')
        },
        {
          name: 'Audio',
          value: [
            `FFmpeg: ${getFfmpegPath()}`,
            `Volume ${Math.round(Number(settings.fixedVolume ?? 0.6) * 100)}% • speaker gain ${speakerLabel.gain.toFixed(2)}×`,
            `Peak limiter ${peakLimiter.enabled ? `ON ${peakLimiter.ceilingDb.toFixed(1)} dBFS` : 'OFF'} • replay only before ${settings.audioPipeline?.replayOnlyBeforeMs}ms • hard max ${Math.round(settings.audioPipeline?.playbackHardMaxMs / 1000)}s • progress watchdog ${Math.round(settings.audioPipeline?.progressWatchdogMs / 1000)}s`
          ].join('\n')
        },
        {
          name: 'Fallback data & process',
          value: [
            `Dictionary: ${getDictionarySize()} shipped + ${getCustomDictionarySize(interaction.guildId)} guild overrides • Malay-context ${getMalayDictionarySize()} • game-context ${getGameDictionarySize()} • acronyms ${getAcronymSize()}`,
            `Custom TTS names: ${Object.keys(current.userAliases ?? {}).length} • voice log ${current.voiceLogEnabled ? 'enabled' : 'disabled'}`,
            `RAM ${formatMegabytes(memory.rss)} RSS / ${formatMegabytes(memory.heapUsed)} heap • uptime ${formatUptime(process.uptime())}`,
            settingsError ? `Settings warning: ${String(settingsError).slice(0, 350)}` : 'settings.json: valid'
          ].join('\n')
        },
        {
          name: 'Recent provider errors',
          value: [
            provider.livePrimary.lastError ? `3.1 Live: ${String(provider.livePrimary.lastError).slice(0, 220)}` : null,
            provider.google.lastError ? `Google: ${String(provider.google.lastError).slice(0, 220)}` : null
          ].filter(Boolean).join('\n') || 'None'
        }
      );

    await interaction.reply({ embeds: [runtimeEmbed, configEmbed], flags: ephemeral });
  }
};

export const commands = [
  askCommand,
  ttsPrivacyCommand,
  ttsOptOutCommand,
  joinCommand,
  leaveCommand,
  speakerCommand,
  changeVoiceCommand,
  nameCommand,
  dictionaryCommand,
  voiceLogCommand,
  restartTtsCommand,
  statusCommand
];
