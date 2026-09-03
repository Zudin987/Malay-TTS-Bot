import { ChannelType, Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { performance } from 'node:perf_hooks';
import { cancelMessageAudio, enqueue } from './audio.js';
import { handleAskStopButton } from './ask-response.js';
import { commands } from './commands.js';
import { config } from './config.js';
import { buildSpeakableMessage } from './message-speech-policy.js';
import { prepareSpeechVariants } from './preprocess.js';
import { getGuildSettings, isUserTtsOptedOut } from './store.js';
import { cleanupTempDirectory, getOrAssignTtsVoice } from './tts.js';
import { sendVoiceStateLog } from './voice-log.js';
import { fatalLogSync, flushLogs } from './logger.js';
import { connectToVoiceChannel, disconnectAllGuilds, evaluateAutoLeave, getRuntimeVoiceChannelId } from './voice.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.commands = new Collection(commands.map((command) => [command.data.name, command]));
let shuttingDown = false;
let fatalExiting = false;

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log('Gemini TTS configured with Google Malay fallback. Fresh one-turn Live sessions; message combining disabled.');
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    try {
      if (await handleAskStopButton(interaction, cancelMessageAudio)) return;
    } catch (error) {
      console.error('[ask-stop-tts]', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Could not stop that TTS item.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This bot only accepts commands inside its private Discord server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try { await command.execute(interaction); }
  catch (error) {
    console.error(`[/${interaction.commandName}]`, error);
    const reply = { content: 'Command failed. Check bot.log.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (shuttingDown || !message.guild || message.author.bot || message.webhookId) return;
  let queuedForVoice = false;
  try {
    // TTS is intentionally limited to normal Discord voice channels. Stage
    // speaking requires a separate permission/speaker-state flow and is not
    // silently treated as a normal voice channel.
    if (message.channel.type !== ChannelType.GuildVoice) return;
    if (message.member?.voice.channelId !== message.channel.id) return;

    const guildSettings = getGuildSettings(message.guild.id);
    // Per-user privacy opt-out is checked before connecting or preprocessing,
    // so opted-out message text is never sent to any TTS provider.
    if (isUserTtsOptedOut(message.guild.id, message.author.id)) return;

    const currentChannelId = getRuntimeVoiceChannelId(message.guild.id);
    if (currentChannelId && currentChannelId !== message.channel.id) return;

    // Only normal chat text, mentions/tags and images are eligible here.
    // Link/file/GIF/video/emoji-only posts are discarded before speaker labels,
    // provider selection or a Discord voice connection is started. /ask has its
    // own interaction path and is intentionally unaffected by this policy.
    const speakableMessage = buildSpeakableMessage(message);
    if (!speakableMessage) return;

    const preprocessStartedAt = performance.now();
    const speech = prepareSpeechVariants(speakableMessage, guildSettings);
    const preprocessMs = performance.now() - preprocessStartedAt;
    const geminiText = speech.geminiText || speech.googleText;
    if (!geminiText) return;
    const googleText = speech.googleText || geminiText;
    const verificationText = speech.geminiVerificationText || geminiText;
    const assignedVoice = getOrAssignTtsVoice(message.guild.id, message.author.id);
    if (isUserTtsOptedOut(message.guild.id, message.author.id)) return;

    // Cold-start latency: begin Discord's voice handshake and provider
    // generation at the same time. audio.js keeps playback gated on voiceReady,
    // so prefetched audio cannot be consumed before the subscription is Ready.
    const connectionPromise = connectToVoiceChannel(message.guild, message.channel, { allowMove: false });
    connectionPromise.catch(() => {});
    const enqueueStatus = enqueue(message.guild.id, geminiText, {
      messageId: message.id,
      voiceChannelId: message.channel.id,
      speakerLabel: speech.speakerLabel,
      speakerResetSeconds: guildSettings.speakerResetSeconds,
      googleText, verificationText, preprocessMs,
      messageCreatedAt: message.createdTimestamp,
      userId: message.author.id,
      voice: assignedVoice
    });
    queuedForVoice = enqueueStatus !== 'rejected-other-channel';

    const result = await connectionPromise;
    if (!result.connection) {
      cancelMessageAudio(message.guild.id, message.id);
      queuedForVoice = false;
      return;
    }
    queuedForVoice = false;
  } catch (error) {
    if (queuedForVoice) cancelMessageAudio(message.guild?.id, message.id);
    // Expected Discord/voice/preprocessing failures are contained here. Truly
    // unhandled failures below are fatal so Task Scheduler can restart cleanly.
    console.error(`[message:${message.guild?.id ?? 'unknown'}]`, error);
  }
});

client.on(Events.MessageDelete, (message) => {
  if (shuttingDown || !message.guild || !message.id) return;
  cancelMessageAudio(message.guild.id, message.id);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  evaluateAutoLeave(newState.guild ?? oldState.guild);
  void sendVoiceStateLog(client, oldState, newState).catch((error) => console.warn('[voice-log]', error));
});
client.on(Events.Error, (error) => console.error('[discord-client]', error));

function fatalExit(kind, error) {
  if (fatalExiting) return;
  fatalExiting = true;
  try { disconnectAllGuilds(); } catch {}
  try { client.destroy(); } catch {}
  fatalLogSync(`[${kind}]`, error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
}
process.on('unhandledRejection', (reason) => fatalExit('unhandledRejection', reason));
process.on('uncaughtException', (error) => fatalExit('uncaughtException', error));

export async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}; cleaning up.`);
  try {
    disconnectAllGuilds();
    client.destroy();
    await cleanupTempDirectory();
    await flushLogs();
  } catch (error) {
    console.error('[shutdown]', error);
    await flushLogs().catch(() => {});
  } finally {
    process.exit(0);
  }
}

process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
await cleanupTempDirectory();
await client.login(config.token);
