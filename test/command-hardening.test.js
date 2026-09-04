import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.GEMINI_API_KEY ||= 'test-gemini-key';

const { __test } = await import('../src/commands.js');

function joinFixture() {
  const replies = [];
  const channel = { id: 'voice-b', name: 'Voice B', type: ChannelType.GuildVoice };
  const interaction = {
    guildId: 'join-guild', member: { voice: { channel } },
    guild: { channels: { cache: new Map([['voice-a', { id: 'voice-a', name: 'Voice A' }]]) } },
    deferReply: async () => {},
    editReply: async (value) => replies.push(value)
  };
  return { interaction, replies };
}

test('/join reports the existing channel when a concurrent different-channel move is rejected', async () => {
  const { interaction, replies } = joinFixture();
  await __test.joinCommand.execute(interaction, {
    connect: async (_guild, channel, options) => {
      assert.equal(channel.id, 'voice-b');
      assert.deepEqual(options, { allowMove: true });
      return { connection: null, status: 'busy-other-channel' };
    },
    getChannelId: () => 'voice-a'
  });
  assert.match(replies[0], /Voice A/u);
  assert.doesNotMatch(replies[0], /^Joined/u);
});

test('/join reports success only after the requested channel is confirmed', async () => {
  const { interaction, replies } = joinFixture();
  await __test.joinCommand.execute(interaction, {
    connect: async () => ({ connection: {}, status: 'connected' }),
    getChannelId: () => 'voice-b'
  });
  assert.equal(replies[0], 'Joined **Voice B**.');
});

test('privacy, guild-deletion and guarded-settings contracts remain wired', () => {
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const config = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(commands, /display name or TTS alias is sent separately to Google Malay/u);
  assert.match(commands, /cached locally per user/u);
  assert.match(commands, /question you explicitly submit is sent to the configured Gemini text model/u);
  assert.match(commands, /purgeSpeakerLabelCacheForOwner/u);
  assert.match(index, /Events\.GuildDelete[\s\S]*deleteGuildSettings\(guild\.id\)/u);
  assert.match(index, /gracefulShutdown[\s\S]*flushStore\(\)/u);
  assert.doesNotMatch(config, /watchFile\(settingsPath/u);
});

