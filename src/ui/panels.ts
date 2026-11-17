// The tabs of the side panel. Each tab builds its controls once; `refresh()` shows outside changes,
// and a change of `structure()` (a new track list, another selected ornament) rebuilds the tab.
import { BACKING_LABELS, INSTRUMENTS } from '../core/instruments.ts';
import type { BackingVoiceName, ColorMode } from '../core/instruments.ts';
import { noteName } from '../core/midi.ts';
import {
  CROPS, DEFAULT_CAMERA, DEFAULT_RAIL_SETTINGS, DEFAULT_WORLD_SETTINGS, ASPECT_DEFAULTS, FONTS, effectiveCamera, effectiveRails,
  effectiveWorld, newId,
} from '../core/project.ts';
import type {
  BallStyle, CameraSettings, CropName, FontName, FrameStyle, Ornament, PhotoOrnament, Project, RailSettings, StickerOrnament, TextOrnament,
  TextStyle, TrackRole, TrackSetting, WallStyle, WorldSettings,
} from '../core/project.ts';
import { BUILTIN_STICKERS, builtinUrl } from '../app/assets.ts';
import type { AssetStore } from '../app/assets.ts';
import type { Store } from '../app/store.ts';
import type { Engine } from '../app/engine.ts';
import type { Player } from '../app/player.ts';
import { textAspect } from '../stage/text.ts';
import {
  Group, button, chips, color, formatTime, h, numberInput, pickFile, select, slider, textInput, timeInput, toast, toggle,
} from './dom.ts';
import type { Control } from './dom.ts';

export interface AppApi {
  store: Store;
  engine: Engine;
  player: Player;
  assets: AssetStore;
  selected: string | null;
  select(id: string | null): void;
  addOrnament(kind: Ornament['kind'], image?: string | null): void;
  openMidi(): void;
  loadDemo(): void;
  /** Video seconds minus MIDI seconds (0 before the first plan). */
  offset(): number;
  now(): number;
  findCleanLayout(): void;
  showOrnament(id: string): void;
}

export interface Built {
  el: HTMLElement;
  refresh(): void;
  structure(): string;
}

