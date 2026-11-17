// The 2D overlay of the film: title card, section labels, captions, end card, watermark, vignette,
// and the fades from and to black. A pure function of time, drawn over the 3D frame.
import type { Plan } from '../core/plan.ts';
import { FONTS } from '../core/project.ts';
import type { Project } from '../core/project.ts';

const fadeIO = (t: number, t0: number, t1: number, f = 0.4) => Math.max(0, Math.min(1, (t - t0) / f, (t1 - t) / f));

/** `fades`: draw the fades from and to black (the editor leaves them out while it is paused). */
export function drawOverlay(ctx: CanvasRenderingContext2D, t: number, W: number, H: number, plan: Plan, project: Project, fades = true): void {
  const theme = project.theme;
  const titles = project.titles;
  const hud = plan.hud;
  const font = FONTS[theme.font]?.css ?? FONTS.sans.css;
  // text scale and layout: landscape sizes follow the height; portrait sizes follow the width and
  // keep the text clear of the UI of Shorts and Reels at the top and bottom
  const portrait = H > W * 1.05;
  const U = Math.min(H, W * 1.25);
  const LAY = portrait
    ? { title: 0.2, section: 0.105, caption: 0.7, end: 0.42, wmY: 0.76 }
    : { title: 0.16, section: 0.085, caption: 0.9, end: 0.45, wmY: 0.97 };

  const textBlock = (text: string, x: number, y: number, size: number, alpha: number, weight = 800) => {
    if (!text || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = size * 0.25;
    ctx.shadowOffsetY = size * 0.05;
    ctx.strokeStyle = theme.textStroke;
    ctx.lineWidth = size * 0.16;
    ctx.strokeText(text, x, y);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = theme.text;
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  const fitSize = (text: string, size: number, weight: number, maxW: number) => {
    ctx.font = `${weight} ${size}px ${font}`;
    const w = ctx.measureText(text).width;
    return w > maxW ? size * (maxW / w) : size;
  };

  const dur = plan.meta.duration;
  if (theme.vignette > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${theme.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const ta = fadeIO(t, -1, hud.titleUntil, 0.7);
  if (ta > 0 && titles.title) {
    const s1 = fitSize(titles.title, U * 0.07, 800, W * 0.9);
    textBlock(titles.title, W / 2, H * LAY.title, s1, ta);
    textBlock(titles.subtitle, W / 2, H * LAY.title + s1 * 0.95, fitSize(titles.subtitle, U * 0.034, 600, W * 0.85), ta, 600);
  }
  if (theme.sectionLabels) {
    for (const s of hud.sections) {
      const label = project.sections.find((x) => x.id === s.id)?.label ?? '';
      const a = fadeIO(t, Math.max(s.t0, hud.titleUntil - 0.2), s.t1, 0.45);
      if (a > 0 && label) textBlock(label, W / 2, H * LAY.section, fitSize(label, U * 0.042, 800, W * 0.9), a);
    }
  }
  for (const c of titles.captions) {
    const a = fadeIO(t, c.from + plan.meta.offset, c.to + plan.meta.offset, 0.25);
    if (a > 0 && c.text) textBlock(c.text, W / 2, H * LAY.caption, fitSize(c.text, U * 0.04, 700, W * 0.9), a, 700);
  }
  const endTitle = titles.endTitle || titles.title;
  if (t > hud.endFrom && (endTitle || titles.endSubtitle)) {
    const k = Math.min(1, (t - hud.endFrom) / 0.8);
    ctx.fillStyle = `rgba(10,10,12,${0.5 * k})`;
    ctx.fillRect(0, 0, W, H);
    const s1 = fitSize(endTitle, U * 0.075, 800, W * 0.9);
    textBlock(endTitle, W / 2, H * LAY.end, s1, k);
    textBlock(titles.endSubtitle, W / 2, H * LAY.end + s1 * 1.0, fitSize(titles.endSubtitle, U * 0.036, 600, W * 0.9), k, 600);
  }
  if (titles.watermark) {
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.font = `600 ${U * 0.022}px ${font}`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText(titles.watermark, W - U * 0.03, H * LAY.wmY);
    ctx.restore();
  }
  const fin = Math.max(0, 1 - t / 0.6), fout = Math.max(0, 1 - (dur - t) / 0.8);
  const f = fades ? Math.max(fin, fout) : 0;
  if (f > 0) {
    ctx.fillStyle = `rgba(0,0,0,${f})`;
    ctx.fillRect(0, 0, W, H);
  }
}
