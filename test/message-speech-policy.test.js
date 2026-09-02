import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';

const { buildSpeakableMessage, sanitizeSpeechContent } = await import('../src/message-speech-policy.js');
const { prepareSpeechVariants } = await import('../src/preprocess.js');
const { settings } = await import('../src/config.js');

const guildSettings = { speakerMode: 'username', speakerResetSeconds: 60 };

function makeMessage({ content = '', attachments = [], embeds = [] } = {}) {
  const member = { id: '222222222222222222', displayName: 'Target User' };
  const role = { id: '333333333333333333', name: 'Raiders' };
  const channel = { id: '444444444444444444', name: 'general' };
  const guild = {
    id: '111111111111111111',
    members: { cache: new Map([[member.id, member]]) },
    roles: { cache: new Map([[role.id, role]]) },
    channels: { cache: new Map([[channel.id, channel]]) },
    client: { users: { cache: new Map() } }
  };

  return {
    content,
    attachments: new Map(attachments.map((attachment, index) => [String(index), attachment])),
    embeds,
    guild,
    mentions: {
      members: new Map([[member.id, member]]),
      users: new Map()
    },
    member: { displayName: 'Sender' },
    author: { id: '555555555555555555', globalName: 'Sender', username: 'sender' }
  };
}

function prepared(message) {
  const speakable = buildSpeakableMessage(message);
  return speakable ? prepareSpeechVariants(speakable, guildSettings) : null;
}

test('normal chat stays speakable while links and emoji beside it are silent', () => {
  const message = makeMessage({
    content: 'hello 😄 https://example.com <:wave:123456789012345678>',
    attachments: [
      { name: 'dance.gif', contentType: 'image/gif' },
      { name: 'clip.mp4', contentType: 'video/mp4' },
      { name: 'notes.pdf', contentType: 'application/pdf' }
    ]
  });
  const speakable = buildSpeakableMessage(message);
  assert.ok(speakable);
  assert.equal(speakable.content, 'hello');
  assert.equal(speakable.attachments.size, 0);

  const speech = prepareSpeechVariants(speakable, guildSettings);
  assert.match(speech.geminiText, /^hello[.!?]?$/iu);
  assert.equal(speech.geminiText.includes(settings.linkPhrase), false);
  assert.equal(speech.geminiText.includes(settings.gifPhrase), false);
  assert.equal(speech.geminiText.includes(settings.videoPhrase), false);
  assert.equal(speech.geminiText.includes(settings.filePhrase), false);
});

test('link-only posts are completely skipped including masked and autolinks', () => {
  for (const content of [
    'https://example.com/test',
    '<https://example.com/test>',
    '[example](https://example.com/test)',
    'discord.gg/example'
  ]) {
    assert.equal(buildSpeakableMessage(makeMessage({ content })), null, content);
  }
});

test('file GIF and video-only posts are completely skipped', () => {
  for (const attachment of [
    { name: 'archive.zip', contentType: 'application/zip' },
    { name: 'dance.gif', contentType: 'image/gif' },
    { name: 'clip.mp4', contentType: 'video/mp4' }
  ]) {
    assert.equal(buildSpeakableMessage(makeMessage({ attachments: [attachment] })), null, attachment.name);
  }
  assert.equal(buildSpeakableMessage(makeMessage({ embeds: [{ type: 'gifv', url: 'https://giphy.com/x' }] })), null);
  assert.equal(buildSpeakableMessage(makeMessage({ embeds: [{ type: 'video', video: { url: 'https://example.com/v.mp4' } }] })), null);
});

test('emoji-only posts are completely skipped for Unicode custom and text emoticons', () => {
  for (const content of ['😂', '❤️', '1️⃣', '<:wave:123456789012345678>', '<a:dance:123456789012345678>', ':)', ':D']) {
    assert.equal(buildSpeakableMessage(makeMessage({ content })), null, content);
  }
});

test('fenced code-only posts are not treated as normal chat', () => {
  assert.equal(buildSpeakableMessage(makeMessage({ content: '```js\nconsole.log("hi")\n```' })), null);
});

test('image-only posts still say hantar gambar', () => {
  const speech = prepared(makeMessage({ attachments: [{ name: 'photo.png', contentType: 'image/png' }] }));
  assert.ok(speech);
  assert.ok(speech.geminiText.includes(settings.imagePhrase));
  assert.ok(speech.googleText.includes(settings.imagePhrase));
});

test('normal text plus image reads the text and hantar gambar only', () => {
  const speech = prepared(makeMessage({
    content: 'tengok ni https://example.com',
    attachments: [
      { name: 'photo.webp', contentType: 'image/webp' },
      { name: 'clip.webm', contentType: 'video/webm' }
    ]
  }));
  assert.ok(speech);
  assert.ok(speech.geminiText.includes('tengok ni'));
  assert.ok(speech.geminiText.includes(settings.imagePhrase));
  assert.equal(speech.geminiText.includes(settings.videoPhrase), false);
  assert.equal(speech.geminiText.includes(settings.linkPhrase), false);
});

test('mention-only posts remain speakable and resolve the tagged name', () => {
  const speech = prepared(makeMessage({ content: '<@222222222222222222>' }));
  assert.ok(speech);
  assert.ok(speech.geminiText.includes('Target User'));
  assert.ok(speech.googleText.includes('Target User'));
});

test('sanitizer removes non-chat payloads without damaging nearby words', () => {
  assert.equal(sanitizeSpeechContent('aku hantar 😄 https://example.com sekarang'), 'aku hantar sekarang');
  assert.equal(sanitizeSpeechContent('weh [buka ni](https://example.com) bro'), 'weh bro');
});