export interface TabDef {
  id: string;
  label: string;
  icon: string;
  build(app: AppApi): Built;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;
const m = (v: number) => `${v.toFixed(2)} m`;
const deg = (v: number) => `${Math.round(v)}°`;

function tab(groups: (Group | Control)[], structure: () => string = () => ''): Built {
  const el = h('div', { class: 'tab' });
  for (const g of groups) el.append(g.el);
  return { el, refresh: () => groups.forEach((g) => g.refresh()), structure };
}

// ---------------------------------------------------------------------------------------------------
// Song

const ROLES: [TrackRole, string][] = [['melody', 'Bounce'], ['fill', 'Fill gaps'], ['backing', 'Backing'], ['off', 'Off']];
const VOICES = Object.entries(BACKING_LABELS) as [BackingVoiceName, string][];

function trackSetting(p: Project, i: number): TrackSetting {
  return p.tracks[String(i)] ?? { role: 'off', voice: 'strings', gain: 0.3, transpose: 0 };
}

const songTab: TabDef = {
  id: 'song', label: 'Song', icon: '♪',
  build(app) {
    const { store, engine } = app;
    const p = () => store.project;
    const up = (fn: (p: Project) => void, key?: string) => store.update(fn, { coalesce: key });

    const file = new Group('group', 'MIDI file');
    file.add(h('div', { class: 'song-file' },
      h('div', { class: 'song-name', text: p().songName || 'No song yet' }),
      h('div', { class: 'btns' }, button('Open MIDI…', () => app.openMidi(), 'btn'), button('Demo song', () => app.loadDemo(), 'btn ghost'))));
    if (engine.songError) file.add(h('p', { class: 'error', text: engine.songError }));
    file.add(h('p', { class: 'hint', text: 'You can also drop a .mid file on the stage.' }));

    const tracks = new Group('group', 'Tracks', 'The ball bounces once on each note of the "Bounce" tracks. "Fill gaps" tracks add bounces where the melody rests. "Backing" tracks only sound.');
    const best = [...engine.stats].sort((a, b) => b.melodyScore - a.melodyScore)[0]?.index;
    for (const s of engine.stats) {
      const ts = () => trackSetting(p(), s.index);
      const setTs = (fn: (t: TrackSetting) => void, key?: string) => up((pp) => {
        const cur = { ...trackSetting(pp, s.index) };
        fn(cur);
        pp.tracks = { ...pp.tracks, [String(s.index)]: cur };
      }, key);
      const card = h('div', { class: `track${ts().role !== 'off' ? ' on' : ''}` });
      const title = s.name || s.instrument || `Track ${s.index + 1}`;
      card.append(h('div', { class: 'track-head' },
        h('div', {}, h('strong', { text: title }), s.index === best ? h('span', { class: 'tag', text: 'melody?' }) : null,
          h('div', { class: 'meta', text: `${s.notes} notes · ${noteName(s.low)}–${noteName(s.high)}${s.percussion ? ' · drums' : ''}` }))));
      const role = select<TrackRole>({ label: '', options: ROLES, get: () => ts().role, set: (v) => setTs((t) => { t.role = v; if (v === 'backing' && s.meanPitch < 52) t.voice = 'bass'; }) });
      card.querySelector('.track-head')!.append(role.el);
      tracks.add({ el: card, refresh: () => role.refresh() });
      if (ts().role === 'backing') {
        const sub = new Group('track-sub');
        sub.add(select<BackingVoiceName>({ label: 'Voice', options: VOICES, get: () => ts().voice, set: (v) => setTs((t) => { t.voice = v; }) }));
        sub.add(slider({ label: 'Volume', min: 0, max: 1, step: 0.01, get: () => ts().gain, set: (v) => setTs((t) => { t.gain = v; }, `gain${s.index}`), format: pct }));
        sub.add(slider({ label: 'Transpose', min: -24, max: 24, step: 1, get: () => ts().transpose, set: (v) => setTs((t) => { t.transpose = v; }, `tr${s.index}`), format: (v) => `${v > 0 ? '+' : ''}${v}` }));
        card.append(sub.el);
        tracks.add({ el: h('span'), refresh: () => sub.refresh() });
      }
    }
    if (!engine.stats.length) tracks.add(h('p', { class: 'hint', text: 'Open a MIDI file to see its tracks.' }));

    const mel = new Group('group', 'Melody');
    mel.add(slider({ label: 'Merge notes closer than', min: 0.04, max: 0.4, step: 0.01, get: () => p().melody.minHitGap, set: (v) => up((pp) => { pp.melody.minHitGap = v; }, 'mhg'), format: sec, title: 'Notes closer than this share one bounce (they still sound). Raise it for very fast passages.' }));
    mel.add(chips<'all' | 'top'>({ label: 'Chords', options: [['all', 'All notes'], ['top', 'Top note']], get: () => p().melody.chord, set: (v) => up((pp) => { pp.melody.chord = v; }) }));
    mel.add(slider({ label: 'Fill gaps longer than', min: 0.6, max: 5, step: 0.1, get: () => p().melody.fillMinGap, set: (v) => up((pp) => { pp.melody.fillMinGap = v; }, 'fmg'), format: sec }));
    mel.add(numberInput({ label: 'Start at (song s)', get: () => p().melody.rangeFrom, set: (v) => up((pp) => { pp.melody.rangeFrom = v; }), placeholder: 'start', min: 0 }));
    mel.add(numberInput({ label: 'End at (song s)', get: () => p().melody.rangeTo, set: (v) => up((pp) => { pp.melody.rangeTo = v; }), placeholder: 'end', min: 0 }));

    const layout = new Group('group', 'Layout', 'The layout of the bars follows from the song, the physics and the seed. Each seed gives another layout.');
    layout.add(numberInput({ label: 'Seed', step: 1, min: 0, get: () => p().seed, set: (v) => up((pp) => { pp.seed = Math.max(0, Math.round(v ?? 0)); }) }));
    layout.add(h('div', { class: 'btns' },
      button('Shuffle', () => up((pp) => { pp.seed = Math.floor(Math.random() * 100000); }), 'btn', 'Another random layout'),
      button('Find a clean layout', () => app.findCleanLayout(), 'btn', 'Try seeds (and a little more gravity) until no bar touches anything')));
    const warn = h('div', { class: 'plan-warn' });
    layout.add({ el: warn, refresh: () => {
      const plan = engine.plan;
      if (engine.planError) { warn.className = 'plan-warn error'; warn.textContent = engine.planError; return; }
      if (!plan) { warn.textContent = ''; return; }
      const n = plan.stats.forced;
      warn.className = `plan-warn ${n ? 'warn' : 'ok'}`;
      warn.textContent = n
        ? `${n} bar${n > 1 ? 's' : ''} may touch something (first at ${formatTime(plan.paddles.length ? (plan.warnings[0] ? Number(/at ([\d.]+)/.exec(plan.warnings[0])?.[1] ?? 0) : 0) : 0)}). Try "Find a clean layout", move some wall art, or merge fast notes.`
        : `${plan.stats.hits} bounces, ${plan.stats.rails} rails, ${formatTime(plan.meta.duration)} video. No collisions.`;
    } });

    const timing = new Group('group', 'Timing');
    timing.add(slider({ label: 'Intro before the first note', min: 1.6, max: 8, step: 0.1, get: () => p().timing.intro, set: (v) => up((pp) => { pp.timing.intro = v; }, 'intro'), format: sec }));
    timing.add(slider({ label: 'Title card', min: 0, max: 8, step: 0.1, get: () => p().timing.titleHold, set: (v) => up((pp) => { pp.timing.titleHold = v; }, 'th'), format: sec }));
    timing.add(slider({ label: 'Outro after the last note', min: 1.5, max: 10, step: 0.1, get: () => p().timing.outro, set: (v) => up((pp) => { pp.timing.outro = v; }, 'outro'), format: sec }));
    timing.add(slider({ label: 'End card', min: 0, max: 6, step: 0.1, get: () => p().timing.endCard, set: (v) => up((pp) => { pp.timing.endCard = v; }, 'ec'), format: sec }));

    const sound = new Group('group', 'Sound');
    sound.add(slider({ label: 'Melody volume', min: 0, max: 2, step: 0.01, get: () => p().audio.melodyGain, set: (v) => up((pp) => { pp.audio.melodyGain = v; }, 'mg'), format: pct }));
    sound.add(slider({ label: 'Reverb', min: 0, max: 0.6, step: 0.01, get: () => p().audio.reverb, set: (v) => up((pp) => { pp.audio.reverb = v; }, 'rv'), format: pct }));
    sound.add(slider({ label: 'Stereo follows the ball', min: 0, max: 1, step: 0.01, get: () => p().audio.pan, set: (v) => up((pp) => { pp.audio.pan = v; }, 'pan'), format: pct }));
    sound.add(slider({ label: 'Master level', min: 0.2, max: 1, step: 0.01, get: () => p().audio.masterGain, set: (v) => up((pp) => { pp.audio.masterGain = v; }, 'mst'), format: pct }));

    return tab([file, tracks, mel, layout, timing, sound], () => `${engine.songKey}|${engine.stats.length}|${engine.songError}|${p().songName}|${engine.stats.map((s) => trackSetting(p(), s.index).role).join(',')}`);
  },
};

// ---------------------------------------------------------------------------------------------------
// Sections (instruments)

const COLOR_MODES: [ColorMode | 'preset', string][] = [['preset', 'Preset colours'], ['single', 'One colour'], ['cycle', 'Cycle'], ['random', 'Random'], ['accent', 'Main + accents'], ['pitch', 'Rainbow by pitch']];

const sectionsTab: TabDef = {
  id: 'sections', label: 'Instruments', icon: '▤',
  build(app) {
    const { store } = app;
    const p = () => store.project;
    const up = (fn: (p: Project) => void, key?: string) => store.update(fn, { coalesce: key });
    const list = new Group('group', 'Instrument sections', 'The bars change look and sound at the start of each section. Each section label shows at the top of the video.');
    const sorted = () => [...p().sections].sort((a, b) => a.from - b.from);
    sorted().forEach((s, i) => {
      const get = () => p().sections.find((x) => x.id === s.id)!;
      const set = (fn: (x: typeof s) => void, key?: string) => up((pp) => { const x = pp.sections.find((y) => y.id === s.id); if (x) fn(x); }, key);
      const card = new Group('card');
      card.add(h('div', { class: 'card-head' }, h('strong', { text: `Section ${i + 1}` }),
        p().sections.length > 1 ? button('Remove', () => up((pp) => { pp.sections = pp.sections.filter((x) => x.id !== s.id); }), 'mini danger') : null));
      if (i > 0) card.add(timeInput({ label: 'Starts at', get: () => get().from, set: (v) => set((x) => { x.from = v; }), offset: () => app.offset(), now: () => app.now() }));
      else card.add(h('p', { class: 'hint', text: 'Starts with the first note.' }));
      card.add(select({ label: 'Instrument', options: Object.entries(INSTRUMENTS).map(([k, v]) => [k, v.label] as [string, string]), get: () => get().instrument, set: (v) => set((x) => {
        const wasDefault = !x.label || x.label === INSTRUMENTS[x.instrument]?.label;
        x.instrument = v;
        if (wasDefault) x.label = INSTRUMENTS[v]!.label;
      }) }));
      card.add(textInput({ label: 'Label', get: () => get().label, set: (v) => set((x) => { x.label = v; }, `lbl${s.id}`), placeholder: 'No label' }));
      card.add(select<ColorMode | 'preset'>({ label: 'Bar colours', options: COLOR_MODES, get: () => get().colorMode ?? 'preset', set: (v) => set((x) => {
        x.colorMode = v === 'preset' ? null : v;
        if (v !== 'preset' && v !== 'pitch' && !x.colors?.length) x.colors = [...(INSTRUMENTS[x.instrument]!.look.colors.length ? INSTRUMENTS[x.instrument]!.look.colors : ['#3d4fe0']), ...(v === 'accent' ? INSTRUMENTS.xylophone!.look.accent! : [])];
      }) }));
      const mode = get().colorMode;
      if (mode && mode !== 'pitch') {
        const swatches = h('div', { class: 'swatches' });
        (get().colors ?? []).forEach((c, ci) => {
          const input = h('input', { type: 'color', value: c, title: 'Change the colour' });
          input.addEventListener('input', () => set((x) => { x.colors = [...(x.colors ?? [])]; x.colors[ci] = input.value; }, `sw${s.id}${ci}`));
          const del = button('×', () => set((x) => { x.colors = (x.colors ?? []).filter((_, k) => k !== ci); }), 'mini', 'Remove the colour');
          swatches.append(h('span', { class: 'swatch' }, input, (get().colors?.length ?? 0) > 1 ? del : null));
        });
        swatches.append(button('+', () => set((x) => { x.colors = [...(x.colors ?? []), '#ffffff']; }), 'mini', 'Add a colour'));
        card.add(h('div', { class: 'row stack' }, h('span', { class: 'lbl', text: mode === 'accent' ? 'Main colour, then accents' : 'Colours' }), swatches));
      }
      list.add(card);
    });
    list.add(button('+ Add a section at the playhead', () => {
      const from = Math.max(0, app.now() - app.offset());
      const names = Object.keys(INSTRUMENTS);
      const last = sorted().filter((s) => s.from <= from).pop();
      const next = names[(names.indexOf(last?.instrument ?? 'xylophone') + 1) % names.length]!;
      up((pp) => { pp.sections.push({ id: newId('s'), from, instrument: next, label: INSTRUMENTS[next]!.label, colorMode: null, colors: null }); });
    }, 'btn wide'));
    return tab([list], () => p().sections.map((s) => `${s.id}:${s.colorMode}:${s.colors?.length ?? 0}`).join(',') + `|${sorted().map((s) => s.id).join(',')}`);
  },
};

// ---------------------------------------------------------------------------------------------------
// Ball

const BALL_STYLES: [BallStyle, string, string][] = [
  ['marble', 'Marble', '◍'], ['earth', 'Earth', '◕'], ['glass', 'Glass', '○'], ['metal', 'Metal', '◉'],
  ['matte', 'Rubber', '●'], ['beach', 'Beach ball', '◑'], ['neon', 'Neon', '✦'], ['image', 'Picture', '▣'],
];

const ballTab: TabDef = {
  id: 'ball', label: 'Ball', icon: '●',
  build(app) {
    const { store, assets } = app;
    const p = () => store.project;
    const b = () => p().ball;
    const up = (fn: (b: Project['ball']) => void, key?: string) => store.update((pp) => fn(pp.ball), { coalesce: key });
    const look = new Group('group', 'Look');
    look.add(chips<BallStyle>({ options: BALL_STYLES, get: () => b().style, set: (v) => up((x) => { x.style = v; }), wrap: true }));
    const st = b().style;
    if (st !== 'earth' && st !== 'image') look.add(color({ label: st === 'glass' ? 'Core colour' : 'Colour', get: () => b().color, set: (v) => up((x) => { x.color = v; }, 'bc') }));
    if (st === 'marble' || st === 'glass' || st === 'beach') look.add(color({ label: st === 'glass' ? 'Glass tint' : st === 'beach' ? 'Second colour' : 'Swirl colour', get: () => b().color2, set: (v) => up((x) => { x.color2 = v; }, 'bc2') }));
    if (st === 'image') {
      const prev = h('div', { class: 'ball-pic' });
      const showPic = async () => {
        prev.replaceChildren();
        const id = b().image;
        const url = id ? await assets.url(id) : null;
        if (url) prev.append(h('img', { src: url, alt: '' }));
        else prev.append(h('span', { class: 'hint', text: 'No picture yet' }));
      };
      void showPic();
      look.add(h('div', { class: 'row stack' }, prev, h('div', { class: 'btns' }, button(b().image ? 'Replace picture…' : 'Choose a picture…', async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        const a = await assets.add(f, f.name);
        up((x) => { x.image = a.id; });
      }))));
      look.add(h('p', { class: 'hint', text: 'A flag, a logo or a face: the picture wraps around the ball. The focus point faces the camera.' }));
      look.add(slider({ label: 'Focus across', min: 0, max: 1, step: 0.01, get: () => b().focus[0], set: (v) => up((x) => { x.focus = [v, x.focus[1]]; }, 'fx'), format: pct }));
      look.add(slider({ label: 'Focus down', min: 0, max: 1, step: 0.01, get: () => b().focus[1], set: (v) => up((x) => { x.focus = [x.focus[0], v]; }, 'fy'), format: pct }));
    }
    look.add(slider({ label: 'Shine', min: 0, max: 0.8, step: 0.01, get: () => 0.8 - b().roughness, set: (v) => up((x) => { x.roughness = +(0.8 - v).toFixed(3); }, 'rough'), format: (v) => pct(v / 0.8) }));
    look.add(slider({ label: 'Glow', min: 0, max: 3, step: 0.05, get: () => b().glow, set: (v) => up((x) => { x.glow = v; }, 'glow'), format: (v) => v.toFixed(2) }));
    const size = new Group('group', 'Size', 'A bigger ball needs more room, so the layout changes.');
    size.add(slider({ label: 'Diameter', min: 0.12, max: 0.5, step: 0.01, get: () => b().radius * 2, set: (v) => up((x) => { x.radius = +(v / 2).toFixed(3); }, 'rad'), format: (v) => `${Math.round(v * 100)} cm` }));
    const trail = new Group('group', 'Trail');
    trail.add(toggle({ label: 'Show a trail', get: () => b().trail, set: (v) => up((x) => { x.trail = v; }) }));
    trail.add(color({ label: 'Trail colour', get: () => b().trailColor, set: (v) => up((x) => { x.trailColor = v; }, 'tc') }));
    trail.add(slider({ label: 'Trail length', min: 0.1, max: 2, step: 0.05, get: () => b().trailLength, set: (v) => up((x) => { x.trailLength = v; }, 'tl'), format: sec }));
    return tab([look, size, trail], () => `${b().style}|${b().image}`);
  },
};

