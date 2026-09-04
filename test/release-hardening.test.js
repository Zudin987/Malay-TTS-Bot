import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('every GitHub Action dependency is pinned to an immutable commit', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const uses = [...workflow.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(uses.length >= 7);
  for (const value of uses) assert.match(value, /^actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@[a-f\d]{40}$/u);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7/u);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7/u);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4/u);
  assert.match(workflow, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\s+# v4/u);
});

test('Dependabot is configured to maintain GitHub Actions pins', () => {
  const dependabot = fs.readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u);
  assert.match(dependabot, /directory:\s*"\/"/u);
});

test('Windows installer seals the full application tree before SYSTEM registration', () => {
  const installer = fs.readFileSync(new URL('../install-task.ps1', import.meta.url), 'utf8');
  const verifier = fs.readFileSync(new URL('../scripts/verify-windows.ps1', import.meta.url), 'utf8');
  const systemSmoke = fs.readFileSync(new URL('../scripts/system-smoke.mjs', import.meta.url), 'utf8');
  const logger = fs.readFileSync(new URL('../src/logger.js', import.meta.url), 'utf8');
  const registerAt = installer.indexOf('Register-ScheduledTask');
  assert.ok(installer.indexOf("'/reset', '/T', '/C'") < registerAt);
  assert.ok(installer.indexOf("'/inheritance:r', '/grant:r'") < registerAt);
  assert.match(installer, /ReparsePoint/u);
  assert.match(verifier, /applicationTreeAcl = \$true/u);
  assert.match(verifier, /standardUserWriteDenied = \$true/u);
  assert.match(verifier, /New-LocalUser/u);
  assert.match(verifier, /FileAccess\]::Write/u);
  assert.match(verifier, /packagedHashes = \$true/u);
  assert.match(verifier, /protectedDataLogs = \$true/u);
  assert.match(verifier, /storeFlush = \$true/u);
  assert.match(verifier, /data\\bot\.log/u);
  assert.match(systemSmoke, /store\.flushStore\(\)/u);
  assert.match(logger, /createLogger\(\{ directory: path\.join\(rootDir, 'data'\) \}\)/u);
});
