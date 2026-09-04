import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maximumBaselineAgeMs = 48 * 60 * 60 * 1000;
const maximumClockSkewMs = 5 * 60 * 1000;

export function digestDependencyText(value) {
  return createHash('sha256').update(String(value).replace(/\r\n?/gu, '\n')).digest('hex');
}

function digestFile(filePath) {
  return digestDependencyText(fs.readFileSync(filePath, 'utf8'));
}

export function isAuthoritativeAuditReport(value) {
  return Boolean(value && Number.isInteger(value.auditReportVersion)
    && value.metadata && value.metadata.vulnerabilities);
}

export function validateAuditBaseline(baseline, { root = repoRoot, now = Date.now() } = {}) {
  if (baseline?.schemaVersion !== 1 || baseline?.auditLevel !== 'high') throw new Error('Unsupported dependency-audit baseline.');
  if (!/^[a-f\d]{40}$/u.test(String(baseline.sourceCommit || ''))) throw new Error('Dependency-audit baseline has no valid source commit.');
  if (!Number.isSafeInteger(baseline.sourceRunId) || !Number.isSafeInteger(baseline.sourceJobId)) throw new Error('Dependency-audit baseline has no valid CI evidence.');
  const verifiedAt = Date.parse(baseline.verifiedAt);
  const expiresAt = Date.parse(baseline.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) throw new Error('Dependency-audit baseline dates are invalid.');
  if (verifiedAt > now + maximumClockSkewMs) throw new Error('Dependency-audit baseline is dated in the future.');
  if (expiresAt <= now) throw new Error('Dependency-audit baseline has expired.');
  if (expiresAt <= verifiedAt || expiresAt - verifiedAt > maximumBaselineAgeMs) throw new Error('Dependency-audit baseline lifetime exceeds 48 hours.');
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    if (baseline.vulnerabilities?.[severity] !== 0) throw new Error(`Dependency-audit baseline is not clean: ${severity}.`);
  }
  const packageJsonHash = digestFile(path.join(root, 'package.json'));
  const packageLockHash = digestFile(path.join(root, 'package-lock.json'));
  if (packageJsonHash !== baseline.packageJsonLfSha256 || packageLockHash !== baseline.packageLockLfSha256) {
    throw new Error('Dependency files changed after the clean audit baseline.');
  }
  return baseline;
}

function parseAuditJson(output) {
  try { return JSON.parse(String(output || '').trim()); }
  catch { return null; }
}

function isNetworkFailure(result) {
  const combined = `${result.error?.code || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  return /(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|FETCH_ERROR|network timeout|Service Unavailable|audit endpoint returned an error)/iu.test(combined);
}

export function runDependencyAudit({ root = repoRoot, now = Date.now(), spawn = spawnSync } = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawn(npm, [
    'audit', '--json', '--audit-level=high',
    '--fetch-timeout=60000', '--fetch-retries=2',
    '--fetch-retry-mintimeout=5000', '--fetch-retry-maxtimeout=30000'
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240000, windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const report = parseAuditJson(result.stdout);
  if (result.status === 0) {
    console.log('[audit] Fresh npm advisory check passed.');
    return true;
  }
  // A real audit report always wins. The outage baseline may never turn a
  // reported vulnerability into a passing result.
  if (isAuthoritativeAuditReport(report) || !isNetworkFailure(result)) {
    throw new Error(`Dependency audit failed with status ${result.status ?? result.error?.code ?? 'unknown'}.`);
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'audit-baseline.json'), 'utf8'));
  validateAuditBaseline(baseline, { root, now });
  console.warn(`[audit] npm advisory service unavailable; accepted fresh exact-file zero-vulnerability evidence from run ${baseline.sourceRunId}, job ${baseline.sourceJobId}, expiring ${baseline.expiresAt}.`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runDependencyAudit(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
