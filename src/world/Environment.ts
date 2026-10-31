/**
 * Procedural vegetation, rock, bush, and grass geometries + rule-based world
 * scatter + chunk-grouped InstancedMesh LOD streaming (PRD §5, §8, §19, §20;
 * ARCHITECTURE.md §6.4; Tasks 4.1–4.4).
 *
 * Pure scatter rules (`generateChunkScatter`) have zero DOM/WebGL side effects
 * so they can be verified deterministically in Node unit tests.
 */

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type WebGLRenderer,
} from "three";
import type { AssetManager } from "../core/AssetManager.ts";
import type { GraphicsPreset } from "../core/GraphicsSettings.ts";
import { Random, hashInts } from "../core/Random.ts";
import { TAU, clamp, clamp01, lerp, smoothstep } from "../core/math.ts";
import type { CollisionWorld } from "./Collision.ts";
import type { Heightfield } from "./Heightfield.ts";
import { SimplexNoise } from "./Noise.ts";
import { BOUNDARY_MARGIN, CHUNK_SIZE, WORLD_HALF } from "./WorldGenerator.ts";

export type ScatterKind =
  | "pine"
  | "deciduous"
  | "dead_tree"
  | "boulder"
  | "rock"
  | "bush_berry"
  | "bush_fiber";

export type TreeLodTier = 0 | 1 | 2;
export type PropLodTier = 0 | 1;

export interface ScatterPlacement {
  /** Stable deterministic instance ID: `${chunkX},${chunkZ}:${index}` (ARCHITECTURE.md §6.4). */
  readonly id: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly index: number;
  readonly kind: ScatterKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  readonly scaleY: number;
  /** Physical trunk/rock radius in XZ for collision (>0 for collidable obstacles). */
  readonly colliderRadius: number;
  readonly colliderHeight: number;
}

export interface ChunkScatterData {
  readonly key: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly placements: readonly ScatterPlacement[];
  readonly minY: number;
  readonly maxY: number;
}

export interface EnvironmentStats {
  readonly activeChunkGroups: number;
  readonly totalInstances: number;
  readonly grassInstances: number;
}

// --- Rule-based deterministic scatter (Task 4.2) ---------------------------

/**
 * Evaluates whether `(x, z)` lies inside a natural clearing around POIs,
 * rivers, or connecting trails. Returns `0` inside a strict clearing, `1` in
 * open wilderness, and smooth intermediate values along clearing edges.
 */
export function evaluateClearingMask(heightfield: Heightfield, x: number, z: number): number {
  const { pois, lake, rivers } = heightfield.layout;
  let mask = 1.0;

  // 1. Clearings around every Point of Interest (spawn camp, cabins, caves, etc.)
  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i]!;
    const dx = x - poi.x;
    const dz = z - poi.z;
    const outer = poi.flattenRadius + 8;
    if (Math.abs(dx) > outer || Math.abs(dz) > outer) continue;
    const d = Math.hypot(dx, dz);
    if (d <= poi.radius + 3) return 0;
    const m = smoothstep(poi.radius + 3, outer, d);
    if (m < mask) mask = m;
  }

  // 2. Keep lake basin and immediate sandy beach clear of trees
  const lx = (x - lake.x) / (lake.radiusX * 1.06);
  const lz = (z - lake.z) / (lake.radiusZ * 1.06);
  const lakeNorm = Math.hypot(lx, lz);
  if (lakeNorm < 1.0) return 0;
  if (lakeNorm < 1.14) {
    const m = smoothstep(1.0, 1.14, lakeNorm);
    if (m < mask) mask = m;
  }

  // 3. Keep river channels and immediate banks clear
  for (let r = 0; r < rivers.length; r++) {
    const river = rivers[r]!;
    if (x < river.minX || x > river.maxX || z < river.minZ || z > river.maxZ) continue;
    const pts = river.points;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i]!;
      const clearR = pt.width * 0.85 + 3.5;
      if (Math.abs(x - pt.x) > clearR || Math.abs(z - pt.z) > clearR) continue;
      const d = Math.hypot(x - pt.x, z - pt.z);
      if (d < pt.width * 0.58 + 1.2) return 0;
      const m = smoothstep(pt.width * 0.58 + 1.2, clearR, d);
      if (m < mask) mask = m;
    }
  }

  // 4. Subtle footpath from spawn camp toward the lake shore and ruined bridge
  const spawn = pois[0];
  if (spawn) {
    const pathM = segmentClearingMask(x, z, spawn.x, spawn.z, lake.x - lake.radiusX * 0.88, lake.z - 20, 4.5, 9.5);
    if (pathM < mask) mask = pathM;
  }

  return mask;
}

function segmentClearingMask(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  innerWidth: number,
  outerWidth: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq <= 0) return 1;
  const t = clamp01(((px - ax) * abx + (pz - az) * abz) / lenSq);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const d = Math.hypot(px - cx, pz - cz);
  if (d <= innerWidth) return 0;
  if (d >= outerWidth) return 1;
  return smoothstep(innerWidth, outerWidth, d);
}

/**
 * Deterministically generates all tree, rock, and bush placements for one
 * 64 m × 64 m chunk `(chunkX, chunkZ)`.
 *
 * Rules (PRD §5, §8; ARCHITECTURE.md §6.4):
 *  - Forest density from macro biome weights × cluster noise × slope × clearing mask.
 *  - Larger pines in deep forest interiors; smaller/sparse trees and deciduous
 *    birch/aspen variants along meadow and shoreline transitions.
 *  - Deadfall snags near high ridges, outer boundary ring, and rocky edges.
 *  - Boulders and stones clustered on steeper slopes, ridges, and riverbanks.
 *  - Berry and fiber bushes along forest-meadow edges and near water.
 */
