import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const defaultInstanceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ownedLease = null;

function normalizeExecutable(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function getInstanceEndpoint(directory = defaultInstanceDirectory) {
  const canonical = normalizeExecutable(fs.realpathSync(directory));
  const identity = createHash('sha256').update(canonical).digest('hex');
  // OS-owned local socket: no compare/unlink race, no polling, and automatic
  // release after a crash. A port collision fails closed without touching files.
  // https://nodejs.org/docs/latest-v24.x/api/net.html#serverlistenoptions-callback
  return { host: '127.0.0.1', port: 23000 + (Number.parseInt(identity.slice(0, 8), 16) % 16000), identity };
}

export function readInstanceRecord(directory = defaultInstanceDirectory) {
  let fd;
  try {
    fd = fs.openSync(path.join(directory, 'data', 'bot.lock'), 'r');
    const buffer = Buffer.alloc(4096);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    return Number.isInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string' && value.nonce.length <= 128 ? value : null;
  } catch { return null; }
  finally { if (fd != null) fs.closeSync(fd); }
}

export async function acquireSingleInstanceLock({ directory = defaultInstanceDirectory, onStopRequested = () => process.exit(0) } = {}) {
  const endpoint = getInstanceEndpoint(directory);
  const lockPath = path.join(directory, 'data', 'bot.lock');
  const sockets = new Set();
  const record = { pid: process.pid, nonce: randomUUID(), identity: endpoint.identity, port: endpoint.port,
    execPath: path.resolve(process.execPath), processStartMs: Math.round(Date.now() - process.uptime() * 1000) };
  let stopping = false;
  let released = false;
  let handler = onStopRequested;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(1500, () => socket.destroy());
    let input = '';
    let received = false;
    socket.on('data', (chunk) => {
      if (received) return;
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 4096) { received = true; socket.destroy(); return; }
      if (!input.includes('\n')) return;
      received = true;
      let request;
      try { request = JSON.parse(input.slice(0, input.indexOf('\n'))); } catch { socket.destroy(); return; }
      const matches = request.identity === record.identity && request.pid === record.pid && request.nonce === record.nonce;
      const valid = matches && ['status', 'stop'].includes(request.action);
      if (!valid) { socket.end(`${JSON.stringify({ ok: false })}\n`); return; }
      const shouldStop = request.action === 'stop' && !stopping;
      if (shouldStop) stopping = true;
      socket.end(`${JSON.stringify({ ok: true, pid: record.pid, nonce: record.nonce, stopping })}\n`, () => {
        if (shouldStop) setImmediate(() => Promise.resolve(handler()).catch((error) => { console.error('[control]', error); process.exit(1); }));
      });
    });
  });
  server.maxConnections = 4;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') return false;
    throw error;
  }
  server.on('error', (error) => { console.error('[instance-owner]', error); process.exit(1); });
  const removeOwnedRecord = () => {
    // Only the process holding the OS socket can publish or remove this record.
    // Remove it before releasing the socket so a new owner cannot be deleted.
    const current = readInstanceRecord(directory);
    if (current?.nonce === record.nonce && current.pid === record.pid) {
      try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') console.warn('[instance-record]', error.code); }
    }
  };
  const releaseSync = () => {
    if (released) return;
    released = true;
    removeOwnedRecord();
    for (const socket of sockets) socket.destroy();
    server.close();
    if (ownedLease === lease) ownedLease = null;
  };
  const lease = { record, setStopHandler(callback) { handler = callback; }, release: releaseSync };
  const tempPath = `${lockPath}.${record.nonce}.tmp`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, lockPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    releaseSync();
    throw error;
  }
  ownedLease = lease;
  process.once('exit', releaseSync);
  return lease;
}

export function releaseSingleInstanceLock() { ownedLease?.release(); }

export async function requestInstanceControl(record, { directory = defaultInstanceDirectory, action = 'status', timeoutMs = 1500 } = {}) {
  const endpoint = getInstanceEndpoint(directory);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let done = false;
    let input = '';
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Local bot control timed out.'), { code: 'CONTROL_TIMEOUT' })), timeoutMs);
    socket.once('error', (error) => finish(error));
    socket.once('end', () => finish(Object.assign(new Error('Bot owner closed its control connection.'), { code: 'ECONNRESET' })));
    socket.once('connect', () => socket.write(`${JSON.stringify({ identity: endpoint.identity, nonce: record?.nonce, pid: record?.pid, action })}\n`));
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (input.length > 4096) return finish(new Error('Invalid bot control response.'));
      if (!input.includes('\n')) return;
      try {
        const reply = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (!reply.ok || reply.pid !== record?.pid || reply.nonce !== record?.nonce) {
          return finish(Object.assign(new Error('Bot instance identity changed; no other process was stopped.'), { code: 'INSTANCE_CHANGED' }));
        }
        finish(null, reply);
      } catch (error) { finish(error); }
    });
  });
}

export const __test = { normalizeExecutable };
