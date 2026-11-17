// The film camera: a smoothed follow of the ball that keeps the whole ball inside the safe part of
// the frame (ported from anthem-bouncing). The stage uses the same model: the camera target is
// (camX, camY - lookDown, 0.2), and the camera sits at target + offset.
import type { V2 } from './geometry.ts';
import { makeBallEvaluator, segPos } from './choreo.ts';
import type { Segment } from './choreo.ts';
import type { AspectName, CameraSettings } from './project.ts';

export interface SafeArea {
  top: number;
  bottom: number;
  side: number;
}

/**
 * Parts of the frame where the ball should not go: the section label at the top and, in 9:16, the
 * UI of Shorts and Reels. Fractions of the frame height from the top and bottom edges.
 */
export const SAFE: Record<AspectName, SafeArea> = {
  landscape: { top: 0.13, bottom: 0.03, side: 0.03 },
  vertical: { top: 0.15, bottom: 0.24, side: 0.04 },
  square: { top: 0.13, bottom: 0.05, side: 0.04 },
  portrait: { top: 0.13, bottom: 0.08, side: 0.04 },
};

export type V3 = [number, number, number];

export interface CameraModel {
  /** NDC of point (px, py, pz) when the camera track is at (cx, cy). */
  project(cx: number, cy: number, px: number, py: number, pz?: number): V2;
  /** Safe area in NDC (y up). */
  box: { x0: number; x1: number; y0: number; y1: number };
  viewHalfW: number;
  viewHalfH: number;
  tanW: number;
  tanH: number;
  /** Camera position minus the target. */
  offset: V3;
}

export function cameraOffset(camera: CameraSettings): V3 {
  const el = (camera.elevationDeg * Math.PI) / 180, yaw = (camera.yawDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(yaw) * camera.distance, Math.sin(el) * camera.distance, Math.cos(el) * Math.cos(yaw) * camera.distance];
}

export function cameraModel(camera: CameraSettings, aspect: number, safe: SafeArea): CameraModel {
  const off = cameraOffset(camera);
  const ol = Math.hypot(...off);
  const fwd = off.map((v) => -v / ol) as V3;
  // right = fwd x up(0,1,0), up' = right x fwd (as three.js lookAt)
  let right: V3 = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(...right);
  right = right.map((v) => v / rl) as V3;
  const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const tanH = Math.tan((camera.fov * Math.PI) / 360);
  const tanW = tanH * aspect;
  const viewHalfH = camera.distance * tanH;
  const viewHalfW = viewHalfH * aspect;
  const box = { x0: -1 + 2 * safe.side, x1: 1 - 2 * safe.side, y0: -1 + 2 * safe.bottom, y1: 1 - 2 * safe.top };
  function project(cx: number, cy: number, px: number, py: number, pz = 0): V2 {
    const pos0 = cx + off[0], pos1 = cy - camera.lookDown + off[1], pos2 = 0.2 + off[2];
    const d0 = px - pos0, d1 = py - pos1, d2 = pz - pos2;
    const z = d0 * fwd[0] + d1 * fwd[1] + d2 * fwd[2];
    return [(d0 * right[0] + d1 * right[1] + d2 * right[2]) / (z * tanW), (d0 * up[0] + d1 * up[1] + d2 * up[2]) / (z * tanH)];
  }
  return { project, box, viewHalfW, viewHalfH, tanW, tanH, offset: off };
}

export const CAM_HZ = 60;

export interface CameraTrackArgs {
  segments: Segment[];
  duration: number;
  holdT: number;
  camera: CameraSettings;
  view: CameraModel;
  ballR: number;
  ballZ: number;
  /** Centres of featured ornaments: the camera leans towards them as the ball goes by. */
  featured: V2[];
}

