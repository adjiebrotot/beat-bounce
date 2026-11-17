// The project: every choice of the user, as plain JSON. The planner, the synth, the stage and the
// render all read it. Times of sections and captions are MIDI seconds (song time).
import type { BackingVoiceName, ColorMode } from './instruments.ts';

export type AspectName = 'landscape' | 'vertical' | 'square' | 'portrait';

export interface AspectInfo {
  label: string;
  hint: string;
  width: number;
  height: number;
}

export const ASPECTS: Record<AspectName, AspectInfo> = {
  landscape: { label: '16:9', hint: 'YouTube, landscape', width: 1920, height: 1080 },
  vertical: { label: '9:16', hint: 'Shorts, Reels, TikTok', width: 1080, height: 1920 },
  square: { label: '1:1', hint: 'Square', width: 1080, height: 1080 },
  portrait: { label: '4:5', hint: 'Instagram feed', width: 1080, height: 1350 },
};

export type TrackRole = 'melody' | 'fill' | 'backing' | 'off';

export interface TrackSetting {
  role: TrackRole;
  voice: BackingVoiceName;
  gain: number;
  transpose: number;
}

export interface SectionSetting {
  id: string;
  /** MIDI seconds. */
  from: number;
  instrument: string;
  label: string;
  colorMode: ColorMode | null;
  colors: string[] | null;
}

export type BallStyle = 'marble' | 'earth' | 'glass' | 'metal' | 'matte' | 'beach' | 'neon' | 'image';

export interface BallSettings {
  style: BallStyle;
  color: string;
  color2: string;
  /** Radius in metres. It changes the physics, so it re-plans the layout. */
  radius: number;
  roughness: number;
  /** Asset id of the picture printed on the ball (style "image"). */
  image: string | null;
  /** The point of the picture that faces the camera, [x, y] in 0..1. */
  focus: [number, number];
  glow: number;
  trail: boolean;
  trailColor: string;
  /** Seconds of path that the trail shows. */
  trailLength: number;
}

export type FrameStyle = 'wood' | 'black' | 'white' | 'gold' | 'silver' | 'color' | 'polaroid' | 'canvas' | 'none';
export type CropName = 'original' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3' | '16:9' | '9:16';
export type FontName = 'sans' | 'serif' | 'rounded' | 'display' | 'mono' | 'script' | 'hand';
export type TextStyle = 'paint' | 'raised' | 'neon';

