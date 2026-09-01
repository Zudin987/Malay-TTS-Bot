import { nextGeminiApiKey } from './gemini-key-config.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_SYSTEM = [
  'You are /ask, a concise chat-answer mode for a private Discord server.',
  'Answer the user directly in the same language and casual register they used, including Malaysian Malay, English, or Manglish.',
  'Sound like a normal chat reply, not an article or report.',
  'Default to one to three short sentences and give only the core answer.',
  'Do not use headings, bullet lists, numbered lists, tables, citations, embeds, image markdown, or image suggestions.',
  'Do not generate or request images. Do not add long background unless the user explicitly asks for detail.',
  'If the question requires current or live information you cannot verify, say so briefly instead of guessing.'
].join(' ');

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function trimCodePoints(value, maxCharacters) {
  const points = Array.from(String(value ?? '').trim());
  return points.length <= maxCharacters ? points.join('') : points.slice(0, maxCharacters).join('');
}

export class AskError extends Error {
  constructor(code, message, { status = null, apiStatus = null } = {}) {
    super(message);
    this.name = 'AskError';
    this.code = code;
    this.status = status;
    this.apiStatus = apiStatus;
  }
}

export function getAskOptions(source = undefined) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    enabled: raw.enabled !== false,
    model: String(raw.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    timeoutMs: clamp(finiteNumber(raw.timeoutMs, 8000), 1500, 20000),
    maxQuestionCharacters: Math.floor(clamp(finiteNumber(raw.maxQuestionCharacters, 1000), 50, 1000)),
    maxOutputTokens: Math.floor(clamp(finiteNumber(raw.maxOutputTokens, 160), 32, 512)),
    maxAnswerCharacters: Math.floor(clamp(finiteNumber(raw.maxAnswerCharacters, 450), 120, 1024)),
    temperature: clamp(finiteNumber(raw.temperature, 0.35), 0, 1.5),
    thinkingLevel: ['minimal', 'low', 'medium', 'high'].includes(String(raw.thinkingLevel || '').toLowerCase())
      ? String(raw.thinkingLevel).toLowerCase()
      : 'minimal',
    systemInstruction: String(raw.systemInstruction || '').trim() || DEFAULT_SYSTEM
  };
}

export function compactAskAnswer(value, maxCharacters = 450) {
  const limit = Math.floor(clamp(finiteNumber(maxCharacters, 450), 120, 1024));
  let text = String(value ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/^\s{0,3}#{1,6}\s*/gmu, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return '';

  const points = Array.from(text);
  if (points.length <= limit) return text;
  const preview = points.slice(0, limit + 1).join('');
  const floor = Math.floor(limit * 0.55);
  let cut = -1;
  for (const mark of ['. ', '? ', '! ', '; ']) {
    const candidate = preview.lastIndexOf(mark);
    if (candidate >= floor) cut = Math.max(cut, candidate + 1);
  }
  if (cut < floor) {
    const whitespace = preview.lastIndexOf(' ');
    if (whitespace >= floor) cut = whitespace;
  }
  if (cut < 1) cut = limit;
  text = preview.slice(0, cut).trimEnd();
  const body = Array.from(text).slice(0, Math.max(1, limit - 1)).join('').trimEnd();
  return `${body}…`;
}

export function buildAskRequest(question, options = getAskOptions()) {
  const text = trimCodePoints(question, options.maxQuestionCharacters);
  if (!text) throw new AskError('empty', 'Question is empty.');
  return {
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      candidateCount: 1,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      responseMimeType: 'text/plain',
      thinkingConfig: { thinkingLevel: options.thinkingLevel }
    }
  };
}

function responseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join(' ');
}

function apiFailure(status, payload) {
  const apiStatus = String(payload?.error?.status || '').trim() || null;
  const apiMessage = String(payload?.error?.message || '').trim();
  const haystack = `${apiStatus || ''} ${apiMessage}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate.?limit/iu.test(haystack)) {
    return new AskError('quota', 'Gemini is rate-limited right now.', { status, apiStatus });
  }
  if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED/iu.test(haystack)) {
    return new AskError('auth', 'Gemini /ask is not available right now.', { status, apiStatus });
  }
  return new AskError('api', `Gemini /ask returned HTTP ${status}.`, { status, apiStatus });
}

export function describeAskError(error) {
  if (error?.code === 'disabled') return '/ask is disabled in config/settings.json.';
  if (error?.code === 'no-key') return 'Gemini /ask is not configured right now.';
  if (error?.code === 'quota') return 'Gemini is rate-limited right now. Try again later.';
  if (error?.code === 'auth') return 'Gemini /ask is unavailable right now.';
  if (error?.code === 'blocked') return 'Gemini could not answer that request.';
  if (error?.code === 'timeout') return 'Gemini took too long to answer. Try again.';
  if (error?.code === 'empty') return 'Ask me a question first.';
  return 'Gemini /ask failed. Try again.';
}

export async function askGemini(question, {
  fetchImpl = globalThis.fetch,
  keyEntry = null,
  options = getAskOptions()
} = {}) {
  if (!options.enabled) throw new AskError('disabled', '/ask is disabled.');
  if (typeof fetchImpl !== 'function') throw new AskError('api', 'Fetch is unavailable.');
  const selectedKey = keyEntry ?? nextGeminiApiKey();
  if (!selectedKey?.key) throw new AskError('no-key', 'No Gemini API key is configured.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(`${API_ROOT}/${encodeURIComponent(options.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': selectedKey.key,
        'x-goog-api-client': 'malay-tts-bot/ask'
      },
      body: JSON.stringify(buildAskRequest(question, options)),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new AskError('timeout', `Gemini /ask timed out after ${options.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw apiFailure(response.status, payload);
  const answer = compactAskAnswer(responseText(payload), options.maxAnswerCharacters);
  if (!answer) {
    const blocked = payload?.promptFeedback?.blockReason || payload?.candidates?.[0]?.finishReason === 'SAFETY';
    throw new AskError(blocked ? 'blocked' : 'api', blocked ? 'Gemini blocked the request.' : 'Gemini returned no text.');
  }
  return { answer, model: options.model, keySlot: selectedKey.slot ?? null };
}