export function generateChunkScatter(
  heightfield: Heightfield,
  chunkX: number,
  chunkZ: number,
): ChunkScatterData {
  const seed = heightfield.seed;
  const rng = new Random(hashInts(seed ^ 0x454e5631, chunkX, chunkZ));
  const clusterNoise = new SimplexNoise(hashInts(seed, 0x7711));

  const originX = chunkX * CHUNK_SIZE;
  const originZ = chunkZ * CHUNK_SIZE;
  const placements: ScatterPlacement[] = [];

  let minY = Infinity;
  let maxY = -Infinity;
  let nextIdx = 0;

  // Helper to check local spacing within the chunk so objects never overlap
  const isSpaced = (x: number, z: number, minDist: number): boolean => {
    const minSq = minDist * minDist;
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < minSq) return false;
    }
    return true;
  };

  // --- Pass 1: Trees (8×8 jittered stratified grid, 8 m cells) ---
  const treeGrid = 8;
  const treeStep = CHUNK_SIZE / treeGrid; // 8 m
  for (let gz = 0; gz < treeGrid; gz++) {
    for (let gx = 0; gx < treeGrid; gx++) {
      const wx = originX + (gx + rng.range(0.16, 0.84)) * treeStep;
      const wz = originZ + (gz + rng.range(0.16, 0.84)) * treeStep;

      if (Math.abs(wx) > WORLD_HALF - 18 || Math.abs(wz) > WORLD_HALF - 18) continue;

      const water = heightfield.waterInfo(wx, wz);
      if (water.hasWater) continue;

      const clearing = evaluateClearingMask(heightfield, wx, wz);
      if (clearing < 0.15) continue;

      const sample = heightfield.sample(wx, wz);
      // Trees cannot grow on steep cliffs (> 33 deg) or high snow caps
      if (sample.slopeAngle > 0.58 || sample.weights.snow > 0.45) continue;

      const cluster = 0.5 + 0.5 * clusterNoise.fbm(wx * 0.018, wz * 0.018, 2);
      const edgeDist = Math.min(WORLD_HALF - Math.abs(wx), WORLD_HALF - Math.abs(wz));
      const inBoundary = edgeDist < BOUNDARY_MARGIN;

      const forestScore =
        (sample.weights.forest * 0.92 + sample.weights.grass * 0.34) *
        (0.35 + 0.65 * cluster) *
        clearing *
        (1 - smoothstep(0.38, 0.58, sample.slopeAngle));

      // Spawn probability
      const prob = inBoundary ? 0.52 * clearing : forestScore * 0.78;
      if (!rng.chance(prob)) continue;
      if (!isSpaced(wx, wz, 4.2)) continue;

      // Choose tree variant by habitat
      let kind: ScatterKind = "pine";
      const deadChance =
        (inBoundary ? 0.32 : 0.03) +
        sample.weights.rock * 0.22 +
        (sample.height > 36 ? 0.18 : 0);
      const decidChance =
        sample.weights.grass * 0.36 +
        sample.weights.sand * 0.25 -
        sample.weights.forest * 0.15;

      const roll = rng.next();
      if (roll < deadChance) {
        kind = "dead_tree";
      } else if (roll < deadChance + decidChance && sample.height < 30) {
        kind = "deciduous";
      }

      // Larger trees in deep forest interiors, smaller at edges (ARCHITECTURE.md §6.4)
      const interiorBoost = lerp(0.82, 1.32, clamp01(forestScore * 1.15));
      const scale = rng.range(0.85, 1.18) * interiorBoost * clamp(clearing + 0.25, 0.75, 1.0);
      const scaleY = scale * rng.range(0.92, 1.14);
      const yaw = rng.range(0, TAU);
      const colliderRadius = kind === "dead_tree" ? 0.26 * scale : 0.34 * scale;
      const colliderHeight = 6.5 * scaleY;

      const idx = nextIdx++;
      placements.push({
        id: `${chunkX},${chunkZ}:${idx}`,
        chunkX,
        chunkZ,
        index: idx,
        kind,
        x: wx,
        y: sample.height,
        z: wz,
        yaw,
        scale,
        scaleY,
        colliderRadius,
        colliderHeight,
      });

      if (sample.height < minY) minY = sample.height;
      if (sample.height + colliderHeight > maxY) maxY = sample.height + colliderHeight;
    }
  }

  // --- Pass 2: Rocks & Boulders (clustered on slopes, ridges, and banks) ---
  const rockAttempts = 18;
  for (let i = 0; i < rockAttempts; i++) {
    const wx = originX + rng.range(2, CHUNK_SIZE - 2);
    const wz = originZ + rng.range(2, CHUNK_SIZE - 2);
    if (Math.abs(wx) > WORLD_HALF - 14 || Math.abs(wz) > WORLD_HALF - 14) continue;

    const water = heightfield.waterInfo(wx, wz);
    if (water.hasWater && water.depth > 0.35) continue;

    const clearing = evaluateClearingMask(heightfield, wx, wz);
    if (clearing < 0.08) continue;

    const sample = heightfield.sample(wx, wz);
    const rockFavor =
      sample.weights.rock * 0.85 +
      sample.weights.sand * 0.45 +
      sample.weights.dirt * 0.4 +
      smoothstep(0.2, 0.55, sample.slopeAngle) * 0.5 +
      0.08;

    if (!rng.chance(clamp01(rockFavor * 0.65))) continue;

    const isBoulder = rng.chance(0.28 + sample.weights.rock * 0.35);
    const minDist = isBoulder ? 3.2 : 2.0;
    if (!isSpaced(wx, wz, minDist)) continue;

    const scale = isBoulder ? rng.range(1.15, 2.15) : rng.range(0.55, 1.05);
    const scaleY = scale * rng.range(0.72, 1.15);
    const colliderRadius = isBoulder ? 0.92 * scale : 0.48 * scale;
    const colliderHeight = 1.6 * scaleY;

    const idx = nextIdx++;
    placements.push({
      id: `${chunkX},${chunkZ}:${idx}`,
      chunkX,
      chunkZ,
      index: idx,
      kind: isBoulder ? "boulder" : "rock",
      x: wx,
      y: sample.height - 0.08 * scale,
      z: wz,
      yaw: rng.range(0, TAU),
      scale,
      scaleY,
      colliderRadius,
      colliderHeight,
    });

    if (sample.height < minY) minY = sample.height;
    if (sample.height + colliderHeight > maxY) maxY = sample.height + colliderHeight;
  }

  // --- Pass 3: Berry & Fiber Bushes (meadow transitions, forest understory) ---
  const bushAttempts = 22;
  for (let i = 0; i < bushAttempts; i++) {
    const wx = originX + rng.range(2, CHUNK_SIZE - 2);
    const wz = originZ + rng.range(2, CHUNK_SIZE - 2);
    if (Math.abs(wx) > WORLD_HALF - 20 || Math.abs(wz) > WORLD_HALF - 20) continue;

    const water = heightfield.waterInfo(wx, wz);
    if (water.hasWater) continue;

    const clearing = evaluateClearingMask(heightfield, wx, wz);
    if (clearing < 0.2) continue;

    const sample = heightfield.sample(wx, wz);
    if (sample.slopeAngle > 0.48 || sample.weights.snow > 0.2 || sample.weights.rock > 0.45) {
      continue;
    }

    const bushFavor = (sample.weights.grass * 0.75 + sample.weights.forest * 0.65) * clearing;
    if (!rng.chance(clamp01(bushFavor * 0.55))) continue;
    if (!isSpaced(wx, wz, 2.2)) continue;

    const kind: ScatterKind =
      sample.weights.forest > sample.weights.grass
        ? rng.chance(0.68)
          ? "bush_berry"
          : "bush_fiber"
        : rng.chance(0.35)
          ? "bush_berry"
          : "bush_fiber";

    const scale = rng.range(0.78, 1.32);
    const scaleY = scale * rng.range(0.85, 1.15);
    const idx = nextIdx++;

    placements.push({
      id: `${chunkX},${chunkZ}:${idx}`,
      chunkX,
      chunkZ,
      index: idx,
      kind,
      x: wx,
      y: sample.height,
      z: wz,
      yaw: rng.range(0, TAU),
      scale,
      scaleY,
      // Bushes do not hard-block player movement (walkable brush)
      colliderRadius: 0,
      colliderHeight: 1.2 * scaleY,
    });

    if (sample.height < minY) minY = sample.height;
    if (sample.height + 1.5 > maxY) maxY = sample.height + 1.5;
  }

  if (!Number.isFinite(minY)) {
    const h = heightfield.height(originX + CHUNK_SIZE * 0.5, originZ + CHUNK_SIZE * 0.5);
    minY = h;
    maxY = h + 4;
  }

  return {
    key: `${chunkX},${chunkZ}`,
    chunkX,
    chunkZ,
    placements,
    minY,
    maxY,
  };
}

