/**
 * @fileoverview Client to frame pixel mapping with object-fit:contain letterboxing removed.
 *
 * Plain JavaScript with JSDoc; no dependencies, no DOM access. The canvas paints the
 * frame scaled with object-fit:contain (uniform scale, centered); points inside the
 * letterbox bars or outside the canvas map to null and are never sent.
 */

/**
 * @typedef {Object} ClientToFrameInput
 * @property {unknown} clientX - Pointer client X (CSS px).
 * @property {unknown} clientY - Pointer client Y (CSS px).
 * @property {unknown} rect - Canvas bounding rect (DOMRect-like).
 * @property {unknown} frameWidth - Paint-owned frame width (px).
 * @property {unknown} frameHeight - Paint-owned frame height (px).
 */

/**
 * @typedef {Object} FramePoint
 * @property {number} x - Frame pixel x (0 <= x < frameWidth).
 * @property {number} y - Frame pixel y (0 <= y < frameHeight).
 */

/**
 * @typedef {Object} ContainFit
 * @property {number} scale - Uniform frame-to-box scale.
 * @property {number} width - Displayed frame width (box px).
 * @property {number} height - Displayed frame height (box px).
 * @property {number} offsetX - Left band width (box px).
 * @property {number} offsetY - Top band height (box px).
 */

/**
 * object-fit:contain placement of a frame inside a box: the largest uniform
 * scale that fits both axes, centred, with bands on the free axis. The paint
 * (CSS object-fit:contain, object-position 50% 50%) and the input mapping
 * below share this one transform. Null on non-positive or non-finite sizes.
 *
 * @param {number} boxWidth
 * @param {number} boxHeight
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {ContainFit | null}
 */
export function containFit(boxWidth, boxHeight, frameWidth, frameHeight) {
  for (const value of [boxWidth, boxHeight, frameWidth, frameHeight]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) return null;
  }
  const scale = Math.min(boxWidth / frameWidth, boxHeight / frameHeight);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return { scale, width, height, offsetX: (boxWidth - width) / 2, offsetY: (boxHeight - height) / 2 };
}

/**
 * Maps a client point to frame pixels, or null when outside the frame image.
 *
 * @param {ClientToFrameInput} input
 * @returns {FramePoint | null}
 */
export function mapClientToFrame(input) {
  if (input === null || typeof input !== 'object') return null;
  const clientX = input.clientX;
  const clientY = input.clientY;
  const rect = input.rect;
  const frameWidth = input.frameWidth;
  const frameHeight = input.frameHeight;
  if (typeof clientX !== 'number' || !Number.isFinite(clientX)) return null;
  if (typeof clientY !== 'number' || !Number.isFinite(clientY)) return null;
  // MVUI26 lane I (input RV10-07): safe integers, matching the downstream
  // input-event contract (isNonNegativeInt / scroll validation).
  if (typeof frameWidth !== 'number' || !Number.isSafeInteger(frameWidth) || frameWidth <= 0) return null;
  if (typeof frameHeight !== 'number' || !Number.isSafeInteger(frameHeight) || frameHeight <= 0) return null;
  if (rect === null || typeof rect !== 'object') return null;
  /** @type {any} */
  const r = rect;
  const left = r.left;
  const top = r.top;
  const width = r.width;
  const height = r.height;
  if (typeof left !== 'number' || !Number.isFinite(left)) return null;
  if (typeof top !== 'number' || !Number.isFinite(top)) return null;
  if (typeof width !== 'number' || !Number.isFinite(width) || !(width > 0)) return null;
  if (typeof height !== 'number' || !Number.isFinite(height) || !(height > 0)) return null;
  const fit = containFit(width, height, frameWidth, frameHeight);
  if (fit === null) return null;
  const scale = fit.scale;
  const px = clientX - (left + fit.offsetX);
  const py = clientY - (top + fit.offsetY);
  if (px < 0 || py < 0 || px >= fit.width || py >= fit.height) return null;
  const x = Math.max(0, Math.min(frameWidth - 1, Math.floor(px / scale)));
  const y = Math.max(0, Math.min(frameHeight - 1, Math.floor(py / scale)));
  return { x, y };
}
