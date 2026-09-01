from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"Expected {label} not found")
    return text.replace(old, new, 1)


response = r'''import { ChannelType, EmbedBuilder } from 'discord.js';

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
'''
Path('src/ask-response.js').write_text(response, encoding='utf-8')

commands_path = Path('src/commands.js')
commands = commands_path.read_text(encoding='utf-8')
commands = replace_once(
    commands,
    "import { cancelUserAudio, getAudioStatus } from './audio.js';",
    "import { cancelMessageAudio, cancelUserAudio, enqueue, getAudioStatus } from './audio.js';",
    'audio import'
)
commands = replace_once(
    commands,
    "import { getTtsProviderStatus, restartTtsRuntime } from './tts.js';",
    "import { getOrAssignTtsVoice, getTtsProviderStatus, restartTtsRuntime } from './tts.js';",
    'tts import'
)
commands = replace_once(
    commands,
    "import { askGemini, describeAskError, getAskOptions } from './ask.js';",
    "import { askGemini, describeAskError, getAskOptions } from './ask.js';\nimport { ASK_ALLOWED_MENTIONS, buildAskEmbed, queueAskAnswerTts } from './ask-response.js';",
    'ask-response import'
)

old_ask = r'''const askCommand = {
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
    await interaction.deferReply();
    try {
      const { answer } = await askGemini(question, { options: getAskOptions(settings.ask) });
      await interaction.editReply({ content: answer, allowedMentions: { parse: [] } });
    } catch (error) {
      console.warn('[ask]', error?.code || error?.name || 'error', error?.status || '');
      await interaction.editReply({ content: describeAskError(error), allowedMentions: { parse: [] } });
    }
  }
};'''

new_ask = r'''const askTtsDependencies = {
  isOptedOut: isUserTtsOptedOut,
  getRuntimeVoiceChannelId,
  getAudioStatus,
  getVoice: getOrAssignTtsVoice,
  connect: connectToVoiceChannel,
  enqueue,
  cancel: cancelMessageAudio
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
    await interaction.deferReply();
    try {
      const { answer } = await askGemini(question, { options: getAskOptions(settings.ask) });
      const embed = buildAskEmbed(interaction, question, answer);
      await interaction.editReply({
        content: null,
        embeds: [embed],
        allowedMentions: ASK_ALLOWED_MENTIONS
      });
      void queueAskAnswerTts(interaction, answer, askTtsDependencies).catch((error) => {
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
};'''
commands = replace_once(commands, old_ask, new_ask, '/ask command block')
commands_path.write_text(commands, encoding='utf-8')

audio_path = Path('src/audio.js')
audio = audio_path.read_text(encoding='utf-8')
old_overflow = "  if (state.queue.length >= maximum) dropForQueueOverflow(guildId, state, maximum);"
new_overflow = "  if (state.queue.length >= maximum) {\n    if (metadata.rejectOnOverflow === true) {\n      cleanupCancelledQueuedItem(incoming);\n      return 'rejected-queue-full';\n    }\n    dropForQueueOverflow(guildId, state, maximum);\n  }"
audio = replace_once(audio, old_overflow, new_overflow, 'queue overflow line')
audio_path.write_text(audio, encoding='utf-8')

ask_path = Path('src/ask.js')
ask = ask_path.read_text(encoding='utf-8')
ask = replace_once(
    ask,
    'maxQuestionCharacters: Math.floor(clamp(finiteNumber(raw.maxQuestionCharacters, 1000), 50, 1800))',
    'maxQuestionCharacters: Math.floor(clamp(finiteNumber(raw.maxQuestionCharacters, 1000), 50, 1000))',
    'ask question clamp'
)
ask = replace_once(
    ask,
    'maxAnswerCharacters: Math.floor(clamp(finiteNumber(raw.maxAnswerCharacters, 450), 120, 1500))',
    'maxAnswerCharacters: Math.floor(clamp(finiteNumber(raw.maxAnswerCharacters, 450), 120, 1024))',
    'ask answer clamp'
)
ask = replace_once(
    ask,
    'const limit = Math.floor(clamp(finiteNumber(maxCharacters, 450), 120, 1500));',
    'const limit = Math.floor(clamp(finiteNumber(maxCharacters, 450), 120, 1024));',
    'answer compactor clamp'
)
ask = replace_once(
    ask,
    "  text = preview.slice(0, cut).trimEnd();\n  return `${text}…`;",
    "  text = preview.slice(0, cut).trimEnd();\n  const body = Array.from(text).slice(0, Math.max(1, limit - 1)).join('').trimEnd();\n  return `${body}…`;",
    'answer ellipsis cap'
)
ask_path.write_text(ask, encoding='utf-8')

