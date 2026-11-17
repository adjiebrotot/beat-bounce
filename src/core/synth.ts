// Offline synthesizer (ported from anthem-bouncing): renders the melody hits (mallet instruments)
// and the backing arrangement into stereo float samples. No sound fonts. Pure: it runs in a worker.
import { BACKING_VOICES } from './instruments.ts';
import type { BackingVoice, BackingVoiceName, Sound } from './instruments.ts';
import { mulberry32 } from './rng.ts';
import type { Rand } from './rng.ts';
import type { AudioSettings } from './project.ts';
import type { BackingEvent, MelodyEvent } from './plan.ts';

export interface SynthInput {
  sampleRate: number;
  duration: number;
  seed: number;
  settings: AudioSettings;
  melody: MelodyEvent[];
  backing: BackingEvent[];
  /** Sound of each section, by section index. */
  sounds: Sound[];
}

export interface SynthOutput {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function panGains(pan: number): [number, number] {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

function renderMallet(L: Float32Array, R: Float32Array, sr: number, ev: MelodyEvent, sound: Sound, gainMul: number, rand: Rand) {
  const f0 = mtof(ev.midi + (sound.transpose || 0));
  const amp = (sound.gain ?? 1) * gainMul * (0.3 + 0.7 * (ev.vel ?? 0.8));
  const dscale = Math.pow(f0 / 440, -(sound.decayPitchScale ?? 0.5));
  const start = Math.round(ev.t * sr);
  const partials = sound.partials.filter(([ratio]) => f0 * ratio < sr * 0.45);
  let maxDecay = 0;
  for (const [, , d] of partials) maxDecay = Math.max(maxDecay, d * dscale);
  const releaseAt = sound.sustainWithDuration ? Math.max(0.15, ev.dur + 0.1) : Infinity;
  const len = Math.min(Math.round(Math.min(5 * maxDecay, releaseAt + 0.4, 8) * sr), L.length - start);
  if (len <= 0 || start < 0) return;
  const [gl, gr] = panGains(ev.pan ?? 0);
  const attack = Math.max(1, Math.round((sound.attack ?? 0.0015) * sr));
  const buf = new Float32Array(len);
  for (const [ratio, a, d] of partials) {
    const detune = 1 + (sound.detune || 0) * (rand() - 0.5) * 2;
    const w = (2 * Math.PI * f0 * ratio * detune) / sr;
    const c = Math.cos(w), s = Math.sin(w);
    const k = Math.exp(-1 / (d * dscale * sr));
    let x = 1, y = 0; // y = sin(phase), starting at 0 so the attack is click-free
    let env = a;
    for (let i = 0; i < len; i++) {
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      buf[i] = buf[i]! + y * env;
      env *= k;
    }
  }
  // mallet click: a short filtered noise burst
  if (sound.click) {
    const n = Math.min(len, Math.round(0.02 * sr));
    const fc = Math.min(sound.clickTone || 3000, sr * 0.4);
    const alpha = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    let lp = 0, lp2 = 0;
    for (let i = 0; i < n; i++) {
      const noise = rand() * 2 - 1;
      lp += alpha * (noise - lp);
      lp2 += alpha * (lp - lp2);
      buf[i] = buf[i]! + (lp - lp2) * 1.6 * sound.click * Math.exp(-i / (0.004 * sr));
    }
  }
  const trem = sound.tremolo;
  for (let i = 0; i < len; i++) {
    let e = i < attack ? i / attack : 1;
    const t = i / sr;
    if (t > releaseAt) e *= Math.exp(-(t - releaseAt) / 0.12);
    if (trem) e *= 1 - trem[1] * 0.5 * (1 - Math.cos(2 * Math.PI * trem[0] * t));
    const v = buf[i]! * e * amp;
    L[start + i] = L[start + i]! + v * gl;
    R[start + i] = R[start + i]! + v * gr;
  }
}

const tableCache = new Map<string, Float32Array>();
function wavetable(voiceName: string, voice: BackingVoice, f0: number, sr: number): Float32Array {
  const maxH = Math.max(1, Math.min(voice.maxHarm, Math.floor((sr * 0.45) / f0)));
  const key = `${voiceName}:${maxH}`;
  const hit = tableCache.get(key);
  if (hit) return hit;
  const N = 2048;
  const tab = new Float32Array(N + 1);
  for (let h = 1; h <= maxH; h++) {
    const a = voice.harmonics(h) * Math.pow(voice.brightness, h - 1);
    if (!a) continue;
    for (let i = 0; i <= N; i++) tab[i] = tab[i]! + a * Math.sin((2 * Math.PI * h * i) / N);
  }
  let peak = 0;
  for (let i = 0; i <= N; i++) peak = Math.max(peak, Math.abs(tab[i]!));
  for (let i = 0; i <= N; i++) tab[i] = tab[i]! / (peak || 1);
  tableCache.set(key, tab);
  return tab;
}

function renderSustained(L: Float32Array, R: Float32Array, sr: number, ev: BackingEvent, rand: Rand) {
  const voice = BACKING_VOICES[ev.voice as BackingVoiceName] ?? BACKING_VOICES.strings;
  const f0 = mtof(ev.midi);
  const tab = wavetable(ev.voice, voice, f0, sr);
  const N = tab.length - 1;
  const start = Math.round(ev.t * sr);
  const hold = Math.max(ev.dur, voice.attack);
  const len = Math.min(Math.round((hold + voice.release * 4) * sr), L.length - start);
  if (len <= 0 || start < 0) return;
  const amp = voice.gain * (ev.gain ?? 0.5) * (0.35 + 0.65 * (ev.vel ?? 0.8));
  const [gl, gr] = panGains(ev.pan ?? 0);
  const copies: [number, number][] = voice.chorus ? [[1 - voice.chorus, -0.35], [1 + voice.chorus, 0.35]] : [[1, 0]];
  const [vibF, vibD] = voice.vibrato;
  for (const [det, spread] of copies) {
    let ph = rand() * N;
    const [cl, cr] = panGains((ev.pan ?? 0) + spread);
    const g = amp / copies.length;
    const vibPh = rand() * 6.28;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let env = t < voice.attack ? t / voice.attack : 1;
      if (voice.decay) env *= Math.exp(-t / voice.decay);
      if (t > hold) env *= Math.exp(-(t - hold) / voice.release);
      const vib = vibD ? 1 + vibD * Math.sin(2 * Math.PI * vibF * t + vibPh) * Math.min(1, t / 0.4) : 1;
      ph += (f0 * det * vib * N) / sr;
      if (ph >= N) ph -= N * Math.floor(ph / N);
      const i0 = ph | 0;
      const s = tab[i0]! + (tab[i0 + 1]! - tab[i0]!) * (ph - i0);
      const v = s * env * g;
      L[start + i] = L[start + i]! + v * (copies.length > 1 ? cl : gl);
      R[start + i] = R[start + i]! + v * (copies.length > 1 ? cr : gr);
    }
  }
}

// Freeverb (Jezar's public-domain design)
function freeverb(L: Float32Array, R: Float32Array, sr: number, wet: number, room = 0.82, damp = 0.25) {
  if (wet <= 0) return;
  const scale = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const aps = [556, 441, 341, 225];
  const mk = (len: number) => ({ buf: new Float32Array(Math.round(len * scale)), i: 0, store: 0 });
  const chans = [0, 23].map((sp) => ({ combs: combs.map((c) => mk(c + sp)), aps: aps.map((a) => mk(a + sp)) }));
  const n = L.length;
  const outL = new Float32Array(n), outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const input = (L[i]! + R[i]!) * 0.015;
    for (let c = 0; c < 2; c++) {
      const ch = chans[c]!;
      let acc = 0;
      for (const cb of ch.combs) {
        const y = cb.buf[cb.i]!;
        cb.store = y * (1 - damp) + cb.store * damp;
        cb.buf[cb.i] = input + cb.store * room;
        if (++cb.i >= cb.buf.length) cb.i = 0;
        acc += y;
      }
      for (const ap of ch.aps) {
        const bo = ap.buf[ap.i]!;
        const y = -acc + bo;
        ap.buf[ap.i] = acc + bo * 0.5;
        if (++ap.i >= ap.buf.length) ap.i = 0;
        acc = y;
      }
      if (c === 0) outL[i] = acc; else outR[i] = acc;
    }
  }
  const w = wet * 3;
  for (let i = 0; i < n; i++) {
    L[i] = L[i]! + outL[i]! * w;
    R[i] = R[i]! + outR[i]! * w;
  }
}

export function renderAudio(input: SynthInput): SynthOutput {
  const sr = input.sampleRate;
  const n = Math.ceil((input.duration + 0.2) * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rand = mulberry32((input.seed || 1) + 99);
  const A = input.settings;
  for (const ev of input.melody) {
    const sound = input.sounds[ev.section] ?? input.sounds[0];
    if (sound) renderMallet(L, R, sr, ev, sound, A.melodyGain, rand);
  }
  for (const ev of input.backing) renderSustained(L, R, sr, ev, rand);
  freeverb(L, R, sr, A.reverb);
  // gentle fade at the very end, then normalise to -1 dBFS
  const fade = Math.min(n, Math.round(0.6 * sr));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    L[n - 1 - i] = L[n - 1 - i]! * g;
    R[n - 1 - i] = R[n - 1 - i]! * g;
  }
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  const g = (0.89 * (A.masterGain ?? 0.9)) / peak / 0.9;
  for (let i = 0; i < n; i++) { L[i] = L[i]! * g; R[i] = R[i]! * g; }
  return { sampleRate: sr, left: L, right: R };
}
