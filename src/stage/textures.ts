// Procedural textures: wall surfaces, wood grain, marbles, ball prints, and text canvases.
// Ported from the anthem-bouncing viewer and extended with more wall and ball styles.
import * as THREE from 'three';
import type { WallStyle } from '../core/project.ts';

// ---------------------------------------------------------------------------------------------------
// Noise

export function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  const grad = (h: number, x: number, y: number) => ((h & 1) ? x : -x) + ((h & 2) ? y : -y);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return function noise(x: number, y: number) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const a = perm[X]! + Y, b = perm[X + 1]! + Y;
    const l1 = grad(perm[a]!, x, y) * (1 - u) + grad(perm[b]!, x - 1, y) * u;
    const l2 = grad(perm[a + 1]!, x, y - 1) * (1 - u) + grad(perm[b + 1]!, x - 1, y - 1) * u;
    return l1 * (1 - v) + l2 * v;
  };
}

const noise = makeNoise(1);
export const fbm = (x: number, y: number, o = 4) => {
  let a = 0, f = 1, amp = 0.5;
  for (let i = 0; i < o; i++) { a += amp * noise(x * f, y * f); f *= 2; amp *= 0.5; }
  return a;
};

/** Tileable gradient noise (period p lattice cells) for seamless wall textures. */
function tileNoise(seed: number) {
  const n = makeNoise(seed);
  return (x: number, y: number, p: number) => {
    const fx = x / p, fy = y / p;
    const a = n(x, y), b = n(x - p, y), c = n(x, y - p), d = n(x - p, y - p);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

function hash2(x: number, y: number, s = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function canvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasTexture(c: HTMLCanvasElement, srgb: boolean, repeat = false, anisotropy = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Walls

export interface WallTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  /** Metres covered by one texture tile at scale 1. */
  natural: number;
}

const wallCache = new Map<string, WallTextures>();

/**
 * Wall albedo, normal and roughness maps from one tileable height field. The albedo is the wall
 * colour times a per-pixel shade (and, for bricks and planks, a per-piece colour variation).
 */
export function wallTextures(style: WallStyle, color: string, bump: number, seed: number): WallTextures {
  const key = `${style}|${color}|${bump}|${seed}`;
  const hit = wallCache.get(key);
  if (hit) return hit;
  const S = style === 'plaster' || style === 'smooth' ? 512 : 1024;
  const tn = tileNoise(seed + 7);
  const hgt = new Float32Array(S * S);
  const shade = new Float32Array(S * S).fill(1);
  const tint = new Float32Array(S * S * 3).fill(1);
  const rough = new Float32Array(S * S).fill(0.9);
  const base = new THREE.Color(color);
  if (style === 'plaster' || style === 'smooth' || style === 'concrete') {
    const octaves = style === 'smooth' ? 4 : 6;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      let h = 0, amp = 1, f = 6;
      for (let o = 0; o < octaves; o++) { h += amp * tn(u * f, v * f, f); f *= 2; amp *= 0.5; }
      const i = y * S + x;
      if (style === 'plaster') {
        h += 0.6 * Math.abs(tn(u * 3 + 0.5 * tn(u * 6, v * 6, 6), v * 3, 3)); // trowel marks
        shade[i] = 1 + h * 0.02;
      } else if (style === 'concrete') {
        const blot = tn(u * 4, v * 4, 4) + 0.5 * tn(u * 8, v * 8, 8);
        const pit = hash2(x, y, seed) > 0.9985 ? -1.2 : 0;
        h = h * 0.6 + pit;
        shade[i] = 1 + blot * 0.09 + h * 0.03 + pit * 0.08;
        rough[i] = 0.85 + blot * 0.05;
      } else {
        h *= 0.15;
        shade[i] = 1 + h * 0.03;
      }
      hgt[i] = h;
    }
  } else if (style === 'brick') {
    // 8 bricks across and 24 courses down one tile; running bond
    const across = 8, courses = 24, mortar = 0.11;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = (y / S) * courses;
      const row = Math.floor(v);
      const u = (x / S) * across + (row % 2 ? 0.5 : 0);
      const col = Math.floor(u) % across;
      const fu = u - Math.floor(u), fv = v - row;
      const edge = Math.min(fu * 3.2, (1 - fu) * 3.2, fv, 1 - fv); // in brick-height units
      const i = y * S + x;
      const n = tn((x / S) * 24, (y / S) * 24, 24);
      if (edge < mortar) {
        // mortar: a light grey whatever the brick colour (tint = mortar / base)
        hgt[i] = -0.6 + n * 0.2;
        shade[i] = 1 + n * 0.08;
        tint[3 * i] = 0.74 / Math.max(0.02, base.r); tint[3 * i + 1] = 0.72 / Math.max(0.02, base.g); tint[3 * i + 2] = 0.68 / Math.max(0.02, base.b);
        rough[i] = 1;
      } else {
        const r = hash2(col, row, seed);
        const bevel = Math.min(1, (edge - mortar) / 0.08);
        hgt[i] = 0.4 * bevel + n * 0.35 + (hash2(x, y, 3) - 0.5) * 0.08;
        shade[i] = 0.82 + r * 0.32 + n * 0.08;
        tint[3 * i] = 1 + (hash2(col, row, 1) - 0.5) * 0.12; tint[3 * i + 1] = 1 + (hash2(col, row, 2) - 0.5) * 0.1; tint[3 * i + 2] = 1;
        rough[i] = 0.82 + n * 0.08;
      }
    }
  } else {
    // vertical planks, 10 across one tile, with wood grain and dark gaps
    const across = 10;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x / S) * across;
      const col = Math.floor(u);
      const fu = u - col;
      const v = y / S;
      const i = y * S + x;
      const off = hash2(col, 0, seed) * 50;
      const warp = fbm(fu * 1.5 + off, v * 3 + off, 3) * 2.2;
      const ring = Math.abs(Math.sin((fu * 6 + warp + off) * Math.PI));
      const line = Math.pow(1 - ring, 6);
      const gap = (Math.min(fu, 1 - fu) * S) / across; // pixels to the edge of the plank
      if (gap < 1.4) {
        hgt[i] = -1; shade[i] = 0.35; rough[i] = 1;
      } else {
        hgt[i] = -0.25 * line + 0.05 * tn(x / S * 64, y / S * 64, 64);
        shade[i] = (0.86 + hash2(col, 1, seed) * 0.22) * (1 - 0.25 * line);
        rough[i] = 0.7 + 0.15 * line;
      }
    }
  }
  const ca = canvas(S), cn = canvas(S), cr = canvas(S);
  const ia = ca.getContext('2d')!.createImageData(S, S), inn = cn.getContext('2d')!.createImageData(S, S), ir = cr.getContext('2d')!.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, k = 4 * i;
    const hx = hgt[y * S + ((x + 1) % S)]! - hgt[y * S + ((x - 1 + S) % S)]!;
    const hy = hgt[((y + 1) % S) * S + x]! - hgt[((y - 1 + S) % S) * S + x]!;
    let nx = -hx * bump, ny = hy * bump, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    inn.data[k] = (nx * 0.5 + 0.5) * 255; inn.data[k + 1] = (ny * 0.5 + 0.5) * 255; inn.data[k + 2] = (nz * 0.5 + 0.5) * 255; inn.data[k + 3] = 255;
    const sh = shade[i]!;
    ia.data[k] = Math.min(255, base.r * sh * tint[3 * i]! * 255);
    ia.data[k + 1] = Math.min(255, base.g * sh * tint[3 * i + 1]! * 255);
    ia.data[k + 2] = Math.min(255, base.b * sh * tint[3 * i + 2]! * 255);
    ia.data[k + 3] = 255;
    const r = Math.max(0, Math.min(1, rough[i]! + (style === 'plaster' ? hgt[i]! * 0.04 : 0)));
    ir.data[k] = ir.data[k + 1] = ir.data[k + 2] = r * 255; ir.data[k + 3] = 255;
  }
  ca.getContext('2d')!.putImageData(ia, 0, 0); cn.getContext('2d')!.putImageData(inn, 0, 0); cr.getContext('2d')!.putImageData(ir, 0, 0);
  const out: WallTextures = {
    map: canvasTexture(ca, true, true), normalMap: canvasTexture(cn, false, true), roughnessMap: canvasTexture(cr, false, true),
    natural: style === 'brick' ? 2.0 : style === 'planks' ? 1.6 : 3.5,
  };
  for (const t of [out.map, out.normalMap, out.roughnessMap]) t.userData['shared'] = true;
  if (wallCache.size > 6) wallCache.clear();
  wallCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Wood (bars, frames)

