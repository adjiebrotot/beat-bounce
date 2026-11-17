// Reads a Standard MIDI File into the plain song data of midi.ts.
import { Midi } from '@tonejs/midi';
import type { Song, SongTrack } from './midi.ts';

/** The largest MIDI file that the app reads. */
export const MAX_MIDI_BYTES = 4_000_000;

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