// ---------------------------------------------------------------------------------------------------
// Wall art (ornaments)

const FRAMES: [FrameStyle, string][] = [
  ['wood', 'Wood'], ['black', 'Black'], ['white', 'White'], ['gold', 'Gold'], ['silver', 'Silver'], ['color', 'Painted'],
  ['polaroid', 'Polaroid'], ['canvas', 'Canvas'], ['none', 'No frame'],
];
const TEXT_STYLES: [TextStyle, string][] = [['raised', 'Raised letters'], ['paint', 'Painted'], ['neon', 'Neon']];
const KIND_ICON: Record<Ornament['kind'], string> = { photo: '🖼', sticker: '★', text: 'T' };

function ornamentName(o: Ornament): string {
  if (o.kind === 'text') return `“${o.text.split('\n')[0]!.slice(0, 24) || 'Text'}”`;
  if (o.kind === 'photo') return o.caption ? `Photo: ${o.caption.slice(0, 22)}` : o.image ? 'Photo' : 'Photo (empty)';
  return o.image?.startsWith('builtin:') ? `Sticker: ${o.image.slice(8)}` : 'Sticker';
}

function stickerLibrary(app: AppApi, onPick: (id: string) => void): HTMLElement {
  const grid = h('div', { class: 'sticker-grid' });
  for (const s of BUILTIN_STICKERS) {
    grid.append(h('button', { type: 'button', class: 'sticker-pick', title: s, onclick: () => onPick(`builtin:${s}`) }, h('img', { src: builtinUrl(`builtin:${s}`), alt: s })));
  }
  grid.append(h('button', { type: 'button', class: 'sticker-pick upload', title: 'Upload a PNG or SVG with a transparent background', onclick: async () => {
    const f = await pickFile('image/png,image/svg+xml,image/webp,image/gif,image/*');
    if (!f) return;
    const a = await app.assets.add(f, f.name);
    onPick(a.id);
  } }, h('span', { text: '⇪' }), h('small', { text: 'Upload' })));
  return grid;
}

