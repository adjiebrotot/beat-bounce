// The 3D stage: renders a plan and the look of a project with three.js. Each frame is a pure
// function of time t (ported from the anthem-bouncing viewer), so the preview and the MP4 render
// draw the same frames, and a frame can be drawn in any order.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as PP from 'postprocessing';
import type { Plan } from '../core/plan.ts';
import type { BallSettings, Ornament, Project, QualityName } from '../core/project.ts';
import { cameraOffset, sampleTrack } from '../core/camera.ts';
import { beachTexture, imageBallTexture, marbleTexture, wallTextures, woodTextures } from './textures.ts';
import { buildOrnament, disposeObject, placeOrnament } from './ornament-mesh.ts';
import type { ImageProvider } from './ornament-mesh.ts';
import { drawOverlay } from './overlay.ts';
import type { HBAOEffect } from '../vendor/realism-effects.js';

export interface QualitySettings {
  /** Sub-frames averaged per frame: anti-aliasing, motion blur and soft shadows. */
  samples: number;
  msaa: boolean;
  /** Motion blur shutter as a fraction of the frame interval. */
  shutter: number;
  ao: 'none' | 'hbao';
  aoOptions?: Record<string, number>;
  bloom: number;
  /** Radius of the area light, as a fraction of its distance. */
  softShadow: number;
  grain: number;
  grade: boolean;
  shadowMap: number;
}

export type StageQuality = 'preview' | QualityName;

export const QUALITY: Record<StageQuality, QualitySettings> = {
  preview: { samples: 1, msaa: true, shutter: 0, ao: 'none', bloom: 0.3, softShadow: 0, grain: 0, grade: true, shadowMap: 2048 },
  draft: { samples: 1, msaa: true, shutter: 0, ao: 'none', bloom: 0.3, softShadow: 0, grain: 0, grade: true, shadowMap: 2048 },
  high: { samples: 4, msaa: false, shutter: 0.5, ao: 'hbao', aoOptions: { spp: 8, iterations: 1, samples: 6 }, bloom: 0.3, softShadow: 0.02, grain: 0.05, grade: true, shadowMap: 2048 },
  ultra: { samples: 8, msaa: false, shutter: 0.5, ao: 'hbao', aoOptions: { spp: 12, iterations: 1, samples: 12 }, bloom: 0.3, softShadow: 0.03, grain: 0.05, grade: true, shadowMap: 4096 },
};

