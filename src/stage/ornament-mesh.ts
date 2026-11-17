// Builds the 3D object of an ornament on the wall: a framed photo, a die-cut sticker, or wall text.
// The origin of the group is the centre of the footprint (core/ornaments.ts), on the wall plane.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { photoAspect, photoLayout, stickerBorder, ornamentSize } from '../core/ornaments.ts';
import type { Ornament, PhotoOrnament, StickerOrnament, TextOrnament } from '../core/project.ts';
import { FONTS } from '../core/project.ts';
import { textCanvas, woodTextures } from './textures.ts';
import { drawText } from './text.ts';

/** A loaded picture: an image element, a bitmap or a canvas. */
export type Picture = CanvasImageSource & { width: number; height: number };

export interface ImageProvider {
  /** Loads the picture of an asset id or "builtin:<name>"; null if it is missing. */
  get(id: string): Promise<Picture | null>;
}

const tex = (src: Picture | HTMLCanvasElement, srgb = true) => {
  const t = new THREE.Texture(src as TexImageSource);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
};

function pictureSize(p: Picture): [number, number] {
  const img = p as HTMLImageElement;
  return [img.naturalWidth || p.width || 1, img.naturalHeight || p.height || 1];
}

/** A texture that fills an area of the given aspect, cropped to cover it (object-fit: cover). */
function coverTexture(p: Picture, aspect: number): THREE.Texture {
  const t = tex(p);
  const [iw, ih] = pictureSize(p);
  const ia = iw / ih;
  if (ia > aspect) { t.repeat.set(aspect / ia, 1); t.offset.set((1 - aspect / ia) / 2, 0); }
  else { t.repeat.set(1, ia / aspect); t.offset.set(0, (1 - ia / aspect) / 2); }
  return t;
}

function frameMaterial(o: PhotoOrnament): THREE.Material {
  switch (o.frame) {
    case 'wood': {
      const wt = woodTextures(o.frameColor);
      return new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: wt.map, normalMap: wt.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4 });
    }
    case 'black': return new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.42, metalness: 0.05 });
    case 'white': return new THREE.MeshStandardMaterial({ color: 0xf1efe9, roughness: 0.5 });
    case 'gold': return new THREE.MeshStandardMaterial({ color: 0xd8b04c, roughness: 0.28, metalness: 1 });
    case 'silver': return new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.24, metalness: 1 });
    default: return new THREE.MeshStandardMaterial({ color: o.frameColor, roughness: 0.45, metalness: 0.05 });
  }
}

function shadowy<T extends THREE.Object3D>(m: T, cast = true): T {
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

function placeholderTexture(text: string, aspect: number): THREE.Texture {
  return textCanvas([{ text, size: 64 }], {
    w: 1024, h: Math.max(64, Math.round(1024 / aspect)), bg: '#eceae4', color: '#8a8780', border: '#a8a59e', borderWidth: 10, dash: [40, 24],
    font: FONTS.sans.css,
  });
}

async function buildPhoto(o: PhotoOrnament, images: ImageProvider): Promise<THREE.Group> {
  const g = new THREE.Group();
  const L = photoLayout(o);
  const aspect = photoAspect(o);
  const pic = o.image ? await images.get(o.image) : null;
  const picMap = pic ? coverTexture(pic, aspect) : placeholderTexture(o.placeholder || 'Your photo here', aspect);
  const block = new THREE.Group();
  block.position.y = L.outerCy;
  g.add(block);

  if (o.frame === 'polaroid') {
    const paper = new THREE.MeshStandardMaterial({ color: 0xf7f5ef, roughness: 0.75 });
    block.add(shadowy(new THREE.Mesh(new THREE.BoxGeometry(L.outerW, L.outerH, 0.006), paper))).position.z = 0.005;
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(L.picW, L.picH), new THREE.MeshStandardMaterial({ map: picMap, roughness: 0.35 }));
    photo.position.set(0, L.picDy, 0.0085);
    block.add(shadowy(photo, false));
    if (o.caption.trim()) {
      const capH = L.border.bottom * 0.7;
      const capW = L.picW;
      const font = FONTS.hand.css;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(capW, capH), new THREE.MeshStandardMaterial({
        map: textCanvas([{ text: o.caption, size: 110, weight: 400 }], { w: 1024, h: Math.round((1024 * capH) / capW), bg: '#f7f5ef', color: '#2a2a3a', font }),
        roughness: 0.8,
      }));
      m.position.set(0, -L.outerH / 2 + L.border.bottom / 2, 0.0085);
      block.add(shadowy(m, false));
    }
    return g;
  }

  if (o.frame === 'canvas') {
    // gallery wrap: the picture on the front of a 4 cm deep stretcher, darker sides
    const depth = 0.04;
    const side = new THREE.MeshStandardMaterial({ color: 0x3a3631, roughness: 0.85 });
    const front = new THREE.MeshStandardMaterial({ map: picMap, roughness: 0.75 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(L.outerW, L.outerH, depth), [side, side, side, side, front, side]);
    box.position.z = depth / 2;
    block.add(shadowy(box));
  } else {
    const fm = frameMaterial(o);
    const back = new THREE.Mesh(new THREE.BoxGeometry(L.outerW, L.outerH, 0.02), o.frame === 'none' ? new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.8 }) : fm);
    back.position.z = 0.01;
    block.add(shadowy(back));
    const f = L.frameW;
    if (f > 0) {
      const depth = o.frame === 'gold' || o.frame === 'silver' ? 0.055 : 0.06;
      const innerW = L.picW + 2 * L.mat, innerH = L.picH + 2 * L.mat;
      const round = o.frame === 'gold' || o.frame === 'silver' || o.frame === 'wood';
      const bars: [number, number, number, number][] = [
        [innerW + 2 * f, f, 0, innerH / 2 + f / 2], [innerW + 2 * f, f, 0, -innerH / 2 - f / 2],
        [f, innerH, -innerW / 2 - f / 2, 0], [f, innerH, innerW / 2 + f / 2, 0],
      ];
      for (const [bw, bh, x, y] of bars) {
        const geo = round ? new RoundedBoxGeometry(bw, bh, depth, 2, Math.min(f * 0.3, 0.015)) : new THREE.BoxGeometry(bw, bh, depth);
        const m = new THREE.Mesh(geo, fm);
        m.position.set(x, y, depth / 2);
        block.add(shadowy(m));
      }
    }
    if (L.mat > 0) {
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(L.picW + 2 * L.mat, L.picH + 2 * L.mat), new THREE.MeshStandardMaterial({ color: o.matColor, roughness: 0.92 }));
      mat.position.z = 0.0205;
      block.add(shadowy(mat, false));
    }
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(L.picW, L.picH), new THREE.MeshStandardMaterial({ map: picMap, roughness: o.frame === 'none' ? 0.55 : 0.45 }));
    photo.position.z = 0.023;
    block.add(shadowy(photo, false));
  }

  if (L.plateH > 0) {
    const plate = new THREE.Mesh(new RoundedBoxGeometry(L.plateW, L.plateH, 0.02, 2, 0.006), new THREE.MeshStandardMaterial({
      map: textCanvas([{ text: o.caption, size: 120, weight: 700 }], {
        w: Math.round((256 * L.plateW) / L.plateH), h: 256, bg: '#f4efe2', color: '#3a3128', font: FONTS.sans.css,
      }),
      roughness: 0.4, metalness: 0.2,
    }));
    plate.position.set(0, L.plateCy, 0.012);
    g.add(shadowy(plate));
  }
  return g;
}