function inspector(app: AppApi, id: string): Group {
  const { store, assets } = app;
  const get = () => store.project.ornaments.find((o) => o.id === id)!;
  const set = (fn: (o: Ornament) => void, key?: string) => store.update((pp) => { const o = pp.ornaments.find((x) => x.id === id); if (o) fn(o); }, { coalesce: key });
  const o = get();
  const g = new Group('group inspector', `${KIND_ICON[o.kind]} ${ornamentName(o)}`);
  g.add(h('div', { class: 'btns' },
    button('Show', () => app.showOrnament(id), 'mini', 'Show it in the overview'),
    button('Duplicate', () => {
      const copy = { ...structuredClone(get()), id: newId(), x: get().x + 0.4, y: get().y - 0.4 };
      store.update((pp) => { pp.ornaments.push(copy); });
      app.select(copy.id);
    }, 'mini'),
    button('Bring to front', () => store.update((pp) => { const i = pp.ornaments.findIndex((x) => x.id === id); pp.ornaments.push(...pp.ornaments.splice(i, 1)); }), 'mini'),
    button('Delete', () => { store.update((pp) => { pp.ornaments = pp.ornaments.filter((x) => x.id !== id); }); app.select(null); }, 'mini danger')));

  const pickImage = async (accept: string) => {
    const f = await pickFile(accept);
    if (!f) return;
    const a = await assets.add(f, f.name);
    set((x) => { if (x.kind !== 'text') { x.image = a.id; x.imageAspect = a.aspect ?? 1; } });
  };

  if (o.kind === 'photo') {
    const ph = () => get() as PhotoOrnament;
    const setP = (fn: (x: PhotoOrnament) => void, key?: string) => set((x) => fn(x as PhotoOrnament), key);
    g.add(h('div', { class: 'btns' }, button(o.image ? 'Replace the photo…' : 'Choose a photo…', () => void pickImage('image/*'), 'btn accent')));
    g.add(select<CropName>({ label: 'Crop', options: Object.keys(CROPS).map((k) => [k as CropName, k === 'original' ? 'Original' : k]), get: () => ph().crop, set: (v) => setP((x) => { x.crop = v; }) }));
    g.add(chips<FrameStyle>({ label: 'Frame', options: FRAMES.map(([v, l]) => [v, l]), get: () => ph().frame, set: (v) => setP((x) => { x.frame = v; if (v === 'wood' && x.frameColor === '#2b2118') x.frameColor = '#6b4423'; }), wrap: true }));
    if (o.frame === 'wood' || o.frame === 'color') g.add(color({ label: o.frame === 'wood' ? 'Wood colour' : 'Frame colour', get: () => ph().frameColor, set: (v) => setP((x) => { x.frameColor = v; }, 'fc') }));
    if (!['polaroid', 'canvas', 'none'].includes(o.frame)) g.add(slider({ label: 'Frame width', min: 0.02, max: 0.25, step: 0.005, get: () => ph().frameWidth, set: (v) => setP((x) => { x.frameWidth = v; }, 'fw'), format: (v) => `${Math.round(v * 100)} cm` }));
    if (o.frame !== 'polaroid' && o.frame !== 'canvas') {
      g.add(slider({ label: 'Mat (passe-partout)', min: 0, max: 0.4, step: 0.01, get: () => ph().mat, set: (v) => setP((x) => { x.mat = v; }, 'mat'), format: (v) => `${Math.round(v * 100)} cm` }));
      if (o.mat > 0) g.add(color({ label: 'Mat colour', get: () => ph().matColor, set: (v) => setP((x) => { x.matColor = v; }, 'mc') }));
    }
    g.add(textInput({ label: o.frame === 'polaroid' ? 'Handwriting' : 'Caption plate', get: () => ph().caption, set: (v) => setP((x) => { x.caption = v; }, 'cap'), placeholder: 'No caption' }));
    if (!o.image) g.add(textInput({ label: 'Placeholder text', get: () => ph().placeholder, set: (v) => setP((x) => { x.placeholder = v; }, 'phd') }));
  } else if (o.kind === 'sticker') {
    const sk = () => get() as StickerOrnament;
    const setS = (fn: (x: StickerOrnament) => void, key?: string) => set((x) => fn(x as StickerOrnament), key);
    g.add(h('div', { class: 'row stack' }, h('span', { class: 'lbl', text: 'Picture' }), stickerLibrary(app, async (img) => {
      let aspect = 1;
      if (!img.startsWith('builtin:')) aspect = (await assets.record(img))?.aspect ?? 1;
      else { const pic = await assets.get(img); if (pic) aspect = pic.width / Math.max(1, pic.height); }
      setS((x) => { x.image = img; x.imageAspect = aspect; });
    })));
    g.add(slider({ label: 'Die-cut border', min: 0, max: 0.12, step: 0.005, get: () => sk().border, set: (v) => setS((x) => { x.border = v; }, 'sb'), format: pct }));
    g.add(color({ label: 'Border colour', get: () => sk().borderColor, set: (v) => setS((x) => { x.borderColor = v; }, 'sbc') }));
    g.add(toggle({ label: 'Glossy', get: () => sk().gloss, set: (v) => setS((x) => { x.gloss = v; }) }));
  } else {
    const tx = () => get() as TextOrnament;
    const setT = (fn: (x: TextOrnament) => void, key?: string) => set((x) => {
      const t = x as TextOrnament;
      fn(t);
      t.textAspect = +textAspect(t).toFixed(4);
    }, key);
    g.add(textInput({ label: 'Text', multiline: true, get: () => tx().text, set: (v) => setT((x) => { x.text = v; }, 'txt'), placeholder: 'Your text' }));
    g.add(chips<TextStyle>({ label: 'Style', options: TEXT_STYLES, get: () => tx().style, set: (v) => setT((x) => { x.style = v; if (v === 'neon' && x.color === '#2b2b2b') x.color = '#ff3cac'; }) }));
    g.add(select<FontName>({ label: 'Font', options: Object.entries(FONTS).map(([k, v]) => [k as FontName, v.label]), get: () => tx().font, set: (v) => setT((x) => { x.font = v; }) }));
    g.add(select<number>({ label: 'Weight', options: [[400, 'Regular'], [700, 'Bold'], [900, 'Black']], get: () => (tx().weight >= 850 ? 900 : tx().weight >= 600 ? 700 : 400), set: (v) => setT((x) => { x.weight = v; }) }));
    g.add(toggle({ label: 'Italic', get: () => tx().italic, set: (v) => setT((x) => { x.italic = v; }) }));
    g.add(chips<'left' | 'center' | 'right'>({ label: 'Align', options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], get: () => tx().align, set: (v) => setT((x) => { x.align = v; }) }));
    g.add(color({ label: 'Colour', get: () => tx().color, set: (v) => setT((x) => { x.color = v; }, 'tcol') }));
    if (o.style !== 'neon') {
      g.add(slider({ label: 'Outline', min: 0, max: 0.12, step: 0.005, get: () => tx().outlineWidth, set: (v) => setT((x) => { x.outlineWidth = v; }, 'tow'), format: pct }));
      g.add(color({ label: 'Outline colour', get: () => tx().outline, set: (v) => setT((x) => { x.outline = v; }, 'toc') }));
    }
  }

  const place = new Group('subgroup', 'Size and place');
  place.add(slider({ label: o.kind === 'photo' ? 'Photo width' : 'Width', min: 0.2, max: 8, step: 0.01, get: () => get().width, set: (v) => set((x) => { x.width = v; }, 'w'), format: m }));
  place.add(slider({ label: 'Turn', min: -180, max: 180, step: 1, get: () => get().rotation, set: (v) => set((x) => { x.rotation = v; }, 'rot'), format: deg }));
  place.add(numberInput({ label: 'Across (x)', step: 0.05, get: () => get().x, set: (v) => set((x) => { x.x = v ?? 0; }), suffix: 'm' }));
  place.add(numberInput({ label: 'Height (y)', step: 0.05, get: () => get().y, set: (v) => set((x) => { x.y = v ?? 0; }), suffix: 'm' }));
  place.add(toggle({ label: 'Keep bars clear', get: () => get().keepClear, set: (v) => set((x) => { x.keepClear = v; }), title: 'The layout goes around it. Off: bars can pass in front of it.' }));
  place.add(toggle({ label: 'Feature it', get: () => get().feature, set: (v) => set((x) => { x.feature = v; }), title: 'The ball lingers near it and the camera leans towards it.' }));
  g.add(place);
  return g;
}

