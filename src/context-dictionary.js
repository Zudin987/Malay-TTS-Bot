import { replaceMalayDictionaryWords, replaceTrailingMalayParticles } from './malay-dictionary.js';
import { replaceGameDictionaryWords } from './game-dictionary.js';

// This is only a safety gate for ambiguous Malay chat shorthand. It is NOT a
// TTS language router: Gemini receives the final mixed-language sentence as one voice.
const MALAY_CONTEXT_PATTERN = /\b(?:aku|kau|korang|kita|kami|dia|diorang|saya|awak|tak|tidak|nak|mahu|mau|dah|sudah|belum|boleh|jangan|kenapa|sebab|kalau|tapi|jadi|juga|nanti|dulu|lepas|masuk|keluar|pergi|balik|datang|sampai|tunggu|tengok|cuba|pakai|punya|orang|macam|sangat|lagi|saja|dekat|kat|dengan|untuk|yang|ini|itu|ada|apa|siapa|bagi|buat|makan|minum|tidur|pukul|malam|pagi|petang|sekejap|semua|memang|betul|rasa|faham|tahu|dapat|kena|suruh|tolong|cepat|lambat|senang|susah|bagus|cantik|sedap|lah|weh|kot|ya|baru|mana|ramai|kurang|atas|ikut|dengar|tekan|naik|sini|lebih|semalam|jauh|salah|malas|lagu|benda|siap|sakit|gila|biasa|takut|kerja|jual|sempat|mahal|kuat|jalan|rumah|beza|situ|laju|letak|tinggal|kawan|sekali|kata|terus|cukup|dalam|dua|esok|nampak|masa|bawah|cuma|ajak|atau|asal|pandai|mari|borak|agak|gerak|kah|penting|janji|geng|mantap|tadi|tiba|fokus|wajib|walaupun|akan|jumpa|hantar|beli|nyanyi|harap|laku|rancak|terkubur|kasi|atur|dan|warna|kuning|hijau|merah|biru|putih|hitam|minta|ambil|simpan|mula|pilih|cari|tanya|jawab|rehat|mandi|murah|penat|mengantuk|baik|buruk|lawa|tinggi|rendah|panjang|pendek|awal|akhir|depan|belakang|kecil|besar|banyak|sikit|sorang|seorang|entah|ingat|lupa|habis|kosong|penuh|harga|duit|ringgit|fon|baju|gambar|abang|bang|kak|fuh|boh|tah|lu|ku|di)\b/iu;
// High-confidence forms observed in real guild chat can establish Malay context
// by themselves. Ambiguous one/two-letter forms such as x, ko, ea, ad, ap and
// tp deliberately do NOT live here; they are only expanded after another Malay
// signal has made the sentence safe to normalize.
const MALAY_STRONG_SHORTHAND_PATTERN = /\b(?:acaner|bgithu|kiteorang|kiteorg|kjp|kosisten|kteorg|lg|masok|memng|msok|prlukan|sntiasa|tnye|xprasan)\b/iu;
const LEADING_TP_MIXED_PATTERN = /^\s*tp\b(?=\s+(?:i|you|we|they|he|she|it|my|your)\b)/u;

export function hasMalayChatContext(input) {
  const text = String(input ?? '');
  MALAY_CONTEXT_PATTERN.lastIndex = 0;
  MALAY_STRONG_SHORTHAND_PATTERN.lastIndex = 0;
  return MALAY_CONTEXT_PATTERN.test(text)
    || MALAY_STRONG_SHORTHAND_PATTERN.test(text)
    || LEADING_TP_MIXED_PATTERN.test(text);
}

export function applyContextDictionaries(input) {
  let text = String(input ?? '').trim();
  if (!text) return '';

  const malayContext = hasMalayChatContext(text);
  if (malayContext) text = replaceMalayDictionaryWords(text);
  text = replaceGameDictionaryWords(text, { allowMalayContext: malayContext });
  if (malayContext) text = replaceTrailingMalayParticles(text);
  return text;
}
