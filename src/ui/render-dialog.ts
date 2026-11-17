// The render dialog: the size, the frame rate and the quality of the MP4, the progress of the
// render with a live preview, and the download link at the end.
import { ASPECTS } from '../core/project.ts';
import type { QualityName, RenderSettings } from '../core/project.ts';
import { canRenderVideo, renderMp4 } from '../app/export.ts';
import type { Store } from '../app/store.ts';
import type { Engine } from '../app/engine.ts';
import type { AssetStore } from '../app/assets.ts';
import { button, chips, formatTime, h, select } from './dom.ts';

const QUALITIES: [QualityName, string, string][] = [
  ['draft', 'Draft', 'Fast check: no ambient occlusion, no motion blur.'],
  ['high', 'High', '4 sub-frames per frame: anti-aliasing, motion blur, soft shadows and ambient occlusion.'],
  ['ultra', 'Ultra', '8 sub-frames per frame and finer shadows. About twice as slow as High.'],
];

export function videoSize(aspect: keyof typeof ASPECTS, short: number): [number, number] {
  const a = ASPECTS[aspect];
  const even = (v: number) => Math.round(v / 2) * 2;
  return a.width >= a.height ? [even((short * a.width) / a.height), short] : [short, even((short * a.height) / a.width)];
}

export class RenderDialog {
  readonly el: HTMLDialogElement;
  #body: HTMLElement;
  #abort: AbortController | null = null;
  #url: string | null = null;
  #range: 'all' | 'test' = 'all';