const artTab: TabDef = {
  id: 'art', label: 'Wall art', icon: '🖼',
  build(app) {
    const { store } = app;
    const p = () => store.project;
    const add = new Group('group', 'Add to the wall', 'New art goes beside the ball at the playhead (or at the centre of the overview). Then drag it on the stage: corners resize, the round handle turns.');
    add.add(h('div', { class: 'add-row' },
      button('🖼  Photo', () => app.addOrnament('photo'), 'btn big'),
      button('★  Sticker', () => app.addOrnament('sticker'), 'btn big'),
      button('T  Text', () => app.addOrnament('text'), 'btn big')));
    const list = new Group('group', 'On the wall');
    const items = p().ornaments;
    if (!items.length) list.add(h('p', { class: 'hint', text: 'Nothing yet. Photos, stickers and text that you add show here.' }));
    const ul = h('ul', { class: 'orn-list' });
    for (const o of [...items].reverse()) {
      const li = h('li', { class: o.id === app.selected ? 'sel' : '' },
        h('button', { type: 'button', class: 'orn-pick', onclick: () => app.select(o.id) }, h('span', { class: 'orn-icon', text: KIND_ICON[o.kind] }), h('span', { text: ornamentName(o) })),
        h('button', { type: 'button', class: 'mini', title: o.hidden ? 'Show' : 'Hide', text: o.hidden ? '◌' : '◉', onclick: () => store.update((pp) => { const x = pp.ornaments.find((y) => y.id === o.id); if (x) x.hidden = !x.hidden; }) }));
      ul.append(li);
    }
    list.add(ul);
    const groups: (Group | Control)[] = [add, list];
    if (app.selected && items.some((o) => o.id === app.selected)) groups.push(inspector(app, app.selected));
    const sel = items.find((o) => o.id === app.selected);
    return tab(groups, () => `${app.selected}|${p().ornaments.map((o) => `${o.id}:${o.hidden}:${ornamentName(o)}`).join(',')}|${sel ? `${sel.kind === 'photo' ? `${sel.frame}${sel.image}${sel.mat > 0}` : sel.kind === 'text' ? sel.style : sel.image}` : ''}`);
  },
};

