// Builds a render-ready plan from a song and the plan inputs of a project: melody hits, the
// choreography around the ornaments that keep clear, the camera track, the ball track, the bars,
// the rails and the audio events. Pure: it runs in a Web Worker.
import { extractMelody } from './midi.ts';
import type { MelodyHit, Song } from './midi.ts';
import { DEFAULT_RAILS, DEFAULT_WORLD, makeBallEvaluator, planChoreography, segPos, segSpin } from './choreo.ts';
import type { DwellZone, Hit, RailConfig, WorldConfig } from './choreo.ts';
import { barColor, resolveInstrument } from './instruments.ts';
import type { BackingVoiceName, ColorMode, Look, Sound } from './instruments.ts';
import { mulberry32 } from './rng.ts';
import { turnedRect } from './geometry.ts';
import type { V2 } from './geometry.ts';
import { CAM_HZ, SAFE, cameraModel, cameraTrack } from './camera.ts';
import { ornamentRect, ornamentSize } from './ornaments.ts';
import {
  ASPECTS, effectiveCamera, effectiveRails, effectiveWorld,
} from './project.ts';
import type {
  AspectName, AudioSettings, CameraSettings, MelodySettings, Project, RailSettings, TimingSettings, TrackSetting,
  WorldSettings,
} from './project.ts';

export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  keepClear: boolean;
  feature: boolean;
}

/** Everything that changes the layout or the sound. A change of anything else needs no re-plan. */
export interface PlanInput {
  songKey: string;
  seed: number;
  aspect: AspectName;
  tracks: Record<string, TrackSetting>;
  melody: MelodySettings;
  sections: { id: string; from: number; instrument: string; colorMode: ColorMode | null; colors: string[] | null }[];
  ballRadius: number;
  world: WorldSettings;
  rails: RailSettings;
  camera: CameraSettings;
  timing: TimingSettings;
  audio: AudioSettings;
  footprints: Footprint[];
}

export function planInputOf(p: Project): PlanInput {
  return {
    songKey: p.songAsset ?? '',
    seed: p.seed,
    aspect: p.aspect,
    tracks: p.tracks,
    melody: p.melody,
    sections: p.sections.map((s) => ({ id: s.id, from: s.from, instrument: s.instrument, colorMode: s.colorMode, colors: s.colors })),
    ballRadius: p.ball.radius,
    world: effectiveWorld(p),
    rails: effectiveRails(p),
    camera: effectiveCamera(p),
    timing: p.timing,
    audio: p.audio,
    footprints: p.ornaments.filter((o) => !o.hidden && (o.keepClear || o.feature)).map((o) => {
      const { w, h } = ornamentSize(o);
      return { x: o.x, y: o.y, w, h, rotation: o.rotation, keepClear: o.keepClear, feature: o.feature };
    }),
  };
}

export interface PlanPaddle {
  t: number;
  cx: number;
  cy: number;
  angle: number;
  len: number;
  thick: number;
  color: string;
  section: number;
  midi: number;
  vel: number;
}

export interface MelodyEvent { t: number; dur: number; midi: number; vel: number; section: number; pan: number }
export interface BackingEvent { t: number; dur: number; midi: number; vel: number; voice: BackingVoiceName; gain: number; pan: number }

export interface PlanSection {
  id: string;
  /** Video seconds. */
  from: number;
  instrument: string;
  look: Look;
  sound: Sound;
}

export interface Plan {
  meta: {
    duration: number;
    /** Video seconds = MIDI seconds + offset. */
    offset: number;
    firstHit: number;
    lastHit: number;
    seed: number;
    aspect: AspectName;
    width: number;
    height: number;
    portrait: boolean;
  };
  world: { ballRadius: number; ballZ: number; barDepth: number; barThickness: number; rail: RailConfig };
  camera: CameraSettings & { hz: number; track: Float32Array; viewHalfW: number; viewHalfH: number };
  ball: { hz: number; track: Float32Array };
  sections: PlanSection[];
  paddles: PlanPaddle[];
  rails: { tube: number[]; intro: boolean }[];
  hud: { titleUntil: number; endFrom: number; sections: { id: string; t0: number; t1: number }[] };
  audio: { settings: AudioSettings; melody: MelodyEvent[]; backing: BackingEvent[] };
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  warnings: string[];
  stats: { hits: number; rails: number; backtracks: number; forced: number; ms: number };
}