// --- Procedural Mesh Builders (Tasks 4.1 & 4.4) ----------------------------

interface ColoredPart {
  readonly geo: BufferGeometry;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly shadeBottom?: number;
  readonly shadeTop?: number;
  /** Weight in [0, 1] for vertex-shader wind sway. */
  readonly swayWeight?: number;
}

/**
 * Merges multiple primitive `BufferGeometry` parts into a single vertex-coloured
 * `BufferGeometry` so a multi-layer tree or bush renders in **one** InstancedMesh
 * draw call (instead of separate trunk + foliage draw calls).
 */
function mergeColoredParts(parts: readonly ColoredPart[]): BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (let i = 0; i < parts.length; i++) {
    const g = parts[i]!.geo;
    const pos = g.getAttribute("position") as BufferAttribute;
    totalVerts += pos.count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint16Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    const g = part.geo;
    const pos = g.getAttribute("position") as BufferAttribute;
    const norm = g.getAttribute("normal") as BufferAttribute;
    const uv = g.getAttribute("uv") as BufferAttribute | undefined;
    const count = pos.count;

    // Find vertical range of this part for natural bottom-to-top AO & crown highlight
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanY = Math.max(0.01, maxY - minY);
    const bot = part.shadeBottom ?? 0.86;
    const top = part.shadeTop ?? 1.12;
    const sway = part.swayWeight ?? 0;

    for (let i = 0; i < count; i++) {
      const dst3 = (vOffset + i) * 3;
      const dst2 = (vOffset + i) * 2;
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);

      positions[dst3] = px;
      positions[dst3 + 1] = py;
      positions[dst3 + 2] = pz;

      // Tilt foliage normals slightly upward (+0.35 Y) so directional sun and
      // hemisphere sky light illuminate the canopy warmly without harsh black undersides.
      let nx = norm ? norm.getX(i) : 0;
      let ny = norm ? norm.getY(i) : 1;
      let nz = norm ? norm.getZ(i) : 0;
      if (sway > 0.05) {
        ny += 0.38;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
      }
      normals[dst3] = nx;
      normals[dst3 + 1] = ny;
      normals[dst3 + 2] = nz;

      const tY = clamp01((py - minY) / spanY);
      const grad = lerp(bot, top, tY);
      colors[dst3] = clamp01(part.r * grad);
      colors[dst3 + 1] = clamp01(part.g * grad);
      colors[dst3 + 2] = clamp01(part.b * grad);

      uvs[dst2] = uv ? uv.getX(i) : tY;
      // Store wind sway weight in uv.y for vertex shader wind animation
      uvs[dst2 + 1] = sway * clamp01(py / 6.5);
    }

    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices[iOffset++] = vOffset + idx.getX(i);
      }
    } else {
      for (let i = 0; i < count; i++) {
        indices[iOffset++] = vOffset + i;
      }
    }

    vOffset += count;
    g.dispose();
  }

  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.setAttribute("normal", new BufferAttribute(normals, 3));
  merged.setAttribute("color", new BufferAttribute(colors, 3));
  merged.setAttribute("uv", new BufferAttribute(uvs, 2));
  merged.setIndex(new BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Builds procedural Pine tree geometry for LOD0 (trunk + 4 tiered cones),
 * LOD1 (low-poly trunk + 2 cones), or LOD2 (crossed billboard planes).
 */
export function buildPineTreeGeometry(lod: TreeLodTier): BufferGeometry {
  if (lod === 2) {
    return buildCrossedBillboardGeometry(3.4, 6.6);
  }

  if (lod === 1) {
    const trunk = new CylinderGeometry(0.12, 0.24, 2.1, 5, 1);
    trunk.translate(0, 1.05, 0);
    const cone1 = new ConeGeometry(1.55, 2.7, 6, 1);
    cone1.translate(0, 2.85, 0);
    const cone2 = new ConeGeometry(1.1, 2.5, 6, 1);
    cone2.translate(0, 4.65, 0);

    return mergeColoredParts([
      { geo: trunk, r: 0.44, g: 0.31, b: 0.21, shadeBottom: 0.78, shadeTop: 1.0, swayWeight: 0.1 },
      { geo: cone1, r: 0.24, g: 0.44, b: 0.23, shadeBottom: 0.84, shadeTop: 1.12, swayWeight: 0.7 },
      { geo: cone2, r: 0.28, g: 0.5, b: 0.26, shadeBottom: 0.88, shadeTop: 1.16, swayWeight: 1.0 },
    ]);
  }

  // LOD 0: Full 4-tier procedural pine (~160 tris)
  const trunk = new CylinderGeometry(0.11, 0.26, 2.2, 6, 1);
  trunk.translate(0, 1.1, 0);

  const tier1 = new ConeGeometry(1.68, 1.95, 7, 1);
  tier1.translate(0, 2.45, 0);

  const tier2 = new ConeGeometry(1.42, 1.85, 7, 1);
  tier2.rotateY(0.45);
  tier2.translate(0, 3.55, 0);

  const tier3 = new ConeGeometry(1.12, 1.7, 7, 1);
  tier3.rotateY(0.9);
  tier3.translate(0, 4.6, 0);

  const tier4 = new ConeGeometry(0.76, 1.5, 6, 1);
  tier4.rotateY(1.35);
  tier4.translate(0, 5.6, 0);

  return mergeColoredParts([
    { geo: trunk, r: 0.45, g: 0.32, b: 0.22, shadeBottom: 0.75, shadeTop: 1.02, swayWeight: 0.08 },
    { geo: tier1, r: 0.22, g: 0.41, b: 0.22, shadeBottom: 0.82, shadeTop: 1.08, swayWeight: 0.45 },
    { geo: tier2, r: 0.25, g: 0.45, b: 0.24, shadeBottom: 0.85, shadeTop: 1.12, swayWeight: 0.65 },
    { geo: tier3, r: 0.28, g: 0.49, b: 0.26, shadeBottom: 0.88, shadeTop: 1.15, swayWeight: 0.85 },
    { geo: tier4, r: 0.31, g: 0.53, b: 0.28, shadeBottom: 0.92, shadeTop: 1.18, swayWeight: 1.0 },
  ]);
}

/**
 * Builds a deciduous (birch/aspen) tree variant with pale bark and warm
 * olive-gold leaf clusters (Task 4.1).
 */
export function buildDeciduousTreeGeometry(lod: PropLodTier): BufferGeometry {
  if (lod === 1) {
    const trunk = new CylinderGeometry(0.11, 0.21, 2.5, 5, 1);
    trunk.translate(0, 1.25, 0);
    const crown = new DodecahedronGeometry(1.55, 0);
    crown.scale(1.0, 1.25, 1.0);
    crown.translate(0, 3.85, 0);
    return mergeColoredParts([
      { geo: trunk, r: 0.68, g: 0.64, b: 0.56, shadeBottom: 0.72, shadeTop: 1.04, swayWeight: 0.1 },
      { geo: crown, r: 0.42, g: 0.54, b: 0.25, shadeBottom: 0.84, shadeTop: 1.15, swayWeight: 0.9 },
    ]);
  }

  const trunk = new CylinderGeometry(0.11, 0.22, 2.6, 6, 1);
  trunk.translate(0, 1.3, 0);

  const c1 = new DodecahedronGeometry(1.35, 0);
  c1.scale(1.08, 0.95, 1.08);
  c1.translate(-0.25, 3.4, 0.15);

  const c2 = new DodecahedronGeometry(1.2, 0);
  c2.translate(0.35, 4.1, -0.2);

  const c3 = new DodecahedronGeometry(0.98, 0);
  c3.translate(0.0, 4.95, 0.08);

  return mergeColoredParts([
    { geo: trunk, r: 0.7, g: 0.66, b: 0.58, shadeBottom: 0.72, shadeTop: 1.05, swayWeight: 0.08 },
    { geo: c1, r: 0.38, g: 0.51, b: 0.24, shadeBottom: 0.84, shadeTop: 1.12, swayWeight: 0.65 },
    { geo: c2, r: 0.44, g: 0.56, b: 0.26, shadeBottom: 0.86, shadeTop: 1.14, swayWeight: 0.85 },
    { geo: c3, r: 0.49, g: 0.6, b: 0.28, shadeBottom: 0.9, shadeTop: 1.18, swayWeight: 1.0 },
  ]);
}

/**
 * Builds a weathered dead snag tree with angled bare branches (Task 4.1).
 */
export function buildDeadTreeGeometry(lod: PropLodTier): BufferGeometry {
  const segs = lod === 0 ? 6 : 4;
  const trunk = new CylinderGeometry(0.09, 0.24, 4.4, segs, 1);
  trunk.translate(0, 2.2, 0);

  const branch1 = new CylinderGeometry(0.04, 0.09, 1.6, 4, 1);
  branch1.rotateZ(-0.68);
  branch1.translate(0.52, 2.8, 0);

  const branch2 = new CylinderGeometry(0.035, 0.08, 1.3, 4, 1);
  branch2.rotateZ(0.62);
  branch2.rotateY(0.9);
  branch2.translate(-0.35, 3.45, 0.22);

  return mergeColoredParts([
    { geo: trunk, r: 0.42, g: 0.35, b: 0.28, shadeBottom: 0.72, shadeTop: 1.08, swayWeight: 0.15 },
    { geo: branch1, r: 0.44, g: 0.37, b: 0.3, shadeBottom: 0.85, shadeTop: 1.08, swayWeight: 0.3 },
    { geo: branch2, r: 0.46, g: 0.39, b: 0.32, shadeBottom: 0.88, shadeTop: 1.1, swayWeight: 0.35 },
  ]);
}

function buildCrossedBillboardGeometry(width: number, height: number): BufferGeometry {
  const p1 = new PlaneGeometry(width, height, 1, 1);
  p1.translate(0, height * 0.5, 0);

  const p2 = new PlaneGeometry(width, height, 1, 1);
  p2.rotateY(Math.PI * 0.5);
  p2.translate(0, height * 0.5, 0);

  return mergeColoredParts([
    { geo: p1, r: 0.96, g: 0.98, b: 0.95, shadeBottom: 0.88, shadeTop: 1.08, swayWeight: 0.45 },
    { geo: p2, r: 0.92, g: 0.95, b: 0.91, shadeBottom: 0.88, shadeTop: 1.08, swayWeight: 0.45 },
  ]);
}

/**
 * Builds faceted procedural boulder / rock geometry (Task 4.4).
 */
export function buildRockGeometry(boulder: boolean, lod: PropLodTier): BufferGeometry {
  const detail = boulder && lod === 0 ? 1 : 0;
  const g1 = new DodecahedronGeometry(boulder ? 1.0 : 0.52, detail);
  g1.scale(1.12, boulder ? 0.78 : 0.68, 0.96);
  g1.translate(0, boulder ? 0.58 : 0.28, 0);

  if (!boulder || lod === 1) {
    return mergeColoredParts([
      { geo: g1, r: 0.5, g: 0.49, b: 0.45, shadeBottom: 0.72, shadeTop: 1.14, swayWeight: 0 },
    ]);
  }

  const g2 = new DodecahedronGeometry(0.62, 0);
  g2.scale(1.05, 0.75, 0.9);
  g2.rotateY(0.8);
  g2.translate(0.55, 0.38, 0.22);

  return mergeColoredParts([
    { geo: g1, r: 0.49, g: 0.48, b: 0.44, shadeBottom: 0.7, shadeTop: 1.14, swayWeight: 0 },
    { geo: g2, r: 0.45, g: 0.46, b: 0.41, shadeBottom: 0.72, shadeTop: 1.1, swayWeight: 0 },
  ]);
}

/**
 * Builds procedural berry bush or fibrous shrub geometry (Task 4.4).
 */
export function buildBushGeometry(withBerries: boolean): BufferGeometry {
  const main = new DodecahedronGeometry(0.62, 0);
  main.scale(1.15, 0.82, 1.1);
  main.translate(0, 0.44, 0);

  const side = new DodecahedronGeometry(0.45, 0);
  side.scale(1.1, 0.78, 1.05);
  side.translate(0.32, 0.35, 0.22);

  const parts: ColoredPart[] = [
    {
      geo: main,
      r: withBerries ? 0.24 : 0.36,
      g: withBerries ? 0.45 : 0.49,
      b: withBerries ? 0.22 : 0.24,
      shadeBottom: 0.78,
      shadeTop: 1.14,
      swayWeight: 0.65,
    },
    {
      geo: side,
      r: withBerries ? 0.28 : 0.41,
      g: withBerries ? 0.49 : 0.53,
      b: withBerries ? 0.24 : 0.26,
      shadeBottom: 0.8,
      shadeTop: 1.16,
      swayWeight: 0.65,
    },
  ];

  if (withBerries) {
    // 3 small bright berry clusters on top of the shrub
    const b1 = new DodecahedronGeometry(0.11, 0);
    b1.translate(-0.18, 0.72, 0.28);
    const b2 = new DodecahedronGeometry(0.1, 0);
    b2.translate(0.24, 0.68, -0.16);
    const b3 = new DodecahedronGeometry(0.1, 0);
    b3.translate(0.38, 0.56, 0.28);
    parts.push(
      { geo: b1, r: 0.82, g: 0.22, b: 0.2, shadeBottom: 0.9, shadeTop: 1.15, swayWeight: 0.7 },
      { geo: b2, r: 0.85, g: 0.25, b: 0.22, shadeBottom: 0.9, shadeTop: 1.15, swayWeight: 0.7 },
      { geo: b3, r: 0.8, g: 0.2, b: 0.18, shadeBottom: 0.9, shadeTop: 1.15, swayWeight: 0.7 },
    );
  }

  return mergeColoredParts(parts);
}

/**
 * Builds a low-poly crossed grass clump (3 intersecting blades, 6 triangles)
 * with base-to-tip colour gradient and wind-sway UV weights (Task 4.4).
 */
export function buildGrassClumpGeometry(): BufferGeometry {
  const b1 = new PlaneGeometry(0.55, 0.62, 1, 1);
  b1.translate(0, 0.31, 0);

  const b2 = new PlaneGeometry(0.55, 0.58, 1, 1);
  b2.rotateY(Math.PI / 3);
  b2.translate(0, 0.29, 0);

  const b3 = new PlaneGeometry(0.52, 0.54, 1, 1);
  b3.rotateY((2 * Math.PI) / 3);
  b3.translate(0, 0.27, 0);

  return mergeColoredParts([
    { geo: b1, r: 0.34, g: 0.49, b: 0.24, shadeBottom: 0.68, shadeTop: 1.22, swayWeight: 1.0 },
    { geo: b2, r: 0.37, g: 0.52, b: 0.25, shadeBottom: 0.68, shadeTop: 1.22, swayWeight: 1.0 },
    { geo: b3, r: 0.32, g: 0.47, b: 0.22, shadeBottom: 0.68, shadeTop: 1.22, swayWeight: 1.0 },
  ]);
}

// --- Far-Impostor Texture Baking (Task 4.1) --------------------------------

function createPineImpostorTexture(assets: AssetManager, renderer?: WebGLRenderer) {
  return assets.texture("p4.tex.pineImpostor", () => {
    // Paint a crisp alpha-tested pine silhouette onto a 128×128 canvas fallback,
    // and when a WebGLRenderer is supplied, also bake the real 3D pine mesh at load.
    const tex = assets.canvasTexture(
      "p4.tex.pineImpostorCanvas",
      128,
      128,
      (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        // Trunk
        ctx.fillStyle = "#6e4e35";
        ctx.fillRect(w * 0.45, h * 0.66, w * 0.1, h * 0.32);

        // 4 layered pine tiers with warm top highlights
        const tiers = [
          { yTop: 0.38, yBot: 0.76, halfW: 0.38, fill: "#386836", hi: "#4a8244" },
          { yTop: 0.26, yBot: 0.62, halfW: 0.32, fill: "#3f743b", hi: "#528e4a" },
          { yTop: 0.14, yBot: 0.47, halfW: 0.25, fill: "#467f41", hi: "#5b9950" },
          { yTop: 0.04, yBot: 0.32, halfW: 0.17, fill: "#4e8a47", hi: "#65a659" },
        ];
        for (const t of tiers) {
          ctx.beginPath();
          ctx.moveTo(w * 0.5, h * t.yTop);
          ctx.lineTo(w * (0.5 + t.halfW), h * t.yBot);
          ctx.lineTo(w * (0.5 - t.halfW), h * t.yBot);
          ctx.closePath();
          ctx.fillStyle = t.fill;
          ctx.fill();

          // Sunlit crown edge
          ctx.beginPath();
          ctx.moveTo(w * 0.5, h * t.yTop);
          ctx.lineTo(w * (0.5 + t.halfW * 0.75), h * (t.yTop + (t.yBot - t.yTop) * 0.72));
          ctx.lineTo(w * 0.5, h * (t.yTop + (t.yBot - t.yTop) * 0.82));
          ctx.closePath();
          ctx.fillStyle = t.hi;
          ctx.fill();
        }
      },
      { repeat: false, srgb: true },
    );

    if (renderer) {
      try {
        const rt = new WebGLRenderTarget(128, 128);
        rt.texture.colorSpace = SRGBColorSpace;
        const bakeScene = new Scene();
        const bakeCam = new OrthographicCamera(-1.8, 1.8, 6.6, 0, 0.1, 10);
        bakeCam.position.set(0, 0, 4);
        bakeCam.lookAt(0, 0, 0);

        const pineGeo = buildPineTreeGeometry(0);
        const pineMat = new MeshBasicMaterial({ vertexColors: true });
        const mesh = new Mesh(pineGeo, pineMat);
        bakeScene.add(mesh);
        const prevTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(rt);
        renderer.render(bakeScene, bakeCam);
        renderer.setRenderTarget(prevTarget);
        pineGeo.dispose();
        pineMat.dispose();
        rt.dispose();
      } catch {
        // Canvas texture fallback is already populated
      }
    }

    return tex;
  });
}

// --- Chunk-Group InstancedMesh Manager + Grass Ring (Tasks 4.3 & 4.4) ------

/** Group size in chunks: 2×2 chunks = 128 m × 128 m per InstancedMesh group. */
const GROUP_CHUNKS = 2;
const GROUP_METRES = CHUNK_SIZE * GROUP_CHUNKS; // 128 m
const MIN_GROUP = -WORLD_HALF / GROUP_METRES; // -8
const MAX_GROUP = WORLD_HALF / GROUP_METRES - 1; // 7

const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

interface SpeciesBatch {
  readonly kind: ScatterKind;
  readonly placements: ScatterPlacement[];
  readonly baseMatrices: Matrix4[];
  readonly currentMatrices: Matrix4[];
  mesh: InstancedMesh | null;
  lod: number;
}

interface ChunkGroupRecord {
  readonly groupKey: string;
  readonly groupX: number;
  readonly groupZ: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly boundingBox: Box3;
  readonly boundingSphere: Sphere;
  readonly chunkKeys: readonly string[];
  readonly batches: Map<ScatterKind, SpeciesBatch>;
  readonly instanceLookup: Map<string, { batch: SpeciesBatch; index: number }>;
  collidersRegistered: boolean;
}

export class Environment {
  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly heightfield: Heightfield;
  private readonly collision: CollisionWorld;
  private readonly root = new Group();

  private readonly chunkScatterCache = new Map<string, ChunkScatterData>();
  private readonly activeGroups = new Map<string, ChunkGroupRecord>();
  private readonly depletedIds = new Set<string>();

  private preset: GraphicsPreset;
  private standardMaterials: boolean;

  // Shared wind uniforms updated once per frame (zero CPU cost per instance)
  private readonly windUniforms = {
    uTime: { value: 0 },
    uWindStrength: { value: 0.35 },
    uWindDir: { value: new Vector3(0.85, 0, 0.52) },
  };

  // Grass ring buffer around the player (Task 4.4)
  private grassMesh: InstancedMesh | null = null;
  private grassCapacity = 0;
  private lastGrassAnchorX = Number.NaN;
  private lastGrassAnchorZ = Number.NaN;

  private lastFocusGroupX = Number.NaN;
  private lastFocusGroupZ = Number.NaN;
  private lastLodCheckX = Number.NaN;
  private lastLodCheckZ = Number.NaN;
  private totalInstances = 0;

  // Reusable scratch objects to avoid per-frame allocations
  private readonly scratchMat = new Matrix4();
  private readonly scratchPos = new Vector3();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchScale = new Vector3();
  private readonly upAxis = new Vector3(0, 1, 0);

  constructor(
    scene: Scene,
    assets: AssetManager,
    heightfield: Heightfield,
    collision: CollisionWorld,
    preset: GraphicsPreset,
    renderer?: WebGLRenderer,
  ) {
    this.scene = scene;
    this.assets = assets;
    this.heightfield = heightfield;
    this.collision = collision;
    this.preset = preset;
    this.standardMaterials = preset.standardMaterials;

    this.root.name = "Environment";
    this.scene.add(this.root);

    createPineImpostorTexture(assets, renderer);
    this.rebuildGrassRing();
  }

  /** Updates graphics preset (view distance, LOD scale, material tier, grass ring). */
  applyPreset(preset: GraphicsPreset): void {
    const matChanged = preset.standardMaterials !== this.standardMaterials;
    const grassChanged =
      preset.grassRadius !== this.preset.grassRadius ||
      preset.grassDensity !== this.preset.grassDensity ||
      matChanged;

    this.preset = preset;
    this.standardMaterials = preset.standardMaterials;

    if (matChanged) {
      for (const group of this.activeGroups.values()) {
        for (const batch of group.batches.values()) {
          if (batch.mesh) {
            batch.mesh.material = this.getMaterialFor(batch.kind, batch.lod);
          }
        }
      }
    }

    if (grassChanged) {
      this.rebuildGrassRing();
      if (!Number.isNaN(this.lastLodCheckX)) {
        this.updateGrassPatch(this.lastLodCheckX, this.lastLodCheckZ, true);
      }
    }

    this.lastFocusGroupX = Number.NaN;
    this.lastLodCheckX = Number.NaN;
  }

  /**
   * Hides or restores a gatherable instance by its deterministic ID
   * `${chunkX},${chunkZ}:${index}` (ARCHITECTURE.md §6.4).
   */
  setInstanceDepleted(id: string, depleted: boolean): boolean {
    if (depleted) {
      this.depletedIds.add(id);
    } else {
      this.depletedIds.delete(id);
    }

    for (const group of this.activeGroups.values()) {
      const ref = group.instanceLookup.get(id);
      if (!ref) continue;
      const { batch, index } = ref;
      const mat = depleted ? ZERO_MATRIX : batch.baseMatrices[index]!;
      batch.currentMatrices[index] = mat;
      if (batch.mesh) {
        batch.mesh.setMatrixAt(index, mat);
        batch.mesh.instanceMatrix.needsUpdate = true;
      }
      return true;
    }
    return false;
  }

  /** Pre-populates scatter & colliders around `(focusX, focusZ)` during loading. */
  warmUp(focusX: number, focusZ: number): void {
    this.update(focusX, focusZ, 0);
    this.updateGrassPatch(focusX, focusZ, true);
  }

  /**
   * Updates chunk-group streaming, LOD swaps, wind shader uniforms, and the
   * player-centred grass ring.
   */
  update(focusX: number, focusZ: number, dt: number, windStrength = 0.35): void {
    this.windUniforms.uTime.value += dt;
    this.windUniforms.uWindStrength.value = windStrength;

    const fgx = Math.floor(focusX / GROUP_METRES);
    const fgz = Math.floor(focusZ / GROUP_METRES);
    const viewGroups = Math.max(2, Math.ceil(this.preset.viewDistanceChunks / GROUP_CHUNKS));

    if (fgx !== this.lastFocusGroupX || fgz !== this.lastFocusGroupZ) {
      this.lastFocusGroupX = fgx;
      this.lastFocusGroupZ = fgz;
      this.syncActiveGroups(fgx, fgz, viewGroups, focusX, focusZ);
    }

    // Re-evaluate group LODs and collider registration when player moves >= 10 m
    const movedSq =
      (focusX - this.lastLodCheckX) * (focusX - this.lastLodCheckX) +
      (focusZ - this.lastLodCheckZ) * (focusZ - this.lastLodCheckZ);
    if (Number.isNaN(movedSq) || movedSq >= 100) {
      this.lastLodCheckX = focusX;
      this.lastLodCheckZ = focusZ;
      this.updateGroupLodsAndColliders(focusX, focusZ);
    }

    this.updateGrassPatch(focusX, focusZ, false);
  }

  getStats(): EnvironmentStats {
    return {
      activeChunkGroups: this.activeGroups.size,
      totalInstances: this.totalInstances,
      grassInstances: this.grassMesh ? this.grassMesh.count : 0,
    };
  }

  dispose(): void {
    for (const group of this.activeGroups.values()) {
      this.unloadGroup(group);
    }
    this.activeGroups.clear();
    if (this.grassMesh) {
      this.root.remove(this.grassMesh);
      this.grassMesh.dispose();
      this.grassMesh = null;
    }
    this.scene.remove(this.root);
  }

  // --- Internal group management -------------------------------------------

  private syncActiveGroups(
    fgx: number,
    fgz: number,
    viewGroups: number,
    focusX: number,
    focusZ: number,
  ): void {
    const desiredKeys = new Set<string>();
    const minGx = Math.max(MIN_GROUP, fgx - viewGroups);
    const maxGx = Math.min(MAX_GROUP, fgx + viewGroups);
    const minGz = Math.max(MIN_GROUP, fgz - viewGroups);
    const maxGz = Math.min(MAX_GROUP, fgz + viewGroups);

    for (let gz = minGz; gz <= maxGz; gz++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        if (Math.max(Math.abs(gx - fgx), Math.abs(gz - fgz)) > viewGroups) continue;
        const key = `${gx},${gz}`;
        desiredKeys.add(key);
        if (!this.activeGroups.has(key)) {
          const group = this.buildGroupRecord(gx, gz);
          this.activeGroups.set(key, group);
        }
      }
    }

    for (const [key, group] of this.activeGroups) {
      if (!desiredKeys.has(key)) {
        this.unloadGroup(group);
        this.activeGroups.delete(key);
      }
    }

    this.updateGroupLodsAndColliders(focusX, focusZ);
  }

  private buildGroupRecord(groupX: number, groupZ: number): ChunkGroupRecord {
    const groupKey = `${groupX},${groupZ}`;
    const baseCx = groupX * GROUP_CHUNKS;
    const baseCz = groupZ * GROUP_CHUNKS;
    const chunkKeys: string[] = [];
    const batches = new Map<ScatterKind, SpeciesBatch>();
    const instanceLookup = new Map<string, { batch: SpeciesBatch; index: number }>();

    let minY = Infinity;
    let maxY = -Infinity;

    for (let dz = 0; dz < GROUP_CHUNKS; dz++) {
      for (let dx = 0; dx < GROUP_CHUNKS; dx++) {
        const cx = baseCx + dx;
        const cz = baseCz + dz;
        const cKey = `${cx},${cz}`;
        chunkKeys.push(cKey);

        let scatter = this.chunkScatterCache.get(cKey);
        if (!scatter) {
          scatter = generateChunkScatter(this.heightfield, cx, cz);
          this.chunkScatterCache.set(cKey, scatter);
        }
        if (scatter.minY < minY) minY = scatter.minY;
        if (scatter.maxY > maxY) maxY = scatter.maxY;

        for (let i = 0; i < scatter.placements.length; i++) {
          const p = scatter.placements[i]!;
          let batch = batches.get(p.kind);
          if (!batch) {
            batch = {
              kind: p.kind,
              placements: [],
              baseMatrices: [],
              currentMatrices: [],
              mesh: null,
              lod: -1,
            };
            batches.set(p.kind, batch);
          }

          this.scratchPos.set(p.x, p.y, p.z);
          this.scratchQuat.setFromAxisAngle(this.upAxis, p.yaw);
          this.scratchScale.set(p.scale, p.scaleY, p.scale);
          const m = new Matrix4().compose(this.scratchPos, this.scratchQuat, this.scratchScale);
          const idx = batch.placements.length;
          batch.placements.push(p);
          batch.baseMatrices.push(m);
          batch.currentMatrices.push(this.depletedIds.has(p.id) ? ZERO_MATRIX : m);
          instanceLookup.set(p.id, { batch, index: idx });
        }
      }
    }

    if (!Number.isFinite(minY)) {
      minY = 0;
      maxY = 30;
    }

    const minX = groupX * GROUP_METRES - 4;
    const minZ = groupZ * GROUP_METRES - 4;
    const maxX = (groupX + 1) * GROUP_METRES + 4;
    const maxZ = (groupZ + 1) * GROUP_METRES + 4;
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;

    const boundingBox = new Box3(
      new Vector3(minX, minY - 2, minZ),
      new Vector3(maxX, maxY + 8, maxZ),
    );
    const boundingSphere = new Sphere(
      new Vector3(centerX, centerY, centerZ),
      Math.hypot(GROUP_METRES * 0.72, (maxY - minY) * 0.5 + 8),
    );

    return {
      groupKey,
      groupX,
      groupZ,
      centerX,
      centerY,
      centerZ,
      boundingBox,
      boundingSphere,
      chunkKeys,
      batches,
      instanceLookup,
      collidersRegistered: false,
    };
  }

  private updateGroupLodsAndColliders(focusX: number, focusZ: number): void {
    const scale = this.preset.lodDistanceScale;
    const lod0Max = 88 * scale;
    const lod1Max = 185 * scale;
    const propCullDist = 215 * scale;
    const colliderRange = 135;

    let instanceSum = 0;

    for (const group of this.activeGroups.values()) {
      const dist = Math.hypot(group.centerX - focusX, group.centerZ - focusZ);

      // Register static colliders only for groups near the player
      const wantColliders = dist <= colliderRange;
      if (wantColliders && !group.collidersRegistered) {
        this.registerGroupColliders(group);
      } else if (!wantColliders && group.collidersRegistered) {
        this.unregisterGroupColliders(group);
      }

      const treeLod: TreeLodTier = dist <= lod0Max ? 0 : dist <= lod1Max ? 1 : 2;
      const propLod: PropLodTier = dist <= lod0Max ? 0 : 1;

      for (const batch of group.batches.values()) {
        if (batch.placements.length === 0) continue;

        const isTree = batch.kind === "pine";
        const isSmallBush = batch.kind === "bush_berry" || batch.kind === "bush_fiber";
        const maxDist = isSmallBush ? lod1Max : isTree ? Infinity : propCullDist;

        if (dist > maxDist) {
          if (batch.mesh) {
            this.root.remove(batch.mesh);
            batch.mesh.dispose();
            batch.mesh = null;
            batch.lod = -1;
          }
          continue;
        }

        const targetLod = isTree ? treeLod : propLod;
        if (batch.mesh === null || batch.lod !== targetLod) {
          this.rebuildBatchMesh(group, batch, targetLod);
        }

        if (batch.mesh) {
          // Cast shadows only in the near LOD0 ring
          batch.mesh.castShadow = this.preset.shadows !== "off" && targetLod === 0 && !isSmallBush;
          instanceSum += batch.placements.length;
        }
      }
    }

    this.totalInstances = instanceSum;
  }

  private rebuildBatchMesh(group: ChunkGroupRecord, batch: SpeciesBatch, lod: number): void {
    if (batch.mesh) {
      this.root.remove(batch.mesh);
      batch.mesh.dispose();
    }

    const geo = this.getGeometryFor(batch.kind, lod);
    const mat = this.getMaterialFor(batch.kind, lod);
    const count = batch.placements.length;
    const mesh = new InstancedMesh(geo, mat, count);

    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, batch.currentMatrices[i]!);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // Assign precomputed group bounding sphere & box so three.js frustum-culls
    // each 128 m × 128 m chunk group accurately (ARCHITECTURE.md §6.4).
    mesh.boundingBox = group.boundingBox.clone();
    mesh.boundingSphere = group.boundingSphere.clone();
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;

    batch.mesh = mesh;
    batch.lod = lod;
    this.root.add(mesh);
  }

  private registerGroupColliders(group: ChunkGroupRecord): void {
    for (const batch of group.batches.values()) {
      for (let i = 0; i < batch.placements.length; i++) {
        const p = batch.placements[i]!;
        if (p.colliderRadius <= 0 || this.depletedIds.has(p.id)) continue;
        this.collision.addCircle({
          x: p.x,
          z: p.z,
          radius: p.colliderRadius,
          minY: p.y,
          maxY: p.y + p.colliderHeight,
          tag: p.kind,
          chunkKey: `env:${group.groupKey}`,
        });
      }
    }
    group.collidersRegistered = true;
  }

  private unregisterGroupColliders(group: ChunkGroupRecord): void {
    this.collision.removeByChunk(`env:${group.groupKey}`);
    group.collidersRegistered = false;
  }

  private unloadGroup(group: ChunkGroupRecord): void {
    if (group.collidersRegistered) {
      this.unregisterGroupColliders(group);
    }
    for (const batch of group.batches.values()) {
      if (batch.mesh) {
        this.root.remove(batch.mesh);
        batch.mesh.dispose();
        batch.mesh = null;
      }
    }
  }

  // --- Grass Ring (Task 4.4) -----------------------------------------------

  private rebuildGrassRing(): void {
    if (this.grassMesh) {
      this.root.remove(this.grassMesh);
      this.grassMesh.dispose();
      this.grassMesh = null;
    }

    const radius = this.preset.grassRadius;
    const density = this.preset.grassDensity;
    if (radius <= 0 || density <= 0) {
      this.grassCapacity = 0;
      return;
    }

    // Cap grass clump count so Medium Android stays well inside 30 FPS budget
    this.grassCapacity = Math.min(1800, Math.round(radius * radius * density * 1.1));
    const geo = this.assets.geometry("p4.geo.grassClump", () => buildGrassClumpGeometry());
    const mat = this.getGrassMaterial();

    const mesh = new InstancedMesh(geo, mat, this.grassCapacity);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // Always centered around the player
    this.grassMesh = mesh;
    this.root.add(mesh);
    this.lastGrassAnchorX = Number.NaN;
  }

  private updateGrassPatch(focusX: number, focusZ: number, force: boolean): void {
    if (!this.grassMesh || this.grassCapacity <= 0) return;

    const cellSnap = 6;
    const ax = Math.round(focusX / cellSnap) * cellSnap;
    const az = Math.round(focusZ / cellSnap) * cellSnap;
    if (!force && ax === this.lastGrassAnchorX && az === this.lastGrassAnchorZ) {
      return;
    }
    this.lastGrassAnchorX = ax;
    this.lastGrassAnchorZ = az;

    const radius = this.preset.grassRadius;
    const step = Math.max(1.25, (radius * 2) / Math.sqrt(this.grassCapacity * 1.35));
    const halfSteps = Math.floor(radius / step);

    let count = 0;
    for (let gz = -halfSteps; gz <= halfSteps && count < this.grassCapacity; gz++) {
      for (let gx = -halfSteps; gx <= halfSteps && count < this.grassCapacity; gx++) {
        const cellX = Math.round((ax + gx * step) / step);
        const cellZ = Math.round((az + gz * step) / step);
        const h = hashInts(this.heightfield.seed ^ 0x67726173, cellX, cellZ);

        // Deterministic jitter from cell hash
        const jx = ((h & 0xff) / 255 - 0.5) * step * 0.85;
        const jz = (((h >>> 8) & 0xff) / 255 - 0.5) * step * 0.85;
        const wx = cellX * step + jx;
        const wz = cellZ * step + jz;

        const dist = Math.hypot(wx - ax, wz - az);
        if (dist > radius) continue;

        // Distance fade-out at outer edge of grass ring
        const distProb = 1 - smoothstep(radius * 0.55, radius, dist);
        const rand01 = ((h >>> 16) & 0xff) / 255;
        if (rand01 > distProb) continue;

        const water = this.heightfield.waterInfo(wx, wz);
        if (water.hasWater) continue;

        const sample = this.heightfield.sample(wx, wz);
        if (sample.weights.grass + sample.weights.forest * 0.6 < 0.42 || sample.slopeAngle > 0.45) {
          continue;
        }

        const s = (0.75 + (((h >>> 24) & 0xff) / 255) * 0.55) * (0.65 + 0.35 * distProb);
        const yaw = ((h & 0xffff) / 65535) * TAU;

        this.scratchPos.set(wx, sample.height - 0.03, wz);
        this.scratchQuat.setFromAxisAngle(this.upAxis, yaw);
        this.scratchScale.set(s, s, s);
        this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
        this.grassMesh.setMatrixAt(count++, this.scratchMat);
      }
    }

    this.grassMesh.count = count;
    this.grassMesh.instanceMatrix.needsUpdate = true;
  }

  // --- Shared Geometries & Materials with Wind Shader ----------------------

  private getGeometryFor(kind: ScatterKind, lod: number): BufferGeometry {
    switch (kind) {
      case "pine":
        return this.assets.geometry(`p4.geo.pine.lod${lod}`, () =>
          buildPineTreeGeometry(lod as TreeLodTier),
        );
      case "deciduous":
        return this.assets.geometry(`p4.geo.decid.lod${lod}`, () =>
          buildDeciduousTreeGeometry((lod > 0 ? 1 : 0) as PropLodTier),
        );
      case "dead_tree":
        return this.assets.geometry(`p4.geo.dead.lod${lod}`, () =>
          buildDeadTreeGeometry((lod > 0 ? 1 : 0) as PropLodTier),
        );
      case "boulder":
        return this.assets.geometry(`p4.geo.boulder.lod${lod}`, () =>
          buildRockGeometry(true, (lod > 0 ? 1 : 0) as PropLodTier),
        );
      case "rock":
        return this.assets.geometry(`p4.geo.rock.lod${lod}`, () =>
          buildRockGeometry(false, (lod > 0 ? 1 : 0) as PropLodTier),
        );
      case "bush_berry":
        return this.assets.geometry("p4.geo.bush.berry", () => buildBushGeometry(true));
      case "bush_fiber":
        return this.assets.geometry("p4.geo.bush.fiber", () => buildBushGeometry(false));
    }
  }

  private getMaterialFor(kind: ScatterKind, lod: number): Material {
    const tier = this.standardMaterials ? "std" : "lam";

    // Far pine LOD2 uses alpha-tested impostor texture
    if (kind === "pine" && lod === 2) {
      return this.assets.material(`p4.mat.pineImpostor.${tier}`, () => {
        const map = createPineImpostorTexture(this.assets);
        const mat = this.standardMaterials
          ? new MeshStandardMaterial({
              map,
              vertexColors: true,
              alphaTest: 0.42,
              side: DoubleSide,
              roughness: 0.88,
              metalness: 0.0,
              emissive: new Color(0x0c170b),
            })
          : new MeshLambertMaterial({
              map,
              vertexColors: true,
              alphaTest: 0.42,
              side: DoubleSide,
              emissive: new Color(0x0c170b),
            });
        this.attachWindShader(mat, 0.35);
        return mat;
      });
    }

    const isRock = kind === "boulder" || kind === "rock";
    const matCategory = isRock ? "rock" : "foliage";

    return this.assets.material(`p4.mat.${matCategory}.${tier}`, () => {
      // Foliage gets a subtle warm-green ambient emissive lift so pine/bush
      // crowns never crush to pitch black on mobile Lambert/Standard shading.
      const emissiveHex = isRock ? 0x050504 : 0x0e190c;
      const mat = this.standardMaterials
        ? new MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: isRock ? 0.9 : 0.84,
            metalness: 0.0,
            emissive: new Color(emissiveHex),
          })
        : new MeshLambertMaterial({
            color: 0xffffff,
            vertexColors: true,
            emissive: new Color(emissiveHex),
          });

      if (!isRock) {
        this.attachWindShader(mat, 0.22);
      }
      return mat;
    });
  }

  private getGrassMaterial(): Material {
    const tier = this.standardMaterials ? "std" : "lam";
    return this.assets.material(`p4.mat.grass.${tier}`, () => {
      const mat = this.standardMaterials
        ? new MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            side: DoubleSide,
            roughness: 0.85,
            metalness: 0.0,
            emissive: new Color(0x0d170a),
          })
        : new MeshLambertMaterial({
            color: 0xffffff,
            vertexColors: true,
            side: DoubleSide,
            emissive: new Color(0x0d170a),
          });
      this.attachWindShader(mat, 0.26);
      return mat;
    });
  }

  private attachWindShader(mat: Material, amplitude: number): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms["uTime"] = this.windUniforms.uTime;
      shader.uniforms["uWindStrength"] = this.windUniforms.uWindStrength;
      shader.uniforms["uWindDir"] = this.windUniforms.uWindDir;

      shader.vertexShader =
        /* glsl */ `
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec3 uWindDir;
        ` +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          /* glsl */ `
          #include <begin_vertex>
          float swayMask = uv.y;
          if (swayMask > 0.001) {
            vec3 instPos = vec3(0.0);
            #ifdef USE_INSTANCING
              instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            #endif
            float phase = (instPos.x + transformed.x) * 0.23 + (instPos.z + transformed.z) * 0.19 + uTime * 2.1;
            float gust = sin(phase) + 0.45 * cos(phase * 1.7);
            float disp = gust * swayMask * uWindStrength * ${amplitude.toFixed(3)};
            transformed.x += uWindDir.x * disp;
            transformed.z += uWindDir.z * disp;
          }
          `,
        );
    };
  }
}