// ---------------------------------------------------------------------------------------------------
// Scene: wall, light, camera, physics

const WALLS: [WallStyle, string][] = [['plaster', 'Plaster'], ['smooth', 'Smooth'], ['concrete', 'Concrete'], ['brick', 'Brick'], ['planks', 'Planks']];

const sceneTab: TabDef = {
  id: 'scene', label: 'Scene', icon: '◐',
  build(app) {
    const { store } = app;
    const p = () => store.project;
    const up = (fn: (p: Project) => void, key?: string) => store.update(fn, { coalesce: key });
    const wall = new Group('group', 'Wall');
    wall.add(chips<WallStyle>({ options: WALLS, get: () => p().theme.wallStyle, set: (v) => up((pp) => {
      pp.theme.wallStyle = v;
      if (v === 'brick' && pp.theme.wall === '#d3d2cf') pp.theme.wall = '#a4553d';
      if (v === 'planks' && pp.theme.wall === '#d3d2cf') pp.theme.wall = '#b98a5e';
    }), wrap: true }));
    wall.add(color({ label: 'Colour', get: () => p().theme.wall, set: (v) => up((pp) => { pp.theme.wall = v; }, 'wall') }));
    wall.add(slider({ label: 'Relief', min: 0, max: 2, step: 0.05, get: () => p().theme.wallBump, set: (v) => up((pp) => { pp.theme.wallBump = v; }, 'bump'), format: (v) => v.toFixed(2) }));
    wall.add(slider({ label: 'Pattern size', min: 1, max: 8, step: 0.1, get: () => p().theme.wallTile, set: (v) => up((pp) => { pp.theme.wallTile = v; }, 'tile'), format: (v) => v.toFixed(1) }));
    wall.add(color({ label: 'Rails', get: () => p().theme.rail, set: (v) => up((pp) => { pp.theme.rail = v; }, 'rail') }));

    const light = new Group('group', 'Light');
    light.add(slider({ label: 'Direction', min: -80, max: 80, step: 1, get: () => p().light.angle, set: (v) => up((pp) => { pp.light.angle = v; }, 'la'), format: (v) => (v === 0 ? 'front' : v > 0 ? `${Math.round(v)}° right` : `${Math.round(-v)}° left`) }));
    light.add(slider({ label: 'Height', min: 8, max: 80, step: 1, get: () => p().light.height, set: (v) => up((pp) => { pp.light.height = v; }, 'lh'), format: deg }));
    light.add(slider({ label: 'Sun', min: 0, max: 8, step: 0.05, get: () => p().light.intensity, set: (v) => up((pp) => { pp.light.intensity = v; }, 'li'), format: (v) => v.toFixed(2) }));
    light.add(color({ label: 'Sun colour', get: () => p().light.color, set: (v) => up((pp) => { pp.light.color = v; }, 'lc') }));
    light.add(slider({ label: 'Fill light', min: 0, max: 2, step: 0.01, get: () => p().light.ambient, set: (v) => up((pp) => { pp.light.ambient = v; }, 'amb'), format: (v) => v.toFixed(2) }));
    light.add(slider({ label: 'Reflections', min: 0, max: 1.5, step: 0.01, get: () => p().light.env, set: (v) => up((pp) => { pp.light.env = v; }, 'env'), format: (v) => v.toFixed(2) }));

    const lookG = new Group('group', 'Picture');
    lookG.add(slider({ label: 'Exposure', min: 0.4, max: 2, step: 0.01, get: () => p().theme.exposure, set: (v) => up((pp) => { pp.theme.exposure = v; }, 'exp'), format: (v) => v.toFixed(2) }));
    lookG.add(chips<'aces' | 'agx' | 'neutral'>({ label: 'Tone mapping', options: [['aces', 'Filmic'], ['agx', 'AgX'], ['neutral', 'Neutral']], get: () => p().theme.toneMapping, set: (v) => up((pp) => { pp.theme.toneMapping = v; }) }));
    lookG.add(slider({ label: 'Vignette', min: 0, max: 0.8, step: 0.01, get: () => p().theme.vignette, set: (v) => up((pp) => { pp.theme.vignette = v; }, 'vig'), format: pct }));

    const cam = new Group('group', 'Camera', 'Values follow the video shape until you change them.');
    const camDef = (): CameraSettings => ({ ...DEFAULT_CAMERA, ...ASPECT_DEFAULTS[p().aspect].camera });
    const camSlider = (key: keyof CameraSettings, label: string, min: number, max: number, step: number, format: (v: number) => string) => slider({
      label, min, max, step, format, get: () => effectiveCamera(p())[key], set: (v) => up((pp) => { pp.camera = { ...pp.camera, [key]: v }; }, `cam${key}`),
      isCustom: () => p().camera[key] !== undefined && p().camera[key] !== camDef()[key], reset: () => up((pp) => { const c = { ...pp.camera }; delete c[key]; pp.camera = c; }),
    });
    cam.add(camSlider('distance', 'Distance', 2.5, 16, 0.1, m));
    cam.add(camSlider('fov', 'Field of view', 20, 75, 1, deg));
    cam.add(camSlider('elevationDeg', 'Looks down by', -10, 70, 1, deg));
    cam.add(camSlider('yawDeg', 'Turned by', -45, 45, 1, deg));
    cam.add(camSlider('lookDown', 'Aim below the ball', -0.5, 2, 0.01, m));
    cam.add(camSlider('smoothing', 'Smoothness', 0.1, 1.5, 0.01, sec));
    cam.add(camSlider('framePictures', 'Leans to featured art', 0, 1, 0.01, pct));

    const phys = new Group('group', 'Physics', 'These change the layout of the bars.');
    const worldDef = (): WorldSettings => ({ ...DEFAULT_WORLD_SETTINGS, ...ASPECT_DEFAULTS[p().aspect].world });
    const wSlider = (key: 'gravity' | 'laneHalfWidth' | 'laneDrift', label: string, min: number, max: number, step: number, format: (v: number) => string) => slider({
      label, min, max, step, format, get: () => effectiveWorld(p())[key], set: (v) => up((pp) => { pp.world = { ...pp.world, [key]: v }; }, `w${key}`),
      isCustom: () => p().world[key] !== undefined && p().world[key] !== worldDef()[key], reset: () => up((pp) => { const c = { ...pp.world }; delete c[key]; pp.world = c; }),
    });
    phys.add(wSlider('gravity', 'Gravity', 3, 14, 0.1, (v) => `${v.toFixed(1)} m/s²`));
    phys.add(wSlider('laneHalfWidth', 'Room to the sides', 0.8, 5, 0.05, m));
    phys.add(wSlider('laneDrift', 'Drift sideways', -0.4, 0.4, 0.01, (v) => `${v.toFixed(2)} m/s`));
    phys.add(slider({ label: 'Bar length', min: 0.3, max: 1.4, step: 0.01, get: () => effectiveWorld(p()).barLength[1], set: (v) => up((pp) => { pp.world = { ...pp.world, barLength: [+(v * 0.58).toFixed(3), v] }; }, 'bl'), format: m,
      isCustom: () => !!p().world.barLength, reset: () => up((pp) => { const c = { ...pp.world }; delete c.barLength; pp.world = c; }) }));
    const railDef = (): RailSettings => ({ ...DEFAULT_RAIL_SETTINGS, ...ASPECT_DEFAULTS[p().aspect].rails });
    phys.add(toggle({ label: 'Rails for long rests', get: () => effectiveRails(p()).enabled, set: (v) => up((pp) => { pp.rails = { ...pp.rails, enabled: v }; }) }));
    phys.add(slider({ label: 'Rail for rests longer than', min: 0.8, max: 4, step: 0.05, get: () => effectiveRails(p()).minGap, set: (v) => up((pp) => { pp.rails = { ...pp.rails, minGap: v }; }, 'rmg'), format: sec,
      isCustom: () => p().rails.minGap !== undefined && p().rails.minGap !== railDef().minGap, reset: () => up((pp) => { const c = { ...pp.rails }; delete c.minGap; pp.rails = c; }) }));
    return tab([wall, light, lookG, cam, phys], () => p().aspect);
  },
};

