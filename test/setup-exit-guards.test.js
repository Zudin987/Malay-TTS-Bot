import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const setup = fs.readFileSync(path.join(root, 'setup-clean.cmd'), 'utf8');

test('setup-clean treats negative Windows process exits as failures', () => {
  assert.match(setup, /set "NPM_EXIT=%ERRORLEVEL%"/u);
  assert.match(setup, /if not "%NPM_EXIT%"=="0"/u);
  assert.match(setup, /set "DOCTOR_EXIT=%ERRORLEVEL%"/u);
  assert.match(setup, /if not "%DOCTOR_EXIT%"=="0"/u);
  assert.match(setup, /set "DEPLOY_EXIT=%ERRORLEVEL%"/u);
  assert.match(setup, /if not "%DEPLOY_EXIT%"=="0"/u);
});

test('setup-clean cannot report success after slash-command deployment failure', () => {
  const deployCheck = setup.indexOf('if not "%DEPLOY_EXIT%"=="0"');
  const failureExit = setup.indexOf('exit /b 1', deployCheck);
  const successText = setup.indexOf('Setup complete.', deployCheck);

  assert.ok(deployCheck >= 0);
  assert.ok(failureExit > deployCheck);
  assert.ok(successText > failureExit);
});
