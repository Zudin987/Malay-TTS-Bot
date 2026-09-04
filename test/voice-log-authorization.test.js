import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.GEMINI_API_KEY ||= 'test-gemini-key';

const { clearVoiceLogForDeletedChannel, sendVoiceStateLog } = await import('../src/voice-log.js');

function fixture(fetchMember) {
  const guild = {
    id: 'voice-log-guild', name: 'Private Guild',
    members: { fetch: fetchMember }
  };
  const eventMember = { displayName: 'Listener', user: { id: 'listener', username: 'listener', bot: false } };
  return {
    oldState: { id: 'listener', guild, member: eventMember, channelId: null },
    newState: { id: 'listener', guild, member: eventMember, channelId: 'voice-1' }
  };
}

function enabledSettings() {
  return { voiceLogEnabled: true, voiceLogUserId: 'admin-user', voiceLogChannelId: 'voice-1' };
}

test('voice-log delivery reauthorizes current guild membership and Manage Guild permission', async () => {
  const deliveries = [];
  const { oldState, newState } = fixture(async (options) => {
    assert.deepEqual(options, { user: 'admin-user', force: true });
    return {
      permissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
      send: async (payload) => deliveries.push(payload)
    };
  });
  const settings = enabledSettings();
  await sendVoiceStateLog(null, oldState, newState, {
    getSettings: () => settings,
    updateSettings: () => assert.fail('Authorized subscriptions must remain enabled')
  });
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].content, /entered <#voice-1>/u);
});

test('voice-log role revocation disables and clears the persisted subscription', async () => {
  let delivered = false;
  const updates = [];
  const { oldState, newState } = fixture(async () => ({
    permissions: { has: () => false },
    send: async () => { delivered = true; }
  }));
  await sendVoiceStateLog(null, oldState, newState, {
    getSettings: enabledSettings,
    updateSettings: (guildId, patch) => updates.push([guildId, patch])
  });
  assert.equal(delivered, false);
  assert.deepEqual(updates, [['voice-log-guild', {
    voiceLogEnabled: false, voiceLogUserId: null, voiceLogChannelId: null
  }]]);
});

test('voice-log member departure fails closed even if the account remains reachable elsewhere', async () => {
  const updates = [];
  const { oldState, newState } = fixture(async () => { throw new Error('Unknown Member'); });
  await sendVoiceStateLog(null, oldState, newState, {
    getSettings: enabledSettings,
    updateSettings: (guildId, patch) => updates.push([guildId, patch])
  });
  assert.deepEqual(updates, [['voice-log-guild', {
    voiceLogEnabled: false, voiceLogUserId: null, voiceLogChannelId: null
  }]]);
});

test('voice-log never sends after settings change during authorization lookup', async () => {
  let finishLookup;
  let current = enabledSettings();
  let delivered = false;
  const { oldState, newState } = fixture(() => new Promise((resolve) => { finishLookup = resolve; }));
  const pending = sendVoiceStateLog(null, oldState, newState, {
    getSettings: () => current,
    updateSettings: () => assert.fail('No authorization failure occurred')
  });
  current = { ...current, voiceLogEnabled: false };
  finishLookup({
    permissions: { has: () => true },
    send: async () => { delivered = true; }
  });
  await pending;
  assert.equal(delivered, false);
});

test('a Discord DM failure does not revoke an otherwise authorized subscription', async () => {
  let updates = 0;
  const { oldState, newState } = fixture(async () => ({
    permissions: { has: () => true },
    send: async () => { throw new Error('DMs disabled'); }
  }));
  await sendVoiceStateLog(null, oldState, newState, {
    getSettings: enabledSettings,
    updateSettings: () => { updates += 1; }
  });
  assert.equal(updates, 0);
});

test('voice-log ignores events outside the configured channel before recipient lookup', async () => {
  let fetched = false;
  const { oldState, newState } = fixture(async () => { fetched = true; });
  await sendVoiceStateLog(null, oldState, newState, {
    getSettings: () => ({ ...enabledSettings(), voiceLogChannelId: 'deleted-or-other-channel' }),
    updateSettings: () => {}
  });
  assert.equal(fetched, false);
});

test('deleting the configured voice channel clears its stale subscription', () => {
  const updates = [];
  const cleared = clearVoiceLogForDeletedChannel({ id: 'voice-1', guild: { id: 'voice-log-guild' } }, {
    getSettings: enabledSettings,
    updateSettings: (guildId, patch) => updates.push([guildId, patch])
  });
  assert.equal(cleared, true);
  assert.deepEqual(updates, [['voice-log-guild', {
    voiceLogEnabled: false, voiceLogUserId: null, voiceLogChannelId: null
  }]]);
});