/** A camera that replaces the film camera, for the overview of the editor. */
export interface ViewOverride {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface StageOptions {
  width: number;
  height: number;
  quality: StageQuality;
  images: ImageProvider;
  /** Draw the 3D frame and the overlay into one 2D canvas (`out`), as the MP4 render needs. */
  composite: boolean;
  canvas?: HTMLCanvasElement;
}

interface BarObj {
  t: number;
  vel: number;
  group: THREE.Group;
  pivot: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  color: THREE.Color;
  metal: boolean;
  active: boolean;
}

const LIGHT_DIST = 7.24;
const WHITE = new THREE.Color(0xffffff);
const TRAIL_N = 48;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly glCanvas: HTMLCanvasElement;
  /** The composed frame (composite mode only). */
  readonly out: HTMLCanvasElement | null;
  readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 400);
  readonly scene = new THREE.Scene();
  plan: Plan | null = null;
  project: Project | null = null;

  #opts: StageOptions;
  #q: QualitySettings;
  #W: number;
  #H: number;
  #outCtx: CanvasRenderingContext2D | null = null;
  #sun = new THREE.DirectionalLight(0xfff3e2, 3.3);
  #hemi = new THREE.HemisphereLight(0xe4ecff, 0xb9b1a4, 0.32);
  #lightOffset = new THREE.Vector3(4.2, 3.6, 4.6);
  #shadowHalf: [number, number] = [6, 4];
  #wall: THREE.Mesh | null = null;
  #wallKey = '';
  #barsGroup = new THREE.Group();
  #railsGroup = new THREE.Group();
  #ornGroup = new THREE.Group();
  #bars: BarObj[] = [];
  #hitTimes: number[] = [];
  #railMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.3 });
  #ball = new THREE.Group();
  #ballMesh: THREE.Mesh | null = null;
  #ballKey = '';
  #ballRadius = 0;
  #tiltQ = new THREE.Quaternion();
  #trail: THREE.Mesh;
  #trailOn = false;
  #trailLen = 0.6;
  #ornaments = new Map<string, { group: THREE.Group | null; key: string; version: number }>();
  #themeKey = '';
  #pending = new Set<Promise<unknown>>();
  #cleanups: (() => void)[] = [];
  // post-processing
  #composer!: PP.EffectComposer;
  #renderPass!: PP.RenderPass;
  #finalPass!: PP.EffectPass;
  #ao: HBAOEffect | null = null;
  #postKey = '';
  #accRT: THREE.WebGLRenderTarget;
  #accMat: THREE.ShaderMaterial;
  #accScene = new THREE.Scene();
  #accCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  #grain: HTMLCanvasElement | null = null;
  #exposure = 1;
  #aoModule: typeof import('../vendor/realism-effects.js') | null = null;
  // scratch
  #v = new THREE.Vector3();
  #target = new THREE.Vector3();
  #camOff = new THREE.Vector3();
  #spinQ = new THREE.Quaternion();
  #tmp: number[] = [];

  static async create(opts: StageOptions): Promise<Stage> {
    const q = QUALITY[opts.quality];
    const mod = q.ao === 'hbao' ? await import('../vendor/realism-effects.js') : null;
    return new Stage(opts, mod);
  }

  private constructor(opts: StageOptions, aoModule: typeof import('../vendor/realism-effects.js') | null) {
    this.#opts = opts;
    this.#q = QUALITY[opts.quality];
    this.#aoModule = aoModule;
    this.#W = opts.width;
    this.#H = opts.height;
    this.glCanvas = opts.canvas ?? document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.glCanvas, antialias: false, stencil: false, depth: false, preserveDrawingBuffer: opts.composite,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.#W, this.#H, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the post-processing chain
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (opts.composite) {
      this.out = document.createElement('canvas');
      this.out.width = this.#W;
      this.out.height = this.#H;
      this.#outCtx = this.out.getContext('2d');
    } else {
      this.out = null;
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.#sun.castShadow = true;
    this.#sun.shadow.mapSize.set(this.#q.shadowMap, this.#q.shadowMap);
    this.#sun.shadow.bias = -0.0004;
    this.#sun.shadow.normalBias = 0.015;
    this.#sun.shadow.radius = 3;
    this.#sun.shadow.camera.near = 0.5;
    this.#sun.shadow.camera.far = 40;
    this.scene.add(this.#sun, this.#sun.target, this.#hemi, this.#barsGroup, this.#railsGroup, this.#ornGroup, this.#ball);

    // trail: a ribbon behind the ball, rebuilt each frame from the ball track
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TRAIL_N + 1) * 2 * 3), 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((TRAIL_N + 1) * 2 * 4), 4));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    trailGeo.setIndex(idx);
    this.#trail = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.#trail.frustumCulled = false;
    this.#trail.visible = false;
    this.scene.add(this.#trail);

    this.#accRT = new THREE.WebGLRenderTarget(this.#W, this.#H, { type: THREE.HalfFloatType, depthBuffer: false });
    this.#accMat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null }, weight: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      // NaN / Inf guard: one bad sub-frame pixel must never reach bloom (it would blow out the frame)
      fragmentShader: `uniform sampler2D tex; uniform float weight; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tex, vUv).rgb;
          uvec3 bits = floatBitsToUint(c) & uvec3(0x7f800000u);
          if (any(equal(bits, uvec3(0x7f800000u)))) c = vec3(0.0);
          gl_FragColor = vec4(clamp(c, 0.0, 64.0) * weight, 1.0);
        }`,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.#accMat);
    quad.frustumCulled = false;
    this.#accScene.add(quad);
    this.#buildPost('aces');
  }

  get width(): number { return this.#W; }
  get height(): number { return this.#H; }

  // ---------------------------------------------------------------------------------------------------
  // Post-processing: AO + bloom + grade + filmic tone mapping, once per frame on the accumulated
  // HDR image. Sub-frames replace TRAA and velocity motion blur, which need frame history.

  #buildPost(toneMapping: string): void {
    const key = `${toneMapping}|${this.#q.msaa}|${this.#q.ao}|${this.#q.bloom}|${this.#q.grade}`;
    if (key === this.#postKey) return;
    this.#postKey = key;
    this.#composer?.dispose();
    const q = this.#q;
    this.#composer = new PP.EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: q.msaa ? 4 : 0 });
    this.#renderPass = new PP.RenderPass(this.scene, this.camera);
    this.#composer.addPass(this.#renderPass);
    const post: PP.Effect[] = [];
    this.#ao = null;
    if (q.ao === 'hbao' && this.#aoModule) {
      const ao = new this.#aoModule.HBAOEffect(this.#composer, this.camera, this.scene, {
        resolutionScale: 1, spp: 8, distance: 0.28, distancePower: 1, power: 1.35, bias: 40, thickness: 0.06,
        iterations: 1, radius: 7, rings: 3, samples: 12, ...(q.aoOptions || {}),
      });
      // The effect animates its noise only with TRAA. Frames here are accumulated instead, so the noise
      // is always on, with a fixed seed (a moving seed would make the AO grain crawl).
      const self = ao as unknown as HBAOEffect & { skipRefresh?: boolean; update(r: THREE.WebGLRenderer): void };
      self.update = function update(r: THREE.WebGLRenderer) {
        const m = this.aoPass.fullscreenMaterial;
        if (!('animatedNoise' in m.defines)) { m.defines['animatedNoise'] = ''; m.needsUpdate = true; }
        this.uniforms.get('inputTexture')!.value = this.iterations > 0 ? this.poissionDenoisePass.texture : this.aoPass.texture;
        if (this.skipRefresh) return;
        this.normalPass?.render(r);
        this.aoPass.render(r);
        if (this.iterations > 0) this.poissionDenoisePass.render(r);
      };
      this.#ao = ao;
      post.push(ao);
    }
    if (q.bloom > 0) post.push(new PP.BloomEffect({ intensity: q.bloom, luminanceThreshold: 0.82, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.65 }));
    if (q.grade) {
      post.push(new PP.BrightnessContrastEffect({ brightness: 0, contrast: 0.07 }));
      post.push(new PP.HueSaturationEffect({ saturation: 0.06 }));
    }
    const modes: Record<string, PP.ToneMappingMode> = { aces: PP.ToneMappingMode.ACES_FILMIC, agx: PP.ToneMappingMode.AGX, neutral: PP.ToneMappingMode.NEUTRAL };
    post.push(new PP.ToneMappingEffect({ mode: modes[toneMapping] ?? PP.ToneMappingMode.ACES_FILMIC }));
    this.#finalPass = new PP.EffectPass(this.camera, ...post);
    this.#finalPass.renderToScreen = true;
    this.#composer.addPass(this.#finalPass);
    this.#composer.setSize(this.#W, this.#H, false);
  }

  setSize(w: number, h: number): void {
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    if (w === this.#W && h === this.#H) return;
    this.#W = w; this.#H = h;
    this.renderer.setSize(w, h, false);
    this.#composer.setSize(w, h, false);
    this.#accRT.setSize(w, h);
    if (this.out) { this.out.width = w; this.out.height = h; }
  }

  // ---------------------------------------------------------------------------------------------------
  // Plan: bars, rails, wall

  setPlan(plan: Plan): void {
    this.plan = plan;
    disposeObject(this.#barsGroup);
    this.#barsGroup.clear();
    for (const c of [...this.#railsGroup.children]) { this.#railsGroup.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    this.#bars = [];
    const world = plan.world;
    const BALL_Z = world.ballZ, BAR_DEPTH = world.barDepth;
    const geoCache = new Map<string, THREE.BufferGeometry>();
    const cached = (key: string, make: () => THREE.BufferGeometry) => {
      let g = geoCache.get(key);
      if (!g) { g = make(); geoCache.set(key, g); }
      return g;
    };
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x9da3aa, metalness: 0.9, roughness: 0.35 });
    const screwMat = new THREE.MeshStandardMaterial({ color: 0x7c8187, metalness: 0.9, roughness: 0.3 });
    for (const p of plan.paddles) {
      const look = plan.sections[p.section]!.look;
      const shape = look.shape || 'bar';
      const color = new THREE.Color(p.color);
      let mat: THREE.MeshPhysicalMaterial;
      if (look.texture === 'wood') {
        const wt = woodTextures(p.color);
        mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: wt.map, normalMap: wt.normalMap, normalScale: new THREE.Vector2(0.6, 0.6),
          roughness: look.roughness, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.35 });
      } else if (look.metalness > 0.5) {
        mat = new THREE.MeshPhysicalMaterial({ color, roughness: look.roughness, metalness: 1, clearcoat: 0.2, clearcoatRoughness: 0.2 });
      } else {
        mat = new THREE.MeshPhysicalMaterial({ color, roughness: Math.max(0.3, look.roughness), metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.12 });
      }
      mat.emissive = new THREE.Color(0x000000);
      const group = new THREE.Group();
      const pivot = new THREE.Group(); // rotates for the wobble
      group.add(pivot);
      const lenQ = Math.round(p.len * 50) / 50;
      const thick = p.thick;
      let body: THREE.Mesh;
      if (shape === 'disc') {
        const geo = cached(`disc${lenQ}`, () => {
          const R = lenQ / 2, d = thick * 0.9, pts: THREE.Vector2[] = [];
          for (let i = 0; i <= 12; i++) { const r = (R * 0.94 * i) / 12; pts.push(new THREE.Vector2(r, thick / 2 - d * (1 - (i / 12) ** 2))); }
          pts.push(new THREE.Vector2(R, thick / 2 + 0.006), new THREE.Vector2(R * 1.02, thick / 2 - 0.004), new THREE.Vector2(R * 1.0, -thick * 1.4));
          return new THREE.LatheGeometry(pts, 48);
        });
        mat.side = THREE.DoubleSide;
        body = new THREE.Mesh(geo, mat);
      } else if (shape === 'tube') {
        body = new THREE.Mesh(cached(`tube${lenQ}_${thick}`, () => new THREE.CylinderGeometry(thick / 2, thick / 2, lenQ, 28, 1, false)), mat);
        body.rotation.z = Math.PI / 2;
      } else {
        const depth = shape === 'tine' ? BAR_DEPTH * 0.55 : BAR_DEPTH;
        body = new THREE.Mesh(cached(`bar${lenQ}_${thick}_${depth}`, () => new RoundedBoxGeometry(lenQ, thick, depth, 3, Math.min(thick * 0.35, 0.03))), mat);
      }
      body.castShadow = true;
      body.receiveShadow = true;
      pivot.add(body);
      // the mount to the wall (local frame: x along the bar, y = bar normal, z out of the wall)
      const backZ = shape === 'disc' ? -0.02 : -(shape === 'tine' ? BAR_DEPTH * 0.55 : shape === 'tube' ? thick : BAR_DEPTH) / 2;
      const rodLen = BALL_Z + backZ;
      if (rodLen > 0.01) {
        const mount = look.mount || 'rods';
        if (mount === 'block') {
          const blk = new THREE.Mesh(cached(`blk${rodLen.toFixed(3)}`, () => new THREE.BoxGeometry(0.16, 0.12, rodLen)), new THREE.MeshStandardMaterial({ color: look.base || '#6b4423', roughness: 0.7 }));
          blk.position.set(-lenQ * 0.32, -thick / 2 - 0.02, backZ - rodLen / 2);
          blk.castShadow = true;
          pivot.add(blk);
        } else {
          const rr = mount === 'pins' ? 0.009 : 0.014;
          const rodGeo = cached(`rod${rr}_${rodLen.toFixed(3)}`, () => new THREE.CylinderGeometry(rr, rr, rodLen, 10));
          for (const sx of shape === 'disc' ? [0] : [-0.3, 0.3]) {
            const rod = new THREE.Mesh(rodGeo, rodMat);
            rod.rotation.x = Math.PI / 2;
            rod.position.set(sx * lenQ, shape === 'disc' ? -thick * 0.9 : 0, backZ - rodLen / 2);
            rod.castShadow = true;
            pivot.add(rod);
          }
        }
      }
      if (look.screws && shape === 'bar') {
        const sg = cached('screw', () => new THREE.CylinderGeometry(0.016, 0.016, 0.01, 12));
        for (const sx of [-0.3, 0.3]) {
          const s = new THREE.Mesh(sg, screwMat);
          s.position.set(sx * lenQ, thick / 2 + 0.002, 0);
          pivot.add(s);
        }
      }
      group.position.set(p.cx, p.cy, BALL_Z);
      group.rotation.z = p.angle;
      this.#barsGroup.add(group);
      this.#bars.push({ t: p.t, vel: p.vel, group, pivot, mat, color, metal: look.metalness > 0.5, active: false });
    }
    this.#hitTimes = plan.paddles.map((p) => p.t);

    // rails: two rods, end caps, and posts to the wall
    const rc = world.rail;
    const capGeo = new THREE.SphereGeometry(rc.tubeRadius, 10, 8);
    const postGeo = new THREE.CylinderGeometry(0.011, 0.011, BALL_Z + rc.gauge / 2, 8);
    for (const rl of plan.rails) {
      const pts: [number, number][] = [];
      for (let i = 0; i < rl.tube.length; i += 2) pts.push([rl.tube[i]!, rl.tube[i + 1]!]);
      const dec = pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1);
      for (const dz of [-rc.gauge / 2, rc.gauge / 2]) {
        const curve = new THREE.CatmullRomCurve3(dec.map(([x, y]) => new THREE.Vector3(x, y, BALL_Z + dz)));
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, dec.length * 2), rc.tubeRadius, 8, false), this.#railMat);
        mesh.castShadow = true;
        this.#railsGroup.add(mesh);
        for (const e of [dec[0]!, dec[dec.length - 1]!]) {
          const cap = new THREE.Mesh(capGeo, this.#railMat);
          cap.position.set(e[0], e[1], BALL_Z + dz);
          this.#railsGroup.add(cap);
        }
      }
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
        if (acc > 0.7 || i === 1 || i === pts.length - 1) {
          acc = 0;
          const post = new THREE.Mesh(postGeo, this.#railMat);
          post.rotation.x = Math.PI / 2;
          post.position.set(pts[i]![0], pts[i]![1] - 0.012, (BALL_Z + rc.gauge / 2) / 2);
          post.castShadow = true;
          this.#railsGroup.add(post);
        }
      }
      if (rl.intro) {
        // a little stopper behind the resting ball
        const [x0, y0] = pts[0]!;
        const [x1, y1] = pts[Math.min(3, pts.length - 1)]!;
        const d = Math.hypot(x1 - x0, y1 - y0) || 1;
        const stop = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, rc.gauge + 0.06, 12), this.#railMat);
        stop.rotation.x = Math.PI / 2;
        const r = world.ballRadius;
        stop.position.set(x0 - ((x1 - x0) / d) * (r + 0.03), y0 - ((y1 - y0) / d) * (r + 0.03) + r * 0.6, BALL_Z);
        this.#railsGroup.add(stop);
      }
    }

    this.camera.fov = plan.camera.fov;
    this.camera.updateProjectionMatrix();
    this.#shadowHalf = [Math.max(3.5, plan.camera.viewHalfW * 2.4), Math.max(3.5, plan.camera.viewHalfH * 3.0)];
    if (Math.abs(this.#ballRadius - world.ballRadius) > 1e-6) {
      this.#ballRadius = world.ballRadius;
      this.#ballKey = '';
    }
    this.#rebuildWall();
    if (this.project) this.#updateBall(this.project.ball);
  }

  #rebuildWall(): void {
    const plan = this.plan, project = this.project;
    if (!plan || !project) return;
    const th = project.theme;
    const b = plan.bounds;
    // the wall reaches 40 m past the path and the ornaments in each direction
    let minX = b.minX, maxX = b.maxX, minY = b.minY, maxY = b.maxY;
    for (const o of project.ornaments) { minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x); minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y); }
    const key = `${th.wallStyle}|${th.wall}|${th.wallBump}|${th.wallTile}|${Math.floor(minX / 10)}|${Math.floor(maxX / 10)}|${Math.floor(minY / 10)}|${Math.floor(maxY / 10)}`;
    if (key === this.#wallKey) return;
    this.#wallKey = key;
    if (this.#wall) {
      this.scene.remove(this.#wall);
      this.#wall.geometry.dispose();
      (this.#wall.material as THREE.Material).dispose();
    }
    minX = Math.floor(minX / 10) * 10 - 40; maxX = Math.ceil(maxX / 10) * 10 + 40;
    minY = Math.floor(minY / 10) * 10 - 40; maxY = Math.ceil(maxY / 10) * 10 + 40;
    const ww = maxX - minX, wh = maxY - minY;
    const tx = wallTextures(th.wallStyle, th.wall, th.wallStyle === 'smooth' ? th.wallBump * 0.2 : th.wallBump, 1);
    const tile = Math.max(0.2, th.wallTile) * (tx.natural / 3.5);
    const maps = [tx.map, tx.normalMap, tx.roughnessMap].map((t) => {
      const c = t.clone();
      c.userData = {};
      c.repeat.set(ww / tile, wh / tile);
      c.needsUpdate = true;
      return c;
    });
    this.#wall = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), new THREE.MeshStandardMaterial({
      color: 0xffffff, map: maps[0], normalMap: maps[1], roughnessMap: maps[2], normalScale: new THREE.Vector2(1, 1), roughness: 1, metalness: 0,
    }));
    this.#wall.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0);
    this.#wall.receiveShadow = true;
    this.scene.add(this.#wall);
    this.scene.background = new THREE.Color(th.wall);
  }

  // ---------------------------------------------------------------------------------------------------
  // Look: theme, light, ball, ornaments

  setLook(project: Project): void {
    this.project = project;
    const th = project.theme;
    const themeKey = JSON.stringify([th.rail, th.toneMapping, th.exposure]);
    if (themeKey !== this.#themeKey) {
      this.#themeKey = themeKey;
      this.#railMat.color.set(th.rail);
      this.#exposure = th.exposure;
      this.#buildPost(th.toneMapping);
    }
    this.#rebuildWall();
    const L = project.light;
    this.#sun.color.set(L.color);
    this.#sun.intensity = L.intensity;
    this.#hemi.color.set(L.sky);
    this.#hemi.groundColor.set(L.ground);
    this.#hemi.intensity = L.ambient;
    this.scene.environmentIntensity = L.env;
    const az = (L.angle * Math.PI) / 180, el = (Math.max(5, Math.min(85, L.height)) * Math.PI) / 180;
    this.#lightOffset.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(LIGHT_DIST);
    this.#updateBall(project.ball);
    this.#updateOrnaments(project.ornaments);
  }

  #track(p: Promise<unknown>): void {
    this.#pending.add(p);
    p.finally(() => this.#pending.delete(p)).catch(() => undefined);
  }

  /** Resolves when the pictures of the ball and the ornaments are on the stage. */
  async whenReady(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  #updateBall(b: BallSettings): void {
    const r = this.plan?.world.ballRadius ?? b.radius;
    const key = JSON.stringify([b.style, b.color, b.color2, b.roughness, b.image, b.focus, b.glow, r]);
    this.#trailOn = b.trail;
    this.#trailLen = b.trailLength;
    (this.#trail.material as THREE.MeshBasicMaterial).color.set(b.trailColor);
    if (key === this.#ballKey) return;
    this.#ballKey = key;
    if (this.#ballMesh) {
      this.#ball.remove(this.#ballMesh);
      disposeObject(this.#ballMesh);
    }
    const geo = new THREE.SphereGeometry(r, 64, 48);
    const color = new THREE.Color(b.color);
    let mat: THREE.MeshPhysicalMaterial;
    const mesh = new THREE.Mesh(geo);
    switch (b.style) {
      case 'glass': {
        // a clear glass shell around a swirled core: the classic cat's-eye marble
        mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(b.color2).lerp(WHITE, 0.6), transmission: 1, thickness: r * 1.6, ior: 1.5, roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02 });
        const core = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 32, 24), new THREE.MeshPhysicalMaterial({ map: marbleTexture(b.color, b.color2), roughness: 0.3 }));
        core.scale.set(1, 0.45, 1);
        mesh.add(core);
        break;
      }
      case 'metal':
        mat = new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness: Math.min(0.6, b.roughness), clearcoat: 0.3 });
        break;
      case 'matte':
        mat = new THREE.MeshPhysicalMaterial({ color, roughness: Math.max(0.55, b.roughness), metalness: 0 });
        break;
      case 'beach':
        mat = new THREE.MeshPhysicalMaterial({ map: beachTexture([b.color, '#ffffff', b.color2, '#ffffff', '#ffd23f', '#ffffff']), roughness: Math.max(0.25, b.roughness), clearcoat: 0.6 });
        break;
      case 'neon':
        mat = new THREE.MeshPhysicalMaterial({ color: 0x050505, emissive: color, emissiveIntensity: 2.5 + b.glow, roughness: 0.2 });
        break;
      case 'earth':
        mat = new THREE.MeshPhysicalMaterial({ map: marbleTexture('earth'), roughness: b.roughness, clearcoat: 1, clearcoatRoughness: 0.04 });
        break;
      case 'image':
        mat = new THREE.MeshPhysicalMaterial({ color: 0xdddddd, roughness: b.roughness, clearcoat: 1, clearcoatRoughness: 0.04 });
        if (b.image) {
          const img = b.image;
          this.#track(this.#opts.images.get(img).then((pic) => {
            if (pic && this.#ballKey === key) {
              mat.map = imageBallTexture(pic, b.focus);
              mat.color.set(0xffffff);
              mat.needsUpdate = true;
            }
          }));
        }
        break;
      default:
        mat = new THREE.MeshPhysicalMaterial({ map: marbleTexture(b.color, b.color2), roughness: b.roughness, clearcoat: 1, clearcoatRoughness: 0.04 });
    }
    if (b.glow > 0 && b.style !== 'neon') {
      mat.emissive = color.clone();
      mat.emissiveIntensity = b.glow;
    }
    mesh.material = mat;
    mesh.castShadow = true;
    this.#ballMesh = mesh;
    this.#ball.add(mesh);
    // a marble gets a tilt; a picture faces the camera with its focus
    if (b.style === 'image') this.#tiltQ.identity();
    else this.#tiltQ.setFromEuler(new THREE.Euler(0.5, 0.35, 0));
  }

  #ornamentKey(o: Ornament): string {
    const { x: _x, y: _y, rotation: _r, hidden: _h, keepClear: _k, feature: _f, ...rest } = o;
    return JSON.stringify(rest);
  }

  #updateOrnaments(list: Ornament[]): void {
    const seen = new Set<string>();
    for (const o of list) {
      seen.add(o.id);
      const key = this.#ornamentKey(o);
      let entry = this.#ornaments.get(o.id);
      if (!entry || entry.key !== key) {
        const version = (entry?.version ?? 0) + 1;
        const old = entry?.group ?? null;
        entry = { group: old, key, version };
        this.#ornaments.set(o.id, entry);
        const e = entry;
        this.#track(buildOrnament(o, this.#opts.images).then((g) => {
          if (this.#ornaments.get(o.id) !== e || e.version !== version) { disposeObject(g); return; }
          if (e.group) { this.#ornGroup.remove(e.group); disposeObject(e.group); }
          e.group = g;
          const cur = this.project?.ornaments.find((x) => x.id === o.id) ?? o;
          placeOrnament(g, cur);
          g.visible = !cur.hidden;
          this.#ornGroup.add(g);
        }));
      }
      if (entry.group) {
        placeOrnament(entry.group, o);
        entry.group.visible = !o.hidden;
      }
    }
    for (const [id, e] of this.#ornaments) {
      if (seen.has(id)) continue;
      if (e.group) { this.#ornGroup.remove(e.group); disposeObject(e.group); }
      this.#ornaments.delete(id);
    }
  }

  /** Moves an ornament at once, while the user drags it (the project commits at the end). */
  moveOrnament(o: Pick<Ornament, 'id' | 'x' | 'y' | 'rotation'>): void {
    const g = this.#ornaments.get(o.id)?.group;
    if (g) placeOrnament(g, o);
  }

  // ---------------------------------------------------------------------------------------------------
  // Frame

  /** The film camera target (camX, camY) at video time t. */
  filmTarget(t: number): [number, number] {
    const plan = this.plan!;
    const [cx, cy] = sampleTrack(plan.camera.track, plan.camera.hz, 2, t, this.#tmp);
    return [cx!, cy!];
  }

  /** Sets a camera to the film camera at video time t. */
  setFilmCamera(cam: THREE.PerspectiveCamera, t: number): void {
    const plan = this.plan!;
    const [cx, cy] = this.filmTarget(t);
    this.#target.set(cx, cy - plan.camera.lookDown, 0.2);
    const off = cameraOffset(plan.camera);
    cam.position.copy(this.#target).add(this.#camOff.set(off[0], off[1], off[2]));
    cam.lookAt(this.#target);
    cam.fov = plan.camera.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  ballAt(t: number): [number, number] {
    const plan = this.plan!;
    const [bx, by] = sampleTrack(plan.ball.track, plan.ball.hz, 3, t, this.#tmp);
    return [bx!, by!];
  }

  #placeSun(target: THREE.Vector3, a: number, b: number, half: [number, number]): void {
    const sun = this.#sun;
    const sc = sun.shadow.camera;
    if (sc.right !== half[0] || sc.top !== half[1]) {
      sc.left = -half[0]; sc.right = half[0]; sc.top = half[1]; sc.bottom = -half[1];
      sc.updateProjectionMatrix();
    }
    const rel = this.#v.copy(this.#lightOffset);
    if (a || b) {
      // area light: the sun moves across a disk perpendicular to its direction
      const u = new THREE.Vector3(0, 1, 0).cross(this.#lightOffset).normalize();
      const w = new THREE.Vector3().crossVectors(this.#lightOffset.clone().normalize(), u);
      rel.addScaledVector(u, a * this.#q.softShadow * LIGHT_DIST).addScaledVector(w, b * this.#q.softShadow * LIGHT_DIST);
    }
    // the shadow camera snaps to whole shadow-map texels, so shadows do not shimmer as the camera moves
    const fwd = rel.clone().normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
    const up = new THREE.Vector3().crossVectors(fwd, right);
    const texelX = (2 * half[0]) / sun.shadow.mapSize.x, texelY = (2 * half[1]) / sun.shadow.mapSize.y;
    const px = target.dot(right), py = target.dot(up);
    const snap = target.clone().addScaledVector(right, Math.round(px / texelX) * texelX - px).addScaledVector(up, Math.round(py / texelY) * texelY - py);
    sun.target.position.copy(snap);
    sun.position.copy(snap).add(rel);
  }

  #updateScene(t: number, lightSample: [number, number] | null, view: ViewOverride | null): void {
    const plan = this.plan!;
    const BALL_Z = plan.world.ballZ;
    const [bx, by, spin] = sampleTrack(plan.ball.track, plan.ball.hz, 3, t, this.#tmp);
    this.#ball.position.set(bx!, by!, BALL_Z);
    this.#spinQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin!);
    this.#ball.quaternion.copy(this.#spinQ).multiply(this.#tiltQ);

    let half = this.#shadowHalf;
    if (view) {
      this.camera.position.set(...view.position);
      this.#target.set(...view.target);
      this.camera.lookAt(this.#target);
      if (this.camera.fov !== view.fov) { this.camera.fov = view.fov; this.camera.updateProjectionMatrix(); }
      const dist = this.camera.position.distanceTo(this.#target);
      const hh = dist * Math.tan((view.fov * Math.PI) / 360);
      half = [Math.max(3.5, hh * (this.#W / this.#H) * 1.3), Math.max(3.5, hh * 1.5)];
    } else {
      this.setFilmCamera(this.camera, t);
      const [cx, cy] = this.filmTarget(t);
      this.#target.set(cx, cy - plan.camera.lookDown, 0.2);
    }
    this.#placeSun(this.#target, lightSample ? lightSample[0] : 0, lightSample ? lightSample[1] : 0, half);

    // bars react to their hit: a short flash, a press and a wobble
    for (const b of this.#bars) {
      if (b.active) {
        b.mat.emissive.setRGB(0, 0, 0);
        b.pivot.rotation.set(0, 0, 0);
        b.pivot.position.set(0, 0, 0);
        b.active = false;
      }
    }
    const i0 = lowerBound(this.#hitTimes, t - 1.4), i1 = lowerBound(this.#hitTimes, t + 1e-6);
    for (let i = i0; i < i1; i++) {
      const b = this.#bars[i]!;
      const dt = t - b.t;
      const v = 0.6 + 0.4 * (b.vel ?? 0.8);
      const flash = Math.exp(-dt / 0.16) * (b.metal ? 0.55 : 0.7);
      b.mat.emissive.copy(b.metal ? WHITE : b.color).multiplyScalar(flash);
      const wob = 0.1 * v * Math.exp(-dt / 0.28) * Math.sin(2 * Math.PI * 6.5 * dt);
      b.pivot.rotation.z = wob * 0.35;
      b.pivot.rotation.x = wob * 0.25;
      b.pivot.position.y = -0.03 * v * Math.exp(-dt / 0.05) * Math.min(1, dt / 0.012);
      b.active = true;
    }

    // trail
    this.#trail.visible = this.#trailOn;
    if (this.#trailOn) this.#updateTrail(t);
  }

  #updateTrail(t: number): void {
    const plan = this.plan!;
    const geo = this.#trail.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const r = plan.world.ballRadius;
    const z = plan.world.ballZ - r * 0.25;
    const pts: [number, number][] = [];
    for (let i = 0; i <= TRAIL_N; i++) {
      const ti = Math.max(0, t - this.#trailLen * (1 - i / TRAIL_N));
      const [x, y] = sampleTrack(plan.ball.track, plan.ball.hz, 3, ti, this.#tmp);
      pts.push([x!, y!]);
    }
    for (let i = 0; i <= TRAIL_N; i++) {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(TRAIL_N, i + 1)]!;
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      if (l < 1e-6) { dx = 1; dy = 0; } else { dx /= l; dy /= l; }
      const k = i / TRAIL_N;
      const w = r * 0.85 * Math.pow(k, 0.7);
      const [px, py] = pts[i]!;
      pos.setXYZ(2 * i, px - dy * w, py + dx * w, z);
      pos.setXYZ(2 * i + 1, px + dy * w, py - dx * w, z);
      const alpha = 0.8 * Math.pow(k, 1.4);
      col.setXYZW(2 * i, 1, 1, 1, alpha);
      col.setXYZW(2 * i + 1, 1, 1, 1, alpha);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** Renders the frame at video time t (with the film camera, or `view` for the editor overview). */
  renderAt(t: number, view: ViewOverride | null = null): void {
    if (!this.plan) return;
    const q = this.#q;
    const K = view ? 1 : Math.max(1, Math.round(q.samples));
    const fps = this.project?.render.fps ?? 60;
    const W = this.#W, H = this.#H;
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    const disk = lightSamples(K);
    for (let i = 0; i < K; i++) {
      const ts = K > 1 ? t + (q.shutter / fps) * ((i + 0.5) / K - 0.5) : t;
      this.#updateScene(ts, q.softShadow > 0 && K > 1 ? disk[i]! : null, view);
      if (K > 1) this.camera.setViewOffset(W, H, halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5, W, H);
      if (this.#ao) {
        // AO is computed once per frame, from the first sub-frame, with a fixed noise seed
        (this.#ao as unknown as { skipRefresh: boolean }).skipRefresh = i > 0;
        this.#ao.aoPass.fullscreenMaterial.uniforms['frame']!.value = 0;
      }
      this.#renderPass.render(this.renderer, this.#composer.inputBuffer, this.#composer.outputBuffer, 1 / fps / K, false);
      this.renderer.setRenderTarget(this.#accRT);
      this.#accMat.blending = i === 0 ? THREE.NoBlending : THREE.CustomBlending; // the first sub-frame overwrites
      this.#accMat.uniforms['tex']!.value = this.#composer.inputBuffer.texture;
      this.#accMat.uniforms['weight']!.value = this.#exposure / K;
      this.renderer.render(this.#accScene, this.#accCam);
      this.renderer.setRenderTarget(null);
    }
    if (this.#ao) (this.#ao as unknown as { skipRefresh: boolean }).skipRefresh = false;
    this.#finalPass.render(this.renderer, this.#accRT, null as unknown as THREE.WebGLRenderTarget, 1 / fps, false);
    this.camera.clearViewOffset();
    this.camera.updateMatrixWorld();

    if (this.#outCtx && this.out) {
      const ctx = this.#outCtx;
      ctx.globalAlpha = 1;
      ctx.drawImage(this.glCanvas, 0, 0, W, H);
      if (q.grain > 0) {
        this.#grain ??= grainCanvas();
        const frame = Math.round(t * fps);
        ctx.save();
        ctx.globalAlpha = q.grain;
        ctx.globalCompositeOperation = 'overlay';
        const ox = (frame * 97) % 256, oy = (frame * 57) % 256;
        ctx.fillStyle = ctx.createPattern(this.#grain, 'repeat')!;
        ctx.translate(-ox, -oy);
        ctx.fillRect(ox, oy, W, H);
        ctx.restore();
      }
      if (this.project) drawOverlay(ctx, t, W, H, this.plan, this.project);
    }
  }

  /** Compiles the shaders and uploads the textures, so the first frames do not stall. */
  warmUp(): void {
    this.renderer.compile(this.scene, this.camera);
    this.renderAt(0);
  }

  dispose(): void {
    for (const c of this.#cleanups) c();
    disposeObject(this.scene);
    this.#composer.dispose();
    this.#accRT.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]! < x) lo = m + 1; else hi = m; }
  return lo;
}

const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

/** Area-light samples: a Vogel disk, the same for each frame, so soft shadows do not flicker. */
function lightSamples(K: number): [number, number][] {
  return Array.from({ length: K }, (_, i) => {
    const rr = Math.sqrt((i + 0.5) / K), a = i * 2.399963 + 0.4;
    return [rr * Math.cos(a), rr * Math.sin(a)] as [number, number];
  });
}

function grainCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  let sd = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    sd = (sd * 1103515245 + 12345) >>> 0;
    const v = 128 + ((sd >>> 16) % 64) - 32;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
