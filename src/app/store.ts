// The project store: one mutable project, change listeners, undo and redo, and an autosave to
// IndexedDB.
import { kvSet } from './db.ts';
import type { Project } from '../core/project.ts';

type Listener = (p: Project) => void;

export interface UpdateOptions {
  /** Changes with the same key within a short time make one undo step (a slider drag). */
  coalesce?: string;
  /** False: no undo step (for example a measured text aspect). */
  history?: boolean;
}

const HISTORY = 100;

export class Store {
  project: Project;
  #listeners = new Set<Listener>();
  #undo: string[] = [];
  #redo: string[] = [];
  #lastKey = '';
  #lastTime = 0;
  #saveTimer = 0;

  constructor(p: Project) {
    this.project = p;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  update(fn: (p: Project) => void, opts: UpdateOptions = {}): void {
    const before = JSON.stringify(this.project);
    fn(this.project);
    const now = performance.now();
    if (opts.history !== false && JSON.stringify(this.project) !== before) {
      const merge = opts.coalesce && opts.coalesce === this.#lastKey && now - this.#lastTime < 900;
      if (!merge) {
        this.#undo.push(before);
        if (this.#undo.length > HISTORY) this.#undo.shift();
      }
      this.#redo = [];
      this.#lastKey = opts.coalesce ?? '';
      this.#lastTime = now;
    }
    this.#changed();
  }

  /** Replaces the whole project (a load or an import); the undo history starts again. */
  replace(p: Project): void {
    this.project = p;
    this.#undo = [];
    this.#redo = [];
    this.#changed();
  }

  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }

  undo(): void {
    const prev = this.#undo.pop();
    if (!prev) return;
    this.#redo.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev) as Project;
    this.#lastKey = '';
    this.#changed();
  }

  redo(): void {
    const next = this.#redo.pop();
    if (!next) return;
    this.#undo.push(JSON.stringify(this.project));
    this.project = JSON.parse(next) as Project;
    this.#lastKey = '';
    this.#changed();
  }

  #changed(): void {
    for (const fn of this.#listeners) fn(this.project);
    window.clearTimeout(this.#saveTimer);
    this.#saveTimer = window.setTimeout(() => { void kvSet('project', JSON.stringify(this.project)); }, 400);
  }

  /** Saves at once (before the page closes). */
  flush(): void {
    window.clearTimeout(this.#saveTimer);
    void kvSet('project', JSON.stringify(this.project));
  }
}
