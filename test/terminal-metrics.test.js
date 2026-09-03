import test from 'node:test';
import assert from 'node:assert/strict';
import { recordTtsOutcome, getTtsMetrics, clearTtsMetrics } from '../src/tts-metrics.js';

test('terminal failures before first audio remain visible in bounded status history', () => {
  for (let i = 0; i < 100; i++) recordTtsOutcome('no-audio', 'unavailable');
  recordTtsOutcome('no-audio', 'stopped');
  const report = getTtsMetrics('no-audio');
  assert.equal(report.sampleSize, 0);
  assert.deepEqual(report.outcomes, { finished: 0, stopped: 1, unavailable: 59, sampleSize: 60 });
  clearTtsMetrics('no-audio');
  assert.equal(getTtsMetrics('no-audio').outcomes.sampleSize, 0);
});
