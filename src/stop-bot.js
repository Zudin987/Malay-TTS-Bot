import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const lockPath = path.join(dataDir, 'bot.lock');
const stopRequestPath = path.join(dataDir, 'stop.request');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockPid() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cleanupStaleFiles() {
  for (const target of [lockPath, stopRequestPath]) {
    try { fs.unlinkSync(target); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

const pid = readLockPid();
if (!pid || !processIsRunning(pid)) {
  try { cleanupStaleFiles(); } catch {}
  console.log('Malay TTS Bot is not running.');
  process.exit(2);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  stopRequestPath,
  `${JSON.stringify({ pid, requestedAt: new Date().toISOString() })}\n`,
  'utf8'
);

const deadline = Date.now() + 12_000;
while (Date.now() < deadline) {
  if (!processIsRunning(pid)) {
    try { fs.unlinkSync(stopRequestPath); } catch {}
    console.log('Malay TTS Bot stopped cleanly.');
    process.exit(0);
  }
  await sleep(100);
}

console.error('Timed out waiting for the bot to stop cleanly.');
console.error('If the bot is frozen, Task Manager can still be used as a fallback.');
process.exit(1);
