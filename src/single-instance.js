import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const lockPath = path.join(rootDir, 'data', 'bot.lock');
let ownsLock = false;
let ownedNonce = null;

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function normalizeExecutable(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function currentProcessStartMs() {
  return Math.round(Date.now() - process.uptime() * 1000);
}

function parseLockData(raw) {
  try {
    const data = JSON.parse(raw);
    return {
      pid: Number(data?.pid),
      execPath: normalizeExecutable(data?.execPath),
      processStartMs: Number(data?.processStartMs),
      nonce: typeof data?.nonce === 'string' ? data.nonce : null,
      raw
    };
  } catch {
    // Preserve the raw record even when JSON is corrupt so a stable corrupt
    // stale lock can still be compared byte-for-byte and safely removed.
    return { pid: NaN, execPath: null, processStartMs: NaN, nonce: null, raw };
  }
}

function readLockData() {
  try {
    return parseLockData(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return { pid: NaN, execPath: null, processStartMs: NaN, nonce: null, raw: null };
  }
}

function lockRecordUnchanged(before, after) {
  return typeof before?.raw === 'string' && before.raw.length > 0 && before.raw === after?.raw;
}

function windowsProcessIdentity(pid) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $start=[DateTimeOffset]$p.StartTime.ToUniversalTime(); [pscustomobject]@{Path=$p.Path;StartMs=$start.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 2500
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    return { execPath: normalizeExecutable(parsed.Path), processStartMs: Number(parsed.StartMs) };
  } catch { return null; }
}

function posixProcessIdentity(pid) {
  try {
    const execPath = normalizeExecutable(fs.readlinkSync(`/proc/${pid}/exe`));
    // Linux proc start-time conversion is intentionally not guessed here; the
    // executable identity still prevents the common unrelated-PID reuse case.
    return { execPath, processStartMs: NaN };
  } catch { return null; }
}

function processIdentity(pid) {
  return process.platform === 'win32' ? windowsProcessIdentity(pid) : posixProcessIdentity(pid);
}

function lockBelongsToLiveBot(lock) {
  if (!processIsRunning(lock.pid)) return false;
  const identity = processIdentity(lock.pid);
  if (!identity) return true; // Conservative when OS inspection is unavailable.

  if (lock.execPath && identity.execPath && lock.execPath !== identity.execPath) return false;
  if (Number.isFinite(lock.processStartMs) && Number.isFinite(identity.processStartMs)) {
    if (Math.abs(lock.processStartMs - identity.processStartMs) > 5000) return false;
  }
  return true;
}

export function acquireSingleInstanceLock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // A third attempt gives a concurrent starter one chance to replace a stale
  // lock while we re-check it without either process deleting the other's new
  // lock file.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const nonce = randomUUID();
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          processStartMs: currentProcessStartMs(),
          execPath: path.resolve(process.execPath),
          nonce
        })}\n`, 'utf8');
        fs.fsyncSync(fd);
      } catch (writeError) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
        throw writeError;
      }
      fs.closeSync(fd);

      ownedNonce = nonce;
      ownsLock = true;
      process.once('exit', releaseSingleInstanceLock);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLockData();
      if (lockBelongsToLiveBot(existing)) return false;

      // Close the stale-lock TOCTOU window: another bot may have removed the
      // stale record and acquired its own lock while we were inspecting the old
      // PID. Delete only if the exact file contents are still the record we
      // classified as stale.
      const confirmed = readLockData();
      if (!lockRecordUnchanged(existing, confirmed)) continue;

      try { fs.unlinkSync(lockPath); }
      catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return false;
}

export function releaseSingleInstanceLock() {
  if (!ownsLock) return;
  ownsLock = false;
  try {
    const data = readLockData();
    if (data.pid === process.pid && data.nonce === ownedNonce) fs.unlinkSync(lockPath);
  } catch {}
  ownedNonce = null;
}

export const __test = { normalizeExecutable, lockBelongsToLiveBot, lockRecordUnchanged, parseLockData };
