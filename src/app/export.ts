// Renders the film to an MP4 file in the browser. Each frame is a pure function of time, so the
// render is offline: frame after frame at the chosen quality, not in real time. The encoders come
// from WebCodecs and the file from mp4-muxer. The encoder tests and fallbacks follow the MP4 render
// of Orchestra: a configuration that the browser accepts can still give no output, so each encoder
// must encode a small test file first, and a failing one gives way to the next.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Plan } from '../core/plan.ts';
import type { Project, QualityName } from '../core/project.ts';
import type { SynthOutput } from '../core/synth.ts';
import { Stage } from '../stage/stage.ts';
import type { ImageProvider } from '../stage/ornament-mesh.ts';

const TEST_MS = 5000;
const STALL_MS = 30_000;
const PACKET_FRAMES = { aac: 1024, opus: 960 } as const;

type VideoKind = 'avc' | 'vp9' | 'av1';
type AudioKind = 'aac' | 'opus';
const CODEC_NAMES: Record<VideoKind | AudioKind, string> = { avc: 'H.264', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus' };

export function canRenderVideo(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function videoCodecs(width: number, height: number, fps: number): [string, VideoKind, string][] {
  // H.264 level 5.1 covers up to 4K at 30 fps; 4K at 60 fps needs level 5.2
  const lvl = width * height * fps > 3840 * 2160 * 31 ? '34' : '33';
  return [
    [`avc1.6400${lvl}`, 'avc', 'H.264 High'],
    [`avc1.4d00${lvl}`, 'avc', 'H.264 Main'],
    ['avc1.42003e', 'avc', 'H.264 Baseline'],
    ['vp09.00.51.08', 'vp9', 'VP9'],
    ['av01.0.12M.08', 'av1', 'AV1'],
  ];
}

const AUDIO_CODECS: [string, AudioKind][] = [['mp4a.40.2', 'aac'], ['opus', 'opus']];

async function firstSupported<T>(list: readonly T[], test: (item: T) => Promise<boolean>): Promise<T | null> {
  for (const item of list) if (await test(item).catch(() => false)) return item;
  return null;
}

async function within(work: Promise<unknown>, limitMs: number): Promise<boolean> {
  let timer = 0;
  const limit = new Promise<boolean>((resolve) => { timer = window.setTimeout(() => resolve(false), limitMs); });
  const result = await Promise.race([work.then(() => true, () => false), limit]);
  window.clearTimeout(timer);
  return result;
}

function videoConfig(codec: string, kind: VideoKind, hardwareAcceleration: HardwareAcceleration, width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig {
  const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, latencyMode: 'quality', hardwareAcceleration };
  if (kind === 'avc') config.avc = { format: 'avc' };
  return config;
}

function addVideo(muxer: Muxer<ArrayBufferTarget>, chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined, frameUs: number): void {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, chunk.duration ?? frameUs, meta);
}

function addAudio(muxer: Muxer<ArrayBufferTarget>, chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined, packetUs: number): void {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  muxer.addAudioChunkRaw(data, chunk.type, chunk.timestamp, chunk.duration ?? packetUs, meta);
}

function audioDataOf(left: Float32Array, right: Float32Array, sampleRate: number, startFrame: number): AudioData {
  const frames = left.length;
  const data = new Float32Array(frames * 2);
  data.set(left, 0);
  data.set(right, frames);
  return new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: frames, numberOfChannels: 2, timestamp: Math.round((startFrame / sampleRate) * 1e6), data });
}

