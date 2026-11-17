// Choreography planner (ported from anthem-bouncing): places one bar on the wall for each melody hit,
// so that a ball under gravity reaches each bar exactly at the note time, with no collisions.
//
// Coordinates: wall plane, x right, y up, metres. All times are VIDEO seconds.
import {
  norm, wrapAngle, makeRect, distPointRect, rectsOverlap, distPointPolyline, bboxOf,
} from './geometry.ts';
import type { Box, Rect, V2 } from './geometry.ts';
import type { Rand } from './rng.ts';

const SAMPLE_DT = 1 / 120;

export interface WorldConfig {
  gravity: number;
  ballRadius: number;
  ballZ: number;
  barThickness: number;
  barDepth: number;
  barLength: [number, number]; // [highest pitch, lowest pitch]
  clearance: number;
  laneHalfWidth: number;
  laneDrift: number; // metres per second the lane centre moves sideways
  maxTiltDeg: number;
  maxBacktracks: number;
  scoreWindow: number;
}

export interface RailConfig {
  enabled: boolean;
  minGap: number; // gaps longer than this (s) use a rolling rail instead of one big arc
  maxRailTime: number; // longer gaps become a zig-zag chain of rails
  speed: number; // rolling speed on the rail (m/s)
  slopeDeg: [number, number];
  turnRadius: number;
  tubeRadius: number;
  gauge: number; // distance between the two rods (z)
}

export const DEFAULT_WORLD: WorldConfig = {
  gravity: 6.0,
  ballRadius: 0.12,
  ballZ: 0.32,
  barThickness: 0.085,
  barDepth: 0.3,
  barLength: [0.55, 0.95],
  clearance: 0.05,
  laneHalfWidth: 2.6,
  laneDrift: 0,
  maxTiltDeg: 70,
  maxBacktracks: 4000,
  scoreWindow: 8,
};

export const DEFAULT_RAILS: RailConfig = {
  enabled: true,
  minGap: 1.45,
  maxRailTime: 4.5,
  speed: 1.25,
  slopeDeg: [6, 10],
  turnRadius: 0.55,
  tubeRadius: 0.018,
  gauge: 0.12,
};

export interface FlightSeg { type: 'flight'; t0: number; t1: number; p0: V2; v0: V2; g: number }
export interface RestSeg { type: 'rest'; t0: number; t1: number; p: V2 }
export interface RailSeg { type: 'rail'; t0: number; t1: number; path: number[]; ds: number; v0: number; vr: number; tau: number; dir: number }
export type Segment = FlightSeg | RestSeg | RailSeg;

export interface RailPiece { tube: number[]; bbox: Box; t0: number; t1: number; dir: number; intro?: boolean }

interface Sample { x: number; y: number; t: number; ownRail?: RailPiece; nearRails?: RailPiece[] }

export interface Hit {
  t: number;
  pitchNorm: number;
  lengthScale: number;
  thicknessScale: number;
  offsetRand: number;
}

/** A reserved wall area (a picture): no bar or rail may be mounted there; the ball may fly in front. */
export type Obstacle = Rect;

/** A zone where the ball takes shallower drops, so it lingers (and the camera with it). */
export interface DwellZone extends Box { factor: number }

export interface PlannedPaddle {
  hit: number;
  t: number;
  cx: number;
  cy: number;
  angle: number;
  len: number;
  thick: number;
  nx: number;
  ny: number;
}

export interface Choreography {
  segments: Segment[];
  paddles: PlannedPaddle[];
  rails: RailPiece[];
  world: WorldConfig;
  railCfg: RailConfig;
  warnings: string[];
  stats: { backtracks: number; forced: number };
  samples: Sample[];
}

// ---------------------------------------------------------------------------------------------
// Motion segments

export function flightPos(seg: FlightSeg, t: number): V2 {
  const dt = t - seg.t0;
  return [seg.p0[0] + seg.v0[0] * dt, seg.p0[1] + seg.v0[1] * dt - 0.5 * seg.g * dt * dt];
}

export function flightVel(seg: FlightSeg, t: number): V2 {
  return [seg.v0[0], seg.v0[1] - seg.g * (t - seg.t0)];
}

