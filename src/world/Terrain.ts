/**
 * Chunk-based terrain manager with 3 LOD rings, Web Worker geometry streaming,
 * time-sliced GPU uploads, per-LOD geometry pooling, and blended vertex-colour
 * terrain materials (PRD §8, §19; ARCHITECTURE.md §6.3, R9).
 */

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type Material,
  type Scene,
} from "three";
import type { AssetManager } from "../core/AssetManager.ts";
import type { GraphicsPreset } from "../core/GraphicsSettings.ts";
import {
  buildChunkGeometry,
  type ChunkGeometryData,
  type ChunkLod,
  type ChunkWorkerRequest,
  type ChunkWorkerResponse,
} from "./ChunkWorker.ts";
import type { Heightfield } from "./Heightfield.ts";
import { CHUNK_SIZE, WORLD_HALF } from "./WorldGenerator.ts";

const MIN_CHUNK = -WORLD_HALF / CHUNK_SIZE; // -16
const MAX_CHUNK = WORLD_HALF / CHUNK_SIZE - 1; // 15
const MAX_IN_FLIGHT = 6;

export interface ChunkTarget {
  readonly key: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly lod: ChunkLod;
  readonly distSq: number;
}

export interface TerrainStats {
  readonly activeChunks: number;
  readonly pendingChunks: number;
  readonly pooledGeometries: number;
  readonly lastUploadMs: number;
}

export interface TerrainOptions {
  /** Use Web Worker when available in browser. Default true. */
  useWorker?: boolean;
  /** Maximum chunk GPU uploads per update() call. Default 2. */
  maxUploadsPerFrame?: number;
}

interface ActiveChunk {
  readonly key: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  lod: ChunkLod;
  mesh: Mesh;
}

/**
 * Determines the LOD ring (0 = 32×32, 1 = 16×16, 2 = 8×8) for a chunk offset
 * `(dx, dz)` from the focus chunk, or `null` if outside `viewDistanceChunks`.
 */
export function selectChunkLod(dx: number, dz: number, viewDistanceChunks: number): ChunkLod | null {
  const cheb = Math.max(Math.abs(dx), Math.abs(dz));
  if (cheb > viewDistanceChunks) return null;
  if (cheb <= 1) return 0;
  const lod1Radius = Math.max(2, Math.floor(viewDistanceChunks * 0.5));
  if (cheb <= lod1Radius) return 1;
  return 2;
}

/**
 * Returns all visible chunks around world coordinates `(focusX, focusZ)` sorted
 * from nearest to farthest so the ground under the player always loads first.
 */
export function planVisibleChunks(
  focusX: number,
  focusZ: number,
  viewDistanceChunks: number,
): ChunkTarget[] {
  const fcx = Math.floor(focusX / CHUNK_SIZE);
  const fcz = Math.floor(focusZ / CHUNK_SIZE);
  const targets: ChunkTarget[] = [];

  const minCx = Math.max(MIN_CHUNK, fcx - viewDistanceChunks);
  const maxCx = Math.min(MAX_CHUNK, fcx + viewDistanceChunks);
  const minCz = Math.max(MIN_CHUNK, fcz - viewDistanceChunks);
  const maxCz = Math.min(MAX_CHUNK, fcz + viewDistanceChunks);

  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const lod = selectChunkLod(cx - fcx, cz - fcz, viewDistanceChunks);
      if (lod === null) continue;
      const centerX = (cx + 0.5) * CHUNK_SIZE;
      const centerZ = (cz + 0.5) * CHUNK_SIZE;
      const dx = centerX - focusX;
      const dz = centerZ - focusZ;
      targets.push({
        key: `${cx},${cz}`,
        chunkX: cx,
        chunkZ: cz,
        lod,
        distSq: dx * dx + dz * dz,
      });
    }
  }

  targets.sort((a, b) => a.distSq - b.distSq);
  return targets;
}

