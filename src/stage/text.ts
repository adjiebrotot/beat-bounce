// Wall text: measuring and drawing a text ornament into a canvas. The editor measures the aspect
// of the block when the text or the font changes; the stage draws the same block as a texture.
import { FONTS } from '../core/project.ts';
import type { TextOrnament } from '../core/project.ts';

/** Font size of the text canvas, pixels per line. */
export const TEXT_PX = 160;
const LINE = 1.18;

type TextLook = Pick<TextOrnament, 'text' | 'font' | 'weight' | 'italic' | 'outlineWidth' | 'style' | 'align'>;

export function textFont(o: Pick<TextOrnament, 'font' | 'weight' | 'italic'>, px = TEXT_PX): string {
  return `${o.italic ? 'italic ' : ''}${o.weight} ${px}px ${FONTS[o.font]?.css ?? FONTS.sans.css}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;

function lines(o: TextLook): string[] {
  const ls = o.text.split('\n');
  return ls.length ? ls : [''];
}

function padding(o: TextLook): number {
  return TEXT_PX * (o.style === 'neon' ? 0.55 : 0.18) + TEXT_PX * o.outlineWidth;
}

export function measureText(o: TextLook): { w: number; h: number; widths: number[] } {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!;
  ctx.font = textFont(o);
  const widths = lines(o).map((l) => Math.max(ctx.measureText(l || ' ').width, TEXT_PX * 0.3));
  const pad = padding(o);
  return { w: Math.max(...widths) + 2 * pad, h: lines(o).length * TEXT_PX * LINE + 2 * pad, widths };
}

/** Width / height of the text block. */
export function textAspect(o: TextLook): number {
  const m = measureText(o);
  return m.w / m.h;
}

/**
 * Draws the text block on a transparent canvas. `mode` "glow" draws only the blurred halo of a
 * neon text, and "side" draws the darker body of raised letters.
 */
export function drawText(o: TextOrnament, mode: 'face' | 'glow' | 'side' = 'face', maxSide = 2048): HTMLCanvasElement {
  const m = measureText(o);
  const scale = Math.min(1, maxSide / Math.max(m.w, m.h));
  const c = document.createElement('canvas');
  c.width = Math.max(4, Math.ceil(m.w * scale));
  c.height = Math.max(4, Math.ceil(m.h * scale));
  const g = c.getContext('2d')!;
  g.scale(scale, scale);
  g.font = textFont(o);
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const pad = padding(o);
  const ls = lines(o);
  const inner = m.w - 2 * pad;
  ls.forEach((line, i) => {
    const w = m.widths[i]!;
    const x = o.align === 'left' ? pad : o.align === 'right' ? pad + inner - w : pad + (inner - w) / 2;
    const y = pad + (i + 0.5) * TEXT_PX * LINE;
    if (mode === 'glow') {
      g.shadowColor = o.color;
      g.shadowBlur = TEXT_PX * 0.35;
      g.fillStyle = o.color;
      for (let k = 0; k < 3; k++) g.fillText(line, x, y);
      return;
    }
    if (o.outlineWidth > 0 && o.style !== 'neon') {
      g.strokeStyle = mode === 'side' ? shade(o.outline, 0.55) : o.outline;
      g.lineWidth = TEXT_PX * o.outlineWidth * 2;
      g.strokeText(line, x, y);
    }
    if (o.style === 'neon' && mode === 'face') {
      // a bright core with a coloured rim: the look of a glass tube
      g.strokeStyle = o.color;
      g.lineWidth = TEXT_PX * 0.06;
      g.strokeText(line, x, y);
      g.fillStyle = mix(o.color, '#ffffff', 0.65);
      g.fillText(line, x, y);
      return;
    }
    g.fillStyle = mode === 'side' ? shade(o.color, 0.55) : o.color;
    g.fillText(line, x, y);
  });
  return c;
}

function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.padEnd(6, '0');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export function shade(hex: string, k: number): string {
  const [r, g, b] = parse(hex);
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

export function mix(a: string, b: string, k: number): string {
  const A = parse(a), B = parse(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i]! - v) * k)).join(',')})`;
}
