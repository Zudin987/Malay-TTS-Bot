import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDiscordDeployError } from '../src/deploy-errors.js';

test('Discord deploy 401 gives actionable token guidance without dumping request details', () => {
  const message = describeDiscordDeployError({
    status: 401,
    code: 0,
    rawError: { message: '401: Unauthorized' },
    requestBody: { token: 'should-never-appear' }
  }, { clientId: '123456', guildId: '654321' });

  assert.match(message, /DISCORD_TOKEN.*401 Unauthorized/u);
  assert.match(message, /Developer Portal > Bot/u);
  assert.match(message, /DISCORD_CLIENT_ID.*123456/u);
  assert.match(message, /deploy-commands\.cmd/u);
  assert.doesNotMatch(message, /should-never-appear/u);
});

test('Discord deploy 403 distinguishes authorization from bad authentication', () => {
  const message = describeDiscordDeployError({
    status: 403,
    rawError: { message: 'Missing Access' }
  }, { clientId: '123456', guildId: '654321' });

  assert.match(message, /authenticated.*403 Forbidden/u);
  assert.match(message, /same bot token/u);
  assert.match(message, /654321/u);
});

test('generic Discord deploy errors keep concise status and server detail', () => {
  const message = describeDiscordDeployError({
    status: 429,
    code: 20028,
    rawError: { message: 'Rate limited\nretry later' }
  });

  assert.equal(message, 'Discord command deployment failed HTTP 429 / code 20028: Rate limited retry later');
});