export class Terrain {
  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly heightfield: Heightfield;
  private readonly root = new Group();
  private readonly active = new Map<string, ActiveChunk>();
  private readonly desired = new Map<string, ChunkTarget>();
  private readonly buildQueue: ChunkTarget[] = [];
  private readonly readyQueue: ChunkGeometryData[] = [];
  private readonly inFlight = new Map<number, string>();
  private readonly inFlightKeys = new Set<string>();
  private readonly geometryPool: Record<ChunkLod, BufferGeometry[]> = { 0: [], 1: [], 2: [] };
  private readonly meshPool: Mesh[] = [];

  private worker: Worker | null = null;
  private nextRequestId = 1;
  private viewDistanceChunks: number;
  private standardMaterials: boolean;
  private material: Material;
  private lastFocusChunkX = Number.NaN;
  private lastFocusChunkZ = Number.NaN;
  private lastViewDistance = -1;
  private lastUploadMs = 0;
  private readonly maxUploadsPerFrame: number;

  constructor(
    scene: Scene,
    assets: AssetManager,
    heightfield: Heightfield,
    preset: GraphicsPreset,
    options: TerrainOptions = {},
  ) {
    this.scene = scene;
    this.assets = assets;
    this.heightfield = heightfield;
    this.viewDistanceChunks = preset.viewDistanceChunks;
    this.standardMaterials = preset.standardMaterials;
    this.maxUploadsPerFrame = options.maxUploadsPerFrame ?? 2;
    this.material = this.createTerrainMaterial(this.standardMaterials);

    this.root.name = "Terrain";
    this.scene.add(this.root);

    const canUseWorker =
      (options.useWorker ?? true) &&
      typeof Worker === "function" &&
      typeof window !== "undefined";
    if (canUseWorker) {
      try {
        this.worker = new Worker(new URL("./ChunkWorker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (event: MessageEvent<ChunkWorkerResponse>) => {
          const msg = event.data;
          if (!msg || msg.type !== "built") return;
          const jobKey = this.inFlight.get(msg.requestId);
          this.inFlight.delete(msg.requestId);
          if (jobKey !== undefined) this.inFlightKeys.delete(jobKey);
          const target = this.desired.get(`${msg.data.chunkX},${msg.data.chunkZ}`);
          if (target && target.lod === msg.data.lod) {
            this.readyQueue.push(msg.data);
          }
        };
      } catch {
        this.worker = null;
      }
    }
  }

  /** Updates graphics preset (view distance + Lambert/Standard material tier). */
  applyPreset(preset: GraphicsPreset): void {
    this.viewDistanceChunks = preset.viewDistanceChunks;
    if (preset.standardMaterials !== this.standardMaterials) {
      this.standardMaterials = preset.standardMaterials;
      this.material = this.createTerrainMaterial(this.standardMaterials);
      for (const chunk of this.active.values()) {
        chunk.mesh.material = this.material;
      }
    }
  }

  /**
   * Streams terrain chunks around `(focusX, focusZ)` within a per-frame CPU
   * budget (`budgetMs`, default 2.2 ms).
   */
  update(focusX: number, focusZ: number, budgetMs = 2.2): void {
    const fcx = Math.floor(focusX / CHUNK_SIZE);
    const fcz = Math.floor(focusZ / CHUNK_SIZE);

    if (
      fcx !== this.lastFocusChunkX ||
      fcz !== this.lastFocusChunkZ ||
      this.viewDistanceChunks !== this.lastViewDistance
    ) {
      this.lastFocusChunkX = fcx;
      this.lastFocusChunkZ = fcz;
      this.lastViewDistance = this.viewDistanceChunks;
      this.replan(focusX, focusZ);
    }

    // Dispatch pending requests to worker if available
    if (this.worker !== null) {
      while (this.inFlight.size < MAX_IN_FLIGHT && this.buildQueue.length > 0) {
        const next = this.buildQueue.shift()!;
        const current = this.active.get(next.key);
        if (current && current.lod === next.lod) continue;
        const jobKey = `${next.key}:${next.lod}`;
        if (this.inFlightKeys.has(jobKey)) continue;
        const requestId = this.nextRequestId++;
        this.inFlight.set(requestId, jobKey);
        this.inFlightKeys.add(jobKey);
        const req: ChunkWorkerRequest = {
          type: "build",
          requestId,
          seed: this.heightfield.seed,
          chunkX: next.chunkX,
          chunkZ: next.chunkZ,
          lod: next.lod,
        };
        this.worker.postMessage(req);
      }
    }

    // Time-sliced GPU upload (and synchronous fallback build when worker is inactive)
    const startMs = performance.now();
    let uploaded = 0;

    while (uploaded < this.maxUploadsPerFrame) {
      let data = this.readyQueue.shift();
      if (!data && this.worker === null && this.buildQueue.length > 0) {
        const next = this.buildQueue.shift()!;
        const current = this.active.get(next.key);
        if (current && current.lod === next.lod) continue;
        data = buildChunkGeometry(this.heightfield, next.chunkX, next.chunkZ, next.lod);
      }
      if (!data) break;

      const key = `${data.chunkX},${data.chunkZ}`;
      const target = this.desired.get(key);
      if (!target || target.lod !== data.lod) continue;

      this.uploadChunk(key, data);
      uploaded++;

      if (performance.now() - startMs >= budgetMs) break;
    }

    this.lastUploadMs = performance.now() - startMs;
  }

  /**
   * Synchronously builds the closest `count` chunks around `(focusX, focusZ)`
   * during the loading screen so the player never spawns over empty air.
   */
  warmUp(focusX: number, focusZ: number, count = 9): void {
    this.lastFocusChunkX = Math.floor(focusX / CHUNK_SIZE);
    this.lastFocusChunkZ = Math.floor(focusZ / CHUNK_SIZE);
    this.lastViewDistance = this.viewDistanceChunks;
    this.replan(focusX, focusZ);

    let built = 0;
    while (built < count && this.buildQueue.length > 0) {
      const next = this.buildQueue.shift()!;
      const current = this.active.get(next.key);
      if (current && current.lod === next.lod) continue;
      const data = buildChunkGeometry(this.heightfield, next.chunkX, next.chunkZ, next.lod);
      this.uploadChunk(next.key, data);
      built++;
    }
  }

  getStats(): TerrainStats {
    const pooledGeometries =
      this.geometryPool[0].length + this.geometryPool[1].length + this.geometryPool[2].length;
    return {
      activeChunks: this.active.size,
      pendingChunks: this.buildQueue.length + this.inFlight.size + this.readyQueue.length,
      pooledGeometries,
      lastUploadMs: this.lastUploadMs,
    };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const chunk of this.active.values()) {
      this.root.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    this.active.clear();
    for (const lod of [0, 1, 2] as const) {
      for (const geo of this.geometryPool[lod]) geo.dispose();
      this.geometryPool[lod].length = 0;
    }
    this.meshPool.length = 0;
    this.scene.remove(this.root);
  }

  private replan(focusX: number, focusZ: number): void {
    const targets = planVisibleChunks(focusX, focusZ, this.viewDistanceChunks);
    this.desired.clear();
    for (const t of targets) {
      this.desired.set(t.key, t);
    }

    // Unload chunks that left the view distance
    for (const [key, chunk] of this.active) {
      if (!this.desired.has(key)) {
        this.unloadChunk(key, chunk);
      }
    }

    // Rebuild priority queue for missing or LOD-changed chunks
    this.buildQueue.length = 0;
    for (const t of targets) {
      const existing = this.active.get(t.key);
      if (!existing || existing.lod !== t.lod) {
        this.buildQueue.push(t);
      }
    }
  }

  private uploadChunk(key: string, data: ChunkGeometryData): void {
    const existing = this.active.get(key);
    if (existing) {
      // Return previous LOD geometry to pool and swap in the new one
      const oldGeo = existing.mesh.geometry;
      this.geometryPool[existing.lod].push(oldGeo);
      existing.mesh.geometry = this.acquireGeometry(data);
      existing.lod = data.lod;
      return;
    }

    const geometry = this.acquireGeometry(data);
    const mesh = this.meshPool.pop() ?? new Mesh(geometry, this.material);
    mesh.geometry = geometry;
    mesh.material = this.material;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = true;
    this.root.add(mesh);
    this.active.set(key, {
      key,
      chunkX: data.chunkX,
      chunkZ: data.chunkZ,
      lod: data.lod,
      mesh,
    });
  }

  private unloadChunk(key: string, chunk: ActiveChunk): void {
    this.root.remove(chunk.mesh);
    this.geometryPool[chunk.lod].push(chunk.mesh.geometry);
    this.meshPool.push(chunk.mesh);
    this.active.delete(key);
  }

  private acquireGeometry(data: ChunkGeometryData): BufferGeometry {
    const pooled = this.geometryPool[data.lod].pop();
    let geo: BufferGeometry;

    if (pooled) {
      geo = pooled;
      const posAttr = geo.getAttribute("position") as BufferAttribute;
      const normAttr = geo.getAttribute("normal") as BufferAttribute;
      const colAttr = geo.getAttribute("color") as BufferAttribute;
      const uvAttr = geo.getAttribute("uv") as BufferAttribute;
      const idxAttr = geo.getIndex()!;

      (posAttr.array as Float32Array).set(data.positions);
      posAttr.needsUpdate = true;
      (normAttr.array as Float32Array).set(data.normals);
      normAttr.needsUpdate = true;
      (colAttr.array as Float32Array).set(data.colors);
      colAttr.needsUpdate = true;
      (uvAttr.array as Float32Array).set(data.uvs);
      uvAttr.needsUpdate = true;
      (idxAttr.array as Uint16Array).set(data.indices);
      idxAttr.needsUpdate = true;
    } else {
      geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(data.positions, 3));
      geo.setAttribute("normal", new BufferAttribute(data.normals, 3));
      geo.setAttribute("color", new BufferAttribute(data.colors, 3));
      geo.setAttribute("uv", new BufferAttribute(data.uvs, 2));
      geo.setIndex(new BufferAttribute(data.indices, 1));
    }

    // Set analytical bounding box & sphere (faster than scanning 1,221 vertices)
    const minX = data.chunkX * CHUNK_SIZE;
    const minZ = data.chunkZ * CHUNK_SIZE;
    const maxX = minX + CHUNK_SIZE;
    const maxZ = minZ + CHUNK_SIZE;
    if (!geo.boundingBox) geo.boundingBox = new Box3();
    geo.boundingBox.min.set(minX, data.minY, minZ);
    geo.boundingBox.max.set(maxX, data.maxY, maxZ);

    if (!geo.boundingSphere) geo.boundingSphere = new Sphere();
    const midY = (data.minY + data.maxY) * 0.5;
    const halfY = (data.maxY - data.minY) * 0.5;
    geo.boundingSphere.center.set(minX + CHUNK_SIZE * 0.5, midY, minZ + CHUNK_SIZE * 0.5);
    geo.boundingSphere.radius = Math.hypot(CHUNK_SIZE * 0.70710678, halfY);

    return geo;
  }

  private createTerrainMaterial(standard: boolean): Material {
    const tier = standard ? "std" : "lam";
    return this.assets.material(`p3.terrain.${tier}`, () => {
      // Subtle tiling detail map (neutral greyscale grain around 1.0) so vertex colours stay accurate
      const detailMap = this.assets.noiseTexture("p3.tex.terrainDetail", 128, 4099, (n) => {
        const v = Math.round(215 + n * 40);
        return [v, v, v];
      });
      return standard
        ? new MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            map: detailMap,
            roughness: 0.92,
            metalness: 0.0,
          })
        : new MeshLambertMaterial({
            color: 0xffffff,
            vertexColors: true,
            map: detailMap,
          });
    });
  }
}

// Keep Vector3 referenced for bundle tree-shaking consistency
export const TERRAIN_UP = new Vector3(0, 1, 0);
