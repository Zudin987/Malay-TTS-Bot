// Copied into the extracted package by the disposable Windows CI smoke test.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startBot } from '../src/bootstrap.js';
import { getGeminiApiKeyRoundRobinStatus, nextGeminiApiKey } from '../src/gemini-key-config.js';
import { readInstanceRecord } from '../src/single-instance.js';

const root = path.resolve(import.meta.dirname, '..');
assert.equal(process.cwd().toLowerCase(), root.toLowerCase());
const gracefulMode = fs.existsSync(path.join(root, 'data', 'ci-graceful-mode'));
await startBot({ directory: root, loadApp: async () => {
  const account = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  assert.match(account, /S-1-5-18/u);
  assert.equal(process.versions.node, '24.19.0');
  assert.equal(getGeminiApiKeyRoundRobinStatus().configuredCount, 10);
  const slots = Array.from({ length: 11 }, () => nextGeminiApiKey().slot);
  assert.deepEqual(slots, [1,2,3,4,5,6,7,8,9,10,1]);
  const store = await import('../src/store.js');
  store.setUserTtsVoice('111111111111111111', '222222222222222222', 'Charon');
  store.setUserTtsOptOut('111111111111111111', '222222222222222222', true);
  assert.equal(store.isUserTtsOptedOut('111111111111111111', '222222222222222222'), true);
  const doctor = execFileSync(process.execPath, [path.join(root, 'src', 'doctor.js')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.match(doctor, /Doctor result: 0 failure/u);
  assert.match(doctor, /Real audio pipeline: PCM/u);
  const result = {
    accountSid: 'S-1-5-18', node: process.versions.node, cwd: process.cwd(), slots,
    nonce: readInstanceRecord(root).nonce, doctorPassed: true, opusRoundTripPassed: true,
    preAppStop: !gracefulMode
  };
  if (gracefulMode) {
    const deferredGuild = `${Date.now()}${process.pid}`;
    const deferredUser = '444444444444444444';
    Object.assign(result, { storeFlushScheduled: true, deferredGuild, deferredUser });
    fs.writeFileSync(path.join(root, 'data', 'ci-system-result.json'), JSON.stringify(result));
    return {
      gracefulShutdown() {
        try {
          assert.equal(store.getOrAssignUserTtsVoice(deferredGuild, deferredUser, ['Charon']), 'Charon');
          process.exit(store.flushStore() ? 0 : 1);
        } catch {
          process.exit(1);
        }
      }
    };
  }
  fs.writeFileSync(path.join(root, 'data', 'ci-system-result.json'), JSON.stringify(result));
  // Exercise stop control while bootstrap is still waiting for remote login.
  return new Promise(() => {});
} }).catch((error) => {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'ci-system-error.txt'), String(error.stack || error.message));
  process.exit(1);
});
