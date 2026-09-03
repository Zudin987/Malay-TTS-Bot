import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFfmpegPath } from './ffmpeg.js';
import { buildAudioFilters } from './audio-filters.js';
import { getGeminiApiKeyConfiguration } from './gemini-key-config.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let warnings = 0;

function pass(message) { console.log(`[PASS] ${message}`); }
function warn(message) { warnings += 1; console.log(`[WARN] ${message}`); }
function fail(message) { failures += 1; console.log(`[FAIL] ${message}`); }
function exists(relative) { return fs.existsSync(path.join(rootDir, relative)); }
function readJson(relative, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(rootDir, relative), 'utf8')); }
  catch { return fallback; }
}

function makePcmProbe({ sampleRate = 24_000, durationMs = 320 } = {}) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(1, i / 300, (samples - i) / 300);
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 8000 * Math.max(0, envelope));
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function runPipelineProbe(ffmpegPath, settings) {
  // Use the exact runtime filter builder so doctor validation cannot drift from
  // the playback path (including FFmpeg alimiter units/ceiling semantics).
  const filters = buildAudioFilters({
    volume: settings?.fixedVolume,
    playbackSpeed: 1,
    audioPipeline: settings?.audioPipeline
  });

  const encoded = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
    '-map', '0:a:0', '-vn', '-af', filters.join(','),
    '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-application', 'audio',
    '-frame_duration', '20', '-page_duration', '20000', '-flush_packets', '1',
    '-f', 'ogg', 'pipe:1'
  ], { input: makePcmProbe(), encoding: null, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });

  if (encoded.status !== 0 || !Buffer.isBuffer(encoded.stdout) || encoded.stdout.length < 200) {
    const detail = String(encoded.stderr || '').trim().slice(0, 500);
    throw new Error(`encode failed${detail ? `: ${detail}` : ''}`);
  }
  if (encoded.stdout.subarray(0, 4).toString('ascii') !== 'OggS') throw new Error('encoded output is not Ogg/Opus');

  const decoded = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'ogg', '-i', 'pipe:0',
    '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { input: encoded.stdout, encoding: null, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });

  if (decoded.status !== 0 || !Buffer.isBuffer(decoded.stdout) || decoded.stdout.length < 4_000) {
    const detail = String(decoded.stderr || '').trim().slice(0, 500);
    throw new Error(`decode failed${detail ? `: ${detail}` : ''}`);
  }
  return { encodedBytes: encoded.stdout.length, decodedBytes: decoded.stdout.length };
}

