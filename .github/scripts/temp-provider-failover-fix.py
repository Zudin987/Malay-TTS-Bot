from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# Runtime defaults + normalization.
replace_once(
    "src/config.js",
    "    quotaThirdSeconds: 300,\n    errorFirstSeconds: 8,",
    "    quotaThirdSeconds: 300,\n    fallbackQuotaBackoffAfter: 3,\n    fallbackQuotaBackoffSeconds: 1800,\n    errorFirstSeconds: 8,",
)
replace_once(
    "src/config.js",
    "      quotaThirdSeconds: clampInt(providerHealth.quotaThirdSeconds, defaults.providerHealth.quotaThirdSeconds, 30, 21600),\n      errorFirstSeconds:",
    "      quotaThirdSeconds: clampInt(providerHealth.quotaThirdSeconds, defaults.providerHealth.quotaThirdSeconds, 30, 21600),\n      fallbackQuotaBackoffAfter: clampInt(providerHealth.fallbackQuotaBackoffAfter, defaults.providerHealth.fallbackQuotaBackoffAfter, 2, 10),\n      fallbackQuotaBackoffSeconds: clampInt(providerHealth.fallbackQuotaBackoffSeconds, defaults.providerHealth.fallbackQuotaBackoffSeconds, 300, 21600),\n      errorFirstSeconds:",
)

# Shipped settings file mirrors the normalized defaults. Existing local
# settings files do not need manual edits because normalization supplies these
# defaults when the fields are absent.
replace_once(
    "config/settings.json",
    '    "quotaThirdSeconds": 300,\n    "errorFirstSeconds": 8,',
    '    "quotaThirdSeconds": 300,\n    "fallbackQuotaBackoffAfter": 3,\n    "fallbackQuotaBackoffSeconds": 1800,\n    "errorFirstSeconds": 8,',
)

# Provider health runtime options.
replace_once(
    "src/tts.js",
    "    quotaThirdSeconds: Math.max(30, Number(raw.quotaThirdSeconds) || 300),\n    errorFirstSeconds:",
    "    quotaThirdSeconds: Math.max(30, Number(raw.quotaThirdSeconds) || 300),\n    fallbackQuotaBackoffAfter: Math.max(2, Math.min(10, Math.floor(Number(raw.fallbackQuotaBackoffAfter) || 3))),\n    fallbackQuotaBackoffSeconds: Math.max(300, Math.min(21_600, Number(raw.fallbackQuotaBackoffSeconds) || 1800)),\n    errorFirstSeconds:",
)

# Sanitization is applied both to persistent state (Discord status) and log
# output. Query-string keys, Google-style API keys and bearer tokens are
# redacted before storage or printing.
marker = """function noteAttempt(state, elapsedMs) {
  const ms = Math.max(0, Number(elapsedMs) || 0);
  state.lastAttemptMs = ms;
  state.maxAttemptMs = Math.max(state.maxAttemptMs, ms);
  state.totalAttemptMs += ms;
}

"""
sanitizer = r"""function sanitizeProviderText(value) {
  return String(value ?? '')
    .replace(/([?&](?:key|api[_-]?key|apikey)=)[^&\s)]+/giu, '$1[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, '[redacted-api-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/giu, 'Bearer [redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1200);
}

function sanitizeProviderError(error) {
  return sanitizeProviderText(error?.message || error || 'Unknown provider error.');
}

function logProviderFailure(providerName, error, phase = 'initial') {
  if (error?.cancelled) return;
  const metadata = [
    error?.code != null ? `code=${sanitizeProviderText(error.code)}` : null,
    error?.status != null ? `status=${sanitizeProviderText(error.status)}` : null,
    error?.apiStatus != null ? `apiStatus=${sanitizeProviderText(error.apiStatus)}` : null,
    error?.reason ? `reason=${sanitizeProviderText(error.reason)}` : null
  ].filter(Boolean).join(' ');
  console.warn(`[provider-fail:${providerName}] phase=${phase}${metadata ? ` ${metadata}` : ''} message=${sanitizeProviderError(error)}`);
}

"""
replace_once("src/tts.js", marker, marker + sanitizer)

