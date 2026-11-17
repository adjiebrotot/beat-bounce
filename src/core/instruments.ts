// Instrument presets: how the bars LOOK on the wall and how they SOUND when the ball hits them.
// Each section of a project can override the look and the sound.
import type { Rand } from './rng.ts';

export type BarShape = 'bar' | 'tine' | 'disc' | 'tube';
export type ColorMode = 'single' | 'cycle' | 'random' | 'accent' | 'pitch';
export type Mount = 'rods' | 'pins' | 'block';

export interface Look {
  shape: BarShape;
  colorMode: ColorMode;
  colors: string[];
  accent?: string[];
  accentEvery?: number;
  texture?: 'wood';
  roughness: number;
  metalness: number;
  mount: Mount;
  base?: string;
  screws?: boolean;
  lengthScale?: number;
  thicknessScale?: number;
}

/** A partial: [frequency ratio, amplitude, decay seconds]. */
export type Partial3 = [number, number, number];

export interface Sound {
  partials: Partial3[];
  click?: number;
  clickTone?: number;
  decayPitchScale?: number;
  gain?: number;
  transpose?: number;
  attack?: number;
  tremolo?: [number, number];
  detune?: number;
  sustainWithDuration?: boolean;
}

export interface Instrument {
  label: string;
  look: Look;
  sound: Sound;
}

// Boomwhacker-style rainbow by pitch class (C = red ... B = magenta).
export const PITCH_COLORS = [
  '#e53935', '#f4511e', '#fb8c00', '#fdd835', '#c0ca33', '#43a047',
  '#00897b', '#1e88e5', '#3949ab', '#5e35b1', '#8e24aa', '#d81b60',
];

export const INSTRUMENTS: Record<string, Instrument> = {
  xylophone: {
    label: 'Xylophone',
    look: { shape: 'bar', colorMode: 'accent', colors: ['#3d4fe0'], accent: ['#f5d90a', '#2fbf4a', '#f27ab8', '#e8412f'], accentEvery: 6,
      roughness: 0.45, metalness: 0.0, mount: 'rods', screws: true },
    sound: { partials: [[1, 1, 0.55], [3.0, 0.32, 0.16], [6.05, 0.12, 0.07], [9.9, 0.05, 0.04]],
      click: 0.25, clickTone: 4200, decayPitchScale: 0.7, gain: 0.9 },
  },
  marimba: {
    label: 'Marimba',
    look: { shape: 'bar', colorMode: 'cycle', colors: ['#8a5a2e', '#9b6936', '#7b4c24', '#a8743d'], texture: 'wood',
      roughness: 0.6, metalness: 0.0, mount: 'rods', screws: true, thicknessScale: 1.15 },
    sound: { partials: [[1, 1, 1.1], [3.95, 0.22, 0.3], [9.8, 0.05, 0.09]],
      click: 0.12, clickTone: 1800, decayPitchScale: 0.5, gain: 1.0 },
  },
  glockenspiel: {
    label: 'Glockenspiel',
    look: { shape: 'bar', colorMode: 'single', colors: ['#d7dbe2'], roughness: 0.22, metalness: 1.0, mount: 'pins', lengthScale: 0.8, thicknessScale: 0.75 },
    sound: { transpose: 12, partials: [[1, 1, 2.2], [2.76, 0.32, 0.9], [5.4, 0.16, 0.4], [8.93, 0.07, 0.2]],
      click: 0.15, clickTone: 6000, decayPitchScale: 0.4, gain: 0.55 },
  },
  vibraphone: {
    label: 'Vibraphone',
    look: { shape: 'bar', colorMode: 'single', colors: ['#c3c8cf'], roughness: 0.32, metalness: 1.0, mount: 'rods', screws: true },
    sound: { partials: [[1, 1, 2.8], [3.98, 0.2, 0.7], [10.1, 0.04, 0.25]], tremolo: [5.2, 0.35],
      click: 0.08, clickTone: 2500, decayPitchScale: 0.3, gain: 0.8, sustainWithDuration: true },
  },
  kalimba: {
    label: 'Kalimba',
    look: { shape: 'tine', colorMode: 'single', colors: ['#b9bec6'], roughness: 0.3, metalness: 1.0, base: '#8a5a2e', mount: 'block',
      lengthScale: 0.85, thicknessScale: 0.55 },
    sound: { partials: [[1, 1, 1.6], [5.4, 0.12, 0.12], [12.1, 0.04, 0.05]],
      click: 0.1, clickTone: 3000, decayPitchScale: 0.5, gain: 1.0, attack: 0.002 },
  },
  steelpan: {
    label: 'Steel Pan',
    look: { shape: 'disc', colorMode: 'single', colors: ['#d5d9de'], roughness: 0.18, metalness: 1.0, mount: 'rods', lengthScale: 0.75 },
    sound: { partials: [[1, 1, 1.3], [2.0, 0.55, 0.9], [3.0, 0.3, 0.55], [4.02, 0.16, 0.35], [5.01, 0.07, 0.2]],
      click: 0.05, clickTone: 1500, decayPitchScale: 0.3, gain: 0.7, attack: 0.004, detune: 0.004 },
  },
  boomwhacker: {
    label: 'Boomwhackers',
    look: { shape: 'tube', colorMode: 'pitch', colors: [], roughness: 0.5, metalness: 0.0, mount: 'rods', thicknessScale: 1.5 },
    sound: { partials: [[1, 1, 0.22], [2, 0.25, 0.1], [3, 0.35, 0.08], [5, 0.1, 0.04]],
      click: 0.45, clickTone: 900, decayPitchScale: 0.4, gain: 1.1 },
  },
  musicbox: {
    label: 'Music Box',
    look: { shape: 'tine', colorMode: 'single', colors: ['#e2c46a'], roughness: 0.25, metalness: 1.0, base: '#5b3a1e', mount: 'block',
      lengthScale: 0.8, thicknessScale: 0.55 },
    sound: { transpose: 12, partials: [[1, 1, 1.8], [2.0, 0.08, 0.6], [5.2, 0.1, 0.25], [8.4, 0.05, 0.12]],
      click: 0.05, clickTone: 7000, decayPitchScale: 0.5, gain: 0.6, attack: 0.001 },
  },
  bells: {
    label: 'Tubular Bells',
    look: { shape: 'tube', colorMode: 'single', colors: ['#d4af5a'], roughness: 0.25, metalness: 1.0, mount: 'rods', thicknessScale: 1.3 },
    sound: { partials: [[0.5, 0.25, 2.5], [1, 1, 3.2], [2.0, 0.5, 2.0], [3.0, 0.3, 1.2], [4.16, 0.22, 0.8], [5.43, 0.12, 0.5]],
      click: 0.08, clickTone: 3000, decayPitchScale: 0.2, gain: 0.55 },
  },
};

