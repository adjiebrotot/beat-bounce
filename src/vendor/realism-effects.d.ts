// Minimal types for the vendored realism-effects 1.1.2 (only the parts that beat-bounce uses).
import type { Camera, Scene, WebGLRenderer, Texture, ShaderMaterial, IUniform, Uniform } from 'three';
import type { Effect, EffectComposer, Pass } from 'postprocessing';

export interface AOOptions {
  resolutionScale?: number;
  spp?: number;
  distance?: number;
  distancePower?: number;
  power?: number;
  bias?: number;
  thickness?: number;
  iterations?: number;
  radius?: number;
  rings?: number;
  samples?: number;
}

export declare class HBAOEffect extends Effect {
  constructor(composer: EffectComposer, camera: Camera, scene: Scene, options?: AOOptions);
  aoPass: Pass & { fullscreenMaterial: ShaderMaterial & { defines: Record<string, string>; uniforms: Record<string, IUniform> }; texture: Texture; render(r: WebGLRenderer): void };
  poissionDenoisePass: Pass & { texture: Texture; render(r: WebGLRenderer): void };
  normalPass?: { render(r: WebGLRenderer): void };
  iterations: number;
  override uniforms: Map<string, Uniform>;
}
