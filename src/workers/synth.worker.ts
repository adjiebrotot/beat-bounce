// Renders the audio off the main thread. Messages: {id, input} -> {id, audio} | {id, error}.
import { renderAudio } from '../core/synth.ts';
import type { SynthInput } from '../core/synth.ts';

self.onmessage = (e: MessageEvent<{ id: number; input: SynthInput }>) => {
  const { id, input } = e.data;
  try {
    const audio = renderAudio(input);
    (self as unknown as Worker).postMessage({ id, audio }, [audio.left.buffer, audio.right.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
