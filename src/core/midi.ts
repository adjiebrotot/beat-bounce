// MIDI loading, track analysis and melody extraction. Pure: bytes in, plain data out.
import { Midi } from '@tonejs/midi';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The largest MIDI file that the app reads. */
export const MAX_MIDI_BYTES = 4_000_000;

export interface SongNote {
  time: number;
  dur: number;
  midi: number;
  vel: number;
}

export interface SongTrack {
  index: number;
  name: string;
  channel: number;
  percussion: boolean;
  program: number;
  instrument: string;
  notes: SongNote[];
}

export interface Song {
  name: string;
  duration: number;
  bpm: number;
  tracks: SongTrack[];
}

export interface TrackStats {
  index: number;
  name: string;
  instrument: string;
  percussion: boolean;
  notes: number;
  onsets: number;
  mono: number;
  low: number;
  high: number;
  meanPitch: number;
  first: number;
  last: number;
  melodyScore: number;
}

export function noteName(midi: number): string {
  return NOTE_NAMES[midi % 12]! + (Math.floor(midi / 12) - 1);
}

/** Parses the bytes of a Standard MIDI File. Throws on a file that is not MIDI. */
export function parseSong(bytes: ArrayBuffer | Uint8Array, name = ''): Song {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length > MAX_MIDI_BYTES) throw new Error('The MIDI file is larger than 4 MB.');
  if (data.length < 14 || String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!) !== 'MThd') {
    throw new Error('This file is not a Standard MIDI File.');
  }
  const midi = new Midi(data);
  const tracks: SongTrack[] = midi.tracks
    .map((t, index) => ({
      index,
      name: t.name || '',
      channel: t.channel,
      percussion: t.channel === 9 || t.instrument.percussion,
      program: t.instrument.number,
      instrument: t.instrument.name,
      notes: t.notes
        .map((n) => ({ time: n.time, dur: n.duration, midi: n.midi, vel: n.velocity }))
        .sort((a, b) => a.time - b.time || b.midi - a.midi),
    }));
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  return { name: midi.name || name, duration: midi.duration, bpm, tracks };
}

export interface OnsetGroup {
  time: number;
  notes: (SongNote & { track?: number })[];
  top: number;
  vel: number;
  fill?: boolean;
}

/** Groups notes whose onsets are within `window` seconds of the first note of the group. */
export function groupOnsets(notes: SongNote[], window = 0.04): OnsetGroup[] {
  const sorted = [...notes].sort((a, b) => a.time - b.time || b.midi - a.midi);
  const groups: OnsetGroup[] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && n.time - g.time <= window) g.notes.push(n);
    else groups.push({ time: n.time, notes: [n], top: 0, vel: 0 });
  }
  for (const g of groups) {
    g.top = Math.max(...g.notes.map((n) => n.midi));
    g.vel = Math.max(...g.notes.map((n) => n.vel));
  }
  return groups;
}

/** Per-track statistics for the track list and the melody guess. */
export function analyseTrack(t: SongTrack, duration: number): TrackStats | null {
  if (!t.notes.length) return null;
  const groups = groupOnsets(t.notes);
  const pitches = t.notes.map((n) => n.midi);
  const first = t.notes[0]!.time;
  const last = t.notes[t.notes.length - 1]!.time;
  const mono = groups.length / t.notes.length; // 1 = strictly monophonic
  const meanPitch = pitches.reduce((a, b) => a + b, 0) / pitches.length;
  const span = last - first;
  // a melody is monophonic, sits in the middle/upper register, and covers most of the piece
  const coverage = span / Math.max(duration, 1e-6);
  const register = 1 - Math.min(1, Math.abs(meanPitch - 70) / 24);
  const density = Math.min(1, groups.length / Math.max(span, 1) / 1.5);
  const melodyScore = t.percussion ? 0 : mono ** 2 * (0.25 + coverage) * (0.3 + register) * (0.4 + density);
  return {
    index: t.index, name: t.name, instrument: t.instrument, percussion: t.percussion,
    notes: t.notes.length, onsets: groups.length, mono: +mono.toFixed(2),
    low: Math.min(...pitches), high: Math.max(...pitches), meanPitch: +meanPitch.toFixed(1),
    first: +first.toFixed(2), last: +last.toFixed(2), melodyScore: +melodyScore.toFixed(3),
  };
}

export interface MelodyOptions {
  tracks: number[];
  fillFrom: number[];
  fillMinGap: number;
  fillGuard: number;
  minHitGap: number;
  chordWindow: number;
  chord: 'all' | 'top';
  rangeFrom: number | null;
  rangeTo: number | null;
}

export interface MelodyHit {
  time: number;
  top: number;
  vel: number;
  fill: boolean;
  notes: SongNote[];
}

/** Builds the list of melody hits: one bounce of the ball each. */
export function extractMelody(song: Song, cfg: MelodyOptions): MelodyHit[] {
  const { tracks } = song;
  let trackIdx = cfg.tracks.filter((i) => tracks[i]);
  if (!trackIdx.length) {
    const ranked = tracks.map((t) => analyseTrack(t, song.duration)).filter((s): s is TrackStats => !!s)
      .sort((a, b) => b.melodyScore - a.melodyScore);
    if (!ranked.length) return [];
    trackIdx = [ranked[0]!.index];
  }
  const inRange = (n: SongNote) => (cfg.rangeFrom == null || n.time >= cfg.rangeFrom) && (cfg.rangeTo == null || n.time <= cfg.rangeTo);
  const pick = (idx: number[]) => idx.filter((i) => tracks[i]).flatMap((i) => tracks[i]!.notes.map((n) => ({ ...n, track: i }))).filter(inRange);

  let groups = groupOnsets(pick(trackIdx), cfg.chordWindow);
  groups.forEach((g) => (g.fill = false));

  // fill long silences of the melody with onsets of secondary tracks
  if (cfg.fillFrom.length) {
    const fillGroups = groupOnsets(pick(cfg.fillFrom), cfg.chordWindow);
    const add: OnsetGroup[] = [];
    const bounds = [-Infinity, ...groups.map((g) => g.time), Infinity];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const a = bounds[i]!, b = bounds[i + 1]!;
      if (b - a < cfg.fillMinGap) continue;
      for (const fg of fillGroups) {
        if (fg.time > a + cfg.fillGuard && fg.time < b - cfg.fillGuard) add.push({ ...fg, fill: true });
      }
    }
    groups = [...groups, ...add].sort((x, y) => x.time - y.time);
  }

  // merge onsets that are too close for the ball to bounce twice
  const merged: (OnsetGroup & { extra: SongNote[] })[] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && g.time - prev.time < cfg.minHitGap) {
      prev.extra.push(...g.notes);
      continue;
    }
    merged.push({ ...g, extra: [] });
  }
  return merged.map((g) => {
    const sounding = cfg.chord === 'top' ? g.notes.filter((n) => n.midi === g.top) : g.notes;
    return {
      time: g.time, top: g.top, vel: g.vel, fill: !!g.fill,
      notes: [...sounding, ...g.extra].map((n) => ({ time: n.time, dur: n.dur, midi: n.midi, vel: n.vel })),
    };
  });
}
