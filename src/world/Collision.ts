/**
 * Uniform spatial-hash collision system for static obstacles (circles &
 * oriented boxes) plus world-boundary soft-stop (PRD §6, §8;
 * ARCHITECTURE.md §6.2, §6.6).
 *
 * Pure, deterministic, and allocation-free inside queries.
 */

import { clamp, smoothstep } from "../core/math.ts";
import { BOUNDARY_MARGIN, WORLD_HALF } from "./WorldGenerator.ts";

export const DEFAULT_CELL_SIZE = 8;
export const BOUNDARY_HINT_MESSAGE = "The wilderness is impassable beyond here";

export interface CircleColliderSpec {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly minY?: number;
  readonly maxY?: number;
  readonly tag?: string;
  readonly chunkKey?: string;
}

export interface BoxColliderSpec {
  readonly x: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly yaw?: number;
  readonly minY?: number;
  readonly maxY?: number;
  readonly tag?: string;
  readonly chunkKey?: string;
}

interface InternalCollider {
  readonly id: number;
  readonly kind: "circle" | "box";
  readonly x: number;
  readonly z: number;
  readonly radius: number; // for box: bounding radius in XZ
  readonly halfX: number;
  readonly halfZ: number;
  readonly cos: number;
  readonly sin: number;
  readonly minY: number;
  readonly maxY: number;
  readonly tag: string;
  readonly chunkKey: string;
  readonly cells: string[];
  stamp: number;
}

export interface CollisionResult {
  x: number;
  z: number;
  hit: boolean;
  normalX: number;
  normalZ: number;
  colliderId: number;
  tag: string;
}

export interface SweepResult {
  hit: boolean;
  distance: number;
  normalX: number;
  normalZ: number;
  colliderId: number;
  tag: string;
}

export interface BoundaryResult {
  x: number;
  z: number;
  nearBoundary: boolean;
  clamped: boolean;
  pushX: number;
  pushZ: number;
  message: string;
}

export class CollisionWorld {
  readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly grid = new Map<string, InternalCollider[]>();
  private readonly byId = new Map<number, InternalCollider>();
  private readonly byChunk = new Map<string, number[]>();
  private readonly candidates: InternalCollider[] = [];
  private nextId = 1;
  private queryStamp = 1;

  private readonly resolveOut: CollisionResult = {
    x: 0,
    z: 0,
    hit: false,
    normalX: 0,
    normalZ: 0,
    colliderId: 0,
    tag: "",
  };

  private readonly sweepOut: SweepResult = {
    hit: false,
    distance: 0,
    normalX: 0,
    normalZ: 0,
    colliderId: 0,
    tag: "",
  };

