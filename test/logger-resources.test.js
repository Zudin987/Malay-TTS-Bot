import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';

test('console, asynchronous logs and fatal logs redact all ten keys and the Discord token', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { DISCORD_TOKEN: 'fake-discord-token-sensitive' };
  for (let slot = 1; slot <= 10; slot++) env[slot === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${slot}`] = `fake-sensitive-key-${slot}-end`;
  const output = [];
  const consoleImpl = Object.fromEntries(['log', 'warn', 'error'].map((name) => [name, (value) => output.push(value)]));
  const logger = createLogger({ directory, env, consoleImpl });
  logger.install();
  consoleImpl.error(new Error(`wss://example.test?key=${env.GEMINI_API_KEY}&other=1 ${Object.values(env).join(' ')}`));
  consoleImpl.warn('Authorization: Bearer unknown-long-token-value');
  assert.equal(await logger.flush(), true);
  logger.fatal('fatal', { nested: { token: env.DISCORD_TOKEN } });
  const file = await fs.readFile(path.join(directory, 'bot.log'), 'utf8');
  for (const value of [...Object.values(env), 'unknown-long-token-value']) {
    assert.ok(!file.includes(value)); assert.ok(!output.join('\n').includes(value));
  }
  assert.match(file, /REDACTED/);
});

test('a stalled log sink has one bounded write, bounded queued bytes and bounded shutdown', async () => {
  const consoleImpl = { log() {}, warn() {}, error() {} };
  let calls = 0;
  const logger = createLogger({ consoleImpl, fsImpl: { appendFile() { calls++; return new Promise(() => {}); } } });
  logger.install();
  consoleImpl.warn('A'.repeat(2 * 1024 * 1024));
  assert.equal(await logger.flush({ timeoutMs: 20 }), false);
  for (let i = 0; i < 100; i++) consoleImpl.warn('B'.repeat(20000));
  assert.equal(await logger.flush({ timeoutMs: 20 }), false);
  const status = logger.status();
  assert.equal(calls, 1);
  assert.ok(status.inFlightBytes <= status.maxEntryBytes);
  assert.ok(status.pendingBytes + status.inFlightBytes <= status.maximumBytes);
  assert.ok(status.dropped > 0);
});