const woodCache = new Map<string, { map: THREE.Texture; normalMap: THREE.Texture }>();

/**
 * Wood grain: albedo and a tangent-space normal map from the same grain height. (A bumpMap is not
 * used: three.js bump mapping can give NaN pixels on sliver fragments, which bloom spreads.)
 */
export function woodTextures(color: string): { map: THREE.Texture; normalMap: THREE.Texture } {
  const hit = woodCache.get(color);
  if (hit) return hit;
  const base = new THREE.Color(color);
  const S = 512;
  const grain = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const warp = fbm(u * 1.5, v * 3, 3) * 2.2 + u * 0.6;
    const ring = Math.abs(Math.sin((v * 9 + warp) * Math.PI));
    const line = Math.pow(1 - ring, 8);
    const pores = fbm(u * 3, v * 90, 2) * 0.5 + 0.5;
    grain[y * S + x] = 1.08 - 0.32 * line - 0.12 * pores + fbm(u * 2, v * 2, 2) * 0.12;
  }
  const ca = canvas(S), cn = canvas(S);
  const ia = ca.getContext('2d')!.createImageData(S, S), inn = cn.getContext('2d')!.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, k = 4 * i, g = grain[i]!;
    ia.data[k] = Math.max(0, Math.min(255, base.r * g * 255));
    ia.data[k + 1] = Math.max(0, Math.min(255, base.g * g * 255));
    ia.data[k + 2] = Math.max(0, Math.min(255, base.b * g * 255));
    ia.data[k + 3] = 255;
    const hx = grain[y * S + Math.min(S - 1, x + 1)]! - grain[y * S + Math.max(0, x - 1)]!;
    const hy = grain[Math.min(S - 1, y + 1) * S + x]! - grain[Math.max(0, y - 1) * S + x]!;
    let nx = -hx * 2.2, ny = hy * 2.2, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    inn.data[k] = (nx * 0.5 + 0.5) * 255; inn.data[k + 1] = (ny * 0.5 + 0.5) * 255; inn.data[k + 2] = (nz * 0.5 + 0.5) * 255; inn.data[k + 3] = 255;
  }
  ca.getContext('2d')!.putImageData(ia, 0, 0);
  cn.getContext('2d')!.putImageData(inn, 0, 0);
  const out = { map: canvasTexture(ca, true, true), normalMap: canvasTexture(cn, false, true) };
  out.map.userData['shared'] = out.normalMap.userData['shared'] = true;
  woodCache.set(color, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Balls

function pixelCanvas(w: number, h: number, fn: (u: number, v: number) => [number, number, number]): HTMLCanvasElement {
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, gg, b] = fn(x / w, y / h);
    const i = 4 * (y * w + x);
    img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** A swirled marble in one colour, or "earth" for the blue and green marble of anthem-bouncing. */
export function marbleTexture(kind: string, color2 = '#ffffff'): THREE.Texture {
  const base = new THREE.Color(kind === 'earth' ? '#2060c0' : kind);
  const vein = new THREE.Color(color2);
  const c = pixelCanvas(512, 256, (u, v) => {
    const x = u * 6, y = v * 3;
    const swirl = fbm(x + fbm(x * 0.7, y * 0.7) * 2.5, y, 5);
    if (kind === 'earth') {
      const land = fbm(x * 0.9 + 10, y * 1.3, 5);
      const cloud = Math.max(0, fbm(x * 1.6 + 30, y * 2.2 + swirl * 2, 4) - 0.05) * 2.4;
      let col = land > 0.08 ? (land > 0.2 ? [120, 140, 70] : [60, 140, 70]) : [25 + swirl * 40, 80 + swirl * 60, 190 + swirl * 40];
      col = col.map((ch) => ch * (1 - Math.min(1, cloud)) + 245 * Math.min(1, cloud));
      return col as [number, number, number];
    }
    const k = 0.75 + swirl * 0.8;
    const white = Math.max(0, Math.sin((x + swirl * 4) * 3.1)) ** 8;
    return [base.r, base.g, base.b].map((ch, i) => {
      const w = [vein.r, vein.g, vein.b][i]!;
      return Math.min(255, (ch * k * (1 - white) + w * white) * 255);
    }) as [number, number, number];
  });
  return canvasTexture(c, true, false, 4);
}

/** A beach ball: coloured segments from pole to pole, with white caps. */
export function beachTexture(colors: string[]): THREE.Texture {
  const c = canvas(1024, 512);
  const g = c.getContext('2d')!;
  const n = 6;
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[i % colors.length]!;
    g.fillRect((i * 1024) / n, 0, 1024 / n + 1, 512);
  }
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 1024, 46);
  g.fillRect(0, 512 - 46, 1024, 46);
  return canvasTexture(c, true, false, 8);
}

