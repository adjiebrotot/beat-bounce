// DOM helpers and form controls. Each control reads its value through `get` and writes through
// `set`; `refresh()` shows the current value again after an outside change (undo, a drag), but
// never while the user types in it.

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined | null>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export interface Control {
  el: HTMLElement;
  refresh(): void;
}

export class Group implements Control {
  el: HTMLElement;
  #controls: Control[] = [];
  constructor(cls = 'group', title?: string, hint?: string) {
    this.el = h('section', { class: cls });
    if (title) this.el.append(h('h3', { text: title }));
    if (hint) this.el.append(h('p', { class: 'hint', text: hint }));
  }
  add<T extends Control | HTMLElement>(c: T): T {
    if (c instanceof HTMLElement) this.el.append(c);
    else { this.#controls.push(c); this.el.append(c.el); }
    return c;
  }
  refresh(): void { for (const c of this.#controls) c.refresh(); }
}

const focused = (el: Element) => document.activeElement === el;

function row(label: string, control: HTMLElement, extra?: HTMLElement | null, title?: string): HTMLElement {
  return h('label', { class: 'row', title }, h('span', { class: 'lbl', text: label }), control, extra ?? null);
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format?: (v: number) => string;
  title?: string;
  /** Shows a reset button when it returns true. */
  isCustom?: () => boolean;
  reset?: () => void;
}

export function slider(o: SliderOpts): Control {
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step });
  const out = h('output');
  const fmt = o.format ?? ((v: number) => String(+v.toFixed(3)));
  const resetBtn = o.reset ? h('button', { class: 'mini reset', type: 'button', title: 'Back to the default', text: '↺', onclick: (e: Event) => { e.preventDefault(); o.reset!(); } }) : null;
  input.addEventListener('input', () => { o.set(Number(input.value)); out.textContent = fmt(Number(input.value)); });
  const wrap = h('span', { class: 'slider' }, input, out, resetBtn);
  const el = row(o.label, wrap, null, o.title);
  const refresh = () => {
    const v = o.get();
    if (!focused(input)) input.value = String(v);
    out.textContent = fmt(v);
    if (resetBtn) resetBtn.style.visibility = (o.isCustom?.() ?? true) ? '' : 'hidden';
  };
  refresh();
  return { el, refresh };
}

export function numberInput(o: { label: string; get: () => number | null; set: (v: number | null) => void; step?: number; min?: number; max?: number; placeholder?: string; title?: string; suffix?: string }): Control {
  const input = h('input', { type: 'number', step: o.step ?? 0.1, min: o.min, max: o.max, placeholder: o.placeholder ?? '' });
  input.addEventListener('change', () => o.set(input.value === '' ? null : Number(input.value)));
  const el = row(o.label, h('span', { class: 'num' }, input, o.suffix ? h('span', { class: 'suffix', text: o.suffix }) : null), null, o.title);
  const refresh = () => { if (!focused(input)) { const v = o.get(); input.value = v == null ? '' : String(+v.toFixed(3)); } };
  refresh();
  return { el, refresh };
}

export function select<T extends string | number>(o: { label: string; options: [T, string][]; get: () => T; set: (v: T) => void; title?: string }): Control {
  const sel = h('select');
  for (const [v, l] of o.options) sel.append(h('option', { value: String(v), text: l }));
  sel.addEventListener('change', () => {
    const opt = o.options.find(([v]) => String(v) === sel.value);
    if (opt) o.set(opt[0]);
  });
  const el = o.label ? row(o.label, sel, null, o.title) : sel;
  const refresh = () => { sel.value = String(o.get()); };
  refresh();
  return { el, refresh };
}

export function color(o: { label: string; get: () => string; set: (v: string) => void }): Control {
  const input = h('input', { type: 'color' });
  input.addEventListener('input', () => o.set(input.value));
  const el = row(o.label, input);
  const refresh = () => { if (!focused(input)) input.value = normalizeHex(o.get()); };
  refresh();
  return { el, refresh };
}

export function toggle(o: { label: string; get: () => boolean; set: (v: boolean) => void; title?: string }): Control {
  const input = h('input', { type: 'checkbox', class: 'switch' });
  input.addEventListener('change', () => o.set(input.checked));
  const el = h('label', { class: 'row toggle', title: o.title }, h('span', { class: 'lbl', text: o.label }), input);
  const refresh = () => { input.checked = o.get(); };
  refresh();
  return { el, refresh };
}

export function textInput(o: { label: string; get: () => string; set: (v: string) => void; placeholder?: string; multiline?: boolean; title?: string }): Control {
  const input = o.multiline ? h('textarea', { rows: 3, placeholder: o.placeholder ?? '' }) : h('input', { type: 'text', placeholder: o.placeholder ?? '' });
  input.addEventListener('input', () => o.set(input.value));
  const el = o.label ? row(o.label, input, null, o.title) : input;
  if (o.multiline) el.classList.add('stack');
  const refresh = () => { if (!focused(input)) input.value = o.get(); };
  refresh();
  return { el, refresh };
}

/** A row of buttons of which one is on. */
export function chips<T extends string>(o: { label?: string; options: [T, string, string?][]; get: () => T; set: (v: T) => void; wrap?: boolean }): Control {
  const box = h('div', { class: `chips${o.wrap ? ' wrap' : ''}`, role: 'radiogroup' });
  const buttons = o.options.map(([v, l, icon]) => {
    const b = h('button', { type: 'button', class: 'chip', role: 'radio', title: l }, icon ? h('span', { class: 'chip-icon', text: icon }) : null, h('span', { text: l }));
    b.addEventListener('click', () => o.set(v));
    box.append(b);
    return [v, b] as const;
  });
  const el = o.label ? h('div', { class: 'row stack' }, h('span', { class: 'lbl', text: o.label }), box) : box;
  const refresh = () => { const cur = o.get(); for (const [v, b] of buttons) b.setAttribute('aria-checked', String(v === cur)); };
  refresh();
  return { el, refresh };
}

export function button(text: string, onclick: () => void, cls = 'btn', title?: string): HTMLButtonElement {
  return h('button', { type: 'button', class: cls, text, title, onclick: () => onclick() });
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function normalizeHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('').toLowerCase();
  return '#888888';
}

export function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '0:00.0';
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function parseTime(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]!;
}

/** A time field in video time (m:ss.s); the store keeps MIDI time. */
export function timeInput(o: { label: string; get: () => number; set: (v: number) => void; offset: () => number; now?: () => number; title?: string }): Control {
  const input = h('input', { type: 'text', class: 'time', inputmode: 'decimal' });
  input.addEventListener('change', () => {
    const v = parseTime(input.value);
    if (v != null) o.set(Math.max(0, v - o.offset()));
    refresh();
  });
  const nowBtn = o.now ? h('button', { type: 'button', class: 'mini', title: 'Set to the playhead', text: '⌖', onclick: (e: Event) => { e.preventDefault(); o.set(Math.max(0, o.now!() - o.offset())); } }) : null;
  const el = row(o.label, h('span', { class: 'num' }, input, nowBtn), null, o.title);
  const refresh = () => { if (!focused(input)) input.value = formatTime(o.get() + o.offset()); };
  refresh();
  return { el, refresh };
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
  let box = document.querySelector<HTMLElement>('.toasts');
  if (!box) { box = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, text: message });
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