function railS(seg: RailSeg, t: number): number {
  const u = Math.max(0, Math.min(t - seg.t0, seg.t1 - seg.t0));
  return seg.vr * u + (seg.v0 - seg.vr) * seg.tau * (1 - Math.exp(-u / seg.tau));
}

function railSpeed(seg: RailSeg, t: number): number {
  const u = Math.max(0, Math.min(t - seg.t0, seg.t1 - seg.t0));
  return seg.vr + (seg.v0 - seg.vr) * Math.exp(-u / seg.tau);
}

function railPathAt(path: number[], ds: number, s: number): [number, number, number, number] {
  const n = path.length / 2 - 1;
  const f = Math.max(0, Math.min(s / ds, n));
  const i = Math.min(Math.floor(f), n - 1);
  const k = f - i;
  const x = path[2 * i]! + (path[2 * i + 2]! - path[2 * i]!) * k;
  const y = path[2 * i + 1]! + (path[2 * i + 3]! - path[2 * i + 1]!) * k;
  const tx = path[2 * i + 2]! - path[2 * i]!, ty = path[2 * i + 3]! - path[2 * i + 1]!;
  return [x, y, ...norm(tx, ty)];
}

export function segPos(seg: Segment, t: number): V2 {
  if (seg.type === 'flight') return flightPos(seg, t);
  if (seg.type === 'rest') return [seg.p[0], seg.p[1]];
  const [x, y] = railPathAt(seg.path, seg.ds, railS(seg, t));
  return [x, y];
}

/** Signed angular velocity (rad/s about +z) of a ball that rolls or flies in this segment. */
export function segSpin(seg: Segment, t: number, r: number): number {
  if (seg.type === 'flight') return -flightVel(seg, t)[0] / r;
  if (seg.type === 'rest') return 0;
  const [, , tx] = railPathAt(seg.path, seg.ds, railS(seg, t));
  return (-Math.sign(tx || seg.dir) * railSpeed(seg, t)) / r;
}

// ---------------------------------------------------------------------------------------------
// Rails

interface BuildRailArgs {
  q: V2; vin: V2; dir: number; slope: number; T: number; vr: number; v0: number; tau: number; R: number;
  ballR: number; railCfg: RailConfig; t0: number;
}

/**
 * Builds a rail that the ball lands on at point q with velocity vin. The rail curves (like a bowl)
 * into a gentle slope in direction dir, and the ball rolls for T seconds. Null if the shape does not work.
 */
function buildRail({ q, vin, dir, slope, T, vr, v0, tau, R, ballR, railCfg, t0 }: BuildRailArgs) {
  const phi1 = Math.atan2(-Math.sin(slope), dir * Math.cos(slope));
  const speedIn = Math.hypot(vin[0], vin[1]);
  const phi0 = speedIn > 1e-6 ? Math.atan2(vin[1], vin[0]) : phi1;
  const dphi = wrapAngle(phi1 - phi0);
  if (dir * dphi < -0.3) return null; // would need a hump; the ball would leave the rail
  const L = vr * T + (v0 - vr) * tau * (1 - Math.exp(-T / tau));
  if (L < 0.3) return null;
  let radius = R;
  if (Math.abs(dphi) * radius > 0.6 * L) radius = (0.6 * L) / Math.abs(dphi);
  if (Math.abs(dphi) > 0.05 && radius < 0.18) return null;
  const ds = 0.03;
  const n = Math.max(2, Math.ceil(L / ds));
  const step = L / n;
  const path: number[] = [];
  const tube: number[] = [];
  const arcLen = Math.abs(dphi) * radius;
  const off = Math.sqrt(Math.max(1e-6, (ballR + railCfg.tubeRadius) ** 2 - (railCfg.gauge / 2) ** 2));
  let x = q[0], y = q[1], phi = phi0;
  for (let i = 0; i <= n; i++) {
    const s = i * step;
    if (i > 0) {
      const sPrev = (i - 1) * step;
      const sMid = (s + sPrev) / 2;
      const phiMid = arcLen > 1e-6 && sMid < arcLen ? phi0 + dphi * (sMid / arcLen) : phi1;
      x += Math.cos(phiMid) * step;
      y += Math.sin(phiMid) * step;
      phi = arcLen > 1e-6 && s < arcLen ? phi0 + dphi * (s / arcLen) : phi1;
    }
    path.push(x, y);
    const tx = Math.cos(phi), ty = Math.sin(phi);
    // the rail is on the "down" side of travel
    const nx = dir > 0 ? ty : -ty;
    const ny = dir > 0 ? -tx : tx;
    tube.push(x + nx * off, y + ny * off);
  }
  const seg: RailSeg = { type: 'rail', t0, t1: t0 + T, path, ds: step, v0, vr, tau, dir };
  const exitSpeed = railSpeed(seg, t0 + T);
  const exitP: V2 = [path[path.length - 2]!, path[path.length - 1]!];
  const exitV: V2 = [Math.cos(phi1) * exitSpeed, Math.sin(phi1) * exitSpeed];
  const rail: RailPiece = { tube, bbox: bboxOf(tube, 0.05), t0, t1: t0 + T, dir };
  return { seg, rail, exitP, exitV };
}

