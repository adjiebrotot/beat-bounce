#!/usr/bin/env node
// Writes the demo song public/demos/ode-to-joy.mid: the "Ode to Joy" theme (Beethoven, Symphony
// No. 9, public domain) in D major, arranged here for melody, bass, and strings. The notes are
// written out below, so the file has no third-party source.
//
//   node tools/make-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'demos', 'ode-to-joy.mid');
const PPQ = 480;
const BPM = 132;

const N = { A2: 45, B2: 47, D3: 50, E3: 52, Fs3: 54, G3: 55, A3: 57, B3: 59, Cs4: 61, D4: 62, E4: 64, Fs4: 66, G4: 67, A4: 69, B4: 71, Cs5: 73, D5: 74 };

// The theme: [note, beats]. 16 bars of 4 beats.
const THEME = [
  ['Fs4', 1], ['Fs4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 1], ['Fs4', 1], ['E4', 1],
  ['D4', 1], ['D4', 1], ['E4', 1], ['Fs4', 1], ['Fs4', 1.5], ['E4', 0.5], ['E4', 2],
  ['Fs4', 1], ['Fs4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 1], ['Fs4', 1], ['E4', 1],
  ['D4', 1], ['D4', 1], ['E4', 1], ['Fs4', 1], ['E4', 1.5], ['D4', 0.5], ['D4', 2],
  ['E4', 1], ['E4', 1], ['Fs4', 1], ['D4', 1], ['E4', 1], ['Fs4', 0.5], ['G4', 0.5], ['Fs4', 1], ['D4', 1],
  ['E4', 1], ['Fs4', 0.5], ['G4', 0.5], ['Fs4', 1], ['E4', 1], ['D4', 1], ['E4', 1], ['A3', 2],
  ['Fs4', 1], ['Fs4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 1], ['Fs4', 1], ['E4', 1],
  ['D4', 1], ['D4', 1], ['E4', 1], ['Fs4', 1], ['E4', 1.5], ['D4', 0.5], ['D4', 2],
];

// The second time: one octave up, with eighth notes in the middle phrase and a run at the end.
const SECOND = THEME.map(([n, b]) => [n, b]);
const up = (name) => (N[name] ?? 0) + 12;
const RUN = [['D4', 0.5], ['E4', 0.5], ['Fs4', 0.5], ['G4', 0.5], ['A4', 0.5], ['B4', 0.5], ['Cs5', 0.5], ['D5', 0.5]];

// Chords: one per half bar, [bass note, chord tones].
const D = ['D3', ['Fs3', 'A3', 'D4']];
const A = ['A2', ['E3', 'A3', 'Cs4']];
const G = ['G3', ['G3', 'B3', 'D4']];
const Bm = ['B2', ['Fs3', 'B3', 'D4']];
const E = ['E3', ['E3', 'B3', 'D4']];
const HARMONY = [
  D, D, A, D, D, D, D, A,
  D, D, A, D, D, D, A, D,
  A, D, A, D, A, Bm, E, A,
  D, D, A, D, D, G, A, D,
];

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function track(name, events) {
  // events: [tick, bytes[]]; at the same tick: meta events, note-offs, program changes, note-ons
  const order = (bytes) => ({ 0xf0: 0, 0x80: 1, 0xc0: 2, 0x90: 3 })[bytes[0] & 0xf0] ?? 4;
  events.sort((a, b) => a[0] - b[0] || order(a[1]) - order(b[1]));
  const nameBytes = [...Buffer.from(name, 'utf8')];
  const data = [0, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes];
  let last = 0;
  for (const [tick, bytes] of events) {
    data.push(...vlq(tick - last), ...bytes);
    last = tick;
  }
  data.push(0, 0xff, 0x2f, 0);
  const head = Buffer.from('MTrk');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([head, len, Buffer.from(data)]);
}

const beat = (b) => Math.round(b * PPQ);
function notes(channel, program, list) {
  const ev = [[0, [0xc0 | channel, program]]];
  for (const { at, len, midi, vel } of list) {
    ev.push([beat(at), [0x90 | channel, midi, vel]]);
    ev.push([beat(at + len) - 4, [0x80 | channel, midi, 0]]);
  }
  return ev;
}

const INTRO_BARS = 2;
const melody = [];
let at = INTRO_BARS * 4;
for (const [n, b] of THEME) { melody.push({ at, len: b * 0.95, midi: N[n], vel: 96 }); at += b; }
for (let i = 0; i < SECOND.length; i++) {
  const [n, b] = SECOND[i];
  const bar = Math.floor((at - (INTRO_BARS + 16) * 4) / 4);
  if (bar === 15 && i === SECOND.length - 3) {
    for (const [rn, rb] of RUN) { melody.push({ at, len: rb * 0.9, midi: up(rn) - 12, vel: 100 }); at += rb; }
    break;
  }
  if (bar >= 8 && bar < 12 && b === 1) {
    melody.push({ at, len: 0.45, midi: up(n), vel: 100 });
    melody.push({ at: at + 0.5, len: 0.45, midi: up(n), vel: 84 });
  } else {
    melody.push({ at, len: b * 0.95, midi: up(n), vel: 100 });
  }
  at += b;
}
const endAt = at;
melody.push({ at: endAt, len: 4, midi: N.D5, vel: 110 });

const bass = [];
const strings = [];
const halves = [...Array(INTRO_BARS * 2).fill(D), ...HARMONY, ...HARMONY];
halves.forEach(([root, tones], i) => {
  bass.push({ at: i * 2, len: 1.9, midi: N[root], vel: 88 });
  for (const t of tones) strings.push({ at: i * 2, len: 2, midi: N[t], vel: 58 });
});
bass.push({ at: endAt, len: 4, midi: N.D3, vel: 96 });
for (const t of ['Fs3', 'A3', 'D4']) strings.push({ at: endAt, len: 4, midi: N[t], vel: 70 });

const tempo = 60000000 / BPM;
const conductor = [[0, [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff]], [0, [0xff, 0x58, 0x04, 4, 2, 24, 8]]];
const header = Buffer.alloc(14);
header.write('MThd', 0);
header.writeUInt32BE(6, 4);
header.writeUInt16BE(1, 8);
header.writeUInt16BE(4, 10);
header.writeUInt16BE(PPQ, 12);
const file = Buffer.concat([
  header,
  track('Ode to Joy', conductor),
  track('Melody', notes(0, 13, melody)),
  track('Bass', notes(1, 32, bass)),
  track('Strings', notes(2, 48, strings)),
]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, file);
console.log(`wrote ${OUT} (${file.length} bytes, ${melody.length} melody notes, ${((endAt + 4) * 60 / BPM).toFixed(1)} s)`);