config_path = Path('src/config.js')
config = config_path.read_text(encoding='utf-8')
config = replace_once(
    config,
    'maxQuestionCharacters: clampInt(ask.maxQuestionCharacters, defaults.ask.maxQuestionCharacters, 50, 1800)',
    'maxQuestionCharacters: clampInt(ask.maxQuestionCharacters, defaults.ask.maxQuestionCharacters, 50, 1000)',
    'config question clamp'
)
config = replace_once(
    config,
    'maxAnswerCharacters: clampInt(ask.maxAnswerCharacters, defaults.ask.maxAnswerCharacters, 120, 1500)',
    'maxAnswerCharacters: clampInt(ask.maxAnswerCharacters, defaults.ask.maxAnswerCharacters, 120, 1024)',
    'config answer clamp'
)
config_path.write_text(config, encoding='utf-8')

test_path = Path('test/ask-command.test.js')
tests = test_path.read_text(encoding='utf-8')
tests = replace_once(
    tests,
    "import assert from 'node:assert/strict';",
    "import assert from 'node:assert/strict';\nimport { ChannelType } from 'discord.js';\nimport { ASK_ALLOWED_MENTIONS, buildAskEmbed, buildAskTtsItem, queueAskAnswerTts } from '../src/ask-response.js';",
    'ask test imports'
)
tests += r'''

test('/ask embed uses display name, exact question, and exact generated answer', () => {
  const interaction = {
    member: { displayName: 'MrEz' },
    user: { username: 'fallback-user' }
  };
  const embed = buildAskEmbed(interaction, 'apa beza ram dengan storage?', 'RAM sementara. Storage kekal.').toJSON();
  assert.equal(embed.title, 'MrEz ask');
  assert.deepEqual(embed.fields, [
    { name: 'Question', value: 'apa beza ram dengan storage?', inline: false },
    { name: 'AI reply', value: 'RAM sementara. Storage kekal.', inline: false }
  ]);
});

test('/ask reply disables all Discord mention parsing', () => {
  assert.deepEqual(ASK_ALLOWED_MENTIONS, { parse: [], users: [], roles: [], repliedUser: false });
});

test('/ask TTS item contains only the generated answer and a synthetic interaction id', () => {
  const interaction = { id: 'interaction-7', createdTimestamp: 1234, user: { id: 'user-1' } };
  const voiceChannel = { id: 'voice-1' };
  const item = buildAskTtsItem(interaction, 'Jawapan sahaja.', voiceChannel, 'Charon');
  assert.equal(item.text, 'Jawapan sahaja.');
  assert.equal(item.metadata.messageId, 'ask:interaction-7');
  assert.equal(item.metadata.googleText, 'Jawapan sahaja.');
  assert.equal(item.metadata.verificationText, 'Jawapan sahaja.');
  assert.equal(item.metadata.speakerLabel, null);
  assert.equal(item.metadata.rejectOnOverflow, true);
  assert.equal('question' in item.metadata, false);
  assert.equal('isRecovery' in item.metadata, false);
});

test('/ask TTS queues only the answer in the asker voice channel', async () => {
  const calls = [];
  const voiceChannel = { id: 'voice-1', type: ChannelType.GuildVoice };
  const interaction = {
    id: 'interaction-8', guildId: 'guild-1', guild: { id: 'guild-1' },
    createdTimestamp: 5678, user: { id: 'user-1' }, member: { voice: { channel: voiceChannel } }
  };
  const status = await queueAskAnswerTts(interaction, 'AI answer only.', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => 'voice-1',
    getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    enqueue: (guildId, text, metadata) => { calls.push(['enqueue', guildId, text, metadata]); return 'started'; },
    connect: async (_guild, channel, options) => { calls.push(['connect', channel.id, options]); return { connection: {}, status: 'already-connected' }; },
    cancel: () => { throw new Error('cancel should not be called'); }
  });
  assert.equal(status, 'started');
  assert.equal(calls[0][0], 'enqueue');
  assert.equal(calls[0][2], 'AI answer only.');
  assert.equal(calls[0][3].voiceChannelId, 'voice-1');
  assert.equal(calls[0][3].googleText, 'AI answer only.');
  assert.equal(calls[0][3].verificationText, 'AI answer only.');
  assert.equal(calls[1][0], 'connect');
  assert.deepEqual(calls[1][2], { allowMove: false });
});

test('/ask TTS never moves to another active voice channel', async () => {
  let touched = false;
  const status = await queueAskAnswerTts({
    id: 'i', guildId: 'g', guild: {}, user: { id: 'u' },
    member: { voice: { channel: { id: 'voice-b', type: ChannelType.GuildVoice } } }
  }, 'answer', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => 'voice-a',
    getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    enqueue: () => { touched = true; },
    connect: async () => { touched = true; },
    cancel: () => { touched = true; }
  });
  assert.equal(status, 'other-channel');
  assert.equal(touched, false);
});

test('/ask text response remains independent when voice connection fails', async () => {
  const cancelled = [];
  const voiceChannel = { id: 'voice-1', type: ChannelType.GuildVoice };
  const interaction = {
    id: 'interaction-9', guildId: 'guild-1', guild: {}, user: { id: 'user-1' },
    member: { voice: { channel: voiceChannel } }
  };
  const status = await queueAskAnswerTts(interaction, 'Still visible in the embed.', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => null,
    getAudioStatus: () => ({ queued: 0, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    enqueue: () => 'prefetching-for-voice',
    connect: async () => ({ connection: null, status: 'voice-unavailable' }),
    cancel: (guildId, messageId) => cancelled.push([guildId, messageId])
  });
  assert.equal(status, 'voice-unavailable');
  assert.deepEqual(cancelled, [['guild-1', 'ask:interaction-9']]);
});

test('/ask queue overflow is rejected without displacing existing audio', async () => {
  let touched = false;
  const status = await queueAskAnswerTts({
    id: 'i', guildId: 'g', guild: {}, user: { id: 'u' },
    member: { voice: { channel: { id: 'v', type: ChannelType.GuildVoice } } }
  }, 'answer', {
    isOptedOut: () => false,
    getRuntimeVoiceChannelId: () => 'v',
    getAudioStatus: () => ({ queued: 10, maximumQueued: 10 }),
    getVoice: () => 'Charon',
    enqueue: () => { touched = true; },
    connect: async () => { touched = true; },
    cancel: () => { touched = true; }
  });
  assert.equal(status, 'queue-full');
  assert.equal(touched, false);
});

test('/ask command posts the embed before detached TTS and normal MessageCreate ignores bot output', () => {
  const commandsSource = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const embedReply = commandsSource.indexOf("await interaction.editReply({\n        content: null,\n        embeds: [embed]");
  const detachedTts = commandsSource.indexOf('void queueAskAnswerTts(interaction, answer, askTtsDependencies)');
  assert.ok(embedReply >= 0 && detachedTts > embedReply);
  assert.match(commandsSource, /allowedMentions: ASK_ALLOWED_MENTIONS/u);
  assert.match(indexSource, /message\.author\.bot \|\| message\.webhookId/u);
});

test('/ask limits align with Discord embed field limits and include ellipsis inside the cap', () => {
  const limited = getAskOptions({ maxQuestionCharacters: 1800, maxAnswerCharacters: 1500 });
  assert.equal(limited.maxQuestionCharacters, 1000);
  assert.equal(limited.maxAnswerCharacters, 1024);
  const compact = compactAskAnswer('A'.repeat(1400), 1024);
  assert.ok(Array.from(compact).length <= 1024);
  assert.match(compact, /…$/u);
});
'''
test_path.write_text(tests, encoding='utf-8')