// ---------------------------------------------------------------------------------------------
// World / collision bookkeeping

class World {
  paddles: Paddle[] = [];
  rails: RailPiece[] = [];
  samples: Sample[] = [];
  mark(): [number, number, number] { return [this.paddles.length, this.rails.length, this.samples.length]; }
  reset(m: [number, number, number]) {
    this.paddles.length = m[0];
    this.rails.length = m[1];
    this.samples.length = m[2];
  }
}

interface Paddle { k: number; t: number; prevT: number; rect: Rect; nx: number; ny: number; contact: V2 }

function sampleSegment(seg: Segment, from: number, to: number, out: Sample[]) {
  const n = Math.max(1, Math.ceil((to - from) / SAMPLE_DT));
  for (let i = 1; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    const [x, y] = segPos(seg, t);
    out.push({ x, y, t });
  }
}

interface State { p: V2; vin: V2; dir: number }
interface FlightCand { kind: 'flight'; vout: V2; score: number; dir: number }
interface RailCand { kind: 'rail'; vout: V2; tau1: number; tau2: number; slope: number; nRails: number; score: number; dir: number }
type Cand = FlightCand | RailCand;
interface Proposal { k: number; pad: Paddle; segs: Segment[]; newRails: RailPiece[]; samples: Sample[]; next: State }
interface StackEntry { state: State; cands: Cand[]; idx: number; mark: [number, number, number]; isLast: boolean; chosen?: Proposal }

export interface ChoreoOptions {
  world: WorldConfig;
  rails: RailConfig;
  rand: Rand;
  intro: { start: V2; rollStart: number; flight: number; dir: number };
  obstacles: Obstacle[];
  dwell: DwellZone[];
  outroCheck?: number;
}

