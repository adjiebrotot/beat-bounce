// The viewport: the 3D preview at the aspect of the project, the HUD overlay, and the placement
// tool. In the film view the camera is the film camera at the playhead (what the video shows). In
// the overview the camera looks straight at the wall; drag the empty wall to pan, scroll to zoom.
// In both views: click an ornament to select it, drag it to move it, drag a corner to resize it,
// and drag the round handle to turn it.
import * as THREE from 'three';
import { ornamentRect } from '../core/ornaments.ts';
import { pointInRect, rectCorners } from '../core/geometry.ts';
import type { V2 } from '../core/geometry.ts';
import { ASPECTS } from '../core/project.ts';
import type { Ornament } from '../core/project.ts';
import { sampleTrack } from '../core/camera.ts';
import { Stage } from '../stage/stage.ts';
import { drawOverlay } from '../stage/overlay.ts';
import type { Store } from '../app/store.ts';
import type { Engine } from '../app/engine.ts';
import type { AssetStore } from '../app/assets.ts';
import { h } from './dom.ts';

export type ViewMode = 'film' | 'overview';

interface Drag {
  kind: 'move' | 'scale' | 'rotate' | 'pan';
  id: string;
  pointer: number;
  start: V2;
  startClient: V2;
  orig: { x: number; y: number; width: number; rotation: number };
  cur: { x: number; y: number; width: number; rotation: number };
  moved: boolean;
  overview?: { x: number; y: number };
}

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_PIXELS = 1920 * 1080;

export class Viewport {
  readonly el: HTMLElement;
  readonly frame: HTMLElement;
  readonly status: HTMLElement;
  readonly empty: HTMLElement;
  stage!: Stage;
  mode: ViewMode = 'film';
  overview = { x: 0, y: 0, dist: 16 };
  dirty = true;
  selected: string | null = null;
  onSelect: (id: string | null) => void = () => undefined;
  onDropFiles: (files: File[], at: V2 | null) => void = () => undefined;
  #overlay: HTMLCanvasElement;
  #overlayCtx: CanvasRenderingContext2D;
  #svg: SVGSVGElement;
  #canvas: HTMLCanvasElement;
  #drag: Drag | null = null;
  #ray = new THREE.Raycaster();
  #tmpCam = new THREE.PerspectiveCamera();
  #v = new THREE.Vector3();
  #cssW = 1;
  #cssH = 1;
  #lastT = 0;

