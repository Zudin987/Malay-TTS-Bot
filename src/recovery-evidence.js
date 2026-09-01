// Output-audio transcription is useful evidence, but it is not authoritative:
// Gemini can speak the full line while returning a partial transcription. Never
// replay a source-text tail from transcription alone. Require independent audio,
// playback, timeout, or provider-failure evidence of a real cutoff.
export function shouldRecoverTranscriptTail({
  suspiciousTranscript = false,
  severeShort = false,
  genuineFailure = false,
  timedOut = false,
  suspiciousDuration = false,
  playbackSuspicious = false,
  hardPlaybackCutoff = false
} = {}) {
  if (!suspiciousTranscript) return false;
  if (genuineFailure || hardPlaybackCutoff || severeShort) return true;
  return Boolean(timedOut && (suspiciousDuration || playbackSuspicious));
}
