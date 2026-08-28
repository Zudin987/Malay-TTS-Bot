import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const lockPath = path.join(rootDir, 'data', 'bot.lock');
let ownsLock = false;

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

function readLockData() {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return {
      pid: Number(data?.pid),
      execPath: normalizeExecutable(data?.execPath),
      processStartMs: Number(data?.processStartMs)
    };
  } catch {
    return { pid: NaN, execPath: null, processStartMs: NaN };
  }
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          processStartMs: currentProcessStartMs(),
          execPath: path.resolve(process.execPath)
        })}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }

      ownsLock = true;
      process.once('exit', releaseSingleInstanceLock);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLockData();
      if (lockBelongsToLiveBot(existing)) return false;

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
    if (data.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

export const __test = { normalizeExecutable, lockBelongsToLiveBot };
