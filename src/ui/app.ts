// The editor: the header, the viewport with the transport, and the side panel. It wires the store,
// the engine (plan and sound), the player and the stage together.
import { ASPECTS, defaultProject, effectiveWorld, newPhoto, newSticker, newText, normalizeProject } from '../core/project.ts';
import type { AspectName, Ornament, Project } from '../core/project.ts';
import { spotNear, planInputOf } from '../core/plan.ts';
import { ornamentSize } from '../core/ornaments.ts';
import { analyseTrack } from '../core/midi.ts';
import type { TrackStats } from '../core/midi.ts';
import { MAX_MIDI_BYTES, parseSong } from '../core/midi-file.ts';
import { INSTRUMENTS } from '../core/instruments.ts';
import { AssetStore } from '../app/assets.ts';
import { kvGet } from '../app/db.ts';
import { Engine, planOnce } from '../app/engine.ts';
import { Player } from '../app/player.ts';
import { Store } from '../app/store.ts';
import { textAspect } from '../stage/text.ts';
import { Viewport } from './viewport.ts';
import { RenderDialog } from './render-dialog.ts';
import { TABS, toastError } from './panels.ts';
import type { AppApi, Built } from './panels.ts';
import { button, formatTime, h, pickFile, toast } from './dom.ts';

const BASE = import.meta.env.BASE_URL;

