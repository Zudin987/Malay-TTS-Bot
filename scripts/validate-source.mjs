import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = path.resolve(process.argv[2] || '.');
const includeRuntime = process.argv.includes('--runtime');
const files = [];
async function walk(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
    if (entry.isDirectory()) {
      if (['.git', 'dist', 'artifacts', '__pycache__'].includes(entry.name)) continue;
      if (entry.name === 'node_modules' && !name.startsWith('runtime/')) continue;
      if (entry.name === 'runtime' && !includeRuntime) continue;
      await walk(path.join(directory, entry.name), name);
    } else if (/\.(?:js|mjs|json)$/u.test(name)) files.push(name);
  }
}
await walk(root);
const scripts = [];
for (const name of files) {
  if (name.endsWith('.json')) JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
  else scripts.push(name);
}
let index = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (index < scripts.length) {
    const name = scripts[index++];
    try { await run(process.execPath, ['--check', path.join(root, name)], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }); }
    catch (error) { throw new Error(`Syntax check failed for ${name}: ${error.stderr || error.message}`); }
  }
}));
for (const relative of ['.env', 'data/guilds.json', 'data/guilds.json.bak', 'data/bot.lock', 'data/stop.request', 'data/speaker-label-cache', 'bot.log', 'bot-old.log', 'temp']) {
  try { await fs.access(path.join(root, relative)); } catch { continue; }
  throw new Error(`Private/generated content in clean source: ${relative}`);
}
console.log(`Validated ${scripts.length} JavaScript files and ${files.length - scripts.length} JSON files; private/runtime-state guard passed.`);
