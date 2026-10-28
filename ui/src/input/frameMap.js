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
  if (typeof frameWidth !== 'number' || !Number.isInteger(frameWidth) || frameWidth <= 0) return null;
  if (typeof frameHeight !== 'number' || !Number.isInteger(frameHeight) || frameHeight <= 0) return null;
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
  const scale = Math.min(width / frameWidth, height / frameHeight);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const displayedWidth = frameWidth * scale;
  const displayedHeight = frameHeight * scale;
  const originX = left + (width - displayedWidth) / 2;
  const originY = top + (height - displayedHeight) / 2;
  const px = clientX - originX;
  const py = clientY - originY;
  if (px < 0 || py < 0 || px >= displayedWidth || py >= displayedHeight) return null;
  const x = Math.max(0, Math.min(frameWidth - 1, Math.floor(px / scale)));
  const y = Math.max(0, Math.min(frameHeight - 1, Math.floor(py / scale)));
  return { x, y };
}
