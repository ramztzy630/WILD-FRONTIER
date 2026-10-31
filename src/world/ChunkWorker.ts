/**
 * Terrain chunk geometry builder + Web Worker entry point
 * (ARCHITECTURE.md §6.3, R9).
 *
 * Exports `buildChunkGeometry` as a pure function so unit tests and fallback
 * main-thread builds share the exact same implementation as the worker.
 */

import { Heightfield } from "./Heightfield.ts";
import { CHUNK_SIZE } from "./WorldGenerator.ts";

export type ChunkLod = 0 | 1 | 2;

export const LOD_SEGMENTS: Readonly<Record<ChunkLod, number>> = {
  0: 32,
  1: 16,
  2: 8,
};

/** Vertical skirt drop in metres along chunk edges to hide LOD seams. */
export const SKIRT_DEPTH = 8.0;

export interface ChunkGeometryData {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly lod: ChunkLod;
  readonly segments: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array;
  readonly minY: number;
  readonly maxY: number;
}

export interface ChunkWorkerRequest {
  readonly type: "build";
  readonly requestId: number;
  readonly seed: number;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly lod: ChunkLod;
}

export interface ChunkWorkerResponse {
  readonly type: "built";
  readonly requestId: number;
  readonly data: ChunkGeometryData;
}

/**
 * Builds vertex attributes and indices for one 64 m × 64 m terrain chunk,
 * including 4 edge skirts so adjacent chunks of differing LODs never show gaps.
 */
export function buildChunkGeometry(
  heightfield: Heightfield,
  chunkX: number,
  chunkZ: number,
  lod: ChunkLod,
): ChunkGeometryData {
  const S = LOD_SEGMENTS[lod];
  const stride = S + 1;
  const topVerts = stride * stride;
  const skirtVerts = 4 * stride;
  const totalVerts = topVerts + skirtVerts;
  const totalIndices = 6 * S * S + 4 * 6 * S;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint16Array(totalIndices);

  const originX = chunkX * CHUNK_SIZE;
  const originZ = chunkZ * CHUNK_SIZE;
  const step = CHUNK_SIZE / S;
  const uvScale = 1 / 8; // 8 m per detail-texture tile

  let minY = Infinity;
  let maxY = -Infinity;

  // 1. Top grid vertices
  let v = 0;
  for (let row = 0; row <= S; row++) {
    const wz = originZ + row * step;
    for (let col = 0; col <= S; col++) {
      const wx = originX + col * step;
      const sample = heightfield.sample(wx, wz);
      const p3 = v * 3;
      const p2 = v * 2;
      positions[p3] = wx;
      positions[p3 + 1] = sample.height;
      positions[p3 + 2] = wz;

      normals[p3] = sample.normalX;
      normals[p3 + 1] = sample.normalY;
      normals[p3 + 2] = sample.normalZ;

      colors[p3] = sample.colorR;
      colors[p3 + 1] = sample.colorG;
      colors[p3 + 2] = sample.colorB;

      uvs[p2] = wx * uvScale;
      uvs[p2 + 1] = wz * uvScale;

      if (sample.height < minY) minY = sample.height;
      if (sample.height > maxY) maxY = sample.height;
      v++;
    }
  }

  // 2. Top grid triangles (CCW looking from +Y)
  let idx = 0;
  for (let row = 0; row < S; row++) {
    for (let col = 0; col < S; col++) {
      const i00 = row * stride + col;
      const i10 = i00 + 1;
      const i01 = (row + 1) * stride + col;
      const i11 = i01 + 1;

      indices[idx++] = i00;
      indices[idx++] = i01;
      indices[idx++] = i10;

      indices[idx++] = i10;
      indices[idx++] = i01;
      indices[idx++] = i11;
    }
  }

  // 3. Edge skirts (North row=0, East col=S, South row=S, West col=0)
  // Ordered clockwise around the perimeter so every skirt quad faces outward.
  const addSkirtEdge = (topIndexAt: (stepIdx: number) => number): void => {
    const baseSkirtVert = v;
    for (let i = 0; i <= S; i++) {
      const topIdx = topIndexAt(i);
      const t3 = topIdx * 3;
      const t2 = topIdx * 2;
      const s3 = v * 3;
      const s2 = v * 2;

      positions[s3] = positions[t3] as number;
      positions[s3 + 1] = (positions[t3 + 1] as number) - SKIRT_DEPTH;
      positions[s3 + 2] = positions[t3 + 2] as number;

      normals[s3] = normals[t3] as number;
      normals[s3 + 1] = normals[t3 + 1] as number;
      normals[s3 + 2] = normals[t3 + 2] as number;

      colors[s3] = (colors[t3] as number) * 0.85;
      colors[s3 + 1] = (colors[t3 + 1] as number) * 0.85;
      colors[s3 + 2] = (colors[t3 + 2] as number) * 0.85;

      uvs[s2] = uvs[t2] as number;
      uvs[s2 + 1] = uvs[t2 + 1] as number;
      v++;
    }

    for (let i = 0; i < S; i++) {
      const topA = topIndexAt(i);
      const topB = topIndexAt(i + 1);
      const botA = baseSkirtVert + i;
      const botB = baseSkirtVert + i + 1;

      indices[idx++] = topA;
      indices[idx++] = topB;
      indices[idx++] = botA;

      indices[idx++] = topB;
      indices[idx++] = botB;
      indices[idx++] = botA;
    }
  };

  // North edge (row = 0, col 0 -> S)
  addSkirtEdge((i) => i);
  // East edge (col = S, row 0 -> S)
  addSkirtEdge((i) => i * stride + S);
  // South edge (row = S, col S -> 0)
  addSkirtEdge((i) => S * stride + (S - i));
  // West edge (col = 0, row S -> 0)
  addSkirtEdge((i) => (S - i) * stride);

  minY -= SKIRT_DEPTH;

  return {
    chunkX,
    chunkZ,
    lod,
    segments: S,
    positions,
    normals,
    colors,
    uvs,
    indices,
    minY,
    maxY,
  };
}

// --- Web Worker runtime message handler ----------------------------------

interface WorkerGlobal {
  document?: unknown;
  onmessage?: ((event: MessageEvent<ChunkWorkerRequest>) => void) | null;
  postMessage?: (message: ChunkWorkerResponse, transfer: Transferable[]) => void;
}

const workerScope = (typeof self !== "undefined" ? self : undefined) as WorkerGlobal | undefined;

if (workerScope && typeof workerScope.document === "undefined" && typeof workerScope.postMessage === "function") {
  let cachedHeightfield: Heightfield | null = null;

  workerScope.onmessage = (event: MessageEvent<ChunkWorkerRequest>): void => {
    const msg = event.data;
    if (!msg || msg.type !== "build") return;
    if (!cachedHeightfield || cachedHeightfield.seed !== (msg.seed >>> 0)) {
      cachedHeightfield = new Heightfield(msg.seed);
    }
    const data = buildChunkGeometry(cachedHeightfield, msg.chunkX, msg.chunkZ, msg.lod);
    workerScope.postMessage?.(
      {
        type: "built",
        requestId: msg.requestId,
        data,
      },
      [
        data.positions.buffer,
        data.normals.buffer,
        data.colors.buffer,
        data.uvs.buffer,
        data.indices.buffer,
      ],
    );
  };
}