readme_path = Path('README.md')
readme = readme_path.read_text(encoding='utf-8')
old_readme = "Use `/ask question:<text>` when you intentionally want an AI answer instead of read-aloud TTS. It uses `gemini-3.1-flash-lite` with minimal thinking and returns one compact public Discord message, normally 1–3 short sentences. It does not request images, embeds, tables, or long article-style output. Bot-authored `/ask` replies are ignored by the normal TTS message handler.\n\n`/ask` uses the existing Gemini key selection and makes only one Gemini request per command. A quota failure does not hop to another key inside the same `/ask` request."
new_readme = "Use `/ask question:<text>` when you intentionally want an AI answer. It uses `gemini-3.1-flash-lite` with minimal thinking and returns one compact public Discord embed, normally 1–3 short sentences. The embed title is `<display name> ask` and contains **Question** and **AI reply** fields. The model itself still cannot request images, embeds, tables, or long article-style output.\n\nAfter the embed is posted, the same AI reply is also queued through the normal TTS provider chain when the asker is in the active normal voice channel. Only the AI answer is spoken: not the username, title, question, or field labels. `/ttsoptout`, voice-channel ownership, queue limits, and normal Live-first read-aloud safeguards still apply. TTS failure never removes the already-posted answer. Bot-authored `/ask` replies are ignored by the normal MessageCreate TTS handler.\n\n`/ask` uses the existing Gemini key selection and makes only one text-generation request per command. A quota failure does not hop to another key inside the same `/ask` request; speaking the resulting answer uses the normal TTS provider chain."
readme = replace_once(readme, old_readme, new_readme, 'README /ask section')
readme_path.write_text(readme, encoding='utf-8')