export type BackingVoiceName = 'strings' | 'pad' | 'brass' | 'organ' | 'bass' | 'piano';

export interface BackingVoice {
  harmonics: (n: number) => number;
  maxHarm: number;
  attack: number;
  release: number;
  vibrato: [number, number];
  brightness: number;
  gain: number;
  chorus: number;
  decay?: number;
}

// Sustained voices of the backing arrangement, rendered with wavetables.
export const BACKING_VOICES: Record<BackingVoiceName, BackingVoice> = {
  strings: { harmonics: (n) => 1 / n, maxHarm: 24, attack: 0.18, release: 0.35, vibrato: [5.3, 0.004], brightness: 0.7, gain: 0.32, chorus: 0.003 },
  pad: { harmonics: (n) => (n % 2 ? 1 / (n * n) : 0.25 / (n * n)), maxHarm: 10, attack: 0.35, release: 0.6, vibrato: [4.5, 0.002], brightness: 0.5, gain: 0.38, chorus: 0.004 },
  brass: { harmonics: (n) => 1 / Math.pow(n, 0.9), maxHarm: 18, attack: 0.07, release: 0.18, vibrato: [5.0, 0.003], brightness: 0.8, gain: 0.26, chorus: 0.002 },
  organ: { harmonics: (n) => ({ 1: 1, 2: 0.6, 3: 0.35, 4: 0.3, 6: 0.15, 8: 0.15 } as Record<number, number>)[n] || 0, maxHarm: 8, attack: 0.03, release: 0.12, vibrato: [6, 0.0015], brightness: 1, gain: 0.25, chorus: 0.0015 },
  bass: { harmonics: (n) => 1 / (n * n * n), maxHarm: 8, attack: 0.01, release: 0.15, vibrato: [0, 0], brightness: 1, gain: 0.55, chorus: 0, decay: 1.2 },
  piano: { harmonics: (n) => 1 / (n * n), maxHarm: 12, attack: 0.004, release: 0.3, vibrato: [0, 0], brightness: 1, gain: 0.45, chorus: 0.001, decay: 1.6 },
};

export const BACKING_LABELS: Record<BackingVoiceName, string> = {
  strings: 'Strings', pad: 'Pad', brass: 'Brass', organ: 'Organ', bass: 'Bass', piano: 'Piano',
};

export interface LookOverride {
  colorMode?: ColorMode;
  colors?: string[];
}

export function resolveInstrument(name: string, look: LookOverride = {}): Instrument & { name: string } {
  const base = INSTRUMENTS[name] ?? INSTRUMENTS['xylophone']!;
  const merged: Look = { ...base.look };
  if (look.colorMode) merged.colorMode = look.colorMode;
  if (look.colors && look.colors.length) {
    merged.colors = [...look.colors];
    // accent mode: the first colour is the main colour, the others are the accents
    if (merged.colorMode === 'accent' && look.colors.length > 1) {
      merged.colors = [look.colors[0]!];
      merged.accent = look.colors.slice(1);
    }
  }
  return { name: INSTRUMENTS[name] ? name : 'xylophone', label: base.label, look: merged, sound: base.sound };
}

/** The colour of the k-th bar of a section. */
export function barColor(look: Look, midi: number, k: number, rand: Rand): string {
  const colors = look.colors.length ? look.colors : ['#3d4fe0'];
  switch (look.colorMode) {
    case 'pitch': return PITCH_COLORS[midi % 12]!;
    case 'cycle': return colors[k % colors.length]!;
    case 'random': return colors[Math.floor(rand() * colors.length)]!;
    case 'accent': {
      const every = look.accentEvery || 6;
      if (look.accent && look.accent.length && rand() < 1 / every) return look.accent[Math.floor(rand() * look.accent.length)]!;
      return colors[0]!;
    }
    default: return colors[0]!;
  }
}