  constructor(private readonly store: Store, private readonly engine: Engine, private readonly assets: AssetStore, private readonly onBusy: (busy: boolean) => void) {
    this.#body = h('div', { class: 'render-body' });
    this.el = h('dialog', { class: 'render-dialog' },
      h('div', { class: 'dlg-head' }, h('h2', { text: 'Render MP4' }), button('×', () => this.close(), 'icon-btn', 'Close')),
      this.#body);
    this.el.addEventListener('cancel', (e) => { if (this.#abort) e.preventDefault(); });
    document.body.append(this.el);
  }

  open(): void {
    this.#showSetup();
    this.el.showModal();
  }

  close(): void {
    if (this.#abort) return;
    this.el.close();
  }

  #showSetup(): void {
    const p = () => this.store.project;
    const r = () => p().render;
    const up = (fn: (r: RenderSettings) => void) => this.store.update((pp) => fn(pp.render), { coalesce: 'render' });
    const plan = this.engine.plan;
    const info = h('div', { class: 'render-info' });
    const refreshInfo = () => {
      const [w, hh] = videoSize(p().aspect, r().resolution);
      const dur = this.#range === 'test' ? Math.min(10, plan?.meta.duration ?? 0) : plan?.meta.duration ?? 0;
      info.textContent = plan ? `${ASPECTS[p().aspect].label} · ${w} × ${hh} · ${r().fps} fps · ${formatTime(dur)} · ${Math.ceil(dur * r().fps)} frames` : 'Open a song first.';
    };
    const res = select<number>({ label: 'Size', options: [[720, '720p'], [1080, '1080p (Full HD)'], [1440, '1440p'], [2160, '2160p (4K)']], get: () => r().resolution, set: (v) => { up((x) => { x.resolution = v as RenderSettings['resolution']; }); refreshInfo(); } });
    const fps = chips<'30' | '60'>({ label: 'Frame rate', options: [['30', '30 fps'], ['60', '60 fps']], get: () => String(r().fps) as '30' | '60', set: (v) => { up((x) => { x.fps = Number(v) as RenderSettings['fps']; }); fps.refresh(); refreshInfo(); } });
    const qHint = h('p', { class: 'hint' });
    const q = chips<QualityName>({ label: 'Quality', options: QUALITIES.map(([v, l]) => [v, l]), get: () => r().quality, set: (v) => { up((x) => { x.quality = v; }); q.refresh(); qHint.textContent = QUALITIES.find((x) => x[0] === v)![2]; } });
    qHint.textContent = QUALITIES.find((x) => x[0] === r().quality)![2];
    const range = chips<'all' | 'test'>({ label: 'Length', options: [['all', 'Whole video'], ['test', 'First 10 s (test)']], get: () => this.#range, set: (v) => { this.#range = v; range.refresh(); refreshInfo(); } });
    refreshInfo();
    const start = button('Render', () => void this.#start(), 'btn accent big');
    const notes = h('p', { class: 'hint', text: 'The page draws each frame at full quality, so the render can take longer than the video. Keep this tab open. The file downloads from this dialog at the end.' });
    let problem = '';
    if (!canRenderVideo()) problem = 'This browser has no WebCodecs, so it cannot make a video. Use a current Chrome, Edge or Safari.';
    else if (!plan) problem = 'Open a song first.';
    else if (this.engine.planning || this.engine.synthing) problem = 'The layout or the sound is still being made. Wait a moment.';
    if (problem) start.disabled = true;
    this.#body.replaceChildren(info, res.el, fps.el, q.el, qHint, range.el, notes, problem ? h('p', { class: 'error', text: problem }) : '', h('div', { class: 'btns right' }, start));
  }

  async #start(): Promise<void> {
    const project = structuredClone(this.store.project);
    const plan = this.engine.plan, audio = this.engine.audio;
    if (!plan || !audio) return;
    const [w, hh] = videoSize(project.aspect, project.render.resolution);
    const abort = new AbortController();
    this.#abort = abort;
    this.onBusy(true);
    const bar = h('div', { class: 'progress' }, h('div', { class: 'fill' }));
    const msg = h('p', { class: 'render-msg', text: 'Starting…' });
    const eta = h('p', { class: 'hint' });
    const live = h('canvas', { class: 'render-live' });
    live.width = 480;
    live.height = Math.round((480 * hh) / w);
    const stop = button('Stop', () => abort.abort(), 'btn danger');
    this.#body.replaceChildren(live, bar, msg, eta, h('div', { class: 'btns right' }, stop));
    const fill = bar.firstElementChild as HTMLElement;
    try {
      const result = await renderMp4({
        project, plan, audio, images: this.assets, width: w, height: hh, fps: project.render.fps, quality: project.render.quality,
        to: this.#range === 'test' ? 10 : undefined,
        signal: abort.signal,
        onProgress: (pr) => {
          msg.textContent = pr.message;
          bar.classList.toggle('busy', pr.stage !== 'frames');
          fill.style.width = pr.frames ? `${(100 * pr.frame) / pr.frames}%` : '0%';
          eta.textContent = pr.eta != null && pr.eta > 0 ? `About ${formatTime(pr.eta)} left` : '';
        },
        onFrame: (c) => live.getContext('2d')!.drawImage(c, 0, 0, live.width, live.height),
      });
      if (this.#url) URL.revokeObjectURL(this.#url);
      this.#url = URL.createObjectURL(result.blob);
      const name = `${(project.name || 'beat-bounce').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'beat-bounce'}${this.#range === 'test' ? '-test' : ''}.mp4`;
      const link = h('a', { class: 'btn accent big', href: this.#url, download: name, text: `Download ${name}` });
      const video = h('video', { class: 'render-video', src: this.#url, controls: true, playsinline: true });
      this.#body.replaceChildren(video,
        h('p', { text: `${result.frames} frames, ${(result.blob.size / 1e6).toFixed(1)} MB, ${result.codecs}, made in ${formatTime(result.seconds)}.` }),
        h('div', { class: 'btns right' }, button('Render again', () => this.#showSetup(), 'btn'), link));
      link.click();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      this.#body.replaceChildren(h('p', { class: abort.signal.aborted ? '' : 'error', text: abort.signal.aborted ? 'The render stopped.' : `The render failed: ${text}` }),
        h('div', { class: 'btns right' }, button('Back', () => this.#showSetup(), 'btn')));
    } finally {
      this.#abort = null;
      this.onBusy(false);
    }
  }
}