  constructor(cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  get count(): number {
    return this.byId.size;
  }

  addCircle(spec: CircleColliderSpec): number {
    const id = this.nextId++;
    const col: InternalCollider = {
      id,
      kind: "circle",
      x: spec.x,
      z: spec.z,
      radius: spec.radius,
      halfX: spec.radius,
      halfZ: spec.radius,
      cos: 1,
      sin: 0,
      minY: spec.minY ?? -Infinity,
      maxY: spec.maxY ?? Infinity,
      tag: spec.tag ?? "obstacle",
      chunkKey: spec.chunkKey ?? "",
      cells: [],
      stamp: 0,
    };
    this.insert(col);
    return id;
  }

  addBox(spec: BoxColliderSpec): number {
    const id = this.nextId++;
    const yaw = spec.yaw ?? 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const boundR = Math.hypot(spec.halfX, spec.halfZ);
    const col: InternalCollider = {
      id,
      kind: "box",
      x: spec.x,
      z: spec.z,
      radius: boundR,
      halfX: spec.halfX,
      halfZ: spec.halfZ,
      cos,
      sin,
      minY: spec.minY ?? -Infinity,
      maxY: spec.maxY ?? Infinity,
      tag: spec.tag ?? "structure",
      chunkKey: spec.chunkKey ?? "",
      cells: [],
      stamp: 0,
    };
    this.insert(col);
    return id;
  }

  remove(id: number): boolean {
    const col = this.byId.get(id);
    if (!col) return false;
    for (let i = 0; i < col.cells.length; i++) {
      const key = col.cells[i]!;
      const bucket = this.grid.get(key);
      if (!bucket) continue;
      const idx = bucket.indexOf(col);
      if (idx !== -1) bucket.splice(idx, 1);
      if (bucket.length === 0) this.grid.delete(key);
    }
    this.byId.delete(id);
    return true;
  }

  /** Removes every collider registered under `chunkKey`. Returns count removed. */
  removeByChunk(chunkKey: string): number {
    const ids = this.byChunk.get(chunkKey);
    if (!ids) return 0;
    let removed = 0;
    for (let i = 0; i < ids.length; i++) {
      if (this.remove(ids[i]!)) removed++;
    }
    this.byChunk.delete(chunkKey);
    return removed;
  }

  clear(): void {
    this.grid.clear();
    this.byId.clear();
    this.byChunk.clear();
  }

  /**
   * Resolves XZ overlaps for a vertical cylinder/capsule of radius `radius`
   * spanning `[yMin, yMax]`. Reuses and returns an internal result object.
   */
  resolveCircle(
    x: number,
    z: number,
    radius: number,
    yMin = -Infinity,
    yMax = Infinity,
  ): CollisionResult {
    let px = x;
    let pz = z;
    let anyHit = false;
    let lastNx = 0;
    let lastNz = 0;
    let lastId = 0;
    let lastTag = "";

    const searchPad = radius + 4.0;
    this.gatherCandidates(px - searchPad, pz - searchPad, px + searchPad, pz + searchPad);

    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let i = 0; i < this.candidates.length; i++) {
        const c = this.candidates[i]!;
        if (yMax < c.minY || yMin > c.maxY) continue;

        if (c.kind === "circle") {
          const dx = px - c.x;
          const dz = pz - c.z;
          const rSum = radius + c.radius;
          const dSq = dx * dx + dz * dz;
          if (dSq < rSum * rSum) {
            let nx = 1;
            let nz = 0;
            let pen = rSum;
            if (dSq > 1e-12) {
              const d = Math.sqrt(dSq);
              nx = dx / d;
              nz = dz / d;
              pen = rSum - d;
            }
            px += nx * pen;
            pz += nz * pen;
            anyHit = true;
            moved = true;
            lastNx = nx;
            lastNz = nz;
            lastId = c.id;
            lastTag = c.tag;
          }
        } else {
          // Oriented box in XZ
          const rx = px - c.x;
          const rz = pz - c.z;
          const lx = rx * c.cos + rz * c.sin;
          const lz = -rx * c.sin + rz * c.cos;

          const insideX = Math.abs(lx) < c.halfX;
          const insideZ = Math.abs(lz) < c.halfZ;
          let lnx = 0;
          let lnz = 0;
          let pen = 0;

          if (insideX && insideZ) {
            const dxFace = c.halfX - Math.abs(lx);
            const dzFace = c.halfZ - Math.abs(lz);
            if (dxFace < dzFace) {
              lnx = lx >= 0 ? 1 : -1;
              pen = dxFace + radius;
            } else {
              lnz = lz >= 0 ? 1 : -1;
              pen = dzFace + radius;
            }
          } else {
            const cx = clamp(lx, -c.halfX, c.halfX);
            const cz = clamp(lz, -c.halfZ, c.halfZ);
            const dlx = lx - cx;
            const dlz = lz - cz;
            const dSq = dlx * dlx + dlz * dlz;
            if (dSq < radius * radius) {
              const d = Math.sqrt(dSq) || 1e-6;
              lnx = dlx / d;
              lnz = dlz / d;
              pen = radius - d;
            }
          }

          if (pen > 0) {
            const nx = lnx * c.cos - lnz * c.sin;
            const nz = lnx * c.sin + lnz * c.cos;
            px += nx * pen;
            pz += nz * pen;
            anyHit = true;
            moved = true;
            lastNx = nx;
            lastNz = nz;
            lastId = c.id;
            lastTag = c.tag;
          }
        }
      }
      if (!moved) break;
    }