console.log('Malay TTS Bot doctor');
console.log(`Folder: ${rootDir}`);
console.log('');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor === 24) pass(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node}; this bot requires Node 24.x`);

if (typeof globalThis.WebSocket === 'function') pass('Built-in WebSocket available for Gemini Live');
else fail('Built-in WebSocket unavailable; Gemini Live requires the bundled Node.js 24 runtime');

const requiredFiles = [
  'package.json', '.env', 'config/settings.json', 'config/dictionary.json',
  'config/dictionary-ms.json', 'config/dictionary-game.json', 'config/acronyms.json'
];
for (const file of requiredFiles) {
  if (exists(file)) pass(file);
  else fail(`Missing ${file}`);
}

const obsoleteFiles = [
  'src/language-router.js', 'src/dictionary-router.js', 'src/pronunciation.js',
  'config/pronunciation.json', 'src/rapid-merge.js'
];
for (const file of obsoleteFiles) {
  if (exists(file)) warn(`Obsolete legacy file still exists: ${file} (remove it or reinstall from the current Clean package)`);
}

for (const file of ['config/settings.json', 'config/dictionary.json', 'config/dictionary-ms.json', 'config/dictionary-game.json', 'config/acronyms.json']) {
  if (!exists(file)) continue;
  try {
    JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf8'));
    pass(`${file} JSON valid`);
  } catch (error) {
    fail(`${file} invalid JSON: ${error.message}`);
  }
}

if (exists('.env')) {
  const envText = fs.readFileSync(path.join(rootDir, '.env'), 'utf8');
  const envValue = (key) => envText.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1]?.trim() || '';
  const usable = (value) => Boolean(value && !/^(["']?)(?:replace|your|changeme|token|client)[-_ ]/iu.test(value));

  const token = envValue('DISCORD_TOKEN');
  if (usable(token)) pass('DISCORD_TOKEN is set');
  else fail('DISCORD_TOKEN is missing/empty in .env');

  const clientId = envValue('DISCORD_CLIENT_ID');
  if (usable(clientId)) pass('DISCORD_CLIENT_ID is set for slash-command deployment');
  else warn('DISCORD_CLIENT_ID is missing/empty; bot runtime can still run, but deploy-commands.js cannot deploy slash commands');

  const gemini = getGeminiApiKeyConfiguration(process.env);
  if (gemini.configuredCount > 0) {
    pass(`Gemini key ring: ${gemini.configuredCount} unique credential(s) in slot(s) ${gemini.configuredSlots.join(', ')}; start slot ${gemini.selectedSlot}`);
  } else {
    warn('No Gemini API key slot is configured; bot will use Google Malay fallback only');
  }
  for (const duplicate of gemini.duplicateSlots) {
    warn(`Gemini API key slot ${duplicate.slot} duplicates slot ${duplicate.duplicateOf}; duplicate slot is ignored by the runtime ring`);
  }
  if (gemini.configuredCount > 0 && gemini.requestedSlot !== gemini.selectedSlot && !gemini.duplicateSlots.some((entry) => entry.slot === gemini.requestedSlot)) {
    warn(`GEMINI_API_KEY_SLOT=${gemini.requestedSlot} is not a unique configured slot; runtime starts at slot ${gemini.selectedSlot}`);
  }
}

for (const dependency of ['discord.js', '@discordjs/voice', 'dotenv', 'libsodium-wrappers']) {
  const packagePath = path.join(rootDir, 'node_modules', ...dependency.split('/'), 'package.json');
  if (fs.existsSync(packagePath)) pass(`Dependency ${dependency}`);
  else fail(`Dependency missing: ${dependency} (run setup-clean.cmd or npm ci)`);
}

const ffmpegPath = getFfmpegPath();
const ffmpeg = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
if (ffmpeg.status === 0) {
  const firstLine = String(ffmpeg.stdout || '').split(/\r?\n/u)[0].trim();
  pass(`${firstLine || 'FFmpeg available'} (${ffmpegPath})`);
} else {
  fail(`FFmpeg unavailable at ${ffmpegPath}; set FFMPEG_PATH or install FFmpeg for SYSTEM`);
}

if (ffmpeg.status === 0) {
  const settings = readJson('config/settings.json', {});
  const limiterEnabled = settings?.audioPipeline?.peakLimiter?.enabled !== false;
  if (limiterEnabled) {
    const limiterProbe = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'filter=alimiter'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const limiterText = `${limiterProbe.stdout || ''}\n${limiterProbe.stderr || ''}`;
    if (limiterProbe.status === 0 && /Audio lookahead limiter|alimiter AVOptions/iu.test(limiterText)) pass('FFmpeg alimiter available for configured peak ceiling');
    else fail('FFmpeg alimiter is unavailable while audioPipeline.peakLimiter.enabled=true');
  } else {
    pass('Peak limiter disabled in settings; alimiter availability is not required');
  }

  try {
    const probe = runPipelineProbe(ffmpegPath, settings);
    pass(`Real audio pipeline: PCM -> filters -> libopus/Ogg -> decode (${probe.encodedBytes}B encoded, ${probe.decodedBytes}B decoded)`);
  } catch (error) {
    fail(`Real audio pipeline test failed: ${error.message}`);
  }
}

try {
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, `.doctor-${process.pid}.tmp`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  pass('data folder is writable');
} catch (error) {
  fail(`data folder is not writable: ${error.message}`);
}

const bundledRuntimeDir = path.join(rootDir, 'runtime', 'node-v24.19.0-win-x64');
const bundledNode = path.join(bundledRuntimeDir, 'node.exe');
const bundledNpmCli = path.join(bundledRuntimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (process.platform === 'win32' || fs.existsSync(bundledRuntimeDir)) {
  if (fs.existsSync(bundledNode) && fs.existsSync(bundledNpmCli)) {
    const npm = spawnSync(bundledNode, [bundledNpmCli, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (npm.status === 0) pass(`Bundled npm ${String(npm.stdout).trim()} available for clean installs`);
    else fail('Bundled npm exists but could not run; re-extract the current Clean release package');
  } else {
    fail('Bundled Node/npm runtime is incomplete; re-extract the current Clean release package');
  }
} else {
  pass('Bundled Windows Node/npm check skipped on non-Windows source checkout');
}

console.log('');
console.log(`Doctor result: ${failures} failure(s), ${warnings} warning(s).`);
process.exitCode = failures ? 1 : 0;
