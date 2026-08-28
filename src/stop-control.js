import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
export const stopRequestPath = path.join(rootDir, 'data', 'stop.request');

function readStopRequest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stopRequestPath, 'utf8'));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? { ...parsed, pid } : null;
  } catch {
    return null;
  }
}

function removeStopRequest() {
  try { fs.unlinkSync(stopRequestPath); } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[control] Could not remove stop request:', error.message);
  }
}

export function startStopRequestWatcher(onStopRequested) {
  // A request is always tied to the PID that was running when stop-bot.vbs was
  // clicked. A stale request must never stop a later bot process.
  const stale = readStopRequest();
  if (stale && stale.pid !== process.pid) removeStopRequest();

  let handling = false;

  const check = () => {
    if (handling) return;
    const request = readStopRequest();
    if (!request || request.pid !== process.pid) return;

    handling = true;
    removeStopRequest();
    Promise.resolve(onStopRequested(request)).catch((error) => {
      handling = false;
      console.error('[control] Graceful stop request failed:', error);
    });
  };

  // watchFile is polling-based and reliable on Windows, including when the
  // request file does not exist yet. 500 ms adds no TTS-path latency.
  fs.watchFile(
    stopRequestPath,
    { interval: 500, persistent: false },
    (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      check();
    }
  );

  check();
  return () => fs.unwatchFile(stopRequestPath);
}