    const out = this.resolveOut;
    out.x = px;
    out.z = pz;
    out.hit = anyHit;
    out.normalX = lastNx;
    out.normalZ = lastNz;
    out.colliderId = lastId;
    out.tag = lastTag;
    return out;
  }

  /**
   * Sweeps a circle of `radius` from `(ox, oz)` along `(dx, dz)` up to `maxDist`.
   * Used for collision-aware camera raycasting and AI steering.
   */
  sweepCircle(
    ox: number,
    oz: number,
    dx: number,
    dz: number,
    maxDist: number,
    radius: number,
    yMin = -Infinity,
    yMax = Infinity,
  ): SweepResult {
    const len = Math.hypot(dx, dz) || 1;
    const ndx = dx / len;
    const ndz = dz / len;
    const ex = ox + ndx * maxDist;
    const ez = oz + ndz * maxDist;
    const pad = radius + 2.0;
    this.gatherCandidates(
      Math.min(ox, ex) - pad,
      Math.min(oz, ez) - pad,
      Math.max(ox, ex) + pad,
      Math.max(oz, ez) + pad,
    );

    let bestDist = maxDist;
    let hit = false;
    let bestNx = 0;
    let bestNz = 0;
    let bestId = 0;
    let bestTag = "";

    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i]!;
      if (yMax < c.minY || yMin > c.maxY) continue;

      if (c.kind === "circle") {
        const rSum = c.radius + radius;
        const fx = ox - c.x;
        const fz = oz - c.z;
        const b = fx * ndx + fz * ndz;
        const cVal = fx * fx + fz * fz - rSum * rSum;
        if (cVal <= 0) {
          const d = Math.hypot(fx, fz) || 1;
          bestDist = 0;
          hit = true;
          bestNx = fx / d;
          bestNz = fz / d;
          bestId = c.id;
          bestTag = c.tag;
          break;
        }
        const disc = b * b - cVal;
        if (disc >= 0) {
          const t = -b - Math.sqrt(disc);
          if (t >= 0 && t < bestDist) {
            bestDist = t;
            hit = true;
            const hx = ox + ndx * t - c.x;
            const hz = oz + ndz * t - c.z;
            const hd = Math.hypot(hx, hz) || 1;
            bestNx = hx / hd;
            bestNz = hz / hd;
            bestId = c.id;
            bestTag = c.tag;
          }
        }
      } else {
        // Slab test in box local coordinates with expanded half-extents
        const rx = ox - c.x;
        const rz = oz - c.z;
        const lox = rx * c.cos + rz * c.sin;
        const loz = -rx * c.sin + rz * c.cos;
        const ldx = ndx * c.cos + ndz * c.sin;
        const ldz = -ndx * c.sin + ndz * c.cos;
        const hx = c.halfX + radius;
        const hz = c.halfZ + radius;

        let tMin = 0;
        let tMax = bestDist;
        let lnx = 0;
        let lnz = 0;

        if (Math.abs(ldx) < 1e-8) {
          if (Math.abs(lox) > hx) continue;
        } else {
          const invX = 1 / ldx;
          let t1 = (-hx - lox) * invX;
          let t2 = (hx - lox) * invX;
          let nSign = -1;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
            nSign = 1;
          }
          if (t1 > tMin) {
            tMin = t1;
            lnx = nSign;
            lnz = 0;
          }
          if (t2 < tMax) tMax = t2;
        }

        if (Math.abs(ldz) < 1e-8) {
          if (Math.abs(loz) > hz) continue;
        } else {
          const invZ = 1 / ldz;
          let t1 = (-hz - loz) * invZ;
          let t2 = (hz - loz) * invZ;
          let nSign = -1;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
            nSign = 1;
          }
          if (t1 > tMin) {
            tMin = t1;
            lnx = 0;
            lnz = nSign;
          }
          if (t2 < tMax) tMax = t2;
        }

        if (tMin <= tMax && tMin >= 0 && tMin < bestDist) {
          bestDist = tMin;
          hit = true;
          bestNx = lnx * c.cos - lnz * c.sin;
          bestNz = lnx * c.sin + lnz * c.cos;
          bestId = c.id;
          bestTag = c.tag;
        }
      }
    }

    const out = this.sweepOut;
    out.hit = hit;
    out.distance = bestDist;
    out.normalX = bestNx;
    out.normalZ = bestNz;
    out.colliderId = bestId;
    out.tag = bestTag;
    return out;
  }

  private insert(col: InternalCollider): void {
    const minCx = Math.floor((col.x - col.radius) * this.invCellSize);
    const maxCx = Math.floor((col.x + col.radius) * this.invCellSize);
    const minCz = Math.floor((col.z - col.radius) * this.invCellSize);
    const maxCz = Math.floor((col.z + col.radius) * this.invCellSize);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = `${cx},${cz}`;
        col.cells.push(key);
        let bucket = this.grid.get(key);
        if (!bucket) {
          bucket = [];
          this.grid.set(key, bucket);
        }
        bucket.push(col);
      }
    }

    this.byId.set(col.id, col);
    if (col.chunkKey) {
      let list = this.byChunk.get(col.chunkKey);
      if (!list) {
        list = [];
        this.byChunk.set(col.chunkKey, list);
      }
      list.push(col.id);
    }
  }

  private gatherCandidates(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.candidates.length = 0;
    const stamp = ++this.queryStamp;
    const minCx = Math.floor(minX * this.invCellSize);
    const maxCx = Math.floor(maxX * this.invCellSize);
    const minCz = Math.floor(minZ * this.invCellSize);
    const maxCz = Math.floor(maxZ * this.invCellSize);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.grid.get(`${cx},${cz}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const c = bucket[i]!;
          if (c.stamp !== stamp) {
            c.stamp = stamp;
            this.candidates.push(c);
          }
        }
      }
    }
  }
}

/**
 * Evaluates world boundary soft pushback and hard clamping (PRD §8,
 * ARCHITECTURE.md §6.2).
 */
export function resolveWorldBounds(x: number, z: number, radius = 0.35): BoundaryResult {
  const softLimit = WORLD_HALF - BOUNDARY_MARGIN; // 896 m
  const hardLimit = WORLD_HALF - 16 - radius; // ~1007.65 m

  let pushX = 0;
  let pushZ = 0;
  let nearBoundary = false;

  if (Math.abs(x) > softLimit) {
    nearBoundary = true;
    const t = smoothstep(softLimit, hardLimit, Math.abs(x));
    pushX = -Math.sign(x) * t;
  }
  if (Math.abs(z) > softLimit) {
    nearBoundary = true;
    const t = smoothstep(softLimit, hardLimit, Math.abs(z));
    pushZ = -Math.sign(z) * t;
  }

  const clampedX = clamp(x, -hardLimit, hardLimit);
  const clampedZ = clamp(z, -hardLimit, hardLimit);
  const clamped = clampedX !== x || clampedZ !== z;

  return {
    x: clampedX,
    z: clampedZ,
    nearBoundary: nearBoundary || clamped,
    clamped,
    pushX,
    pushZ,
    message: nearBoundary || clamped ? BOUNDARY_HINT_MESSAGE : "",
  };
}
