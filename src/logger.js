import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const logPath = path.join(rootDir, 'bot.log');
const oldLogPath = path.join(rootDir, 'bot-old.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const FLUSH_DELAY_MS = 75;

let installed = false;
let currentBytes = 0;
let pending = [];
let pendingBytes = 0;
let flushTimer = null;
let writeTail = Promise.resolve();

function initialSize() { try { return fs.statSync(logPath).size; } catch { return 0; } }
function render(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  return inspect(value, { depth: 4, breakLength: 160, compact: true });
}
function makeLine(level, args) { return `[${new Date().toISOString()}] [${level}] ${args.map(render).join(' ')}\n`; }

async function rotateAsync() {
  try { await fsp.rm(oldLogPath, { force: true }); } catch {}
  try { await fsp.rename(logPath, oldLogPath); } catch (error) { if (error?.code !== 'ENOENT') return false; }
  currentBytes = 0;
  return true;
}
function rotateSync() {
  try { fs.rmSync(oldLogPath, { force: true }); } catch {}
  try { fs.renameSync(logPath, oldLogPath); } catch (error) { if (error?.code !== 'ENOENT') return false; }
  currentBytes = 0;
  return true;
}

function enqueueLine(line) {
  const bytes = Buffer.byteLength(line, 'utf8');
  pending.push({ line, bytes });
  pendingBytes += bytes;
  while (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) {
    const dropped = pending.shift();
    pendingBytes -= dropped.bytes;
  }
  scheduleFlush();
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushLogs(); }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

export async function flushLogs() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pending.length) return writeTail;
  const batch = pending;
  pending = [];
  pendingBytes = 0;
  const text = batch.map((entry) => entry.line).join('');
  const bytes = Buffer.byteLength(text, 'utf8');
  writeTail = writeTail.then(async () => {
    try {
      if (currentBytes > 0 && currentBytes + bytes > MAX_LOG_BYTES) await rotateAsync();
      await fsp.appendFile(logPath, text, 'utf8');
      currentBytes += bytes;
    } catch {}
  });
  return writeTail;
}

export function fatalLogSync(...args) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const queued = pending.map((entry) => entry.line).join('');
  pending = [];
  pendingBytes = 0;
  const fatal = makeLine('FATAL', args);
  const text = queued + fatal;
  const bytes = Buffer.byteLength(text, 'utf8');
  try {
    if (currentBytes > 0 && currentBytes + bytes > MAX_LOG_BYTES) rotateSync();
    fs.appendFileSync(logPath, text, 'utf8');
    currentBytes += bytes;
  } catch {}
}

export function installLogger() {
  if (installed) return;
  installed = true;
  currentBytes = initialSize();
  if (currentBytes >= MAX_LOG_BYTES) rotateSync();
  for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[name].bind(console);
    console[name] = (...args) => { original(...args); enqueueLine(makeLine(level, args)); };
  }
}
