import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
const { decodeAudioToSpeakerPcm } = await import('../src/speaker-label.js');

test('speaker-label FFmpeg decoder times out and terminates a wedged child', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stderr.setEncoding = () => child.stderr;
    child.kill = () => { killed = true; return true; };
    return child;
  };

  await assert.rejects(
    decodeAudioToSpeakerPcm(Buffer.from([1, 2, 3]), { spawnImpl, timeoutMs: 500 }),
    /timed out after 500ms/
  );
  assert.equal(killed, true);
});
