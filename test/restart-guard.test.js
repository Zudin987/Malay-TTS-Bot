import test from 'node:test';
import assert from 'node:assert/strict';

const { getTtsRestartBlockers, describeTtsRestartBlockers } = await import('../src/restart-guard.js');

test('restart guard permits a globally idle runtime', () => {
  const blockers = getTtsRestartBlockers({
    guildIds: ['1', '2'],
    getAudioStatus: () => ({ playing: false, queued: 0 }),
    getProviderStatus: () => ({ geminiLimiter: { active: 0, queued: 0 } })
  });
  assert.equal(blockers.safe, true);
  assert.deepEqual(blockers.busyGuilds, []);
});

test('restart guard blocks when another guild is playing or queued', () => {
  const blockers = getTtsRestartBlockers({
    guildIds: ['1', '2', '2'],
    getAudioStatus: (guildId) => guildId === '2'
      ? { playing: true, queued: 3 }
      : { playing: false, queued: 0 },
    getProviderStatus: () => ({ geminiLimiter: { active: 0, queued: 0 } })
  });
  assert.equal(blockers.safe, false);
  assert.deepEqual(blockers.busyGuilds, [{ guildId: '2', playing: true, queued: 3 }]);
  assert.match(describeTtsRestartBlockers(blockers), /1 guild queue\(s\) busy/);
  assert.match(describeTtsRestartBlockers(blockers), /3 queued/);
});

test('restart guard blocks while process-global Gemini work is active or waiting', () => {
  const blockers = getTtsRestartBlockers({
    guildIds: ['1'],
    getAudioStatus: () => ({ playing: false, queued: 0 }),
    getProviderStatus: () => ({ geminiLimiter: { active: 2, queued: 1 } })
  });
  assert.equal(blockers.safe, false);
  assert.equal(blockers.providerActive, 2);
  assert.equal(blockers.providerQueued, 1);
  assert.match(describeTtsRestartBlockers(blockers), /Gemini work 2 active • 1 waiting/);
});