export function buildPlan(song: Song, input: PlanInput, now: () => number = () => 0): Plan {
  const t0 = now();
  const info = ASPECTS[input.aspect];
  const aspect = info.width / info.height;
  const portrait = info.height > info.width;
  const { timing, camera, audio } = input;
  const seed = input.seed >>> 0;

  // ---- melody ---------------------------------------------------------------------------------------
  const roleTracks = (role: string) => Object.entries(input.tracks).filter(([, s]) => s.role === role).map(([i]) => Number(i));
  const melody: MelodyHit[] = extractMelody(song, {
    tracks: roleTracks('melody'), fillFrom: roleTracks('fill'), fillMinGap: input.melody.fillMinGap, fillGuard: 0.3,
    minHitGap: input.melody.minHitGap, chordWindow: 0.04, chord: input.melody.chord,
    rangeFrom: input.melody.rangeFrom, rangeTo: input.melody.rangeTo,
  });
  if (melody.length < 2) throw new Error('The melody has fewer than 2 notes. Choose another melody track.');

  // ---- sections ---------------------------------------------------------------------------------------
  const sectionsIn = (input.sections.length ? input.sections : [{ id: 's0', from: 0, instrument: 'xylophone', colorMode: null, colors: null }])
    .slice().sort((a, b) => a.from - b.from);
  const sections = sectionsIn.map((s) => {
    const inst = resolveInstrument(s.instrument, { colorMode: s.colorMode ?? undefined, colors: s.colors ?? undefined });
    return { id: s.id, from: s.from, instrument: inst.name, look: inst.look, sound: inst.sound };
  });
  const sectionAt = (t: number) => {
    let idx = 0;
    for (let i = 0; i < sections.length; i++) if (t >= sections[i]!.from - 1e-6) idx = i;
    return idx;
  };

  // ---- time mapping: video = music + offset ------------------------------------------------------
  const firstMusic = melody[0]!.time;
  const offset = Math.max(timing.intro - firstMusic, 0.3);
  const toVideo = (t: number) => t + offset;

  // separate random streams, so a change of colours never moves a bar
  const randOffset = mulberry32(seed);
  const randColor = mulberry32((seed ^ 0x2c1b3c6d) >>> 0);
  const pitches = melody.map((m) => m.top);
  const pmin = Math.min(...pitches), pmax = Math.max(...pitches);
  const counts = sections.map(() => 0);
  const hits = melody.map((m) => {
    const si = sectionAt(m.time);
    const sec = sections[si]!;
    const k = counts[si]!++;
    return {
      t: toVideo(m.time), pitch: m.top, vel: m.vel, notes: m.notes, section: si,
      pitchNorm: pmax > pmin ? (m.top - pmin) / (pmax - pmin) : 0.5,
      lengthScale: sec.look.lengthScale ?? 1, thicknessScale: sec.look.thicknessScale ?? 1,
      color: barColor(sec.look, m.top, k, randColor), offsetRand: randOffset() * 2 - 1,
    };
  });
  const firstHit = hits[0]!.t;
  const lastHit = hits[hits.length - 1]!.t;

  // ---- choreography around the ornaments --------------------------------------------------------
  const world: WorldConfig = {
    ...DEFAULT_WORLD, gravity: input.world.gravity, laneHalfWidth: input.world.laneHalfWidth, laneDrift: input.world.laneDrift,
    barLength: input.world.barLength, ballRadius: input.ballRadius, ballZ: Math.max(DEFAULT_WORLD.ballZ, input.ballRadius + 0.2),
  };
  const rails: RailConfig = { ...DEFAULT_RAILS, ...input.rails };
  const obstacles = input.footprints.filter((f) => f.keepClear).map((f) => turnedRect(f.x, f.y, f.w + 0.2, f.h + 0.2, (f.rotation * Math.PI) / 180));
  const dwell: DwellZone[] = input.footprints.filter((f) => f.feature).map((f) => {
    const r = turnedRect(f.x, f.y, f.w, f.h, (f.rotation * Math.PI) / 180);
    return { minx: r.minx - 1.6, maxx: r.maxx + 1.6, miny: r.miny - 1.4, maxy: r.maxy + 0.8, factor: 0.35 };
  });
  const rollT = Math.min(2.0, firstHit - 0.9);
  const choreoHits: Hit[] = hits.map((h) => ({ t: h.t, pitchNorm: h.pitchNorm, lengthScale: h.lengthScale, thicknessScale: h.thicknessScale, offsetRand: h.offsetRand }));
  const choreo = planChoreography(choreoHits, {
    world, rails, rand: mulberry32((seed ^ 0x5bd1e995) >>> 0), obstacles, dwell,
    intro: { start: [0, 0], rollStart: Math.max(0.3, firstHit - 0.42 - rollT), flight: 0.42, dir: 1 },
  });
  const W = choreo.world;

  // ---- backing ----------------------------------------------------------------------------------------
  const backing: BackingEvent[] = [];
  const { rangeFrom, rangeTo } = input.melody;
  for (const [idx, s] of Object.entries(input.tracks)) {
    if (s.role !== 'backing') continue;
    const tr = song.tracks[Number(idx)];
    if (!tr) continue;
    for (const n of tr.notes) {
      if ((rangeFrom != null && n.time < rangeFrom - 0.05) || (rangeTo != null && n.time > rangeTo + 2)) continue;
      backing.push({ t: toVideo(n.time), dur: n.dur, midi: n.midi + (s.transpose || 0), vel: n.vel, voice: s.voice, gain: s.gain, pan: 0 });
    }
  }
  let lastAudio = lastHit + 1.5;
  for (const e of backing) lastAudio = Math.max(lastAudio, e.t + e.dur + 1.0);
  const duration = Math.max(lastHit + timing.outro, lastAudio + 0.5);

  // ---- camera ------------------------------------------------------------------------------------------
  const view = cameraModel(camera, aspect, SAFE[input.aspect]);
  const featured: V2[] = input.footprints.filter((f) => f.feature).map((f) => [f.x, f.y]);
  const cam = cameraTrack({
    segments: choreo.segments, duration, holdT: lastHit + camera.holdAfterLast, camera, view,
    ballR: W.ballRadius, ballZ: W.ballZ, featured,
  });
  const camTrack = new Float32Array(cam.length * 2);
  cam.forEach(([x, y], i) => { camTrack[2 * i] = x; camTrack[2 * i + 1] = y; });
  const camAt = (t: number) => cam[Math.max(0, Math.min(cam.length - 1, Math.round(t * CAM_HZ)))]!;

  // ---- ball track (240 Hz): x, y, spin ---------------------------------------------------------------
  const BALL_HZ = 240;
  const segAt = makeBallEvaluator(choreo.segments);
  const nBall = Math.ceil(duration * BALL_HZ) + 2;
  const ball = new Float32Array(nBall * 3);
  let spin = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nBall; i++) {
    const t = i / BALL_HZ;
    const seg = segAt(t);
    const [x, y] = segPos(seg, t);
    if (i > 0) spin += segSpin(seg, t, W.ballRadius) / BALL_HZ;
    ball[3 * i] = x;
    ball[3 * i + 1] = y;
    ball[3 * i + 2] = spin;
    if (t <= lastHit + 2) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }

  // ---- bars ------------------------------------------------------------------------------------------
  const paddles: PlanPaddle[] = choreo.paddles.map((p) => {
    const h = hits[p.hit]!;
    return { t: p.t, cx: p.cx, cy: p.cy, angle: p.angle, len: p.len, thick: p.thick, color: h.color, section: h.section, midi: h.pitch, vel: h.vel };
  });

  // ---- audio events -------------------------------------------------------------------------------------
  const melodyEvents: MelodyEvent[] = [];
  hits.forEach((h, i) => {
    const p = paddles[i]!;
    const [cx] = camAt(h.t);
    const pan = Math.max(-1, Math.min(1, ((p.cx - cx) / view.viewHalfW) * audio.pan));
    for (const n of h.notes) melodyEvents.push({ t: toVideo(n.time), dur: n.dur, midi: n.midi, vel: n.vel, section: h.section, pan });
  });

  const hud = {
    titleUntil: Math.max(firstHit + 0.6, timing.titleHold),
    endFrom: duration - timing.endCard,
    sections: sections.map((s, i) => ({
      id: s.id,
      t0: i === 0 ? firstHit : toVideo(s.from),
      t1: i + 1 < sections.length ? toVideo(sections[i + 1]!.from) : lastHit + 1.0,
    })),
  };

  return {
    meta: { duration, offset, firstHit, lastHit, seed, aspect: input.aspect, width: info.width, height: info.height, portrait },
    world: { ballRadius: W.ballRadius, ballZ: W.ballZ, barDepth: W.barDepth, barThickness: W.barThickness, rail: rails },
    camera: { ...camera, hz: CAM_HZ, track: camTrack, viewHalfW: view.viewHalfW, viewHalfH: view.viewHalfH },
    ball: { hz: BALL_HZ, track: ball },
    sections: sections.map((s) => ({ id: s.id, from: toVideo(s.from), instrument: s.instrument, look: s.look, sound: s.sound })),
    paddles,
    rails: choreo.rails.map((rl) => ({ tube: rl.tube, intro: !!rl.intro })),
    hud,
    audio: { settings: audio, melody: melodyEvents, backing },
    bounds: { minX, maxX, minY, maxY },
    warnings: choreo.warnings,
    stats: { hits: hits.length, rails: choreo.rails.length, backtracks: choreo.stats.backtracks, forced: choreo.stats.forced, ms: now() - t0 },
  };
}

/** A good spot for a new ornament of size w x h at video time t: beside the ball, inside the view. */
export function spotNear(plan: Plan, t: number, w: number, h: number): V2 {
  const cam = plan.camera;
  const i = Math.max(0, Math.min(cam.track.length / 2 - 1, Math.round(t * cam.hz)));
  const cx = cam.track[2 * i]!, cy = cam.track[2 * i + 1]!;
  const j = Math.max(0, Math.min(plan.ball.track.length / 3 - 1, Math.round(t * plan.ball.hz)));
  const bx = plan.ball.track[3 * j]!;
  const side = bx > cx ? -1 : 1;
  const room = Math.max(0, cam.viewHalfW * 0.92 - w / 2);
  return [cx + side * Math.min(room, cam.viewHalfW * 0.5), cy - cam.lookDown * 0.3 + Math.max(0, 0.2 - h * 0.05)];
}

/** Rectangle helper re-exported for the editor. */
export { ornamentRect };