export class App implements AppApi {
  store!: Store;
  engine: Engine;
  player = new Player();
  assets = new AssetStore();
  viewport!: Viewport;
  selected: string | null = null;
  #root: HTMLElement;
  #tab = 'song';
  #built: Built | null = null;
  #builtKey = '';
  #panelBody = h('div', { class: 'panel-body' });
  #tabButtons = new Map<string, HTMLButtonElement>();
  #play!: HTMLButtonElement;
  #time!: HTMLElement;
  #seek!: HTMLInputElement;
  #markers!: HTMLElement;
  #undoBtn!: HTMLButtonElement;
  #redoBtn!: HTMLButtonElement;
  #aspectBtns = new Map<AspectName, HTMLButtonElement>();
  #viewBtns = new Map<string, HTMLButtonElement>();
  #nameInput!: HTMLInputElement;
  #renderDialog!: RenderDialog;
  #rendering = false;
  #seedDemoArt = false;
  #searching = false;
  #lastAspect: AspectName | null = null;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.engine = new Engine(this.assets);
  }

  async start(): Promise<void> {
    let project: Project | null = null;
    try {
      const saved = await kvGet<string>('project');
      if (saved) project = normalizeProject(JSON.parse(saved));
    } catch { /* a broken save starts the demo */ }
    let fresh = false;
    if (!project) { project = await this.#demoProject(); fresh = true; }
    this.store = new Store(project);
    this.viewport = new Viewport(this.store, this.engine, this.assets);
    this.#buildLayout();
    await this.viewport.init();
    this.viewport.onSelect = (id) => this.select(id);
    this.viewport.onDropFiles = (files, at) => void this.#dropFiles(files, at);
    this.#renderDialog = new RenderDialog(this.store, this.engine, this.assets, (busy) => { this.#rendering = busy; });
    if (fresh) this.#seedDemoArt = true;

    this.store.subscribe((p) => this.#onProject(p));
    this.engine.addEventListener('song', () => { this.engine.sync(this.store.project); this.#refreshPanel(); this.#updateStatus(); });
    this.engine.addEventListener('plan', () => this.#onPlan());
    this.engine.addEventListener('audio', () => {
      const a = this.engine.audio;
      if (a) this.player.setAudio(a.left, a.right, a.sampleRate);
      this.#updateStatus();
    });
    this.player.addEventListener('change', () => { this.#updateTransport(); this.viewport.dirty = true; });
    window.addEventListener('beforeunload', () => this.store.flush());
    this.#bindKeys();
    this.#onProject(this.store.project);
    requestAnimationFrame(this.#loop);
  }

  // ---------------------------------------------------------------------------------------------------
  // AppApi

  offset(): number { return this.engine.plan?.meta.offset ?? 0; }
  now(): number { return this.player.time; }

  select(id: string | null): void {
    this.selected = id;
    this.viewport.selected = id;
    this.viewport.dirty = true;
    if (id && this.#tab !== 'art') this.#setTab('art');
    else this.#refreshPanel(true);
  }

  showOrnament(id: string): void {
    const o = this.store.project.ornaments.find((x) => x.id === id);
    if (!o) return;
    const { w, h: hh } = ornamentSize(o);
    this.#setView('overview');
    this.viewport.showPoint(o.x, o.y, Math.max(4, Math.max(w, hh) * 2.6));
  }

  addOrnament(kind: Ornament['kind'], image: string | null = null, at?: [number, number]): void {
    const plan = this.engine.plan;
    if (!plan) { toast('Open a song first: the art goes on the wall of its layout.'); return; }
    const t = this.player.time;
    const view = plan.camera.viewHalfW;
    let o: Ornament;
    if (kind === 'photo') o = newPhoto(0, 0, Math.max(1.0, Math.min(2.4, view * 0.55)));
    else if (kind === 'sticker') o = newSticker(0, 0, image ?? 'builtin:star', Math.max(0.5, Math.min(0.9, view * 0.2)));
    else {
      o = newText(0, 0, 'Your text', Math.max(1.4, Math.min(3, view * 0.6)));
      o.textAspect = textAspect(o);
    }
    if (kind === 'photo' && image) { o = { ...o, image } as Ornament; }
    const { w, h: hh } = ornamentSize(o);
    const [x, y] = at ?? (this.viewport.mode === 'overview' ? this.viewport.viewCentre() : spotNear(plan, t, w, hh));
    o.x = Math.round(x * 100) / 100;
    o.y = Math.round(y * 100) / 100;
    this.store.update((p) => { p.ornaments.push(o); });
    this.select(o.id);
    if (kind === 'sticker' && image?.startsWith('builtin:')) {
      void this.assets.get(image).then((pic) => {
        if (pic) this.store.update((p) => { const s = p.ornaments.find((q) => q.id === o.id); if (s && s.kind === 'sticker') s.imageAspect = pic.width / Math.max(1, pic.height); }, { history: false });
      });
    }
  }

  openMidi(): void {
    void pickFile('.mid,.midi,audio/midi,audio/x-midi').then((f) => { if (f) void this.#loadMidiFile(f); });
  }

  loadDemo(): void {
    if (this.store.project.songAsset && !window.confirm('Load the demo song? Your current project is replaced (export it first to keep it).')) return;
    void this.#demoProject().then((p) => {
      this.selected = null;
      this.viewport.selected = null;
      this.store.replace(p);
      this.#seedDemoArt = true;
      this.player.seek(0);
    });
  }

  findCleanLayout(): void {
    const song = this.engine.song;
    if (!song || this.#searching) return;
    this.#searching = true;
    const base = this.store.project;
    const g0 = effectiveWorld(base).gravity;
    const tries: { seed: number; gravity: number }[] = [];
    for (const dg of [0, 1.5, 3]) for (let k = 1; k <= 6; k++) tries.push({ seed: (base.seed + k * 7919) % 100000, gravity: +(g0 + dg).toFixed(1) });
    const run = async () => {
      let best: { seed: number; gravity: number; forced: number } | null = null;
      for (let i = 0; i < tries.length; i++) {
        const tr = tries[i]!;
        this.viewport.status.textContent = `Looking for a clean layout (${i + 1} of ${tries.length})…`;
        const input = planInputOf({ ...base, seed: tr.seed, world: { ...base.world, gravity: tr.gravity } });
        try {
          const plan = await planOnce(song, input);
          if (!best || plan.stats.forced < best.forced) best = { ...tr, forced: plan.stats.forced };
          if (plan.stats.forced === 0) break;
        } catch { /* try the next one */ }
      }
      this.#searching = false;
      if (best) {
        const b = best;
        this.store.update((p) => { p.seed = b.seed; if (b.gravity !== g0) p.world = { ...p.world, gravity: b.gravity }; });
        toast(b.forced === 0 ? `Clean layout: seed ${b.seed}${b.gravity !== g0 ? `, gravity ${b.gravity}` : ''}.` : `Best found: ${b.forced} bars may touch. Try merging fast notes (Song tab).`);
      }
      this.#updateStatus();
    };
    void run();
  }

  // ---------------------------------------------------------------------------------------------------
  // Projects and files

  async #demoProject(): Promise<Project> {
    const p = defaultProject();
    try {
      const r = await fetch(`${BASE}demos/ode-to-joy.mid`);
      const blob = await r.blob();
      const a = await this.assets.add(new Blob([blob], { type: 'audio/midi' }), 'ode-to-joy.mid');
      p.songAsset = a.id;
    } catch (e) { toastError(e); }
    const beat = 60 / 132;
    p.name = 'Ode to Joy';
    p.songName = 'Ode to Joy (demo)';
    p.tracks = {
      '0': { role: 'melody', voice: 'strings', gain: 1, transpose: 0 },
      '1': { role: 'backing', voice: 'bass', gain: 0.45, transpose: 0 },
      '2': { role: 'backing', voice: 'strings', gain: 0.18, transpose: 0 },
    };
    p.sections = [
      { id: 's1', from: 0, instrument: 'xylophone', label: '1. Xylophone', colorMode: null, colors: null },
      { id: 's2', from: 18 * 4 * beat - 0.05, instrument: 'marimba', label: '2. Marimba', colorMode: null, colors: null },
      { id: 's3', from: 26 * 4 * beat - 0.05, instrument: 'boomwhacker', label: '3. Boomwhackers', colorMode: null, colors: null },
      { id: 's4', from: 30 * 4 * beat - 0.05, instrument: 'bells', label: '4. Tubular Bells', colorMode: null, colors: null },
    ];
    p.world = { gravity: 9 };
    p.ball = { ...p.ball, style: 'glass', color: '#ff7a1a', color2: '#bfe3ff', trail: true, trailColor: '#ffd166', trailLength: 0.5 };
    p.titles = { title: 'Ode to Joy', subtitle: 'Ludwig van Beethoven · Symphony No. 9', endTitle: '', endSubtitle: 'Made with Beat Bounce', watermark: '', captions: [] };
    return p;
  }

  /** Puts the art of the demo beside the path of its first plan. */
  #placeDemoArt(): void {
    const plan = this.engine.plan;
    if (!plan) return;
    this.#seedDemoArt = false;
    const items: Ornament[] = [];
    const title = newText(0, 0, 'Beat Bounce', 2.6);
    title.style = 'raised'; title.color = '#ff5d3a'; title.outline = '#ffffff'; title.outlineWidth = 0.05; title.rotation = -4;
    title.textAspect = textAspect(title);
    const photo = newPhoto(0, 0, 1.5);
    photo.frame = 'polaroid'; photo.rotation = 5; photo.caption = 'Drop your photo here'; photo.placeholder = 'Your photo';
    const note = newSticker(0, 0, 'builtin:note', 0.75);
    const star = newSticker(0, 0, 'builtin:star', 0.7);
    star.rotation = 12;
    const neon = newText(0, 0, 'Encore!', 2.2);
    neon.style = 'neon'; neon.color = '#ff3cac'; neon.font = 'script'; neon.weight = 700; neon.textAspect = textAspect(neon);
    const at = [4.5, 15, 27, 40, 56];
    [title, photo, note, star, neon].forEach((o, i) => {
      const { w, h: hh } = ornamentSize(o);
      const [x, y] = spotNear(plan, Math.min(at[i]!, plan.meta.duration - 2), w, hh);
      o.x = Math.round(x * 100) / 100;
      o.y = Math.round(y * 100) / 100;
      items.push(o);
    });
    this.store.update((p) => { p.ornaments.push(...items); }, { history: false });
  }

  async #loadMidiFile(file: File): Promise<void> {
    try {
      if (file.size > MAX_MIDI_BYTES) throw new Error('The MIDI file is larger than 4 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const song = parseSong(bytes, file.name);
      const stats = song.tracks.map((t) => analyseTrack(t, song.duration)).filter((s): s is TrackStats => !!s && s.notes > 0);
      if (!stats.length) throw new Error('This MIDI file has no notes.');
      const a = await this.assets.add(new Blob([bytes], { type: 'audio/midi' }), file.name);
      const ranked = [...stats].filter((s) => !s.percussion).sort((x, y) => y.melodyScore - x.melodyScore);
      const melody = ranked[0] ?? stats[0]!;
      const bass = stats.filter((s) => !s.percussion && s.index !== melody.index && s.meanPitch < 52).sort((x, y) => y.notes - x.notes)[0];
      const name = file.name.replace(/\.(mid|midi)$/i, '');
      this.store.update((p) => {
        p.songAsset = a.id;
        p.songName = file.name;
        p.tracks = { [String(melody.index)]: { role: 'melody', voice: 'strings', gain: 1, transpose: 0 } };
        if (bass) p.tracks[String(bass.index)] = { role: 'backing', voice: 'bass', gain: 0.4, transpose: 0 };
        p.melody = { ...p.melody, rangeFrom: null, rangeTo: null };
        p.sections = [{ id: p.sections[0]?.id ?? 's1', from: 0, instrument: p.sections[0]?.instrument ?? 'xylophone', label: INSTRUMENTS[p.sections[0]?.instrument ?? 'xylophone']!.label, colorMode: null, colors: null }];
        p.titles.captions = [];
        if (!p.titles.title || p.name === p.titles.title) p.titles.title = song.name && song.name !== file.name ? song.name : name;
        p.name = p.titles.title || name;
      });
      this.player.seek(0);
      this.#setTab('song');
      toast(`Loaded ${file.name}: ${stats.length} tracks. The ball bounces on "${melody.name || melody.instrument || `track ${melody.index + 1}`}".`);
    } catch (e) {
      toastError(e);
    }
  }

  async #dropFiles(files: File[], at: [number, number] | null): Promise<void> {
    for (const f of files) {
      if (/\.(mid|midi)$/i.test(f.name) || f.type.includes('midi')) { await this.#loadMidiFile(f); return; }
      if (f.type.startsWith('image/')) {
        const a = await this.assets.add(f, f.name);
        const sticker = f.type === 'image/png' || f.type === 'image/svg+xml' || f.type === 'image/webp' || f.type === 'image/gif';
        // a dropped picture on a selected empty photo fills it
        const sel = this.store.project.ornaments.find((o) => o.id === this.selected);
        if (sel && sel.kind === 'photo' && !sel.image) {
          this.store.update((p) => { const o = p.ornaments.find((x) => x.id === sel.id); if (o && o.kind === 'photo') { o.image = a.id; o.imageAspect = a.aspect ?? 1; } });
          continue;
        }
        const kind = sticker && window.confirm(`Add "${f.name}" as a sticker (no frame)? Cancel adds it as a framed photo.`) ? 'sticker' : 'photo';
        this.addOrnament(kind, a.id, at ?? undefined);
        const id = this.selected;
        this.store.update((p) => { const o = p.ornaments.find((x) => x.id === id); if (o && o.kind !== 'text') o.imageAspect = a.aspect ?? 1; }, { history: false });
      }
    }
  }

  async #exportProject(): Promise<void> {
    const p = this.store.project;
    const ids = new Set<string>();
    if (p.songAsset) ids.add(p.songAsset);
    if (p.ball.image) ids.add(p.ball.image);
    for (const o of p.ornaments) if (o.kind !== 'text' && o.image && !o.image.startsWith('builtin:')) ids.add(o.image);
    const assets: Record<string, { name: string; type: string; aspect?: number; data: string }> = {};
    for (const id of ids) {
      const a = await this.assets.record(id);
      if (!a) continue;
      const data = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(a.blob); });
      assets[id] = { name: a.name, type: a.type, aspect: a.aspect, data };
    }
    const blob = new Blob([JSON.stringify({ app: 'beat-bounce', version: 1, project: p, assets })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `${(p.name || 'beat-bounce').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'beat-bounce'}.beatbounce.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async #importProject(): Promise<void> {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as { app?: string; project?: unknown; assets?: Record<string, { name: string; type: string; aspect?: number; data: string }> };
      if (data.app !== 'beat-bounce' || !data.project) throw new Error('This file is not a Beat Bounce project.');
      for (const [id, a] of Object.entries(data.assets ?? {})) {
        const blob = await (await fetch(a.data)).blob();
        await this.assets.put({ id, name: a.name, type: a.type, aspect: a.aspect, blob });
      }
      this.selected = null;
      this.viewport.selected = null;
      this.store.replace(normalizeProject(data.project));
      this.player.seek(0);
      toast(`Opened ${f.name}.`);
    } catch (e) {
      toastError(e);
    }
  }

  #newProject(): void {
    if (!window.confirm('Start a new, empty project? Export the current one first to keep it.')) return;
    const p = defaultProject();
    this.selected = null;
    this.viewport.selected = null;
    this.store.replace(p);
    void this.assets.prune(new Set());
  }

  // ---------------------------------------------------------------------------------------------------
  // Layout

  #buildLayout(): void {
    this.#nameInput = h('input', { class: 'proj-name', type: 'text', 'aria-label': 'Project name', spellcheck: 'false' });
    this.#nameInput.addEventListener('input', () => this.store.update((p) => { p.name = this.#nameInput.value; }, { coalesce: 'name' }));
    const aspects = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Video shape' });
    for (const [k, a] of Object.entries(ASPECTS) as [AspectName, (typeof ASPECTS)[AspectName]][]) {
      const b = h('button', { type: 'button', class: 'seg-btn', title: a.hint, role: 'radio' }, h('span', { class: `shape shape-${k}` }), h('span', { text: a.label }));
      b.addEventListener('click', () => this.store.update((p) => { p.aspect = k; }));
      aspects.append(b);
      this.#aspectBtns.set(k, b);
    }
    this.#undoBtn = button('↶', () => this.store.undo(), 'icon-btn', 'Undo (Ctrl+Z)');
    this.#redoBtn = button('↷', () => this.store.redo(), 'icon-btn', 'Redo (Ctrl+Shift+Z)');
    const menu = h('details', { class: 'menu' },
      h('summary', { class: 'btn ghost', text: 'Project ▾' }),
      h('div', { class: 'menu-list' },
        button('Open MIDI file…', () => this.openMidi(), 'menu-item'),
        button('Load the demo song', () => this.loadDemo(), 'menu-item'),
        button('Export project…', () => void this.#exportProject(), 'menu-item', 'A .json file with the MIDI and the pictures inside'),
        button('Import project…', () => void this.#importProject(), 'menu-item'),
        button('New empty project', () => this.#newProject(), 'menu-item')));
    menu.addEventListener('click', (e) => { if ((e.target as Element).classList.contains('menu-item')) menu.open = false; });
    const header = h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), h('span', { text: 'Beat Bounce' })),
      this.#nameInput,
      h('div', { class: 'spacer' }),
      aspects,
      h('div', { class: 'undo' }, this.#undoBtn, this.#redoBtn),
      menu,
      button('Render MP4', () => this.#renderDialog.open(), 'btn accent'));

    this.#play = button('▶', () => this.player.toggle(), 'play', 'Play / pause (Space)');
    this.#time = h('span', { class: 'time', text: '0:00.0' });
    this.#seek = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Playhead' });
    this.#seek.addEventListener('input', () => this.player.seek((Number(this.#seek.value) / 1000) * this.player.duration));
    this.#markers = h('div', { class: 'markers' });
    const view = h('div', { class: 'seg small' });
    for (const [k, l, tip] of [['film', 'Film', 'What the video shows'], ['overview', 'Overview', 'The whole wall, straight on: pan and zoom to place art']] as const) {
      const b = h('button', { type: 'button', class: 'seg-btn', title: tip, text: l });
      b.addEventListener('click', () => this.#setView(k));
      view.append(b);
      this.#viewBtns.set(k, b);
    }
    const transport = h('div', { class: 'transport' }, this.#play, this.#time, h('div', { class: 'seek-wrap' }, this.#markers, this.#seek), view);

    const tabs = h('nav', { class: 'tabs', role: 'tablist' });
    for (const t of TABS) {
      const b = h('button', { type: 'button', class: 'tab-btn', role: 'tab' }, h('span', { class: 'tab-icon', text: t.icon }), h('span', { text: t.label }));
      b.addEventListener('click', () => this.#setTab(t.id));
      tabs.append(b);
      this.#tabButtons.set(t.id, b);
    }
    const panel = h('aside', { class: 'panel' }, tabs, this.#panelBody);
    const stageCol = h('section', { class: 'stage-col' }, this.viewport.el, transport);
    this.#root.replaceChildren(header, h('main', { class: 'main' }, stageCol, panel));
    this.#setTab(this.#tab);
    this.#updateView();
  }

  #setTab(id: string): void {
    this.#tab = id;
    for (const [k, b] of this.#tabButtons) b.setAttribute('aria-selected', String(k === id));
    this.#refreshPanel(true);
  }

  #refreshPanel(force = false): void {
    const def = TABS.find((t) => t.id === this.#tab)!;
    const key = this.#built ? this.#built.structure() : '';
    if (force || !this.#built || key !== this.#builtKey || this.#builtTab !== this.#tab) {
      const scroll = this.#builtTab === this.#tab ? this.#panelBody.scrollTop : 0;
      this.#built = def.build(this);
      this.#builtKey = this.#built.structure();
      this.#builtTab = this.#tab;
      this.#panelBody.replaceChildren(this.#built.el);
      this.#panelBody.scrollTop = scroll;
    } else {
      this.#built.refresh();
    }
  }
  #builtTab = '';

  #setView(mode: 'film' | 'overview'): void {
    this.viewport.setMode(mode, this.player.time);
    this.#updateView();
  }

  #updateView(): void {
    for (const [k, b] of this.#viewBtns) b.setAttribute('aria-pressed', String(k === this.viewport.mode));
  }

  // ---------------------------------------------------------------------------------------------------
  // Updates

  #onProject(p: Project): void {
    void this.engine.loadSong(p.songAsset);
    this.engine.sync(p);
    this.viewport.stage.setLook(p);
    if (p.aspect !== this.#lastAspect) {
      this.#lastAspect = p.aspect;
      this.viewport.relayout();
    }
    if (this.selected && !p.ornaments.some((o) => o.id === this.selected)) {
      this.selected = null;
      this.viewport.selected = null;
    }
    for (const [k, b] of this.#aspectBtns) b.setAttribute('aria-checked', String(k === p.aspect));
    if (document.activeElement !== this.#nameInput) this.#nameInput.value = p.name;
    this.#undoBtn.disabled = !this.store.canUndo;
    this.#redoBtn.disabled = !this.store.canRedo;
    document.title = `${p.name || 'Untitled'} · Beat Bounce`;
    this.#refreshPanel();
    this.#updateStatus();
    this.viewport.dirty = true;
  }

  #onPlan(): void {
    const plan = this.engine.plan;
    if (plan && this.viewport.stage.plan !== plan) {
      this.viewport.stage.setLook(this.store.project);
      this.viewport.stage.setPlan(plan);
      this.player.duration = plan.meta.duration;
      if (this.player.time > plan.meta.duration) this.player.seek(plan.meta.duration);
      this.#updateMarkers();
      if (this.#seedDemoArt) this.#placeDemoArt();
    }
    this.#refreshPanel();
    this.#updateStatus();
    this.#updateTransport();
    this.viewport.dirty = true;
  }

  #updateMarkers(): void {
    const plan = this.engine.plan;
    this.#markers.replaceChildren();
    if (!plan) return;
    for (const s of plan.hud.sections) {
      const label = this.store.project.sections.find((x) => x.id === s.id)?.label ?? '';
      this.#markers.append(h('span', { class: 'marker', style: `left:${(100 * s.t0) / plan.meta.duration}%`, title: `${label} at ${formatTime(s.t0)}` }));
    }
  }

  #updateStatus(): void {
    const e = this.engine;
    const st = this.viewport.status;
    const empty = this.viewport.empty;
    const p = this.store.project;
    if (!p.songAsset || e.songError) {
      empty.hidden = false;
      empty.replaceChildren(h('div', { class: 'empty-card' },
        h('div', { class: 'empty-ball', 'aria-hidden': 'true' }),
        h('h2', { text: 'Make a ball bounce to your music' }),
        h('p', { text: e.songError ?? 'Open a MIDI file, or drop one here. The ball hits one bar on each note of the melody.' }),
        h('div', { class: 'btns center' }, button('Open MIDI…', () => this.openMidi(), 'btn accent big'), button('Try the demo', () => this.loadDemo(), 'btn big'))));
    } else {
      empty.hidden = true;
    }
    if (this.#searching) return;
    const parts: string[] = [];
    if (e.planError) parts.push(`⚠ ${e.planError}`);
    else if (e.planning) parts.push('Planning the bars…');
    else if (e.synthing) parts.push('Making the sound…');
    else if (e.plan?.stats.forced) parts.push(`⚠ ${e.plan.stats.forced} bars may touch`);
    st.textContent = parts.join(' · ');
    st.classList.toggle('warn', !!(e.planError || e.plan?.stats.forced));
    st.hidden = !parts.length;
  }

  #updateTransport(): void {
    const t = this.player.time, d = this.player.duration || 0;
    this.#play.textContent = this.player.playing ? '❚❚' : '▶';
    this.#play.setAttribute('aria-pressed', String(this.player.playing));
    this.#time.textContent = `${formatTime(t)} / ${formatTime(d)}`;
    if (document.activeElement !== this.#seek) this.#seek.value = String(d ? Math.round((1000 * t) / d) : 0);
  }

  #loop = (): void => {
    this.player.tick();
    if ((this.player.playing || this.viewport.dirty) && !this.#rendering) {
      this.viewport.render(this.player.time);
      this.#updateTransport();
    }
    requestAnimationFrame(this.#loop);
  };

  #bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const typing = target.closest('input, textarea, select, [contenteditable]') && !(target instanceof HTMLInputElement && ['range', 'checkbox', 'color', 'button'].includes(target.type));
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) this.store.redo(); else this.store.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); this.store.redo(); return; }
      if (typing || this.#rendering) return;
      const sel = this.store.project.ornaments.find((o) => o.id === this.selected);
      if (e.key === ' ') { e.preventDefault(); this.player.toggle(); return; }
      if (e.key === 'Escape' && sel) { this.select(null); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        this.store.update((p) => { p.ornaments = p.ornaments.filter((o) => o.id !== sel.id); });
        this.select(null);
        return;
      }
      if (mod && e.key.toLowerCase() === 'd' && sel) {
        e.preventDefault();
        const copy = { ...structuredClone(sel), id: `${sel.id}c${Date.now().toString(36)}`, x: sel.x + 0.4, y: sel.y - 0.4 };
        this.store.update((p) => { p.ornaments.push(copy); });
        this.select(copy.id);
        return;
      }
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        if (sel) {
          const step = e.shiftKey ? 0.25 : 0.05;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
          this.store.update((p) => { const o = p.ornaments.find((x) => x.id === sel.id); if (o) { o.x = +(o.x + dx).toFixed(3); o.y = +(o.y + dy).toFixed(3); } }, { coalesce: `nudge${sel.id}` });
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          this.player.seek(this.player.time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 5));
        }
        return;
      }
      if (e.key === 'Home') { this.player.seek(0); return; }
      if (e.key.toLowerCase() === 'o') { this.#setView(this.viewport.mode === 'film' ? 'overview' : 'film'); }
    });
  }
}
