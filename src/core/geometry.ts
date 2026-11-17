// 2D geometry in the wall plane (x right, y up, metres).

export type V2 = [number, number];

/** An oriented rectangle: centre, unit long axis u, half length a, half thickness b, and its bounding box. */
export interface Rect {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  a: number;
  b: number;
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
}

export interface Box {
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
}

export function norm(x: number, y: number): V2 {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

export function makeRect(cx: number, cy: number, ux: number, uy: number, a: number, b: number): Rect {
  const ex = Math.abs(ux) * a + Math.abs(uy) * b;
  const ey = Math.abs(uy) * a + Math.abs(ux) * b;
  return { cx, cy, ux, uy, a, b, minx: cx - ex, maxx: cx + ex, miny: cy - ey, maxy: cy + ey };
}

export function axisRect(cx: number, cy: number, w: number, h: number): Rect {
  return makeRect(cx, cy, 1, 0, w / 2, h / 2);
}

/** A w x h rectangle centred at (cx, cy) and turned by `angle` radians. */
export function turnedRect(cx: number, cy: number, w: number, h: number, angle: number): Rect {
  return makeRect(cx, cy, Math.cos(angle), Math.sin(angle), w / 2, h / 2);
}

export function distPointRect(px: number, py: number, r: Rect): number {
  const dx = px - r.cx, dy = py - r.cy;
  const lx = dx * r.ux + dy * r.uy;
  const ly = -dx * r.uy + dy * r.ux;
  const qx = Math.max(Math.abs(lx) - r.a, 0);
  const qy = Math.max(Math.abs(ly) - r.b, 0);
  return Math.hypot(qx, qy);
}

/** True when the two rectangles, each inflated by clr/2, overlap (separating axis test). */
export function rectsOverlap(A: Rect, B: Rect, clr = 0): boolean {
  if (A.maxx + clr < B.minx || B.maxx + clr < A.minx || A.maxy + clr < B.miny || B.maxy + clr < A.miny) return false;
  const axes: V2[] = [[A.ux, A.uy], [-A.uy, A.ux], [B.ux, B.uy], [-B.uy, B.ux]];
  for (const [ax, ay] of axes) {
    const pa = projRadius(A, ax, ay) + clr / 2;
    const pb = projRadius(B, ax, ay) + clr / 2;
    const d = Math.abs((B.cx - A.cx) * ax + (B.cy - A.cy) * ay);
    if (d > pa + pb) return false;
  }
  return true;
}

function projRadius(R: Rect, ax: number, ay: number): number {
  return R.a * Math.abs(R.ux * ax + R.uy * ay) + R.b * Math.abs(-R.uy * ax + R.ux * ay);
}

export function distPointSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const vx = x2 - x1, vy = y2 - y1;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - x1) * vx + (py - y1) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
}

/** Distance from a point to a polyline stored as flat [x0, y0, x1, y1, ...]. */
export function distPointPolyline(px: number, py: number, pts: ArrayLike<number>, bbox: Box | null, cutoff = Infinity): number {
  if (bbox && (px < bbox.minx - cutoff || px > bbox.maxx + cutoff || py < bbox.miny - cutoff || py > bbox.maxy + cutoff)) return Infinity;
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d = distPointSegment(px, py, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
    if (d < best) best = d;
  }
  return best;
}

export function bboxOf(pts: ArrayLike<number>, pad = 0): Box {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minx = Math.min(minx, pts[i]!); maxx = Math.max(maxx, pts[i]!);
    miny = Math.min(miny, pts[i + 1]!); maxy = Math.max(maxy, pts[i + 1]!);
  }
  return { minx: minx - pad, maxx: maxx + pad, miny: miny - pad, maxy: maxy + pad };
}

/** The four corners of a rectangle, counter-clockwise from the lower left. */
export function rectCorners(r: Rect): V2[] {
  const ax = r.ux * r.a, ay = r.uy * r.a, bx = -r.uy * r.b, by = r.ux * r.b;
  return [
    [r.cx - ax - bx, r.cy - ay - by],
    [r.cx + ax - bx, r.cy + ay - by],
    [r.cx + ax + bx, r.cy + ay + by],
    [r.cx - ax + bx, r.cy - ay + by],
  ];
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  const dx = px - r.cx, dy = py - r.cy;
  const lx = dx * r.ux + dy * r.uy;
  const ly = -dx * r.uy + dy * r.ux;
  return Math.abs(lx) <= r.a && Math.abs(ly) <= r.b;
}
