import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const setup = fs.readFileSync(new URL('../setup-clean.cmd', import.meta.url), 'utf8');
const doctor = fs.readFileSync(new URL('../src/doctor.js', import.meta.url), 'utf8');

test('clean setup installs with the bundled Node/npm toolchain', () => {
  assert.doesNotMatch(setup, /where\s+node/iu);
  assert.doesNotMatch(setup, /where\s+npm/iu);
  assert.match(setup, /runtime\\node-v24\.19\.0-win-x64\\node\.exe/iu);
  assert.match(setup, /node_modules\\npm\\bin\\npm-cli\.js/iu);
  assert.match(setup, /"%NODE_EXE%"\s+"%NPM_CLI%"\s+ci/iu);
});

test('doctor validates bundled npm rather than requiring system npm', () => {
  assert.match(doctor, /Bundled npm/);
  assert.doesNotMatch(doctor, /System npm/);
});
