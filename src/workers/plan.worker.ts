// Runs the planner off the main thread. Messages: {id, song?, songKey, input} -> {id, plan} | {id, error}.
import { buildPlan } from '../core/plan.ts';
import type { PlanInput } from '../core/plan.ts';
import type { Song } from '../core/midi.ts';

interface PlanRequest { id: number; songKey: string; song?: Song; input: PlanInput }

const songs = new Map<string, Song>();

self.onmessage = (e: MessageEvent<PlanRequest>) => {
  const { id, songKey, song, input } = e.data;
  if (song) {
    songs.clear();
    songs.set(songKey, song);
  }
  try {
    const s = songs.get(songKey);
    if (!s) throw new Error('The planner has no song.');
    const plan = buildPlan(s, input, () => performance.now());
    (self as unknown as Worker).postMessage({ id, plan }, [plan.ball.track.buffer, plan.camera.track.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
