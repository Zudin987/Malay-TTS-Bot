import { acquireSingleInstanceLock } from '../src/single-instance.js';
const [directory, mode = 'plain'] = process.argv.slice(2);
if (!directory) throw new Error('Fixture directory is required.');
if (mode === 'startup') {
  const { startBot } = await import('../src/bootstrap.js');
  await startBot({ directory, loadApp: () => { process.stdout.write('ready\n'); return new Promise(() => {}); } });
} else {
  const lease = await acquireSingleInstanceLock({ directory });
  process.stdout.write(lease ? 'ready\n' : 'busy\n');
  if (!lease) process.exit(2);
}
