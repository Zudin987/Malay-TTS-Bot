import { spawn } from 'node:child_process';

const children = new Set();
const closed = new WeakSet();
const stopping = new WeakMap();
const MAX_CHILDREN = 12;

export function spawnManagedProcess(command, args, options, spawnImpl = spawn) {
  if (children.size >= MAX_CHILDREN) throw new Error('Audio child-process limit reached; waiting for existing decoders to close.');
  const child = spawnImpl(command, args, options);
  children.add(child);
  child.once('close', () => { closed.add(child); children.delete(child); });
  return child;
}

export function terminateChild(child, { graceMs = 250, timeoutMs = 1000 } = {}) {
  if (!child || closed.has(child) || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  if (stopping.has(child)) return stopping.get(child);
  const result = new Promise((resolve) => {
    let done = false;
    let forceTimer;
    let deadlineTimer;
    const finish = (confirmed) => {
      if (done) return;
      done = true;
      clearTimeout(forceTimer); clearTimeout(deadlineTimer);
      child.removeListener?.('close', onClose);
      resolve(confirmed);
    };
    const onClose = () => { closed.add(child); children.delete(child); finish(true); };
    child.once?.('close', onClose);
    // child.killed means a signal was sent, not that the process exited.
    forceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, graceMs);
    deadlineTimer = setTimeout(() => finish(false), timeoutMs);
    forceTimer.unref?.(); deadlineTimer.unref?.();
    try { child.stdin?.destroy?.(); child.kill('SIGTERM'); } catch {}
  });
  stopping.set(child, result);
  return result;
}

export async function terminateAllChildren() {
  return Promise.all([...children].map((child) => terminateChild(child)));
}

export function getChildProcessStatus() { return { active: children.size, maximum: MAX_CHILDREN }; }