/** Camera track (60 Hz, zero-phase smoothed). */
export function cameraTrack({ segments, duration, holdT, camera, view, ballR, ballZ, featured }: CameraTrackArgs): V2[] {
  const segAt = makeBallEvaluator(segments);
  const nCam = Math.ceil(duration * CAM_HZ) + 2;
  const raw: V2[] = [];
  for (let i = 0; i < nCam; i++) {
    const t = Math.min(i / CAM_HZ, holdT);
    raw.push(segPos(segAt(t), t));
  }
  const alpha = 1 - Math.exp(-1 / CAM_HZ / camera.smoothing);
  const smooth = (arr: V2[]): V2[] => {
    const f = arr.map((p) => [p[0], p[1]] as V2);
    for (let i = 1; i < f.length; i++) for (let d = 0; d < 2; d++) f[i]![d] = f[i - 1]![d]! + alpha * (f[i]![d]! - f[i - 1]![d]!);
    for (let i = f.length - 2; i >= 0; i--) for (let d = 0; d < 2; d++) f[i]![d] = f[i + 1]![d]! + alpha * (f[i]![d]! - f[i + 1]![d]!);
    return f;
  };
  let cam = smooth(raw);
  // lean towards a featured ornament while the ball passes it, so it stays in frame longer
  const pull = camera.framePictures;
  if (pull > 0 && featured.length) {
    const reach = view.viewHalfH * 2.2;
    cam = cam.map(([x, y]) => {
      let dx = 0, dy = 0;
      for (const [fx, fy] of featured) {
        const vx = fx - x, vy = fy - y, dist = Math.hypot(vx, vy);
        const w = pull * Math.max(0, Math.min(1, (reach - dist) / (reach * 0.5)));
        dx += w * vx; dy += w * vy;
      }
      return [x + dx, y + dy] as V2;
    });
    cam = smooth(cam);
  }
  // Keep the whole ball inside the safe part of the frame, with the real perspective projection: a
  // few soft passes on a tighter box, each re-smoothed, then one exact pass.
  const rx = ballR / (camera.distance * view.tanW) + 0.03;
  const ry = ballR / (camera.distance * view.tanH) + 0.03;
  const { box } = view;
  const fit = (track: V2[], shrink: number): V2[] => track.map((c, i) => {
    const [bx, by] = raw[i]!;
    let [x, y] = c;
    const lo = [box.x0 + rx + shrink, box.y0 + ry + shrink], hi = [box.x1 - rx - shrink, box.y1 - ry - shrink];
    for (let it = 0; it < 4; it++) {
      const [u, v] = view.project(x, y, bx, by, ballZ);
      const tu = Math.max(lo[0]!, Math.min(hi[0]!, u)), tv = Math.max(lo[1]!, Math.min(hi[1]!, v));
      if (Math.abs(tu - u) < 1e-4 && Math.abs(tv - v) < 1e-4) break;
      // Newton step on the camera shift (numerical 2x2 Jacobian of the ball's screen position)
      const e = 1e-3;
      const [ux, vx] = view.project(x + e, y, bx, by, ballZ), [uy, vy] = view.project(x, y + e, bx, by, ballZ);
      const a = (ux - u) / e, b = (uy - u) / e, cc = (vx - v) / e, d = (vy - v) / e, det = a * d - b * cc;
      const du = tu - u, dv = tv - v;
      x += (d * du - b * dv) / det; y += (a * dv - cc * du) / det;
    }
    return [x, y] as V2;
  });
  // The shift that each sample needs is spread over its neighbours with a smooth bump (a dilation,
  // so the shift is never smaller than needed), then lightly smoothed: the camera eases into each
  // correction instead of snapping.
  const half = Math.round(CAM_HZ * 0.55);
  const bump = Array.from({ length: half + 1 }, (_, k) => 0.5 * (1 + Math.cos((Math.PI * k) / (half + 1))));
  const lightAlpha = 1 - Math.exp(-1 / CAM_HZ / 0.1);
  const dilate = (delta: V2[], d: number, sign: number) => {
    const out = new Float64Array(delta.length);
    for (let i = 0; i < delta.length; i++) {
      const v = sign * delta[i]![d]!;
      if (v <= 0) continue;
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j >= 0 && j < out.length) out[j] = Math.max(out[j]!, v * bump[Math.abs(k)]!);
      }
    }
    return out;
  };
  for (let pass = 0; pass < 3; pass++) {
    const target = fit(cam, 0.06);
    const delta = target.map((p, i) => [p[0] - cam[i]![0], p[1] - cam[i]![1]] as V2);
    if (!delta.some(([dx, dy]) => Math.abs(dx) + Math.abs(dy) > 1e-5)) break;
    const corr = [0, 1].map((d) => {
      const pos = dilate(delta, d, 1), neg = dilate(delta, d, -1);
      return Array.from(pos, (v, i) => v - neg[i]!);
    });
    const shift = corr[0]!.map((v, i) => [v, corr[1]![i]!] as V2);
    for (let i = 1; i < shift.length; i++) for (let d = 0; d < 2; d++) shift[i]![d] = shift[i - 1]![d]! + lightAlpha * (shift[i]![d]! - shift[i - 1]![d]!);
    for (let i = shift.length - 2; i >= 0; i--) for (let d = 0; d < 2; d++) shift[i]![d] = shift[i + 1]![d]! + lightAlpha * (shift[i]![d]! - shift[i + 1]![d]!);
    cam = cam.map((c, i) => [c[0] + shift[i]![0], c[1] + shift[i]![1]] as V2);
  }
  return fit(cam, 0);
}

/** Linear interpolation in a flat track of `stride` values per sample at `hz`. */
export function sampleTrack(track: ArrayLike<number>, hz: number, stride: number, t: number, out: number[] = []): number[] {
  const n = track.length / stride;
  const f = Math.max(0, Math.min(t * hz, n - 1.000001));
  const i = Math.floor(f), k = f - i;
  for (let d = 0; d < stride; d++) out[d] = track[i * stride + d]! * (1 - k) + track[(i + 1) * stride + d]! * k;
  return out;
}