/** hits: sorted by time (video seconds). */
export function planChoreography(hits: Hit[], opts: ChoreoOptions): Choreography {
  const W = opts.world;
  const RC = opts.rails;
  const rand = opts.rand;
  const G = W.gravity;
  const r = W.ballRadius;
  const b = W.barThickness / 2;
  const clr = W.clearance;
  const maxTilt = (W.maxTiltDeg * Math.PI) / 180;
  const world = new World();
  const warnings: string[] = [];
  const segments: Segment[] = [];
  const railsOut: RailPiece[] = [];

  // --- intro: the ball rests on a short ramp, rolls off and drops onto the first bar --------------
  const first = hits[0]!;
  const intro = opts.intro;
  const introFlight = intro.flight;
  const rollStart = intro.rollStart;
  const rollT = first.t - introFlight - rollStart;
  if (rollT < 0.4) throw new Error('The intro is too short.');
  const start = intro.start;
  const introDir = intro.dir;
  const ramp = buildRail({
    q: start, vin: [0, 0], dir: introDir, slope: (14 * Math.PI) / 180, T: rollT, vr: 1.6, v0: 0, tau: 0.55,
    R: RC.turnRadius, ballR: r, railCfg: RC, t0: rollStart,
  });
  if (!ramp) throw new Error('Could not build the start ramp.');
  segments.push({ type: 'rest', t0: 0, t1: rollStart, p: start });
  segments.push(ramp.seg);
  ramp.rail.intro = true;
  world.rails.push(ramp.rail);
  railsOut.push(ramp.rail);
  const introFl: FlightSeg = { type: 'flight', t0: ramp.seg.t1, t1: first.t, p0: ramp.exitP, v0: ramp.exitV, g: G };
  segments.push(introFl);
  sampleSegment(ramp.seg, rollStart, ramp.seg.t1, world.samples);
  sampleSegment(introFl, introFl.t0, introFl.t1, world.samples);
  world.samples.forEach((s) => (s.ownRail = ramp.rail));

  const initState: State = { p: flightPos(introFl, first.t), vin: flightVel(introFl, first.t), dir: introDir };

  const barHalfLen = (h: Hit) => {
    const [hi, lo] = W.barLength;
    return ((lo + (hi - lo) * h.pitchNorm) * h.lengthScale) / 2;
  };

  function makePaddle(k: number, p: V2, vin: V2, vout: V2): Paddle | null {
    const h = hits[k]!;
    const [nx, ny] = norm(vout[0] - vin[0], vout[1] - vin[1]);
    if (ny < Math.cos(maxTilt)) return null; // too steep
    const ux = ny, uy = -nx;
    // fast passages get shorter bars so they can be packed closely
    const dPrev = k > 0 ? h.t - hits[k - 1]!.t : 1;
    const dNext = k + 1 < hits.length ? hits[k + 1]!.t - h.t : 1;
    const fast = Math.min(1, Math.max(0.5, 0.45 + 0.55 * (Math.min(dPrev, dNext) / 0.4)));
    const a = barHalfLen(h) * fast;
    const bb = h.thicknessScale * b;
    // hit the bar near the end that faces the incoming ball, so the bar extends away from the previous one
    const dirIn = Math.sign(vin[0]) || 1;
    const offset = (0.45 + 0.15 * h.offsetRand) * a * dirIn * Math.sign(ux || 1);
    const cx = p[0] - nx * (r + bb) + ux * offset;
    const cy = p[1] - ny * (r + bb) + uy * offset;
    const rect = makeRect(cx, cy, ux, uy, a, bb);
    return { k, t: h.t, prevT: k > 0 ? hits[k - 1]!.t : -Infinity, rect, nx, ny, contact: p };
  }

  // ---- validity checks ----------------------------------------------------------------------------
  const obstacles = opts.obstacles;
  const hitsObstacle = (R: Rect) => obstacles.some((o) => rectsOverlap(R, o, clr));

  function paddleOk(pad: Paddle, newRails: RailPiece[]): boolean {
    const R = pad.rect;
    if (hitsObstacle(R)) return false;
    for (const q of world.paddles) if (rectsOverlap(R, q.rect, clr * 1.2)) return false;
    for (const rl of [...world.rails, ...newRails]) {
      if (R.maxx + 0.3 < rl.bbox.minx || R.minx - 0.3 > rl.bbox.maxx || R.maxy + 0.3 < rl.bbox.miny || R.miny - 0.3 > rl.bbox.maxy) continue;
      for (let i = 0; i < rl.tube.length; i += 2) {
        if (distPointRect(rl.tube[i]!, rl.tube[i + 1]!, R) < RC.tubeRadius + clr) return false;
      }
    }
    const lim = r + clr;
    for (const s of world.samples) {
      if (s.x < R.minx - lim || s.x > R.maxx + lim || s.y < R.miny - lim || s.y > R.maxy + lim) continue;
      const d = distPointRect(s.x, s.y, R);
      // the flight that arrives at this bar only has to miss it (it ends touching it)
      const near = s.t > pad.prevT - 1e-6;
      if (d < (near ? r - 0.006 : lim)) return false;
    }
    return true;
  }

  function railOk(rl: RailPiece, pad: Paddle, otherNew: RailPiece[]): boolean {
    const lim = RC.tubeRadius + clr;
    for (const o of obstacles) {
      if (o.maxx + lim < rl.bbox.minx || o.minx - lim > rl.bbox.maxx || o.maxy + lim < rl.bbox.miny || o.miny - lim > rl.bbox.maxy) continue;
      for (let i = 0; i < rl.tube.length; i += 2) if (distPointRect(rl.tube[i]!, rl.tube[i + 1]!, o) < lim) return false;
    }
    for (const q of [...world.paddles, pad]) {
      const R = q.rect;
      if (R.maxx + 0.3 < rl.bbox.minx || R.minx - 0.3 > rl.bbox.maxx || R.maxy + 0.3 < rl.bbox.miny || R.miny - 0.3 > rl.bbox.maxy) continue;
      for (let i = 0; i < rl.tube.length; i += 2) if (distPointRect(rl.tube[i]!, rl.tube[i + 1]!, R) < lim) return false;
    }
    for (const o of [...world.rails, ...otherNew]) {
      if (o === rl) continue;
      if (o.bbox.maxx < rl.bbox.minx - 0.4 || o.bbox.minx > rl.bbox.maxx + 0.4 || o.bbox.maxy < rl.bbox.miny - 0.4 || o.bbox.miny > rl.bbox.maxy + 0.4) continue;
      for (let i = 0; i < rl.tube.length; i += 4) {
        if (distPointPolyline(rl.tube[i]!, rl.tube[i + 1]!, o.tube, o.bbox, 0.4) < 2 * r + 0.08) return false;
      }
    }
    const sl = r + RC.tubeRadius + clr + 0.03;
    for (const s of world.samples) {
      if (s.x < rl.bbox.minx - sl || s.x > rl.bbox.maxx + sl || s.y < rl.bbox.miny - sl || s.y > rl.bbox.maxy + sl) continue;
      if (distPointPolyline(s.x, s.y, rl.tube, null) < sl) return false;
    }
    return true;
  }

  function samplesOk(samples: Sample[], pad: Paddle, newRails: RailPiece[]): boolean {
    const lim = r + clr;
    for (const s of samples) {
      for (const q of world.paddles) {
        const R = q.rect;
        if (s.x < R.minx - lim || s.x > R.maxx + lim || s.y < R.miny - lim || s.y > R.maxy + lim) continue;
        if (distPointRect(s.x, s.y, R) < lim) return false;
      }
      const d = distPointRect(s.x, s.y, pad.rect);
      if (d < r - 0.006) return false; // leaving this bar: must just not pass through it
      for (const rl of [...world.rails, ...newRails]) {
        if (s.ownRail === rl || (s.nearRails && s.nearRails.includes(rl))) continue;
        if (distPointPolyline(s.x, s.y, rl.tube, rl.bbox, r + 0.2) < r + RC.tubeRadius + clr) return false;
      }
    }
    return true;
  }

  // ---- candidate generation ---------------------------------------------------------------------
  const laneCenter = (t: number) => W.laneDrift * t;

  function commonScore(state: State, vout: V2, endX: number, endT: number): number {
    const vin = state.vin;
    const sIn = Math.hypot(vin[0], vin[1]);
    const sOut = Math.hypot(vout[0], vout[1]);
    const ratio = sOut / Math.max(sIn, 0.3);
    if (ratio > 2.6 || ratio < 0.25) return Infinity;
    const [, ny] = norm(vout[0] - vin[0], vout[1] - vin[1]);
    const tilt = Math.acos(Math.max(-1, Math.min(1, ny)));
    if (tilt > maxTilt) return Infinity;
    let score = 0;
    score += 1.2 * Math.log(ratio) ** 2;
    score += 1.5 * (tilt / maxTilt) ** 4;
    const off = Math.abs(endX - laneCenter(endT)) - W.laneHalfWidth;
    if (off > 0) score += 0.8 * off * off;
    return score;
  }

  function flightCandidates(k: number, state: State): FlightCand[] {
    const t0 = hits[k]!.t;
    const t1 = hits[k + 1]!.t;
    const dt = t1 - t0;
    // near a picture the ball takes shallower drops, so it lingers (and the camera with it)
    const p = state.p;
    const dwell = opts.dwell.reduce((f, z) => (p[0] >= z.minx && p[0] <= z.maxx && p[1] >= z.miny && p[1] <= z.maxy ? Math.min(f, z.factor) : f), 1);
    const target = Math.min(1.5, Math.max(0.28, 0.3 + 1.05 * dt)) * dwell;
    const out: FlightCand[] = [];
    const sameCost = rand() * 0.9 - 0.25; // random preference for keeping or switching direction
    for (const s of [1, -1]) {
      for (const vx of [0.45, 0.7, 1.0, 1.35, 1.8, 2.4, 3.2, 4.2, 5.4]) {
        for (const f of [-0.35, -0.1, 0.15, 0.4, 0.65, 0.85, 1.0, 1.2, 1.5, 1.9, 2.5]) {
          const drop = f * target;
          const vy = (0.5 * G * dt * dt - drop) / dt;
          const vout: V2 = [s * vx, vy];
          const endX = state.p[0] + s * vx * dt;
          let score = commonScore(state, vout, endX, t1);
          if (!Number.isFinite(score)) continue;
          score += 2.0 * ((drop - target) / target) ** 2;
          score += 0.25 * ((vx * dt - 0.75) / 0.75) ** 2;
          const apex = vy > 0 ? (vy * vy) / (2 * G) : 0;
          if (apex > 1.4) score += (apex - 1.4) * 3;
          if (s === state.dir) score += sameCost;
          // avoid grazing arrivals (a very flat incoming angle makes the next bar awkward)
          const vyEnd = vy - G * dt;
          if (Math.abs(vyEnd) < 0.6 * vx) score += 0.8 * (1 - Math.abs(vyEnd) / (0.6 * vx));
          score += rand() * 0.35;
          out.push({ kind: 'flight', vout, score, dir: s });
        }
      }
    }
    return out.sort((a, b2) => a.score - b2.score);
  }

  function railCandidates(k: number, state: State): RailCand[] {
    const t0 = hits[k]!.t;
    const t1 = hits[k + 1]!.t;
    const dt = t1 - t0;
    const out: RailCand[] = [];
    const slopes = RC.slopeDeg.map((d) => (d * Math.PI) / 180);
    for (const s of [1, -1]) {
      for (const vx of [0.7, 1.2, 1.8]) {
        for (const vy of [0.4, 1.3, 2.2]) {
          for (const tau1 of [0.38, 0.55]) {
            for (const tau2 of [0.3, 0.45]) {
              for (const slope of slopes) {
                const vout: V2 = [s * vx, vy];
                const vland: V2 = [vout[0], vy - G * tau1];
                if (vland[1] > -0.5) continue;
                const roll = dt - tau1 - tau2;
                if (roll < 0.35) continue;
                const nRails = Math.max(1, Math.ceil(roll / RC.maxRailTime));
                const exitGuess = state.p[0] + s * (vx * tau1 + RC.speed * Math.min(roll, RC.maxRailTime));
                let score = commonScore(state, vout, nRails % 2 ? exitGuess : state.p[0], t1);
                if (!Number.isFinite(score)) continue;
                score += rand() * 0.4;
                out.push({ kind: 'rail', vout, tau1, tau2, slope, nRails, score, dir: s });
              }
            }
          }
        }
      }
    }
    return out.sort((a, b2) => a.score - b2.score);
  }

  /** Turns a candidate into concrete segments and rails; null if it does not work. */
  function realise(k: number, state: State, c: Cand, isLast: boolean): Proposal | null {
    const t0 = hits[k]!.t;
    const t1 = isLast ? t0 + (opts.outroCheck ?? 0.9) : hits[k + 1]!.t;
    const pad = makePaddle(k, state.p, state.vin, c.vout);
    if (!pad) return null;
    const segs: Segment[] = [];
    const newRails: RailPiece[] = [];
    const samples: Sample[] = [];
    if (c.kind === 'flight') {
      const seg: FlightSeg = { type: 'flight', t0, t1, p0: state.p, v0: c.vout, g: G };
      segs.push(seg);
      sampleSegment(seg, t0, t1, samples);
      const next: State = { p: flightPos(seg, t1), vin: flightVel(seg, t1), dir: c.dir };
      return { k, pad, segs, newRails, samples, next };
    }
    // rail chain
    const roll = t1 - t0 - c.tau1 - c.tau2;
    const between = 0.42;
    const n = c.nRails;
    const each = (roll - (n - 1) * between) / n;
    if (each < 0.35) return null;
    let seg: FlightSeg = { type: 'flight', t0, t1: t0 + c.tau1, p0: state.p, v0: c.vout, g: G };
    segs.push(seg);
    sampleSegment(seg, seg.t0, seg.t1, samples);
    let t = seg.t1;
    let dir = c.dir;
    for (let j = 0; j < n; j++) {
      const q = flightPos(seg, t);
      const vin = flightVel(seg, t);
      const built = buildRail({
        q, vin, dir, slope: c.slope, T: each, vr: RC.speed, v0: 0.9 * Math.hypot(vin[0], vin[1]), tau: 0.45,
        R: RC.turnRadius, ballR: r, railCfg: RC, t0: t,
      });
      if (!built) return null;
      newRails.push(built.rail);
      segs.push(built.seg);
      const before = samples.length;
      sampleSegment(built.seg, built.seg.t0, built.seg.t1, samples);
      for (let i = before; i < samples.length; i++) samples[i]!.ownRail = built.rail;
      // the last bit of the incoming flight touches this rail too
      for (let i = Math.max(0, before - 14); i < before; i++) (samples[i]!.nearRails ||= []).push(built.rail);
      t = built.seg.t1;
      const last = j === n - 1;
      const fl: FlightSeg = { type: 'flight', t0: t, t1: last ? t1 : t + between, p0: built.exitP, v0: built.exitV, g: G };
      segs.push(fl);
      const b2 = samples.length;
      sampleSegment(fl, fl.t0, fl.t1, samples);
      for (let i = b2; i < Math.min(samples.length, b2 + 14); i++) (samples[i]!.nearRails ||= []).push(built.rail);
      seg = fl;
      t = fl.t1;
      dir = -dir;
    }
    const next: State = { p: flightPos(seg, t1), vin: flightVel(seg, t1), dir: -dir };
    return { k, pad, segs, newRails, samples, next };
  }

  /** Cheap lookahead: is there at least one bar orientation that fits at the next contact point? */
  function nextBarFits(prop: Proposal, k: number): boolean {
    if (k + 1 >= hits.length) return true;
    const p = prop.next.p;
    const vin = prop.next.vin;
    const h = hits[k + 1]!;
    const a = barHalfLen(h) * 0.8;
    const bb = h.thicknessScale * b;
    const dirIn = Math.sign(vin[0]) || 1;
    for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
      const th = (deg * Math.PI) / 180;
      const nx = Math.sin(th), ny = Math.cos(th);
      if (nx * vin[0] + ny * vin[1] >= 0) continue; // the ball must move into the bar
      const ux = ny, uy = -nx;
      const off = 0.45 * a * dirIn;
      const R = makeRect(p[0] - nx * (r + bb) + ux * off, p[1] - ny * (r + bb) + uy * off, ux, uy, a, bb);
      if (rectsOverlap(R, prop.pad.rect, clr)) continue;
      if (hitsObstacle(R)) continue;
      let bad = false;
      for (const q of world.paddles) if (rectsOverlap(R, q.rect, clr)) { bad = true; break; }
      if (!bad) return true;
    }
    return false;
  }

  function valid(prop: Proposal): boolean {
    if (!nextBarFits(prop, prop.k)) return false;
    if (!paddleOk(prop.pad, prop.newRails)) return false;
    for (const rl of prop.newRails) if (!railOk(rl, prop.pad, prop.newRails)) return false;
    if (!samplesOk(prop.samples, prop.pad, prop.newRails)) return false;
    return true;
  }

  function commit(prop: Proposal) {
    world.paddles.push(prop.pad);
    for (const rl of prop.newRails) world.rails.push(rl);
    for (const s of prop.samples) world.samples.push(s);
  }

  function flightCandidatesOutro(k: number, state: State): FlightCand[] {
    const out: FlightCand[] = [];
    for (const s of [1, -1]) for (const vx of [0.8, 1.3, 1.9]) for (const vy of [0.8, 1.6, 2.4]) {
      const vout: V2 = [s * vx, vy];
      const score = commonScore(state, vout, state.p[0] + s * vx, hits[k]!.t + 1) + rand() * 0.2;
      if (Number.isFinite(score)) out.push({ kind: 'flight', vout, score, dir: s });
    }
    return out.sort((a, b2) => a.score - b2.score);
  }

  // ---- depth-first search with backtracking ----------------------------------------------------
  const N = hits.length;
  const stack: (StackEntry | undefined)[] = new Array(N);
  let k = 0;
  let backtracks = 0;
  let forced = 0;
  while (k < N) {
    if (!stack[k]) {
      const state = k === 0 ? initState : stack[k - 1]!.chosen!.next;
      const isLast = k === N - 1;
      const dt = isLast ? Infinity : hits[k + 1]!.t - hits[k]!.t;
      let cands: Cand[];
      if (isLast) cands = flightCandidatesOutro(k, state);
      else if (RC.enabled && dt > RC.minGap) cands = [...railCandidates(k, state), ...flightCandidates(k, state).slice(0, 30)];
      else cands = flightCandidates(k, state);
      if (cands.length) {
        const best = cands.reduce((m, c) => Math.min(m, c.score), Infinity);
        cands = cands.filter((c) => c.score < best + W.scoreWindow);
      }
      stack[k] = { state, cands, idx: 0, mark: world.mark(), isLast };
    }
    const st = stack[k]!;
    let ok = false;
    while (st.idx < st.cands.length && st.idx < 260) {
      const c = st.cands[st.idx++]!;
      const prop = realise(k, st.state, c, st.isLast);
      if (prop && valid(prop)) {
        st.chosen = prop;
        commit(prop);
        ok = true;
        break;
      }
    }
    if (ok) { k++; continue; }
    backtracks++;
    if (backtracks > W.maxBacktracks || k === 0) {
      // give up on perfection for this step: take the best candidate that can be built
      let prop: Proposal | null = null;
      for (const c of st.cands) { prop = realise(k, st.state, c, st.isLast); if (prop) break; }
      if (!prop) throw new Error(`Could not place the bar of note ${k + 1}.`);
      st.chosen = prop;
      commit(prop);
      forced++;
      warnings.push(`The bar at ${hits[k]!.t.toFixed(1)} s may touch something.`);
      k++;
      continue;
    }
    // backtrack one step
    stack[k] = undefined;
    k--;
    world.reset(stack[k]!.mark);
    stack[k]!.chosen = undefined;
  }

  // ---- outputs ----------------------------------------------------------------------------------------
  const paddles: PlannedPaddle[] = [];
  for (let i = 0; i < N; i++) {
    const ch = stack[i]!.chosen!;
    segments.push(...ch.segs);
    for (const rl of ch.newRails) railsOut.push(rl);
    const R = ch.pad.rect;
    paddles.push({
      hit: i, t: hits[i]!.t, cx: R.cx, cy: R.cy, angle: Math.atan2(R.uy, R.ux), len: 2 * R.a, thick: 2 * R.b,
      nx: ch.pad.nx, ny: ch.pad.ny,
    });
  }
  // outro: the final flight goes on forever
  segments[segments.length - 1]!.t1 = Infinity;
  segments.sort((a, b2) => a.t0 - b2.t0);

  return { segments, paddles, rails: railsOut, world: W, railCfg: RC, warnings, stats: { backtracks, forced }, samples: world.samples };
}

export function makeBallEvaluator(segments: Segment[]): (t: number) => Segment {
  return function at(t: number) {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid]!.t0 <= t) lo = mid; else hi = mid - 1;
    }
    return segments[lo]!;
  };
}
