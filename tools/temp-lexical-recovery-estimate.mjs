import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8').replace(/\r\n/gu, '\n'); }
function once(path, before, after) {
  const text = read(path);
  const i = text.indexOf(before);
  if (i < 0) throw new Error(`Missing target in ${path}`);
  if (text.indexOf(before, i + before.length) >= 0) throw new Error(`Ambiguous target in ${path}`);
  fs.writeFileSync(path, text.slice(0, i) + after + text.slice(i + before.length));
}

let guard = read('src/live-readaloud-guard.js');
guard = guard.replace(
  `const MALAY_QUESTION_PARTICLE = /\\b(?:takde|xde|ada|boleh|dah|sudah|belum|nak|mau|mahu|betul|serius|event|current|baru)\\b[^\\n]{0,60}\\bke(?:\\s+[\\p{L}\\p{N}_-]{1,32})?\\s*[.!…]*$/iu;`,
  `const MALAY_QUESTION_PARTICLE = /(?:\\b(?:event\\s+baru|current\\s+event|event\\s+current|betul|serius)\\s+ke(?:\\s+[\\p{L}\\p{N}_-]{1,32})?\\s*[.!…]*$)/iu;`
);
if (!guard.includes('event\\s+baru|current\\s+event')) throw new Error('Question particle patch failed.');
fs.writeFileSync('src/live-readaloud-guard.js', guard);

once('src/audio.js',
`function isSuspiciouslyShortPcm(item, generated, audioBytes) {\n  const reference = String(item.verificationText || item.text || '').trim();\n`,
`function estimateRecoveryDurationMs(text) {\n  const value = String(text ?? '').trim();\n  if (!value) return 0;\n  const words = value.split(/\\s+/u).filter(Boolean).length;\n  const lexicalCharacters = [...value.replace(/[^\\p{L}\\p{N}]/gu, '')].length;\n  const estimate = Math.max(words * 330, lexicalCharacters * 48);\n  return Math.max(650, Math.min(Math.round(estimate), 50_000));\n}\n\nfunction isSuspiciouslyShortPcm(item, generated, audioBytes) {\n  const reference = String(item.verificationText || item.text || '').trim();\n`);

once('src/audio.js',
`  const expected = item.estimatedDurationMs || estimateSpeechDurationMs(item.text);\n  return actual >= 250 && actual < expected * 0.35 && expected - actual >= 900;\n`,
`  // Recovery must not inherit punctuation pause inflation from the queue ETA.\n  // A message full of ellipses can be spoken completely much faster than the\n  // display-oriented estimate without being truncated.\n  const expected = estimateRecoveryDurationMs(item.verificationText || item.text);\n  return actual >= 250 && actual < expected * 0.35 && expected - actual >= 900;\n`);

once('src/audio.js',
`  const expectedMs = Math.max(1, Number(item.estimatedDurationMs) || estimateSpeechDurationMs(item.text));\n  const severeShort = actualMs >= 250 && actualMs < expectedMs * 0.75 && expectedMs - actualMs >= 650;\n`,
`  const expectedMs = Math.max(1, estimateRecoveryDurationMs(item.verificationText || item.text));\n  const severeShort = actualMs >= 250 && actualMs < expectedMs * 0.75 && expectedMs - actualMs >= 650;\n`);

let tests = read('test/readaloud-guards.test.js');
tests = tests.replace(
`  assert.equal(shouldBypassGeminiLiveForReadAloud('aku pergi ke kedai lepas ni'), false);\n  assert.equal(shouldBypassGeminiLiveForReadAloud('aku tak tahu apa nak buat'), false);\n`,
`  assert.equal(shouldBypassGeminiLiveForReadAloud('aku pergi ke kedai lepas ni'), false);\n  assert.equal(shouldBypassGeminiLiveForReadAloud('aku dah pergi ke kedai'), false);\n  assert.equal(shouldBypassGeminiLiveForReadAloud('baru pergi ke kedai'), false);\n  assert.equal(shouldBypassGeminiLiveForReadAloud('aku tak tahu apa nak buat'), false);\n`
);
if (!tests.includes("aku dah pergi ke kedai")) throw new Error('Question false-positive tests not inserted.');

tests += `\n\ntest('punctuation pause inflation cannot turn complete fast speech into a recovery tail', () => {\n  const text = 'aku... nak... pergi... ke... kedai...';\n  const item = audioTest.createQueueItem(text, { verificationText: text });\n  const state = stateForRecovery();\n  const fullAudio = pcm(1100);\n  const generated = { audioFormat: 's16le', sampleRate: 24_000, channels: 1 };\n  const info = { audioBytes: fullAudio.length, audioBuffer: fullAudio, transcript: 'aku nak' };\n  assert.equal(audioTest.handleCompletionRecovery('test-guild', state, item, generated, 1100, 1, { info }), false);\n  assert.equal(state.queue.length, 0);\n  assert.equal(state.suppressedCutoffReplays, 1);\n});\n`;
fs.writeFileSync('test/readaloud-guards.test.js', tests);

console.log('Applied lexical recovery estimate and safer Malay ke-question rule.');
