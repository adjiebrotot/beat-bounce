// The footprint of each ornament on the wall: the stage draws it, the planner keeps bars clear of
// it, and the placement tool picks and drags it. All sizes are metres; the origin of an ornament is
// the centre of its whole footprint (a photo with its caption plate, a sticker, a text block).
import { turnedRect } from './geometry.ts';
import type { Rect } from './geometry.ts';
import { CROPS } from './project.ts';
import type { Ornament, PhotoOrnament, StickerOrnament } from './project.ts';

export interface PhotoLayout {
  picW: number;
  picH: number;
  /** Width of the mat around the picture. */
  mat: number;
  /** Width of the frame moulding around the mat. */
  frameW: number;
  /** Size of the framed block (frame, mat and picture). */
  outerW: number;
  outerH: number;
  /** Centre of the framed block, relative to the footprint centre. */
  outerCy: number;
  /** Centre of the picture, relative to the centre of the framed block. */
  picDy: number;
  /** Polaroid borders (0 for the other styles). */
  border: { side: number; top: number; bottom: number };
  /** Caption plate below the frame (0 x 0 when there is no plate). */
  plateW: number;
  plateH: number;
  plateCy: number;
  captionSize: number;
  totalW: number;
  totalH: number;
}

export function photoAspect(o: PhotoOrnament): number {
  return CROPS[o.crop] ?? (o.imageAspect > 0 ? o.imageAspect : 4 / 3);
}

export function photoLayout(o: PhotoOrnament): PhotoLayout {
  const picW = o.width;
  const picH = picW / photoAspect(o);
  const captionSize = Math.max(0.07, Math.min(0.2, 0.075 * picW));
  if (o.frame === 'polaroid') {
    const side = 0.06 * picW, top = side, bottom = 0.26 * picW;
    const outerW = picW + 2 * side, outerH = picH + top + bottom;
    return {
      picW, picH, mat: 0, frameW: 0, outerW, outerH, outerCy: 0, picDy: (bottom - top) / 2,
      border: { side, top, bottom }, plateW: 0, plateH: 0, plateCy: 0, captionSize, totalW: outerW, totalH: outerH,
    };
  }
  const mat = Math.max(0, o.mat);
  const frameW = o.frame === 'none' || o.frame === 'canvas' ? 0 : Math.max(0.01, o.frameWidth);
  const outerW = picW + 2 * mat + 2 * frameW;
  const outerH = picH + 2 * mat + 2 * frameW;
  let plateW = 0, plateH = 0, gap = 0;
  if (o.caption.trim()) {
    plateH = captionSize * 1.6;
    plateW = Math.min(outerW * 0.95, [...o.caption].length * captionSize * 0.56 + 0.3);
    gap = 0.07;
  }
  const totalH = outerH + gap + plateH;
  return {
    picW, picH, mat, frameW, outerW, outerH, outerCy: (gap + plateH) / 2, picDy: 0, border: { side: 0, top: 0, bottom: 0 },
    plateW, plateH, plateCy: -totalH / 2 + plateH / 2, captionSize, totalW: outerW, totalH,
  };
}

/** Width of the die-cut border of a sticker, metres. */
export function stickerBorder(o: StickerOrnament): number {
  return Math.max(0, Math.min(0.2, o.border)) * o.width;
}

/** Width and height of the footprint of an ornament. */
export function ornamentSize(o: Ornament): { w: number; h: number } {
  if (o.kind === 'photo') {
    const L = photoLayout(o);
    return { w: L.totalW, h: L.totalH };
  }
  if (o.kind === 'sticker') {
    // the die-cut border goes around the picture: width = picture + 2 borders
    const b = stickerBorder(o);
    return { w: o.width, h: (o.width - 2 * b) / Math.max(0.05, o.imageAspect || 1) + 2 * b };
  }
  return { w: o.width, h: o.width / Math.max(0.05, o.textAspect || 1) };
}

/** The footprint as an oriented rectangle on the wall, grown by `pad` metres on each side. */
export function ornamentRect(o: Ornament, pad = 0): Rect {
  const { w, h } = ornamentSize(o);
  return turnedRect(o.x, o.y, w + 2 * pad, h + 2 * pad, (o.rotation * Math.PI) / 180);
}
