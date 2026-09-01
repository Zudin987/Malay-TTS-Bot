import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { ASK_ALLOWED_MENTIONS, buildAskEmbed, buildAskTtsItem, queueAskAnswerTts } from '../src/ask-response.js';
import {
  AskError,
  askGemini,
  buildAskRequest,
  compactAskAnswer,
  describeAskError,
  getAskOptions
} from '../src/ask.js';

const options = getAskOptions({
  enabled: true,
  model: 'gemini-3.1-flash-lite',
  timeoutMs: 5000,
  maxQuestionCharacters: 1000,
  maxOutputTokens: 160,
  maxAnswerCharacters: 450,
  temperature: 0.35,
  thinkingLevel: 'minimal'
});

test('/ask registration is present without loading Discord config', () => {
  const source = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  assert.match(source, /\.setName\('ask'\)/u);
  assert.match(source, /\.setName\('question'\)/u);
  assert.match(source, /askCommand,/u);
});

test('ask request is text-only, concise, and minimal-thinking', () => {
  const request = buildAskRequest('apa beza RAM dengan storage?', options);
  assert.equal(request.contents[0].parts[0].text, 'apa beza RAM dengan storage?');
  assert.equal(request.generationConfig.responseMimeType, 'text/plain');
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(request.generationConfig.maxOutputTokens, 160);
  assert.equal('tools' in request, false);
  assert.match(request.systemInstruction.parts[0].text, /one to three short sentences/i);
  assert.match(request.systemInstruction.parts[0].text, /Do not generate or request images/i);
});

test('ask answer compaction removes article/list/image formatting', () => {
  const source = '# Answer\n- First point\n- Second point\n![pic](https://example.com/a.png)\nDone.';
  assert.equal(compactAskAnswer(source, 450), 'Answer First point Second point Done.');
});

test('ask answer hard cap prefers a clean boundary', () => {
  const source = `${'A'.repeat(90)}. ${'B'.repeat(120)}. ${'C'.repeat(120)}.`;
  const compact = compactAskAnswer(source, 120);
  assert.ok(Array.from(compact).length <= 121);
  assert.match(compact, /…$/u);
});

test('askGemini makes one request and returns compact text', async () => {
  let calls = 0;
  let captured = null;
  const fetchImpl = async (url, init) => {
    calls += 1;
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: 'RAM is temporary working memory. Storage keeps files long-term.' }] } }] };
      }
    };
  };
  const result = await askGemini('RAM vs storage?', {
    fetchImpl,
    keyEntry: { slot: 2, key: 'test-key' },
    options
  });
  assert.equal(calls, 1);
  assert.match(captured.url, /gemini-3\.1-flash-lite:generateContent$/u);
  assert.equal(captured.init.headers['x-goog-api-key'], 'test-key');
  assert.equal(result.keySlot, 2);
  assert.equal(result.answer, 'RAM is temporary working memory. Storage keeps files long-term.');
});

test('quota failure does not retry another key inside /ask', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      async json() { return { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }; }
    };
  };
  await assert.rejects(
    askGemini('hello?', { fetchImpl, keyEntry: { slot: 1, key: 'test-key' }, options }),
    (error) => error instanceof AskError && error.code === 'quota'
  );
  assert.equal(calls, 1);
  assert.equal(describeAskError(new AskError('quota', 'x')), 'Gemini is rate-limited right now. Try again later.');
});


test('config normalization retains the /ask settings block', () => {
  const source = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(source, /const ask = isObject\(parsed\.ask\)/u);
  assert.match(source, /model: String\(ask\.model/u);
  assert.match(source, /maxAnswerCharacters: clampInt\(ask\.maxAnswerCharacters/u);
});


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
