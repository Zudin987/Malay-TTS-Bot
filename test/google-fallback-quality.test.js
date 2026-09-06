import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';

const { replaceDictionaryWords } = await import('../src/dictionary.js');
const { applyContextDictionaries } = await import('../src/context-dictionary.js');
const { replaceExactAcronyms } = await import('../src/acronyms.js');
const { inferGoogleTtsLanguage, streamGoogleMalay } = await import('../src/providers/google.js');

function normalChatGoogleText(input) {
  let text = replaceExactAcronyms(input);
  text = replaceDictionaryWords(text);
  text = applyContextDictionaries(text);
  return text;
}

function audioResponse(byte = 7) {
  return {
    ok: true,
    headers: { get: () => 'audio/mpeg' },
    body: null,
    async arrayBuffer() { return Buffer.alloc(320, byte); }
  };
}

test('NeverRun Malay shorthand improves Google pronunciation without touching ambiguous uppercase forms', () => {
  assert.equal(normalChatGoogleText('aku x nk main'), 'aku tak nak main');
  assert.equal(normalChatGoogleText('ko kene hack ni'), 'kau kena hack ni');
  assert.equal(normalChatGoogleText('Acaner nk manage resources'), 'macam mana nak manage resources');
  assert.equal(normalChatGoogleText('kiteorg tak cukup dps ni'), 'kita orang tak cukup D P S ni');
  assert.equal(normalChatGoogleText('kteorg join org lain je'), 'kita orang join orang lain je');
  assert.equal(normalChatGoogleText('boleh ea?'), 'boleh eh?');
  assert.equal(normalChatGoogleText('apa EA id kau?'), 'apa E A I D kau?');
  assert.equal(normalChatGoogleText('td aku hold barrel dlm nyawa penuh bolh KO'), 'tadi aku hold barrel dalam nyawa penuh boleh K O');
  assert.equal(normalChatGoogleText('X axis'), 'X axis');
});

test('observed high-confidence typos normalize but nicknames and dialect slang stay literal', () => {
  assert.equal(normalChatGoogleText('prlukan bantuan sntiasa response'), 'perlukan bantuan sentiasa response');
  assert.equal(normalChatGoogleText('msok dulu pastu tnye'), 'masuk dulu lepas itu tanya');
  assert.equal(normalChatGoogleText('xprasan tadi'), 'tak perasan tadi');
  assert.equal(normalChatGoogleText('selek Izi Eriii ghey noh uish'), 'selek Izi Eriii ghey noh uish');
});

test('Indonesian negation gak is not rewritten as Malaysian juga when strong Indonesian context is present', () => {
  assert.equal(replaceDictionaryWords('bisa gak?'), 'bisa gak?');
  assert.equal(replaceDictionaryWords('udah bisa gak sekarang?'), 'udah bisa gak sekarang?');
  assert.equal(replaceDictionaryWords('aku amik beat performer gak'), 'aku ambil beat performer juga');
});

test('Google fallback language routing is conservative for Manglish and strong for clear English', () => {
  assert.equal(inferGoogleTtsLanguage('Can you guys carry me? I do not want to do mech.'), 'en');
  assert.equal(inferGoogleTtsLanguage('How to check my ID and where is the setting?'), 'en');
  assert.equal(inferGoogleTtsLanguage('aku tak sure lagi nak manage resources'), 'ms');
  assert.equal(inferGoogleTtsLanguage('I see material la, nanti aku check'), 'ms');
  assert.equal(inferGoogleTtsLanguage('hello'), 'ms');
});

test('Google request uses English only for confidently English whole messages', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    return audioResponse(urls.length);
  };

  const english = await streamGoogleMalay('Can you please check this for me?', {
    fetchImpl, timeoutMs: 1000, completionTimeoutMs: 2000, retryCount: 0
  });
  for await (const _chunk of english.audioStream) {}
  await english.completion;
  assert.equal(english.languageCode, 'en');
  assert.equal(urls[0].searchParams.get('tl'), 'en');

  urls.length = 0;
  const manglish = await streamGoogleMalay('aku nak check this dulu boleh?', {
    fetchImpl, timeoutMs: 1000, completionTimeoutMs: 2000, retryCount: 0
  });
  for await (const _chunk of manglish.audioStream) {}
  await manglish.completion;
  assert.equal(manglish.languageCode, 'ms');
  assert.equal(urls[0].searchParams.get('tl'), 'ms');
});
