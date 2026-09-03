import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnManagedProcess, terminateChild, getChildProcessStatus } from '../src/child-processes.js';

test('decoder termination waits for a real child and escalates when SIGTERM is ignored', async () => {
  const child = spawnManagedProcess(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  await once(child.stdout, 'data');
  assert.equal(getChildProcessStatus().active, 1);
  assert.equal(await terminateChild(child, { graceMs: 30, timeoutMs: 1500 }), true);
  assert.ok(child.exitCode != null || child.signalCode != null);
  assert.equal(getChildProcessStatus().active, 0);
});
