import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const directory = path.resolve('artifacts');
fs.mkdirSync(directory, { recursive: true });
for (let pass = 1; pass <= 5; pass++) {
  const file = path.join(directory, `tests-${process.platform}-${pass}.log`);
  const log = fs.createWriteStream(file);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const [code] = await once(child, 'close');
  log.end(); await once(log, 'finish');
  const output = fs.readFileSync(file, 'utf8');
  if (code !== 0) { console.error(output.slice(-16000)); throw new Error(`Regression pass ${pass} failed (${code})`); }
  console.log(`Pass ${pass}/5: ${output.match(/\btests\s+(\d+)/u)?.[1] || '?'} tests; zero failures.`);
}
