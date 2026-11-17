// The user's files (MIDI, photos, stickers, ball pictures), by asset id, with a cache of decoded
// pictures. Built-in stickers have ids "builtin:<name>" and live in public/stickers/.
import { assetDelete, assetGet, assetKeys, assetPut } from './db.ts';
import type { StoredAsset } from './db.ts';
import { newId } from '../core/project.ts';
import type { Picture, ImageProvider } from '../stage/ornament-mesh.ts';

export const BUILTIN_STICKERS = ['star', 'heart', 'note', 'bolt', 'sun', 'smile', 'crown', 'sparkle', 'flame', 'rainbow'] as const;

export function builtinUrl(id: string): string {
  return `${import.meta.env.BASE_URL}stickers/${id.slice('builtin:'.length)}.svg`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be read.'));
    img.src = url;
  });
}

export class AssetStore implements ImageProvider {
  #mem = new Map<string, StoredAsset>();
  #urls = new Map<string, string>();
  #images = new Map<string, Promise<Picture | null>>();

  /** Adds a file; returns its id. Pictures get their aspect. */
  async add(blob: Blob, name: string): Promise<StoredAsset> {
    const a: StoredAsset = { id: newId('a'), name, type: blob.type || guessType(name), blob };
    if (a.type.startsWith('image/')) {
      const img = await loadImage(this.#urlOf(a));
      a.aspect = (img.naturalWidth || img.width) / Math.max(1, img.naturalHeight || img.height);
      this.#images.set(a.id, Promise.resolve(img));
    }
    this.#mem.set(a.id, a);
    await assetPut(a);
    return a;
  }

  /** Puts an asset that comes from a project file. */
  async put(a: StoredAsset): Promise<void> {
    this.#mem.set(a.id, a);
    await assetPut(a);
  }

  async record(id: string): Promise<StoredAsset | null> {
    const m = this.#mem.get(id);
    if (m) return m;
    const a = await assetGet(id);
    if (a) this.#mem.set(id, a);
    return a ?? null;
  }

  async blob(id: string): Promise<Blob | null> {
    if (id.startsWith('builtin:')) {
      const r = await fetch(builtinUrl(id));
      return r.ok ? await r.blob() : null;
    }
    return (await this.record(id))?.blob ?? null;
  }

  #urlOf(a: StoredAsset): string {
    let u = this.#urls.get(a.id);
    if (!u) { u = URL.createObjectURL(a.blob); this.#urls.set(a.id, u); }
    return u;
  }

  async url(id: string): Promise<string | null> {
    if (id.startsWith('builtin:')) return builtinUrl(id);
    const a = await this.record(id);
    return a ? this.#urlOf(a) : null;
  }

  get(id: string): Promise<Picture | null> {
    let p = this.#images.get(id);
    if (!p) {
      p = this.url(id).then((u) => (u ? loadImage(u) : null)).catch(() => null);
      this.#images.set(id, p);
    }
    return p;
  }

  /** Deletes the stored files that no project uses. */
  async prune(keep: Set<string>): Promise<void> {
    const keys = (await assetKeys()) ?? [];
    for (const k of keys) if (typeof k === 'string' && !keep.has(k)) await assetDelete(k);
    for (const id of [...this.#mem.keys()]) if (!keep.has(id)) this.#mem.delete(id);
  }
}

function guessType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ({ mid: 'audio/midi', midi: 'audio/midi', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
