// The transport: play, pause and seek on the video timeline, with the synthesized audio. The clock
// is the audio clock while audio plays, and the wall clock before the audio is ready.

export class Player extends EventTarget {
  #ctx: AudioContext | null = null;
  #buffer: AudioBuffer | null = null;
  #source: AudioBufferSourceNode | null = null;
  #gain: GainNode | null = null;
  #playing = false;
  #t = 0;
  #startCtx = 0;
  #startPerf = 0;
  #startT = 0;
  #volume = 0.9;
  duration = 0;

  get playing(): boolean { return this.#playing; }

  get time(): number {
    if (!this.#playing) return this.#t;
    const t = this.#source && this.#ctx ? this.#startT + (this.#ctx.currentTime - this.#startCtx) : this.#startT + (performance.now() - this.#startPerf) / 1000;
    return Math.min(t, this.duration);
  }

  get volume(): number { return this.#volume; }
  set volume(v: number) {
    this.#volume = v;
    if (this.#gain) this.#gain.gain.value = v;
  }

  setAudio(left: Float32Array, right: Float32Array, sampleRate: number): void {
    const b = new AudioBuffer({ length: left.length, numberOfChannels: 2, sampleRate });
    b.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    b.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    this.#buffer = b;
    if (this.#playing) this.#restart(this.time);
  }

  clearAudio(): void {
    const t = this.time;
    this.#buffer = null;
    if (this.#playing) this.#restart(t);
  }

  play(): void {
    if (this.#playing) return;
    if (this.#t >= this.duration - 0.05) this.#t = 0;
    this.#playing = true;
    this.#restart(this.#t);
    this.#emit();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#t = this.time;
    this.#playing = false;
    this.#stopSource();
    this.#emit();
  }

  toggle(): void { if (this.#playing) this.pause(); else this.play(); }

  seek(t: number): void {
    const v = Math.max(0, Math.min(this.duration, t));
    if (this.#playing) this.#restart(v);
    else this.#t = v;
    this.#emit();
  }

  /** Called each frame: stops at the end. */
  tick(): void {
    if (this.#playing && this.time >= this.duration) {
      this.#t = this.duration;
      this.#playing = false;
      this.#stopSource();
      this.#emit();
    }
  }

  #emit(): void { this.dispatchEvent(new Event('change')); }

  #stopSource(): void {
    if (this.#source) {
      try { this.#source.stop(); } catch { /* not started */ }
      this.#source.disconnect();
      this.#source = null;
    }
  }

  #restart(t: number): void {
    this.#stopSource();
    this.#startT = t;
    this.#startPerf = performance.now();
    if (!this.#buffer) return;
    this.#ctx ??= new AudioContext({ latencyHint: 'interactive' });
    if (this.#ctx.state === 'suspended') void this.#ctx.resume();
    if (!this.#gain) {
      this.#gain = this.#ctx.createGain();
      this.#gain.gain.value = this.#volume;
      this.#gain.connect(this.#ctx.destination);
    }
    const src = this.#ctx.createBufferSource();
    src.buffer = this.#buffer;
    src.connect(this.#gain);
    this.#startCtx = this.#ctx.currentTime + 0.03;
    src.start(this.#startCtx, Math.min(t, this.#buffer.duration));
    this.#source = src;
  }
}