// ---------------------------------------------------------------------------------------------------
// Titles

const titlesTab: TabDef = {
  id: 'titles', label: 'Titles', icon: 'Aa',
  build(app) {
    const { store } = app;
    const p = () => store.project;
    const up = (fn: (p: Project) => void, key?: string) => store.update(fn, { coalesce: key });
    const tt = new Group('group', 'Title card and end card');
    const txt = (label: string, key: 'title' | 'subtitle' | 'endTitle' | 'endSubtitle' | 'watermark', ph = '') =>
      tt.add(textInput({ label, get: () => p().titles[key], set: (v) => up((pp) => { pp.titles[key] = v; }, `t${key}`), placeholder: ph }));
    txt('Title', 'title', 'No title');
    txt('Subtitle', 'subtitle');
    txt('End title', 'endTitle', 'Same as the title');
    txt('End subtitle', 'endSubtitle');
    txt('Watermark', 'watermark', '@yourchannel');
    const style = new Group('group', 'Text style');
    style.add(toggle({ label: 'Show the section labels', get: () => p().theme.sectionLabels, set: (v) => up((pp) => { pp.theme.sectionLabels = v; }) }));
    style.add(select<FontName>({ label: 'Font', options: Object.entries(FONTS).map(([k, v]) => [k as FontName, v.label]), get: () => p().theme.font, set: (v) => up((pp) => { pp.theme.font = v; }) }));
    style.add(color({ label: 'Text', get: () => p().theme.text, set: (v) => up((pp) => { pp.theme.text = v; }, 'ttx') }));
    style.add(color({ label: 'Outline', get: () => p().theme.textStroke, set: (v) => up((pp) => { pp.theme.textStroke = v; }, 'tts') }));
    const caps = new Group('group', 'Captions', 'Lines of text at the bottom of the video, for example lyrics.');
    for (const c of [...p().titles.captions].sort((a, b) => a.from - b.from)) {
      const get = () => p().titles.captions.find((x) => x.id === c.id)!;
      const set = (fn: (x: typeof c) => void, key?: string) => up((pp) => { const x = pp.titles.captions.find((y) => y.id === c.id); if (x) fn(x); }, key);
      const card = new Group('card');
      card.add(textInput({ label: '', get: () => get().text, set: (v) => set((x) => { x.text = v; }, `cap${c.id}`), placeholder: 'Caption text' }));
      card.add(timeInput({ label: 'From', get: () => get().from, set: (v) => set((x) => { x.from = v; }), offset: () => app.offset(), now: () => app.now() }));
      card.add(timeInput({ label: 'To', get: () => get().to, set: (v) => set((x) => { x.to = v; }), offset: () => app.offset(), now: () => app.now() }));
      card.add(button('Remove', () => up((pp) => { pp.titles.captions = pp.titles.captions.filter((x) => x.id !== c.id); }), 'mini danger'));
      caps.add(card);
    }
    caps.add(button('+ Add a caption at the playhead', () => {
      const from = Math.max(0, app.now() - app.offset());
      up((pp) => { pp.titles.captions.push({ id: newId('c'), from, to: from + 3, text: '' }); });
    }, 'btn wide'));
    return tab([tt, style, caps], () => p().titles.captions.map((c) => c.id).join(','));
  },
};

export const TABS: TabDef[] = [songTab, sectionsTab, ballTab, artTab, sceneTab, titlesTab];

export function toastError(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), 'error', 6000);
}
