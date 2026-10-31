/**
 * REC-STATE tile badge copy: phase word, live `mm:ss` while recording and the
 * typed reason when a capture action was refused or a recording failed.
 * Pure; the wall keeps the DOM ids, anchors and variants (wall/tileCapture.js).
 *
 * @module recording/recordingBadge
 */
import { formatElapsedClock } from './recordingClock.js';
import { mvCaptureRefusalText } from './recordingModel.js';

/**
 * @param {{ phase?: unknown, elapsedMs?: number | null, code?: unknown }} input Phase, live elapsed (ms or null) and last code.
 * @returns {{ text: string, title: string, reason: string }} Visible text, tooltip and reason copy ('' when none).
 */
export function recordingBadgeCopy(input) {
  const phase = input.phase;
  const reason = mvCaptureRefusalText(typeof input.code === 'string' ? input.code : '');
  let head = 'Idle';
  if (phase === 'recording') head = `Recording ${formatElapsedClock(input.elapsedMs)}`;
  else if (phase === 'starting') head = 'Starting';
  else if (phase === 'stopping') head = 'Stopping';
  else if (phase === 'sealed') head = 'Sealed';
  return {
    text: reason ? `${head} — ${reason}` : head,
    title: reason || `Phase ${typeof phase === 'string' ? phase : 'idle'}`,
    reason,
  };
}