# 2.5 Live gets a long model-specific half-open probe interval only after
# repeated quota-like failures. 3.1 Live keeps the normal 15s -> 60s -> 300s
# health ladder.
replace_once(
    "src/tts.js",
    """  } else if (error?.quotaLike) {
    seconds = stepValue(state.consecutiveQuotaFailures, health.quotaFirstSeconds, health.quotaSecondSeconds, health.quotaThirdSeconds);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
    reason = `quota/rate limit x${state.consecutiveQuotaFailures}`;
    kind = 'quota/rate limit';""",
    """  } else if (error?.quotaLike) {
    const persistentFallbackQuota = key === 'liveFallback'
      && state.consecutiveQuotaFailures >= health.fallbackQuotaBackoffAfter;
    seconds = persistentFallbackQuota
      ? health.fallbackQuotaBackoffSeconds
      : stepValue(state.consecutiveQuotaFailures, health.quotaFirstSeconds, health.quotaSecondSeconds, health.quotaThirdSeconds);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
    reason = persistentFallbackQuota
      ? `quota/rate limit x${state.consecutiveQuotaFailures} (fallback probe in ${seconds}s)`
      : `quota/rate limit x${state.consecutiveQuotaFailures}`;
    kind = 'quota/rate limit';""",
)
replace_once(
    "src/tts.js",
    "  state.lastError = error?.message || String(error);",
    "  state.lastError = sanitizeProviderError(error);",
)
replace_once(
    "src/tts.js",
    "    console.warn(`[${providerName}] Provider failed after first audio: ${error.message}`);",
    "    logProviderFailure(providerName, error, 'midstream');",
)
replace_once(
    "src/tts.js",
    "    state.lastError = error.message || String(error);",
    "    state.lastError = sanitizeProviderError(error);",
)
replace_once(
    "src/tts.js",
    "  state.lastError = `Skipped after primary Live setup/transport failure: ${error.message}`;",
    "  state.lastError = `Skipped after primary Live setup/transport failure: ${sanitizeProviderError(error)}`;",
)
replace_once(
    "src/tts.js",
    "    if (budget || !error?.cancelled) setProviderFailure(state, error, stateOptions(key), { phase: 'initial', budget, key, configSignature });\n    else releaseHalfOpenProbe(key, state);",
    "    if (budget || !error?.cancelled) {\n      setProviderFailure(state, error, stateOptions(key), { phase: 'initial', budget, key, configSignature });\n      if (!budget && !error?.cancelled) logProviderFailure(providerName, error, 'initial');\n    } else releaseHalfOpenProbe(key, state);",
)
replace_once(
    "src/tts.js",
    "export const __test = { makeBudgetError, setProviderFailure, newProviderState, bufferGenerated, healthOptions, pacificDailyResetMs, recordGeminiQuotaFailure, providerReady, acquireGeminiSlot, providerConfigSignature, beginHalfOpenProbe, releaseHalfOpenProbe };",
    "export const __test = { makeBudgetError, setProviderFailure, newProviderState, bufferGenerated, healthOptions, pacificDailyResetMs, recordGeminiQuotaFailure, providerReady, acquireGeminiSlot, providerConfigSignature, beginHalfOpenProbe, releaseHalfOpenProbe, sanitizeProviderText, sanitizeProviderError };",
)

# Regression tests.
tests = Path("test/regression.test.js")
text = tests.read_text(encoding="utf-8")
append = r"""

test('provider diagnostics redact API credentials but preserve useful quota context', () => {
  const message = 'socket wss://example.test/live?key=AIzaSyTHIS_IS_A_FAKE_TEST_KEY_123456789 quota exceeded Bearer abc.def.ghi';
  const safe = tts.__test.sanitizeProviderText(message);
  assert.equal(safe.includes('AIzaSyTHIS_IS_A_FAKE_TEST_KEY_123456789'), false);
  assert.equal(safe.includes('Bearer abc.def.ghi'), false);
  assert.ok(safe.includes('key=[redacted]'));
  assert.ok(safe.includes('quota exceeded'));
});

test('provider status stores sanitized provider errors', () => {
  const state = tts.__test.newProviderState();
  const error = Object.assign(new Error('quota exceeded https://example.test?key=AIzaSyTHIS_IS_A_FAKE_TEST_KEY_123456789'), { quotaLike: true });
  tts.__test.setProviderFailure(state, error, {}, { key: 'liveFallback' });
  assert.equal(state.lastError.includes('AIzaSyTHIS_IS_A_FAKE_TEST_KEY_123456789'), false);
  assert.ok(state.lastError.includes('key=[redacted]'));
});

test('repeated 2.5 Live quota failures use a long model-specific probe backoff without penalizing 3.1', () => {
  const health = settings.providerHealth;
  const originalAfter = health.fallbackQuotaBackoffAfter;
  const originalSeconds = health.fallbackQuotaBackoffSeconds;
  const originalThird = health.quotaThirdSeconds;
  health.fallbackQuotaBackoffAfter = 3;
  health.fallbackQuotaBackoffSeconds = 1800;
  health.quotaThirdSeconds = 300;
  const quotaError = Object.assign(new Error('You exceeded your current quota.'), { quotaLike: true });
  try {
    const fallback = tts.__test.newProviderState();
    tts.__test.setProviderFailure(fallback, quotaError, {}, { key: 'liveFallback' });
    tts.__test.setProviderFailure(fallback, quotaError, {}, { key: 'liveFallback' });
    const beforeFallbackThird = Date.now();
    tts.__test.setProviderFailure(fallback, quotaError, {}, { key: 'liveFallback' });
    assert.ok(fallback.cooldownUntil - beforeFallbackThird >= 1_799_000);
    assert.match(fallback.cooldownReason, /fallback probe in 1800s/u);

    const primary = tts.__test.newProviderState();
    tts.__test.setProviderFailure(primary, quotaError, {}, { key: 'livePrimary' });
    tts.__test.setProviderFailure(primary, quotaError, {}, { key: 'livePrimary' });
    const beforePrimaryThird = Date.now();
    tts.__test.setProviderFailure(primary, quotaError, {}, { key: 'livePrimary' });
    assert.ok(primary.cooldownUntil - beforePrimaryThird < 310_000);
    assert.equal(primary.cooldownReason, 'quota/rate limit x3');
  } finally {
    health.fallbackQuotaBackoffAfter = originalAfter;
    health.fallbackQuotaBackoffSeconds = originalSeconds;
    health.quotaThirdSeconds = originalThird;
  }
});

test('provider-health settings normalize the fallback quota probe controls', () => {
  const normalized = configTest.normalizeSettings({
    providerHealth: { fallbackQuotaBackoffAfter: 99, fallbackQuotaBackoffSeconds: 1 }
  });
  assert.equal(normalized.providerHealth.fallbackQuotaBackoffAfter, 10);
  assert.equal(normalized.providerHealth.fallbackQuotaBackoffSeconds, 300);
});
"""
if "repeated 2.5 Live quota failures use a long model-specific probe backoff" in text:
    raise SystemExit("regression tests already patched unexpectedly")
tests.write_text(text.rstrip() + append + "\n", encoding="utf-8")
