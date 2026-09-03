import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

process.env.DISCORD_TOKEN ||= 'test-token';

const configModule = await import('../src/config.js');

test('settings normalization drops obsolete speech/replay controls and matches audio hard maximum', () => {
  const normalized = configModule.__test.normalizeSettings({
    videoPhrase: 'old video',
    gifPhrase: 'old gif',
    filePhrase: 'old file',
    linkPhrase: 'old link',
    audioPipeline: {
      transcriptReplayEnabled: true,
      durationReplayEnabled: true,
      playbackHardMaxMs: 90000
    }
  });

  for (const key of ['videoPhrase', 'gifPhrase', 'filePhrase', 'linkPhrase']) {
    assert.equal(Object.hasOwn(normalized, key), false, key);
  }
  assert.equal(Object.hasOwn(normalized.audioPipeline, 'transcriptReplayEnabled'), false);
  assert.equal(Object.hasOwn(normalized.audioPipeline, 'durationReplayEnabled'), false);
  assert.equal(normalized.audioPipeline.playbackHardMaxMs, 60000);
});

test('shipped settings contain only the active image media phrase', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));
  assert.equal(shipped.imagePhrase, 'hantar gambar');
  for (const key of ['videoPhrase', 'gifPhrase', 'filePhrase', 'linkPhrase']) assert.equal(Object.hasOwn(shipped, key), false, key);
  assert.equal(Object.hasOwn(shipped.audioPipeline, 'transcriptReplayEnabled'), false);
  assert.equal(Object.hasOwn(shipped.audioPipeline, 'durationReplayEnabled'), false);
});

test('runtime config starts without DISCORD_CLIENT_ID while deploy still guards it', () => {
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { config } from ${JSON.stringify(configUrl)}; console.log(config.clientId === null ? 'optional' : 'present');`], {
    encoding: 'utf8',
    env: { ...process.env, DISCORD_TOKEN: 'test-token', DISCORD_CLIENT_ID: '' },
    timeout: 5000
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /optional/);

  const deploy = fs.readFileSync(new URL('../deploy-commands.js', import.meta.url), 'utf8');
  assert.match(deploy, /if \(!config\.clientId\)/);
  assert.match(deploy, /slash-command deployment requires/iu);
});

test('missing settings startup path warns before defaults make settings non-empty', () => {
  const source = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(source, /const wasInitialized = Object\.keys\(settings\)\.length > 0;/);
  assert.match(source, /if \(wasPresent \|\| !wasInitialized\) console\.warn/);
});
