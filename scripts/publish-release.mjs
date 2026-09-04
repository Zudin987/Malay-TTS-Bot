import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
assert.match(commit || '', /^[a-f\d]{40}$/u);
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function api(route, optional = false) {
  try { return JSON.parse(gh(['api', `repos/${repository}/${route}`])); }
  catch (error) { if (optional && String(error.stderr).includes('404')) return null; throw error; }
}
if (api('git/ref/heads/main').object.sha !== commit) {
  console.log('A newer main commit exists; its own full CI run owns publishing.');
} else {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const tag = `v${version}`;
  if (api(`releases/tags/${tag}`, true)) {
    console.log(`${tag} is already published; release assets and tags are never overwritten.`);
  } else {
    const existingTag = api(`git/ref/tags/${tag}`, true);
    if (existingTag) assert.equal(existingTag.object.sha, commit, 'Existing tag points at a different source commit');
    const directory = path.resolve('dist');
    const archive = `Malay-TTS-Bot-${tag}-CLEAN.zip`;
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory, archive))).digest('hex');
    assert.equal(actual, fs.readFileSync(path.join(directory, `${archive}.sha256`), 'utf8').split(/\s/u)[0]);
    const proof = JSON.parse(fs.readFileSync(path.join(directory, 'verification.json'), 'utf8').replace(/^\uFEFF/u, ''));
    assert.equal(proof.sourceCommit, commit);
    for (const field of ['tenKeyRoundRobin', 'opusRoundTrip', 'storeFlush', 'privateStateAcl', 'applicationTreeAcl', 'standardUserWriteDenied', 'packagedHashes', 'protectedDataLogs']) assert.equal(proof[field], true);
    assert.equal(proof.accountSid, 'S-1-5-18'); assert.equal(proof.cleanStops, 2);
    gh(['release', 'create', tag, path.join(directory, archive), path.join(directory, `${archive}.sha256`), path.join(directory, 'verification.json'),
      '--repo', repository, '--target', commit, '--title', `${tag} — Reliability and clean Windows release`, '--notes-file', 'RELEASE-NOTES.md', '--latest']);
    console.log(`Published https://github.com/${repository}/releases/tag/${tag} from ${commit}.`);
  }
}
