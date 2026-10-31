/**
 * Shared GPU resource registry (ARCHITECTURE.md §5.3, §8.4).
 *
 * Every geometry, material, and texture is created once under a string key
 * and reused, which keeps draw-call batching possible and memory bounded.
 * Textures are procedural (R5/R6): there are no asset files to load, so
 * there can be no missing-file references.
 */

import {
  CanvasTexture,
  DataTexture,
  LinearMipmapLinearFilter,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { generateTilingNoiseRGBA } from "./proceduralTextures.ts";

export interface AssetStats {
  geometries: number;
  materials: number;
  textures: number;
  /** Estimated texture memory in bytes (RGBA8 + full mip chain). */
  textureBytes: number;
}

export interface ProceduralTextureOptions {
  /** Colour data (sRGB) or data/masks (linear). Default true. */
  srgb?: boolean;
  repeat?: boolean;
}

export class AssetManager {
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly materials = new Map<string, Material>();
  private readonly textures = new Map<string, Texture>();
  private readonly textureBytes = new Map<string, number>();

  geometry<T extends BufferGeometry>(key: string, create: () => T): T {
    const existing = this.geometries.get(key);
    if (existing) return existing as T;
    const created = create();
    created.name ||= key;
    this.geometries.set(key, created);
    return created;
  }

  material<T extends Material>(key: string, create: () => T): T {
    const existing = this.materials.get(key);
    if (existing) return existing as T;
    const created = create();
    created.name ||= key;
    this.materials.set(key, created);
    return created;
  }

  texture<T extends Texture>(key: string, create: () => T): T {
    const existing = this.textures.get(key);
    if (existing) return existing as T;
    const created = create();
    created.name ||= key;
    this.textures.set(key, created);
    const image = created.image as { width?: number; height?: number } | null;
    const w = image?.width ?? 0;
    const h = image?.height ?? 0;
    // ×4 bytes per texel, ×4/3 for the mip chain.
    this.textureBytes.set(key, Math.round(w * h * 4 * (created.generateMipmaps ? 4 / 3 : 1)));
    return created;
  }

  has(key: string): boolean {
    return this.geometries.has(key) || this.materials.has(key) || this.textures.has(key);
  }

  /**
   * Seamless tiling value-noise texture (RGBA8), generated from a seed.
   * `tint` maps a noise value in [0,1] to RGB bytes.
   */
  noiseTexture(
    key: string,
    size: number,
    seed: number,
    tint: (n: number, x: number, y: number) => readonly [number, number, number],
    options: ProceduralTextureOptions = {},
  ): DataTexture {
    return this.texture(key, () => {
      const data = generateTilingNoiseRGBA(size, seed, tint);
      const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
      configureTexture(tex, options);
      tex.needsUpdate = true;
      return tex;
    });
  }

  /** Texture drawn once with the 2D canvas API (e.g. impostors, icons on sprites, map). */
  canvasTexture(
    key: string,
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
    options: ProceduralTextureOptions = {},
  ): CanvasTexture {
    return this.texture(key, () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`AssetManager: 2D canvas unavailable for texture "${key}"`);
      draw(ctx, width, height);
      const tex = new CanvasTexture(canvas);
      configureTexture(tex, options);
      return tex;
    });
  }

  /** Disposes and forgets one resource of any kind. */
  release(key: string): void {
    this.geometries.get(key)?.dispose();
    this.materials.get(key)?.dispose();
    this.textures.get(key)?.dispose();
    this.geometries.delete(key);
    this.materials.delete(key);
    this.textures.delete(key);
    this.textureBytes.delete(key);
  }

  stats(): AssetStats {
    let bytes = 0;
    for (const b of this.textureBytes.values()) bytes += b;
    return {
      geometries: this.geometries.size,
      materials: this.materials.size,
      textures: this.textures.size,
      textureBytes: bytes,
    };
  }

  disposeAll(): void {
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.textureBytes.clear();
  }
}

function configureTexture(tex: Texture, options: ProceduralTextureOptions): void {
  const repeat = options.repeat ?? true;
  tex.wrapS = tex.wrapT = repeat ? RepeatWrapping : tex.wrapS;
  tex.colorSpace = (options.srgb ?? true) ? SRGBColorSpace : NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 1;
}