  constructor(private readonly store: Store, private readonly engine: Engine, private readonly assets: AssetStore) {
    this.#canvas = h('canvas', { class: 'gl' });
    this.#overlay = h('canvas', { class: 'hud' });
    this.#overlayCtx = this.#overlay.getContext('2d')!;
    this.#svg = document.createElementNS(SVGNS, 'svg');
    this.#svg.classList.add('handles');
    this.status = h('div', { class: 'vp-status' });
    this.empty = h('div', { class: 'vp-empty' });
    this.frame = h('div', { class: 'vp-frame' }, this.#canvas, this.#overlay, this.#svg as unknown as HTMLElement, this.status);
    this.el = h('div', { class: 'viewport' }, this.frame, this.empty);
    new ResizeObserver(() => this.#layout()).observe(this.el);
    this.#bindPointer();
    this.#bindDrop();
  }

  async init(): Promise<void> {
    this.stage = await Stage.create({ width: 640, height: 360, quality: 'preview', images: this.assets, composite: false, canvas: this.#canvas });
    this.#layout();
  }

  get aspect(): number {
    const a = ASPECTS[this.store.project.aspect];
    return a.width / a.height;
  }

  #layout(): void {
    const r = this.el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const pad = 16;
    const aw = r.width - 2 * pad, ah = r.height - 2 * pad;
    let w = aw, hh = aw / this.aspect;
    if (hh > ah) { hh = ah; w = ah * this.aspect; }
    this.#cssW = Math.max(10, Math.floor(w));
    this.#cssH = Math.max(10, Math.floor(hh));
    this.frame.style.width = `${this.#cssW}px`;
    this.frame.style.height = `${this.#cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(dpr, Math.sqrt(MAX_PIXELS / (this.#cssW * this.#cssH)));
    const pw = Math.round(this.#cssW * scale), ph = Math.round(this.#cssH * scale);
    this.stage?.setSize(pw, ph);
    this.#overlay.width = pw;
    this.#overlay.height = ph;
    this.#svg.setAttribute('viewBox', `0 0 ${this.#cssW} ${this.#cssH}`);
    this.dirty = true;
  }

  relayout(): void { this.#layout(); }

  setMode(mode: ViewMode, t: number): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'overview' && this.engine.plan) {
      const [cx, cy] = this.stage.filmTarget(t);
      const cam = this.engine.plan.camera;
      this.overview = { x: cx, y: cy - cam.lookDown, dist: cam.distance * 2.4 };
    }
    this.el.classList.toggle('is-overview', mode === 'overview');
    this.dirty = true;
  }

  /** Centres the overview on a wall point. */
  showPoint(x: number, y: number, dist?: number): void {
    this.overview.x = x;
    this.overview.y = y;
    if (dist) this.overview.dist = dist;
    this.dirty = true;
  }

  #view() {
    const o = this.overview;
    return { position: [o.x, o.y, o.dist] as [number, number, number], target: [o.x, o.y, 0] as [number, number, number], fov: 40 };
  }

  /** `playing`: the film fades from and to black only while it plays. */
  render(t: number, playing = false): void {
    const plan = this.engine.plan;
    this.#lastT = t;
    this.dirty = false;
    const ctx = this.#overlayCtx;
    ctx.clearRect(0, 0, this.#overlay.width, this.#overlay.height);
    if (!plan || !this.stage.plan) { this.#svg.replaceChildren(); return; }
    this.stage.renderAt(t, this.mode === 'overview' ? this.#view() : null);
    if (this.mode === 'film') drawOverlay(ctx, t, this.#overlay.width, this.#overlay.height, plan, this.store.project, playing);
    this.#drawHandles(t);
  }

  // ---------------------------------------------------------------------------------------------------
  // Geometry between the screen and the wall

  wallPoint(clientX: number, clientY: number): V2 | null {
    const r = this.frame.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.#ray.setFromCamera(ndc, this.stage.camera);
    const { origin, direction } = this.#ray.ray;
    if (Math.abs(direction.z) < 1e-6) return null;
    const s = -origin.z / direction.z;
    if (s < 0) return null;
    return [origin.x + s * direction.x, origin.y + s * direction.y];
  }

  #toScreen(x: number, y: number, z = 0, cam: THREE.Camera = this.stage.camera): V2 {
    this.#v.set(x, y, z).project(cam);
    return [((this.#v.x + 1) / 2) * this.#cssW, ((1 - this.#v.y) / 2) * this.#cssH];
  }

  /** The centre of the view on the wall: where a new ornament goes in the overview. */
  viewCentre(): V2 {
    return [this.overview.x, this.overview.y];
  }

  // ---------------------------------------------------------------------------------------------------
  // Handles and guides

  #ornament(id: string): Ornament | undefined {
    return this.store.project.ornaments.find((o) => o.id === id);
  }

  #current(o: Ornament): Ornament {
    const d = this.#drag;
    return d && d.id === o.id && d.kind !== 'pan' ? { ...o, ...d.cur } : o;
  }

  #drawHandles(t: number): void {
    const svg = this.#svg;
    const parts: string[] = [];
    const poly = (pts: V2[], cls: string) => `<polygon class="${cls}" points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>`;
    const plan = this.engine.plan!;
    if (this.mode === 'overview') {
      // the path of the ball, and what the film camera sees at the playhead
      const pts: string[] = [];
      const end = Math.min(plan.meta.duration, plan.meta.lastHit + 1.5);
      const tmp: number[] = [];
      for (let s = 0; s <= end; s += 0.05) {
        const [x, y] = sampleTrack(plan.ball.track, plan.ball.hz, 3, s, tmp);
        const [px, py] = this.#toScreen(x!, y!, plan.world.ballZ);
        pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      }
      parts.push(`<polyline class="path" points="${pts.join(' ')}"/>`);
      const cam = this.#tmpCam;
      cam.aspect = this.aspect;
      this.stage.setFilmCamera(cam, t);
      const corners: V2[] = [];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        this.#v.set(u, v, 0.5).unproject(cam).sub(cam.position).normalize();
        const s = -cam.position.z / this.#v.z;
        corners.push(this.#toScreen(cam.position.x + s * this.#v.x, cam.position.y + s * this.#v.y, 0));
      }
      parts.push(poly(corners, 'filmframe'));
      parts.push(`<text class="filmlabel" x="${corners[3]![0] + 6}" y="${corners[3]![1] + 16}">Camera at the playhead</text>`);
      for (const o of this.store.project.ornaments) {
        if (o.hidden || o.id === this.selected) continue;
        parts.push(poly(rectCorners(ornamentRect(this.#current(o))).map(([x, y]) => this.#toScreen(x, y)), o.keepClear ? 'outline clear' : 'outline'));
      }
    }
    const sel = this.selected ? this.#ornament(this.selected) : undefined;
    if (sel) {
      const o = this.#current(sel);
      const r = ornamentRect(o);
      const c = rectCorners(r).map(([x, y]) => this.#toScreen(x, y, 0.03));
      parts.push(poly(c, 'selection'));
      // corner handles scale; the round handle above the top edge turns
      c.forEach(([x, y], i) => parts.push(`<rect class="handle" data-handle="scale" data-i="${i}" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="3"/>`));
      const top = [(c[2]![0] + c[3]![0]) / 2, (c[2]![1] + c[3]![1]) / 2];
      const mid = this.#toScreen(o.x, o.y, 0.03);
      let dx = top[0]! - mid[0], dy = top[1]! - mid[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      const hx = top[0]! + dx * 26, hy = top[1]! + dy * 26;
      parts.push(`<line class="stem" x1="${top[0]}" y1="${top[1]}" x2="${hx}" y2="${hy}"/>`);
      parts.push(`<circle class="handle rot" data-handle="rotate" cx="${hx}" cy="${hy}" r="8"/>`);
    }
    svg.innerHTML = parts.join('');
  }

  // ---------------------------------------------------------------------------------------------------
  // Pointer

  #hit(p: V2): Ornament | null {
    const list = this.store.project.ornaments;
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i]!;
      if (!o.hidden && pointInRect(p[0], p[1], ornamentRect(o, 0.04))) return o;
    }
    return null;
  }

  #bindPointer(): void {
    const f = this.frame;
    f.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.engine.plan) return;
      const wp = this.wallPoint(e.clientX, e.clientY);
      const handle = (e.target as Element).closest?.('[data-handle]');
      const sel = this.selected ? this.#ornament(this.selected) : undefined;
      let drag: Drag | null = null;
      const base = (o: Ornament, kind: Drag['kind']): Drag => ({
        kind, id: o.id, pointer: e.pointerId, start: wp ?? [o.x, o.y], startClient: [e.clientX, e.clientY],
        orig: { x: o.x, y: o.y, width: o.width, rotation: o.rotation }, cur: { x: o.x, y: o.y, width: o.width, rotation: o.rotation }, moved: false,
      });
      if (handle && sel) {
        drag = base(sel, handle.getAttribute('data-handle') === 'rotate' ? 'rotate' : 'scale');
      } else if (wp) {
        const o = this.#hit(wp);
        if (o) {
          if (this.selected !== o.id) this.onSelect(o.id);
          drag = base(o, 'move');
        } else {
          if (this.selected) this.onSelect(null);
          if (this.mode === 'overview') {
            drag = { kind: 'pan', id: '', pointer: e.pointerId, start: wp, startClient: [e.clientX, e.clientY], orig: { x: 0, y: 0, width: 0, rotation: 0 }, cur: { x: 0, y: 0, width: 0, rotation: 0 }, moved: false, overview: { x: this.overview.x, y: this.overview.y } };
          }
        }
      }
      if (drag) {
        this.#drag = drag;
        f.setPointerCapture(e.pointerId);
        f.classList.add('dragging');
        e.preventDefault();
      }
      this.dirty = true;
    });
    f.addEventListener('pointermove', (e) => {
      const d = this.#drag;
      if (!d || d.pointer !== e.pointerId) {
        if (!d && this.engine.plan) {
          const wp = this.wallPoint(e.clientX, e.clientY);
          f.classList.toggle('can-grab', !!(wp && this.#hit(wp)));
        }
        return;
      }
      if (Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) > 2) d.moved = true;
      if (d.kind === 'pan') {
        const k = (2 * this.overview.dist * Math.tan((40 * Math.PI) / 360)) / this.#cssH;
        this.overview.x = d.overview!.x - (e.clientX - d.startClient[0]) * k;
        this.overview.y = d.overview!.y + (e.clientY - d.startClient[1]) * k;
        this.dirty = true;
        return;
      }
      const wp = this.wallPoint(e.clientX, e.clientY);
      if (!wp) return;
      const o = d.orig;
      if (d.kind === 'move') {
        d.cur.x = o.x + wp[0] - d.start[0];
        d.cur.y = o.y + wp[1] - d.start[1];
      } else if (d.kind === 'scale') {
        const r0 = Math.hypot(d.start[0] - o.x, d.start[1] - o.y), r1 = Math.hypot(wp[0] - o.x, wp[1] - o.y);
        d.cur.width = Math.max(0.15, Math.min(14, (o.width * r1) / Math.max(r0, 1e-3)));
      } else {
        let a = (Math.atan2(wp[1] - o.y, wp[0] - o.x) * 180) / Math.PI - 90;
        if (e.shiftKey) a = Math.round(a / 15) * 15;
        a = ((a + 540) % 360) - 180;
        d.cur.rotation = Math.round(a * 10) / 10;
      }
      this.stage.moveOrnament({ id: d.id, x: d.cur.x, y: d.cur.y, rotation: d.cur.rotation }, d.cur.width / o.width);
      this.dirty = true;
    });
    const end = (e: PointerEvent) => {
      const d = this.#drag;
      if (!d || d.pointer !== e.pointerId) return;
      this.#drag = null;
      f.classList.remove('dragging');
      if (d.kind !== 'pan' && d.moved) {
        this.store.update((p) => {
          const o = p.ornaments.find((x) => x.id === d.id);
          if (o) Object.assign(o, roundPose(d.cur));
        }, { coalesce: `drag-${d.id}-${Date.now()}` });
      } else if (d.kind !== 'pan') {
        this.stage.moveOrnament({ id: d.id, ...d.orig }, 1);
      }
      this.dirty = true;
    };
    f.addEventListener('pointerup', end);
    f.addEventListener('pointercancel', end);
    f.addEventListener('wheel', (e) => {
      if (this.mode !== 'overview') return;
      e.preventDefault();
      const before = this.wallPoint(e.clientX, e.clientY);
      const r = this.frame.getBoundingClientRect();
      const u = ((e.clientX - r.left) / r.width) * 2 - 1, v = -((e.clientY - r.top) / r.height) * 2 + 1;
      const nd = Math.max(2.5, Math.min(140, this.overview.dist * Math.exp(e.deltaY * 0.0015)));
      if (before) {
        const tan = Math.tan((40 * Math.PI) / 360);
        this.overview.x = before[0] - u * nd * tan * this.aspect;
        this.overview.y = before[1] - v * nd * tan;
      }
      this.overview.dist = nd;
      this.dirty = true;
    }, { passive: false });
  }

  #bindDrop(): void {
    const el = this.el;
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const at = this.engine.plan ? this.wallPoint(e.clientX, e.clientY) : null;
      this.onDropFiles(files, at);
    });
  }

  get time(): number { return this.#lastT; }
}

function roundPose(p: { x: number; y: number; width: number; rotation: number }) {
  return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, width: Math.round(p.width * 1000) / 1000, rotation: p.rotation };
}
