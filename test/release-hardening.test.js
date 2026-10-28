import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { digestDependencyText, isAuthoritativeAuditReport, validateAuditBaseline } from '../scripts/audit-dependencies.mjs';

test('every GitHub Action dependency is pinned to an immutable commit', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  // Dependabot can update immutable SHA pins without changing the security policy.
  // Check the allowlist, full commit SHAs, version comments and consistent pins.
  const uses = [...workflow.matchAll(/^\s*-\s+uses:\s*([^\s#]+)\s+#\s+(\S+)\s*$/gmu)];
  assert.ok(uses.length >= 7);
  assert.equal(uses.length, [...workflow.matchAll(/^\s*-\s+uses:\s*[^\s#]+/gmu)].length);

  const expectedActions = new Set(['checkout', 'setup-node', 'upload-artifact', 'download-artifact']);
  const observedActions = new Set();
  const pins = new Map();
  for (const [, value, version] of uses) {
    const match = /^actions\/(checkout|setup-node|upload-artifact|download-artifact)@([a-f\d]{40})$/u.exec(value);
    assert.ok(match, 'Action must be allowlisted and pinned to a full commit SHA: ' + value);
    assert.match(version, /^v\d+(?:\.\d+){0,2}$/u, 'Missing or invalid version comment for ' + value);
    const action = match[1];
    observedActions.add(action);
    const pin = match[2] + ' # ' + version;
    if (pins.has(action)) {
      assert.equal(pin, pins.get(action), action + ' must use the same version and SHA everywhere');
    } else {
      pins.set(action, pin);
    }
  }
  assert.deepEqual(observedActions, expectedActions);
});

test('Dependabot is configured to maintain GitHub Actions pins', () => {
  const dependabot = fs.readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u);
  assert.match(dependabot, /directory:\s*"\/"/u);
});

test('CI performs one explicit bounded dependency audit without duplicate install audits', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npm ci --no-audit --no-fund --prefer-offline/u);
  assert.match(workflow, /name: Dependency audit\s+if: runner\.os == 'Linux'\s+run: node scripts\/audit-dependencies\.mjs/u);
});

test('dependency-audit outage evidence is clean, exact-file bound and short lived', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const baseline = JSON.parse(fs.readFileSync(new URL('../scripts/audit-baseline.json', import.meta.url), 'utf8'));
  const hash = (name) => digestDependencyText(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  const validationNow = Date.parse('2026-09-27T09:04:00Z');
  assert.equal(baseline.packageJsonLfSha256, hash('package.json'));
  assert.equal(baseline.packageLockLfSha256, hash('package-lock.json'));
  assert.equal(digestDependencyText('same\r\ncontent\r\n'), digestDependencyText('same\ncontent\n'));
  assert.doesNotThrow(() => validateAuditBaseline(baseline, { root, now: validationNow }));
  assert.throws(() => validateAuditBaseline(baseline, { root, now: Date.parse(baseline.expiresAt) }), /expired/u);
  assert.throws(() => validateAuditBaseline({ ...baseline, packageLockLfSha256: '0'.repeat(64) }, { root, now: validationNow }), /changed/u);
  assert.equal(isAuthoritativeAuditReport({ auditReportVersion: 2, metadata: { vulnerabilities: { high: 1 } } }), true);
  assert.equal(isAuthoritativeAuditReport({ error: { code: 'ETIMEDOUT' } }), false);
});

test('Windows installer seals the full application tree before SYSTEM registration', () => {
  const installer = fs.readFileSync(new URL('../install-task.ps1', import.meta.url), 'utf8');
  const verifier = fs.readFileSync(new URL('../scripts/verify-windows.ps1', import.meta.url), 'utf8');
  const systemSmoke = fs.readFileSync(new URL('../scripts/system-smoke.mjs', import.meta.url), 'utf8');
  const logger = fs.readFileSync(new URL('../src/logger.js', import.meta.url), 'utf8');
  const registerAt = installer.indexOf('Register-ScheduledTask');
  assert.ok(installer.indexOf("'/reset', '/T', '/C'") < registerAt);
  assert.ok(installer.indexOf("'/inheritance:r', '/grant:r'") < registerAt);
  assert.match(installer, /function Reset-DescendantAcls/u);
  assert.match(installer, /Reset-DescendantAcls -Directory \$InstallPath/u);
  assert.match(installer, /Reset-DescendantAcls -Directory \$DataPath/u);
  assert.match(installer, /\*S-1-5-11:\(OI\)\(CI\)RX/u);
  assert.match(installer, /\*S-1-5-32-545:\(OI\)\(CI\)RX/u);
  assert.match(installer, /'\/remove:g', '\*S-1-1-0', '\*S-1-5-11', '\*S-1-5-32-545'/u);
  assert.match(installer, /ReparsePoint/u);
  assert.match(verifier, /applicationTreeAcl = \$true/u);
  assert.match(verifier, /standardUserWriteDenied = \$true/u);
  assert.match(verifier, /New-LocalUser/u);
  assert.match(verifier, /FileAccess\]::Write/u);
  assert.match(verifier, /FileSystemRights\]::WriteData/u);
  assert.match(verifier, /FileSystemRights\]::DeleteSubdirectoriesAndFiles/u);
  assert.doesNotMatch(verifier, /FileSystemRights\]::Modify/u);
  assert.match(verifier, /packagedHashes = \$true/u);
  assert.match(verifier, /protectedDataLogs = \$true/u);
  assert.match(verifier, /storeFlush = \$true/u);
  assert.match(verifier, /data\\bot\.log/u);
  assert.match(systemSmoke, /store\.flushStore\(\)/u);
  assert.match(logger, /createLogger\(\{ directory: path\.join\(rootDir, 'data'\) \}\)/u);
});