/** Draws a picture with a die-cut border of `b` pixels around its shape. */
function dieCut(p: Picture, w: number, h: number, b: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w + 2 * b);
  c.height = Math.ceil(h + 2 * b);
  const g = c.getContext('2d')!;
  if (b > 0.5) {
    // the outline: the shape stamped around a circle, then filled with the border colour
    const steps = 32;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      g.drawImage(p, b + Math.cos(a) * b, b + Math.sin(a) * b, w, h);
    }
    g.drawImage(p, b, b, w, h);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
  }
  g.drawImage(p, b, b, w, h);
  return c;
}

async function buildSticker(o: StickerOrnament, images: ImageProvider): Promise<THREE.Group> {
  const g = new THREE.Group();
  const { w, h } = ornamentSize(o);
  const pic = o.image ? await images.get(o.image) : null;
  let map: THREE.Texture;
  if (pic) {
    const px = 1024 / w; // pixels per metre
    const b = stickerBorder(o);
    map = tex(dieCut(pic, (w - 2 * b) * px, (h - 2 * b) * px, b * px, o.borderColor));
  } else {
    map = placeholderTexture('Sticker', w / h);
  }
  const mat = new THREE.MeshPhysicalMaterial({
    map, alphaTest: 0.5, roughness: o.gloss ? 0.28 : 0.7, clearcoat: o.gloss ? 0.7 : 0, clearcoatRoughness: 0.15, side: THREE.FrontSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.z = 0.006;
  g.add(shadowy(m));
  return g;
}

function buildText(o: TextOrnament): THREE.Group {
  const g = new THREE.Group();
  const { w, h } = ornamentSize(o);
  const face = tex(drawText(o, 'face'));
  const geo = new THREE.PlaneGeometry(w, h);
  if (o.style === 'paint') {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: face, transparent: true, roughness: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.z = 0.002;
    m.receiveShadow = true;
    g.add(m);
  } else if (o.style === 'raised') {
    // cut-out letters 3.5 cm off the wall: a face that casts letter-shaped shadows, and darker layers
    // behind it that read as the sides of the letters
    const side = tex(drawText(o, 'side'));
    const sideMat = new THREE.MeshStandardMaterial({ map: side, alphaTest: 0.5, roughness: 0.6 });
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(geo, sideMat);
      s.position.z = 0.005 + i * 0.005;
      s.receiveShadow = true;
      g.add(s);
    }
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: face, alphaTest: 0.5, roughness: 0.45, metalness: 0.05 }));
    m.position.z = 0.036;
    g.add(shadowy(m));
  } else {
    // neon: a bright tube face (HDR emissive, so bloom picks it up) and a soft halo on the wall
    const glow = tex(drawText(o, 'glow', 1024));
    const halo = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: glow, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    halo.position.z = 0.004;
    g.add(halo);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 2.6, alphaMap: face, transparent: true, depthWrite: false, alphaTest: 0.05,
    }));
    m.position.z = 0.03;
    g.add(m);
  }
  return g;
}

export async function buildOrnament(o: Ornament, images: ImageProvider): Promise<THREE.Group> {
  const inner = o.kind === 'photo' ? await buildPhoto(o, images) : o.kind === 'sticker' ? await buildSticker(o, images) : buildText(o);
  const g = new THREE.Group();
  g.add(inner);
  g.name = o.id;
  return g;
}

export function placeOrnament(g: THREE.Object3D, o: Pick<Ornament, 'x' | 'y' | 'rotation'>): void {
  g.position.set(o.x, o.y, 0);
  g.rotation.set(0, 0, (o.rotation * Math.PI) / 180);
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture && !v.userData['shared']) v.dispose();
      mat.dispose();
    }
  });
}