export const FONTS: Record<FontName, { label: string; css: string }> = {
  sans: { label: 'Sans', css: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, "Noto Sans", sans-serif' },
  serif: { label: 'Serif', css: 'Georgia, "Times New Roman", "Noto Serif", serif' },
  rounded: { label: 'Rounded', css: '"Arial Rounded MT Bold", "Nunito", "Varela Round", "Trebuchet MS", system-ui, sans-serif' },
  display: { label: 'Display', css: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif' },
  mono: { label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
  script: { label: 'Script', css: '"Brush Script MT", "Segoe Script", "Snell Roundhand", "URW Chancery L", cursive' },
  hand: { label: 'Hand', css: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", "Segoe Print", cursive' },
};

export const CROPS: Record<CropName, number | null> = {
  original: null, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '3:2': 3 / 2, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16,
};

interface OrnamentBase {
  id: string;
  /** Centre of the whole ornament on the wall, metres. */
  x: number;
  y: number;
  /** Width in metres (the picture for a photo, the whole sticker, the text block). */
  width: number;
  /** Degrees, counter-clockwise. */
  rotation: number;
  /** Bars and rails keep clear of the ornament (the layout is re-planned around it). */
  keepClear: boolean;
  /** The ball lingers near the ornament and the camera leans towards it. */
  feature: boolean;
  hidden: boolean;
}

export interface PhotoOrnament extends OrnamentBase {
  kind: 'photo';
  image: string | null;
  imageAspect: number;
  crop: CropName;
  frame: FrameStyle;
  frameColor: string;
  /** Width of the frame moulding, metres. */
  frameWidth: number;
  /** Width of the mat (passe-partout), metres. */
  mat: number;
  matColor: string;
  caption: string;
  placeholder: string;
}

export interface StickerOrnament extends OrnamentBase {
  kind: 'sticker';
  /** An asset id, or "builtin:<name>". */
  image: string | null;
  imageAspect: number;
  /** Width of the die-cut border as a fraction of the sticker width. */
  border: number;
  borderColor: string;
  gloss: boolean;
}

export interface TextOrnament extends OrnamentBase {
  kind: 'text';
  text: string;
  font: FontName;
  weight: number;
  italic: boolean;
  color: string;
  outline: string;
  /** Outline width as a fraction of the font size. */
  outlineWidth: number;
  style: TextStyle;
  align: 'left' | 'center' | 'right';
  /** Width / height of the text block; the editor measures it when the text or the font changes. */
  textAspect: number;
}

export type Ornament = PhotoOrnament | StickerOrnament | TextOrnament;
export type OrnamentKind = Ornament['kind'];

export interface CameraSettings {
  distance: number;
  elevationDeg: number;
  yawDeg: number;
  fov: number;
  smoothing: number;
  lookDown: number;
  holdAfterLast: number;
  /** How strongly the camera leans towards a featured ornament that the ball passes. */
  framePictures: number;
}

export interface WorldSettings {
  gravity: number;
  laneHalfWidth: number;
  laneDrift: number;
  barLength: [number, number];
}

export interface RailSettings {
  enabled: boolean;
  minGap: number;
  maxRailTime: number;
  speed: number;
}

export type WallStyle = 'plaster' | 'smooth' | 'brick' | 'planks' | 'concrete';

export interface ThemeSettings {
  wall: string;
  wallStyle: WallStyle;
  wallBump: number;
  /** Metres per texture tile. */
  wallTile: number;
  rail: string;
  text: string;
  textStroke: string;
  font: FontName;
  vignette: number;
  sectionLabels: boolean;
  exposure: number;
  toneMapping: 'aces' | 'agx' | 'neutral';
}

export interface LightSettings {
  /** Azimuth of the key light, degrees: 0 = in front of the wall, + = from the right. */
  angle: number;
  /** Elevation of the key light, degrees. */
  height: number;
  intensity: number;
  ambient: number;
  env: number;
  color: string;
  sky: string;
  ground: string;
}

export interface CaptionSetting {
  id: string;
  from: number;
  to: number;
  text: string;
}

export interface TitleSettings {
  title: string;
  subtitle: string;
  endTitle: string;
  endSubtitle: string;
  watermark: string;
  captions: CaptionSetting[];
}

export interface TimingSettings {
  intro: number;
  titleHold: number;
  outro: number;
  endCard: number;
}

export interface AudioSettings {
  reverb: number;
  melodyGain: number;
  masterGain: number;
  pan: number;
}

export type QualityName = 'draft' | 'high' | 'ultra';

export interface RenderSettings {
  /** Short side of the video in pixels. */
  resolution: 720 | 1080 | 1440 | 2160;
  fps: 30 | 60;
  quality: QualityName;
}

export interface MelodySettings {
  minHitGap: number;
  chord: 'all' | 'top';
  fillMinGap: number;
  rangeFrom: number | null;
  rangeTo: number | null;
}

export interface Project {
  version: 1;
  name: string;
  /** Asset id of the MIDI file. */
  songAsset: string | null;
  songName: string;
  seed: number;
  aspect: AspectName;
  /** Keyed by track index. */
  tracks: Record<string, TrackSetting>;
  melody: MelodySettings;
  sections: SectionSetting[];
  ball: BallSettings;
  /** Only the values that the user changed; the rest follow the aspect. */
  camera: Partial<CameraSettings>;
  world: Partial<WorldSettings>;
  rails: Partial<RailSettings>;
  theme: ThemeSettings;
  light: LightSettings;
  titles: TitleSettings;
  timing: TimingSettings;
  audio: AudioSettings;
  ornaments: Ornament[];
  render: RenderSettings;
}

// ---------------------------------------------------------------------------------------------------
// Defaults

export const DEFAULT_CAMERA: CameraSettings = {
  distance: 6.0, elevationDeg: 28, yawDeg: -16, fov: 42, smoothing: 0.42, lookDown: 0.35, holdAfterLast: 0.45, framePictures: 0.8,
};

export const DEFAULT_WORLD_SETTINGS: WorldSettings = { gravity: 6.0, laneHalfWidth: 2.6, laneDrift: 0, barLength: [0.55, 0.95] };

export const DEFAULT_RAIL_SETTINGS: RailSettings = { enabled: true, minGap: 1.45, maxRailTime: 4.5, speed: 1.25 };

/** Values that each aspect puts under the user's own values: narrower frames get a narrower lane. */
export const ASPECT_DEFAULTS: Record<AspectName, { camera?: Partial<CameraSettings>; world?: Partial<WorldSettings>; rails?: Partial<RailSettings> }> = {
  landscape: {},
  vertical: { camera: { distance: 7.0, fov: 50, lookDown: 0.6 }, world: { laneHalfWidth: 1.35 }, rails: { maxRailTime: 2.4, speed: 1.1 } },
  square: { camera: { distance: 6.4, fov: 46, lookDown: 0.45 }, world: { laneHalfWidth: 1.9 }, rails: { maxRailTime: 3.2 } },
  portrait: { camera: { distance: 6.8, fov: 48, lookDown: 0.52 }, world: { laneHalfWidth: 1.6 }, rails: { maxRailTime: 2.8, speed: 1.15 } },
};

export function effectiveCamera(p: Pick<Project, 'camera' | 'aspect'>): CameraSettings {
  return { ...DEFAULT_CAMERA, ...ASPECT_DEFAULTS[p.aspect].camera, ...p.camera };
}

export function effectiveWorld(p: Pick<Project, 'world' | 'aspect'>): WorldSettings {
  return { ...DEFAULT_WORLD_SETTINGS, ...ASPECT_DEFAULTS[p.aspect].world, ...p.world };
}

export function effectiveRails(p: Pick<Project, 'rails' | 'aspect'>): RailSettings {
  return { ...DEFAULT_RAIL_SETTINGS, ...ASPECT_DEFAULTS[p.aspect].rails, ...p.rails };
}

export const DEFAULT_BALL: BallSettings = {
  style: 'earth', color: '#d62828', color2: '#ffffff', radius: 0.12, roughness: 0.12, image: null, focus: [0.5, 0.5],
  glow: 0, trail: false, trailColor: '#ffffff', trailLength: 0.6,
};

export const DEFAULT_THEME: ThemeSettings = {
  wall: '#d3d2cf', wallStyle: 'plaster', wallBump: 0.55, wallTile: 3.5, rail: '#9aa0a6', text: '#ffffff', textStroke: '#1d1d1d',
  font: 'sans', vignette: 0.28, sectionLabels: true, exposure: 1.0, toneMapping: 'aces',
};

export const DEFAULT_LIGHT: LightSettings = {
  angle: 42, height: 30, intensity: 3.3, ambient: 0.32, env: 0.38, color: '#fff3e2', sky: '#e4ecff', ground: '#b9b1a4',
};

let idCounter = 0;
/** A short unique id. */
export function newId(prefix = 'o'): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function defaultProject(): Project {
  return {
    version: 1,
    name: 'My bounce',
    songAsset: null,
    songName: '',
    seed: 11,
    aspect: 'landscape',
    tracks: {},
    melody: { minHitGap: 0.09, chord: 'all', fillMinGap: 1.5, rangeFrom: null, rangeTo: null },
    sections: [{ id: newId('s'), from: 0, instrument: 'xylophone', label: 'Xylophone', colorMode: null, colors: null }],
    ball: { ...DEFAULT_BALL, focus: [...DEFAULT_BALL.focus] },
    camera: {},
    world: {},
    rails: {},
    theme: { ...DEFAULT_THEME },
    light: { ...DEFAULT_LIGHT },
    titles: { title: '', subtitle: '', endTitle: '', endSubtitle: '', watermark: '', captions: [] },
    timing: { intro: 3.2, titleHold: 2.6, outro: 4.0, endCard: 3.0 },
    audio: { reverb: 0.22, melodyGain: 1.0, masterGain: 0.9, pan: 0.55 },
    ornaments: [],
    render: { resolution: 1080, fps: 60, quality: 'high' },
  };
}

export function newPhoto(x: number, y: number, width = 2.0): PhotoOrnament {
  return {
    id: newId(), kind: 'photo', x, y, width, rotation: 0, keepClear: true, feature: true, hidden: false,
    image: null, imageAspect: 4 / 3, crop: 'original', frame: 'wood', frameColor: '#2b2118', frameWidth: 0.07,
    mat: 0, matColor: '#f4f1ea', caption: '', placeholder: 'Your photo here',
  };
}

export function newSticker(x: number, y: number, image: string | null = 'builtin:star', width = 0.8): StickerOrnament {
  return {
    id: newId(), kind: 'sticker', x, y, width, rotation: -8, keepClear: true, feature: false, hidden: false,
    image, imageAspect: 1, border: 0.045, borderColor: '#ffffff', gloss: true,
  };
}

export function newText(x: number, y: number, text = 'Your text', width = 2.4): TextOrnament {
  return {
    id: newId(), kind: 'text', x, y, width, rotation: 0, keepClear: true, feature: false, hidden: false,
    text, font: 'display', weight: 800, italic: false, color: '#2b2b2b', outline: '#ffffff', outlineWidth: 0,
    style: 'raised', align: 'center', textAspect: 4,
  };
}

/** Fills the missing keys of a stored project with defaults, so older files keep working. */
export function normalizeProject(raw: unknown): Project {
  const d = defaultProject();
  if (!raw || typeof raw !== 'object') return d;
  const p = raw as Partial<Project>;
  const pick = <T extends object>(def: T, v: unknown): T => ({ ...def, ...(v && typeof v === 'object' ? (v as Partial<T>) : {}) });
  return {
    version: 1,
    name: typeof p.name === 'string' ? p.name : d.name,
    songAsset: typeof p.songAsset === 'string' ? p.songAsset : null,
    songName: typeof p.songName === 'string' ? p.songName : '',
    seed: Number.isFinite(p.seed) ? Number(p.seed) : d.seed,
    aspect: p.aspect && ASPECTS[p.aspect] ? p.aspect : d.aspect,
    tracks: p.tracks && typeof p.tracks === 'object' ? p.tracks : {},
    melody: pick(d.melody, p.melody),
    sections: Array.isArray(p.sections) && p.sections.length ? p.sections.map((s) => ({ ...d.sections[0]!, ...s })) : d.sections,
    ball: pick(d.ball, p.ball),
    camera: pick({}, p.camera),
    world: pick({}, p.world),
    rails: pick({}, p.rails),
    theme: pick(d.theme, p.theme),
    light: pick(d.light, p.light),
    titles: { ...pick(d.titles, p.titles), captions: Array.isArray(p.titles?.captions) ? p.titles!.captions : [] },
    timing: pick(d.timing, p.timing),
    audio: pick(d.audio, p.audio),
    ornaments: Array.isArray(p.ornaments) ? p.ornaments.map(normalizeOrnament).filter((o): o is Ornament => !!o) : [],
    render: pick(d.render, p.render),
  };
}

function normalizeOrnament(o: Partial<Ornament>): Ornament | null {
  if (!o || typeof o !== 'object') return null;
  const x = Number(o.x) || 0, y = Number(o.y) || 0;
  if (o.kind === 'photo') return { ...newPhoto(x, y), ...o } as PhotoOrnament;
  if (o.kind === 'sticker') return { ...newSticker(x, y), ...o } as StickerOrnament;
  if (o.kind === 'text') return { ...newText(x, y), ...o } as TextOrnament;
  return null;
}
