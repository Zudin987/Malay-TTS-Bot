import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
process.env.DISCORD_TOKEN ||= 'test-token';
const voice = await import('../src/voice.js');

function fixture(id) {
  const channel = { id: 'voice', isVoiceBased: () => true, members: { filter: () => ({ size: 1 }) } };
  const guild = { id, channels: { cache: new Map([[channel.id, channel]]) } };
  const connection = new EventEmitter();
  connection.state = { status: 'disconnected' };
  connection.subscribe = () => ({});
  connection.destroy = () => { connection.state = { status: 'destroyed' }; };
  const state = voice.__test.stateFor(id);
  state.connection = connection;
  state.desiredChannelId = channel.id;
  return { guild, channel, connection, state };
}

test('connect never awaits recovery queued behind its own guild lock', { timeout: 2000 }, async () => {
  const f = fixture('lock-cycle');
  let unlock;
  const blocked = voice.__test.withGuildLock(f.guild.id, () => new Promise(resolve => { unlock = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const connecting = voice.connectToVoiceChannel(f.guild, f.channel);
  const recovering = voice.__test.scheduleRecovery(f.guild, f.channel.id, f.connection, f.state.epoch, 'fixture');
  unlock();
  await blocked;
  await new Promise(resolve => setImmediate(resolve));
  f.connection.state = { status: 'ready' };
  f.connection.emit('ready');
  const result = await connecting;
  assert.equal(result.status, 'recovered');
  assert.equal(await recovering, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(voice.__test.guildLocks.has(f.guild.id), false);
  voice.disconnectGuild(f.guild.id);
});

test('disconnect aborts readiness waits and retires state without recreating it through status', async () => {
  const f = fixture('disconnect-wait');
  const waiting = voice.__test.waitReady(f.connection, 20000, f.state.controller.signal);
  voice.disconnectGuild(f.guild.id);
  await assert.rejects(waiting, /disconnected/);
  assert.equal(f.connection.listenerCount('ready'), 0);
  assert.equal(voice.getRuntimeVoiceChannelId(f.guild.id), null);
  assert.equal(voice.isVoiceRecovering(f.guild.id), false);
  assert.equal(voice.__test.voiceStates.has(f.guild.id), false);
});

test('concurrent same-channel joins share one connection wait and report real readiness', async () => {
  const f = fixture('shared-join');
  const first = voice.connectToVoiceChannel(f.guild, f.channel);
  const second = voice.connectToVoiceChannel(f.guild, f.channel);
  assert.equal(first, second);
  assert.equal(voice.getVoiceRuntimeStatus(f.guild.id).phase, 'disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  f.connection.state = { status: 'ready' }; f.connection.emit('ready');
  await first;
  assert.equal(voice.getVoiceRuntimeStatus(f.guild.id).phase, 'ready');
  voice.disconnectGuild(f.guild.id);
});
