import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readInstanceRecord, requestInstanceControl } from '../src/single-instance.js';
import { stopBot } from '../src/stop-bot.js';

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-owner-'));
  await fs.mkdir(path.join(directory, 'data'));
  const children = [];
  t.after(async () => {
    for (const entry of children) if (entry.child.exitCode == null && entry.child.signalCode == null) entry.child.kill('SIGKILL');
    await Promise.allSettled(children.map((entry) => entry.closed));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, async start(mode = 'plain') {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/instance-worker.mjs', import.meta.url)), directory, mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child, closed: new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))) };
    children.push(entry);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    let timer;
    const status = await new Promise((resolve, reject) => {
      let stdout = '';
      timer = setTimeout(() => reject(new Error(`Worker did not start: ${stderr}`)), 10000);
      child.once('error', reject);
      child.stdout.on('data', (data) => { stdout += data; if (stdout.includes('\n')) resolve(stdout.trim().split('\n').at(-1)); });
      child.once('close', (code) => { if (!stdout) reject(new Error(`Worker exited ${code}: ${stderr}`)); });
    }).finally(() => clearTimeout(timer));
    return { ...entry, status };
  } };
}

test('real concurrent processes elect exactly one owner despite an empty stale record', { timeout: 15000 }, async (t) => {
  const h = await harness(t);
  await fs.writeFile(path.join(h.directory, 'data', 'bot.lock'), '');
  const contenders = await Promise.all(Array.from({ length: 6 }, () => h.start()));
  assert.equal(contenders.filter((entry) => entry.status === 'ready').length, 1);
  assert.equal(contenders.filter((entry) => entry.status === 'busy').length, 5);
  const owner = readInstanceRecord(h.directory);
  assert.equal((await requestInstanceControl(owner, { directory: h.directory })).pid, owner.pid);
  assert.equal((await stopBot({ directory: h.directory })).code, 0);
  assert.equal(readInstanceRecord(h.directory), null);
});

test('a crashed owner is replaced without trusting stale PIDs and old nonces cannot stop the new process', { timeout: 15000 }, async (t) => {
  const h = await harness(t);
  // A legacy record pointing at this test process must never cause it to be killed.
  await fs.writeFile(path.join(h.directory, 'data', 'bot.lock'), JSON.stringify({ pid: process.pid, nonce: 'legacy' }));
  const first = await h.start();
  assert.equal(first.status, 'ready');
  const old = readInstanceRecord(h.directory);
  first.child.kill('SIGKILL'); await first.closed;
  assert.equal(readInstanceRecord(h.directory).nonce, old.nonce);
  const second = await h.start(); assert.equal(second.status, 'ready');
  const current = readInstanceRecord(h.directory);
  assert.notEqual(current.nonce, old.nonce);
  await assert.rejects(requestInstanceControl(old, { directory: h.directory, action: 'stop' }), { code: 'INSTANCE_CHANGED' });
  await assert.rejects(requestInstanceControl({ ...current, pid: process.pid }, { directory: h.directory, action: 'stop' }), { code: 'INSTANCE_CHANGED' });
  assert.equal((await requestInstanceControl(current, { directory: h.directory })).stopping, false);
  assert.equal((await stopBot({ directory: h.directory })).code, 0);
});

test('stop control is reachable while the real bootstrap waits indefinitely for login', { timeout: 15000 }, async (t) => {
  const h = await harness(t);
  const worker = await h.start('startup');
  assert.equal(worker.status, 'ready');
  assert.equal((await stopBot({ directory: h.directory })).code, 0);
  assert.equal((await worker.closed).code, 0);
  assert.equal(readInstanceRecord(h.directory), null);
});