/**
 * Equirectangular ball texture from a picture (a flag, a logo, a face). The picture is wrapped twice
 * around the equator, and the polar caps continue its top and bottom edge colours. `focus` is placed
 * at the point of the sphere that faces the camera (+z), which stays facing it as the ball rolls.
 */
export function imageBallTexture(img: CanvasImageSource & { width: number; height: number }, focus: [number, number]): THREE.Texture {
  const TW = 2048, TH = 1024;
  const c = canvas(TW, TH);
  const g = c.getContext('2d')!;
  const iw = (img as HTMLImageElement).naturalWidth || img.width || 300, ih = (img as HTMLImageElement).naturalHeight || img.height || 200;
  const fw = TW / 2;
  const fh = Math.min(TH, fw * (ih / iw));
  const [fx, fy] = focus;
  const x0 = TW * 0.25 - fx * fw;
  const y0 = Math.max(0, Math.min(TH - fh, TH / 2 - fy * fh));
  g.imageSmoothingQuality = 'high';
  for (const k of [-2, -1, 0, 1, 2]) {
    const x = x0 + k * fw;
    if (x > TW || x + fw < 0) continue;
    g.drawImage(img, x, y0, fw, fh);
    if (y0 > 0) g.drawImage(img, 0, 0, iw, 1, x, 0, fw, y0 + 1);
    if (y0 + fh < TH) g.drawImage(img, 0, ih - 1, iw, 1, x, y0 + fh - 1, fw, TH - y0 - fh + 1);
  }
  return canvasTexture(c, true, false, 8);
}

// ---------------------------------------------------------------------------------------------------
// Text

export interface TextLine {
  text: string;
  size: number;
  weight?: number;
}

export function textCanvas(lines: TextLine[], opts: { w: number; h: number; bg: string; color: string; font: string; border?: string; borderWidth?: number; dash?: number[] }): THREE.Texture {
  const c = canvas(opts.w, opts.h);
  const g = c.getContext('2d')!;
  g.fillStyle = opts.bg; g.fillRect(0, 0, c.width, c.height);
  if (opts.border) {
    g.strokeStyle = opts.border; g.lineWidth = opts.borderWidth || 6;
    if (opts.dash) g.setLineDash(opts.dash);
    g.strokeRect(g.lineWidth, g.lineWidth, c.width - 2 * g.lineWidth, c.height - 2 * g.lineWidth);
    g.setLineDash([]);
  }
  g.fillStyle = opts.color; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((ln, i) => {
    g.font = `${ln.weight || 600} ${ln.size}px ${opts.font}`;
    g.fillText(ln.text, c.width / 2, c.height / 2 + (i - (lines.length - 1) / 2) * ln.size * 1.25);
  });
  return canvasTexture(c, true, false, 4);
}
