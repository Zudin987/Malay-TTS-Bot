import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;

export function redactLogText(value, env = process.env) {
  let text = String(value ?? '');
  const secrets = Object.entries(env)
    .filter(([name]) => /^(?:DISCORD_TOKEN|GEMINI_API_KEY(?:_\d+)?)$/u.test(name))
    .map(([, secret]) => String(secret || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text
    .replace(/([?&](?:key|api_key|token)=)[^&\s"'<>]+/giu, '$1[REDACTED]')
    .replace(/\b(Bearer|Bot)\s+[A-Za-z\d._~+\/-]{8,}=*/gu, '$1 [REDACTED]')
    .replace(/((?:x-goog-api-key|authorization|discord_token|gemini_api_key(?:_\d+)?)['"]?\s*[:=]\s*['"]?)[^\s,'"}\]]+/giu, '$1[REDACTED]');
}

function bounded(value, maxBytes) {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes ? value : `${bytes.subarray(0, maxBytes - 20).toString('utf8')} [truncated]\n`;
}

export function createLogger({ directory = rootDir, env = process.env, consoleImpl = console, fsImpl = fsp } = {}) {
  const logPath = path.join(directory, 'bot.log');
  const oldLogPath = path.join(directory, 'bot-old.log');
  let installed = false;
  let currentBytes = 0;
  let pending = [];
  let pendingBytes = 0;
  let inFlightBytes = 0;
  let dropped = 0;
  let timer = null;
  let writer = null;
  try { currentBytes = fs.statSync(logPath).size; } catch {}

  const render = (value) => {
    const raw = typeof value === 'string' ? value : value instanceof Error ? value.stack || value.message
      : inspect(value, { depth: 4, breakLength: 160, compact: true, maxArrayLength: 32, maxStringLength: MAX_ENTRY_BYTES, customInspect: false });
    return bounded(redactLogText(raw, env), MAX_ENTRY_BYTES);
  };
  const makeLine = (level, args) => bounded(`[${new Date().toISOString()}] [${level}] ${args.slice(0, 32).map(render).join(' ')}\n`, MAX_ENTRY_BYTES);
  const clearTimer = () => { clearTimeout(timer); timer = null; };

  async function rotate() {
    await fsImpl.rm(oldLogPath, { force: true });
    try { await fsImpl.rename(logPath, oldLogPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    currentBytes = 0;
  }
  function drain() {
    if (writer) return writer;
    clearTimer();
    writer = Promise.resolve().then(async () => {
      await fsImpl.mkdir?.(directory, { recursive: true });
      while (pending.length) {
        const batch = [];
        inFlightBytes = 0;
        while (pending.length && inFlightBytes + pending[0].bytes <= MAX_BATCH_BYTES) {
          const entry = pending.shift(); pendingBytes -= entry.bytes;
          inFlightBytes += entry.bytes; batch.push(entry.line);
        }
        try {
          if (currentBytes + inFlightBytes > MAX_LOG_BYTES) await rotate();
          await fsImpl.appendFile(logPath, batch.join(''), 'utf8');
          currentBytes += inFlightBytes;
        } catch { dropped += batch.length; }
        finally { inFlightBytes = 0; }
      }
    }).finally(() => { writer = null; if (pending.length) schedule(); });
    return writer;
  }
  function schedule() {
    if (timer || writer) return;
    timer = setTimeout(() => { timer = null; void drain(); }, 75);
    timer.unref?.();
  }
  function enqueue(line) {
    const bytes = Buffer.byteLength(line);
    pending.push({ line, bytes }); pendingBytes += bytes;
    // Include the active write in the same bound; a stalled filesystem cannot
    // move unlimited batches into a promise chain outside this accounting.
    while (pendingBytes + inFlightBytes > MAX_PENDING_BYTES && pending.length) {
      pendingBytes -= pending.shift().bytes; dropped += 1;
    }
    schedule();
  }
  return {
    install() {
      if (installed) return;
      installed = true;
      for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
        const original = consoleImpl[name].bind(consoleImpl);
        consoleImpl[name] = (...args) => {
          const line = makeLine(level, args);
          original(line.trimEnd());
          enqueue(line);
        };
      }
    },
    async flush({ timeoutMs = 1000 } = {}) {
      clearTimer();
      let deadline;
      try {
        return await Promise.race([drain().then(() => true), new Promise((resolve) => { deadline = setTimeout(() => resolve(false), timeoutMs); })]);
      } finally { clearTimeout(deadline); }
    },
    fatal(...args) {
      clearTimer();
      const text = pending.map((entry) => entry.line).join('') + makeLine('FATAL', args);
      pending = []; pendingBytes = 0;
      try {
        fs.mkdirSync(directory, { recursive: true });
        if (currentBytes + Buffer.byteLength(text) > MAX_LOG_BYTES) {
          fs.rmSync(oldLogPath, { force: true });
          try { fs.renameSync(logPath, oldLogPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
          currentBytes = 0;
        }
        fs.appendFileSync(logPath, text, 'utf8');
        currentBytes += Buffer.byteLength(text);
      } catch {}
    },
    status: () => ({ pendingBytes, inFlightBytes, dropped, writing: Boolean(writer), maximumBytes: MAX_PENDING_BYTES, maxEntryBytes: MAX_ENTRY_BYTES })
  };
}

const logger = createLogger({ directory: path.join(rootDir, 'data') });
export const installLogger = () => logger.install();
export const flushLogs = (options) => logger.flush(options);
export const fatalLogSync = (...args) => logger.fatal(...args);
