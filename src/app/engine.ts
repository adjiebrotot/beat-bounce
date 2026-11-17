// Keeps the plan and the audio in step with the project: the planner and the synth run in workers,
// and only the newest request runs (a request that comes while a worker is busy waits, and a newer
// one replaces it).
import { analyseTrack } from '../core/midi.ts';
import type { Song, TrackStats } from '../core/midi.ts';
import { parseSong } from '../core/midi-file.ts';
import { planInputOf } from '../core/plan.ts';
import type { Plan, PlanInput } from '../core/plan.ts';
import type { SynthInput, SynthOutput } from '../core/synth.ts';
import type { Project } from '../core/project.ts';
import type { AssetStore } from './assets.ts';

export const SAMPLE_RATE = 48000;

type Job<I> = { input: I; key: string };

class LatestWorker<I, O> {
  #worker: Worker;
  #busy = false;
  #next: Job<I> | null = null;
  #id = 0;
  constructor(make: () => Worker, private readonly send: (w: Worker, id: number, input: I) => void, private readonly done: (key: string, out: O | null, error: string | null) => void) {
    this.#worker = make();
    this.#worker.onmessage = (e: MessageEvent<{ id: number; error?: string } & Record<string, unknown>>) => {
      const job = this.#current;
      this.#busy = false;
      if (job) this.done(job.key, (e.data.error ? null : (Object.values(e.data).find((v) => typeof v === 'object') as O)) ?? null, e.data.error ?? null);
      this.#pump();
    };
    this.#worker.onerror = (e) => {
      this.#busy = false;
      if (this.#current) this.done(this.#current.key, null, e.message || 'The worker failed.');
      this.#pump();
    };
  }
  #current: Job<I> | null = null;
  request(job: Job<I>): void {
    this.#next = job;
    this.#pump();
  }
  get busy(): boolean { return this.#busy || !!this.#next; }
  #pump(): void {
    if (this.#busy || !this.#next) return;
    this.#current = this.#next;
    this.#next = null;
    this.#busy = true;
    this.send(this.#worker, ++this.#id, this.#current.input);
  }
}

export interface EngineState {
  song: Song | null;
  songError: string | null;
  stats: TrackStats[];
  plan: Plan | null;
  planError: string | null;
  planning: boolean;
  audio: SynthOutput | null;
  synthing: boolean;
}

export class Engine extends EventTarget {
  song: Song | null = null;
  songKey = '';
  songError: string | null = null;
  stats: TrackStats[] = [];
  plan: Plan | null = null;
  planKey = '';
  planError: string | null = null;
  audio: SynthOutput | null = null;
  audioKey = '';
  #wantPlan = '';
  #wantAudio = '';
  #workerSong = '';
  #planner: LatestWorker<{ input: PlanInput; song?: Song }, Plan>;
  #synth: LatestWorker<SynthInput, SynthOutput>;
  #loadingSong: Promise<void> | null = null;

  constructor(private readonly assets: AssetStore) {
    super();
    this.#planner = new LatestWorker<{ input: PlanInput; song?: Song }, Plan>(
      () => new Worker(new URL('../workers/plan.worker.ts', import.meta.url), { type: 'module' }),
      (w, id, { input, song }) => w.postMessage({ id, songKey: input.songKey, song, input }),
      (key, plan, error) => {
        if (key !== this.#wantPlan) return; // an older request
        this.planError = error;
        if (plan) {
          this.plan = plan;
          this.planKey = key;
          this.#requestAudio();
        }
        this.#emit('plan');
      },
    );
    this.#synth = new LatestWorker<SynthInput, SynthOutput>(
      () => new Worker(new URL('../workers/synth.worker.ts', import.meta.url), { type: 'module' }),
      (w, id, input) => w.postMessage({ id, input }),
      (key, audio) => {
        if (key !== this.#wantAudio || !audio) return;
        this.audio = audio;
        this.audioKey = key;
        this.#emit('audio');
      },
    );
  }

  get planning(): boolean { return this.#wantPlan !== this.planKey && !this.planError; }
  get synthing(): boolean { return this.#wantAudio !== this.audioKey; }

  #emit(type: string): void { this.dispatchEvent(new Event(type)); }

  /** Loads the song of the project if it changed. */
  async loadSong(assetId: string | null): Promise<void> {
    if ((assetId ?? '') === this.songKey) return this.#loadingSong ?? undefined;
    this.songKey = assetId ?? '';
    this.song = null;
    this.stats = [];
    this.songError = null;
    this.plan = null;
    this.planKey = '';
    this.audio = null;
    this.audioKey = '';
    if (!assetId) { this.#emit('song'); return; }
    this.#loadingSong = (async () => {
      try {
        const blob = await this.assets.blob(assetId);
        if (!blob) throw new Error('The MIDI file is missing. Open it again.');
        const song = parseSong(new Uint8Array(await blob.arrayBuffer()));
        if (this.songKey !== assetId) return;
        this.song = song;
        this.stats = song.tracks.map((t) => analyseTrack(t, song.duration)).filter((s): s is TrackStats => !!s);
      } catch (e) {
        this.songError = e instanceof Error ? e.message : String(e);
      }
      this.#emit('song');
    })();
    return this.#loadingSong;
  }

  /** Requests a new plan when the plan inputs of the project changed. */
  sync(p: Project): void {
    if (!this.song || this.songKey !== (p.songAsset ?? '')) return;
    const input = planInputOf(p);
    const key = JSON.stringify(input);
    if (key === this.#wantPlan) return;
    this.#wantPlan = key;
    this.planError = null;
    const song = this.#workerSong !== this.songKey ? this.song : undefined;
    this.#workerSong = this.songKey;
    this.#planner.request({ key, input: { input, song } });
    this.#emit('plan');
  }

  #requestAudio(): void {
    const plan = this.plan;
    if (!plan) return;
    const input: SynthInput = {
      sampleRate: SAMPLE_RATE, duration: plan.meta.duration, seed: plan.meta.seed, settings: plan.audio.settings,
      melody: plan.audio.melody, backing: plan.audio.backing, sounds: plan.sections.map((s) => s.sound),
    };
    const key = JSON.stringify(input);
    if (key === this.#wantAudio) return;
    this.#wantAudio = key;
    this.#synth.request({ key, input });
  }
}

/** Runs the planner on its own worker for a search (a clean layout), one input after the other. */
export async function planOnce(song: Song, input: PlanInput): Promise<Plan> {
  const w = new Worker(new URL('../workers/plan.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<Plan>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<{ plan?: Plan; error?: string }>) => (e.data.plan ? resolve(e.data.plan) : reject(new Error(e.data.error)));
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ id: 1, songKey: input.songKey, song, input });
    });
  } finally {
    w.terminate();
  }
}