package_path = Path('package.json')
package = package_path.read_text(encoding='utf-8')
package = replace_once(package, '"version": "0.23.13"', '"version": "0.23.14"', 'package version')
package_path.write_text(package, encoding='utf-8')

lock_path = Path('package-lock.json')
lock = lock_path.read_text(encoding='utf-8')
if lock.count('"version": "0.23.13"') < 2:
    raise SystemExit('Expected two package-lock version entries')
lock = lock.replace('"version": "0.23.13"', '"version": "0.23.14"', 2)
lock_path.write_text(lock, encoding='utf-8')

release = '''Malay TTS Bot v0.23.14 — /ask Embed + Spoken Reply

Main change
- Successful `/ask question:<text>` responses now appear as one compact public Discord embed.
- The embed title uses the member display name when available and contains `Question` and `AI reply` fields.
- The exact same Gemini answer is queued for speech after the embed is posted.
- TTS speaks only the AI answer; it does not speak the username, title, question, or field labels.

Safety and reliability
- Message mention parsing is disabled for `/ask` replies, preventing user/Gemini text from pinging everyone, roles, or users.
- `/ask` TTS respects `/ttsoptout` and never moves the bot away from an already-active voice channel.
- A synthetic `ask:<interaction id>` queue identity allows cancellation/recovery without requiring a normal Discord message ID.
- `/ask` queue overflow is rejected rather than displacing an existing waiting TTS item.
- Voice/TTS failure is independent from the text answer: the embed remains posted.
- Bot-authored interaction replies remain ignored by MessageCreate TTS.

Provider behavior
- `/ask` still makes one Gemini text-generation request using `gemini-3.1-flash-lite` with minimal thinking.
- Spoken `/ask` answers use the existing normal TTS chain: Gemini 3.1 Live, Gemini 2.5 Live, Gemini 3.1 TTS, then Google Malay fallback.
- Existing strict read-aloud boundaries remain in force so Gemini Live reads the generated answer instead of answering or expanding it.

Configuration
- Existing `config/settings.json` files remain compatible.
- Default `/ask` settings remain enabled, 8 s timeout, 1000-character question cap, 160 output tokens, 450-character answer cap, temperature 0.35, and minimal thinking.
- Configured question/answer hard caps are constrained to Discord field limits so successful embeds show the exact generated content without truncation.

Upgrade
Preserve `.env` and `data\\guilds.json`. Existing `config/settings.json` remains compatible. Run `setup-clean.cmd` after replacing the application files so `/ask` is deployed/updated.
'''
Path('RELEASE-v0.23.14.txt').write_text(release, encoding='utf-8')