/** Encodes four frames into a small MP4 file: true if the encoder gives a file. */
async function testVideo(config: VideoEncoderConfig, kind: VideoKind): Promise<boolean> {
  if ((await VideoEncoder.isConfigSupported(config)).supported !== true) return false;
  const { width, height } = config;
  const fps = config.framerate ?? 30;
  const frameUs = Math.round(1e6 / fps);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: kind, width, height, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let chunks = 0;
  let failed = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { addVideo(muxer, chunk, meta, frameUs); chunks++; } catch { failed = true; } },
    error: () => { failed = true; },
  });
  try {
    encoder.configure(config);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return false;
    for (let i = 0; i < 4; i++) {
      context.fillStyle = i % 2 === 0 ? '#234' : '#987';
      context.fillRect(0, 0, width, height);
      const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
      encoder.encode(frame, { keyFrame: i === 0 });
      frame.close();
    }
    if (!(await within(encoder.flush(), TEST_MS)) || failed || chunks === 0) return false;
    muxer.finalize();
    return muxer.target.buffer.byteLength > 0;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/** Encodes a short silence into a small MP4 file: true if the encoder gives a file. */
async function testAudio(config: AudioEncoderConfig, kind: AudioKind): Promise<boolean> {
  if ((await AudioEncoder.isConfigSupported(config)).supported !== true) return false;
  const { sampleRate } = config;
  const packetUs = (PACKET_FRAMES[kind] / sampleRate) * 1e6;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: kind, numberOfChannels: 2, sampleRate }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let chunks = 0;
  let failed = false;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => { try { addAudio(muxer, chunk, meta, packetUs); chunks++; } catch { failed = true; } },
    error: () => { failed = true; },
  });
  try {
    encoder.configure(config);
    const silence = new Float32Array(Math.round(sampleRate / 4));
    const audio = audioDataOf(silence, silence, sampleRate, 0);
    encoder.encode(audio);
    audio.close();
    if (!(await within(encoder.flush(), TEST_MS)) || failed || chunks === 0) return false;
    muxer.finalize();
    return muxer.target.buffer.byteLength > 0;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/** Yields to the event loop without the clamping of timers (a message is not throttled). */
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();
function yieldTask(): Promise<void> {
  return new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
}

export interface RenderProgress {
  stage: 'testing' | 'preparing' | 'audio' | 'frames' | 'finishing';
  message: string;
  frame: number;
  frames: number;
  /** Seconds left, when known. */
  eta: number | null;
}

export interface RenderOptions {
  project: Project;
  plan: Plan;
  audio: SynthOutput;
  images: ImageProvider;
  width: number;
  height: number;
  fps: number;
  quality: QualityName;
  /** Optional time window in video seconds (a draft of a part). */
  from?: number;
  to?: number;
  signal: AbortSignal;
  onProgress: (p: RenderProgress) => void;
  /** Gets the frame just drawn, for a live preview. */
  onFrame?: (canvas: HTMLCanvasElement) => void;
}

export interface RenderResult {
  blob: Blob;
  codecs: string;
  seconds: number;
  frames: number;
}

export async function renderMp4(o: RenderOptions): Promise<RenderResult> {
  const { width, height, fps, signal } = o;
  const started = performance.now();
  const report = (stage: RenderProgress['stage'], message: string, frame = 0, frames = 0, eta: number | null = null) => o.onProgress({ stage, message, frame, frames, eta });
  const aborted = () => { if (signal.aborted) throw new Error('The render stopped.'); };

  // ---- encoders --------------------------------------------------------------------------------------
  const bitrate = Math.round(width * height * fps * 0.1);
  const videoTests = videoCodecs(width, height, fps).flatMap(([codec, kind, name]) =>
    (['no-preference', 'prefer-software'] as const).map((hw) => ({ kind, name: hw === 'prefer-software' ? `${name}, software` : name, config: videoConfig(codec, kind, hw, width, height, fps, bitrate) })));
  const video = await firstSupported(videoTests, async (test) => {
    aborted();
    report('testing', `Testing the video encoder: ${test.name} (test ${videoTests.indexOf(test) + 1} of ${videoTests.length})…`);
    return await testVideo(test.config, test.kind);
  });
  const sampleRate = o.audio.sampleRate;
  const audio = await firstSupported(AUDIO_CODECS.map(([codec, kind]) => ({ kind, config: { codec, sampleRate, numberOfChannels: 2, bitrate: 192_000 } as AudioEncoderConfig })), async ({ kind, config }) => {
    aborted();
    report('testing', `Testing the audio encoder: ${CODEC_NAMES[kind]}…`);
    return await testAudio(config, kind);
  });
  if (!video || !audio) throw new Error(`This browser cannot encode the ${video ? 'audio' : 'video'} of an MP4 file. Try a current Chrome, Edge, or Safari.`);
  const codecs = `${CODEC_NAMES[video.kind]} + ${CODEC_NAMES[audio.kind]}`;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: video.kind, width, height, frameRate: fps },
    audio: { codec: audio.kind, numberOfChannels: 2, sampleRate },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let error: Error | null = null;
  const fail = (e: unknown) => { error ??= e instanceof Error ? e : new Error(String(e)); };
  const frameUs = 1e6 / fps;
  const packetUs = (PACKET_FRAMES[audio.kind] / sampleRate) * 1e6;
  let lastOutput = performance.now();
  let videoChunks = 0;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { lastOutput = performance.now(); try { addVideo(muxer, chunk, meta, frameUs); videoChunks++; } catch (e) { fail(e); } },
    error: fail,
  });
  venc.configure(video.config);
  const aenc = new AudioEncoder({
    output: (chunk, meta) => { lastOutput = performance.now(); try { addAudio(muxer, chunk, meta, packetUs); } catch (e) { fail(e); } },
    error: fail,
  });
  aenc.configure(audio.config);

  let stage: Stage | null = null;
  try {
    // ---- the stage at the size of the video --------------------------------------------------------
    report('preparing', `Preparing the stage at ${width} × ${height} (${o.quality})…`);
    stage = await Stage.create({ width, height, quality: o.quality, images: o.images, composite: true });
    stage.setLook(o.project);
    stage.setPlan(o.plan);
    await stage.whenReady();
    stage.warmUp();
    aborted();

    const from = Math.max(0, o.from ?? 0);
    const to = Math.min(o.plan.meta.duration, o.to ?? o.plan.meta.duration);
    const first = Math.round(from * fps);
    const last = Math.ceil(to * fps);
    const frames = last - first;

    // ---- audio: the synthesized samples of the window, in one-second packets ----------------------
    report('audio', `Encoding the audio (${CODEC_NAMES[audio.kind]})…`, 0, frames);
    const a0 = Math.round((first / fps) * sampleRate);
    const a1 = Math.min(o.audio.left.length, Math.round((last / fps) * sampleRate));
    for (let s = a0; s < a1; s += sampleRate) {
      const e = Math.min(a1, s + sampleRate);
      const data = audioDataOf(o.audio.left.subarray(s, e), o.audio.right.subarray(s, e), sampleRate, s - a0);
      aenc.encode(data);
      data.close();
    }

    // ---- frames ------------------------------------------------------------------------------------
    const loopStart = performance.now();
    for (let i = 0; i < frames; i++) {
      aborted();
      if (error) throw error;
      const t = (first + i) / fps;
      stage.renderAt(t);
      const frame = new VideoFrame(stage.out!, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      if (o.onFrame && i % Math.max(1, Math.round(fps / 6)) === 0) o.onFrame(stage.out!);
      // back-pressure: keep the encoder queue short
      while (venc.encodeQueueSize > 4) {
        if (performance.now() - lastOutput > STALL_MS) throw new Error(`The video encoder gave no output for ${STALL_MS / 1000} seconds.`);
        await new Promise((r) => setTimeout(r, 2));
      }
      if (i % 2 === 0) {
        const el = (performance.now() - loopStart) / 1000;
        const rate = (i + 1) / Math.max(el, 1e-3);
        report('frames', `Rendering frame ${i + 1} of ${frames} (${rate.toFixed(1)} frames/s, ${codecs})`, i + 1, frames, (frames - i - 1) / rate);
        await yieldTask();
      }
    }

    // ---- finish ------------------------------------------------------------------------------------
    report('finishing', 'Finishing the file…', frames, frames, 0);
    lastOutput = performance.now();
    const flushed = Promise.all([venc.flush(), aenc.flush()]);
    let timer = 0;
    const watch = new Promise<void>((_, reject) => {
      timer = window.setInterval(() => {
        if (signal.aborted) reject(new Error('The render stopped.'));
        else if (error) reject(error);
        else if (performance.now() - lastOutput > STALL_MS) reject(new Error(`The encoders gave no output for ${STALL_MS / 1000} seconds.`));
      }, 250);
    });
    try { await Promise.race([flushed, watch]); } finally { window.clearInterval(timer); }
    if (error) throw error;
    if (videoChunks === 0) throw new Error('The video encoder gave no frames.');
    await new Promise((r) => setTimeout(r, 30));
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), codecs, seconds: (performance.now() - started) / 1000, frames };
  } finally {
    for (const enc of [venc, aenc]) if (enc.state !== 'closed') enc.close();
    stage?.dispose();
  }
}
