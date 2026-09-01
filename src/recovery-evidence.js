// Output-audio transcription is useful evidence, but it is not authoritative:
// Gemini can speak the full line while returning a partial transcription. A
// duration estimate is also not authoritative by itself. Tail recovery therefore
// requires corroborating evidence from a strong duration mismatch, playback,
// timeout, or hard-cutoff signal.
export function shouldRecoverTranscriptTail({
  suspiciousTranscript = false,
  strongShort = false,
  playbackFailure = false,
  timedOut = false,
  suspiciousDuration = false,
  playbackSuspicious = false,
  hardPlaybackCutoff = false
} = {}) {
  if (!suspiciousTranscript) return false;
  if (hardPlaybackCutoff || suspiciousDuration || strongShort) return true;
  if (playbackFailure && playbackSuspicious) return true;
  return Boolean(timedOut && (suspiciousDuration || playbackSuspicious));
}
