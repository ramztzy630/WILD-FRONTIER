/**
 * Analytic heightfield, surface normals, slope, water depth queries, and
 * biome material weights (ARCHITECTURE.md §6.1, §6.2, §6.6).
 *
 * Pure and worker-safe: produces identical values on the main thread and
 * inside ChunkWorker so collision and rendered terrain match.
 */

import { hashInts } from "../core/Random.ts";
import { clamp, clamp01, lerp, smoothstep } from "../core/math.ts";
import { SimplexNoise } from "./Noise.ts";
import {
  BOUNDARY_MARGIN,
  WORLD_HALF,
  WorldGenerator,
  type RiverSpline,
  type WorldLayout,
} from "./WorldGenerator.ts";

export interface BiomeWeights {
  grass: number;
  forest: number;
  dirt: number;
  sand: number;
  rock: number;
  snow: number;
}

export interface HeightSample {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Slope angle in radians (0 = flat horizontal, PI/2 = vertical cliff). */
  slopeAngle: number;
  weights: BiomeWeights;
  colorR: number;
  colorG: number;
  colorB: number;
}

export interface WaterInfo {
  hasWater: boolean;
  surfaceY: number;
  depth: number;
  flowX: number;
  flowZ: number;
  kind: "none" | "lake" | "river" | "waterfall";
}

interface RiverHit {
  dist: number;
  width: number;
  waterY: number;
  bedDepth: number;
  flowX: number;
  flowZ: number;
}

export class Heightfield {
  readonly seed: number;
  readonly layout: WorldLayout;
  private readonly terrainNoise: SimplexNoise;
  private readonly ridgeNoise: SimplexNoise;
  private readonly biomeNoise: SimplexNoise;

  constructor(seed: number, layout?: WorldLayout) {
    this.seed = seed >>> 0;
    this.layout = layout ?? new WorldGenerator(this.seed).layout;
    this.terrainNoise = new SimplexNoise(hashInts(this.seed, 0x101));
    this.ridgeNoise = new SimplexNoise(hashInts(this.seed, 0x202));
    this.biomeNoise = new SimplexNoise(hashInts(this.seed, 0x303));
  }

  /** Evaluates the ground elevation (metres) at world coordinates (x, z). */
  height(x: number, z: number): number {
    const { lake, waterfall, pois } = this.layout;

    // 1. Base valley undulation
    const valley =
      16.8 +
      this.terrainNoise.warpedFbm(x * 0.0018, z * 0.0018, 0.5, 0.55, 4) * 9.5 +
      this.terrainNoise.fbm(x * 0.0075, z * 0.0075, 3) * 2.4;

    // 2. Northern highland shelf + waterfall cliff step + mountain range
    const wfStep = 1 - smoothstep(waterfall.z - 16, waterfall.z + 16, z);
    const northFactor = 1 - smoothstep(-780, -240, z);
    const ridge = this.ridgeNoise.ridged(x * 0.0022, z * 0.0022, 4);
    const northHighlands = wfStep * 12.5 + northFactor * (14.0 + ridge * 32.0);

    // 3. Outer world boundary ring rises into impassable crags
    const edgeDistX = WORLD_HALF - Math.abs(x);
    const edgeDistZ = WORLD_HALF - Math.abs(z);
    const minEdgeDist = Math.min(edgeDistX, edgeDistZ);
    const boundaryBlend = 1 - smoothstep(40, BOUNDARY_MARGIN + 90, minEdgeDist);
    const boundaryHeight = boundaryBlend * boundaryBlend * (26.0 + ridge * 28.0);

    let h = valley + northHighlands + boundaryHeight;

    // 4. Lake basin & shoreline shaping
    const lx = (x - lake.x) / lake.radiusX;
    const lz = (z - lake.z) / lake.radiusZ;
    const lakeWobble = this.terrainNoise.noise2D(x * 0.009, z * 0.009) * 0.08;
    const lakeNorm = Math.hypot(lx, lz) + lakeWobble;
    if (lakeNorm < 1.45) {
      const shoreHeight = lake.waterY + 0.35;
      const shoreT = smoothstep(0.95, 1.45, lakeNorm);
      h = lerp(shoreHeight, h, shoreT);
      if (lakeNorm < 1.0) {
        const bowl = 1 - lakeNorm * lakeNorm;
        const bedY = lake.waterY - 0.55 - lake.maxDepth * bowl;
        const innerT = smoothstep(0.78, 1.0, lakeNorm);
        h = lerp(bedY, h, innerT);
      }
    }

    // 5. POI pad flattening (applied before river carving so bridges don't block rivers)
    for (let i = 0; i < pois.length; i++) {
      const poi = pois[i]!;
      const dx = x - poi.x;
      const dz = z - poi.z;
      if (Math.abs(dx) > poi.flattenRadius || Math.abs(dz) > poi.flattenRadius) continue;
      const d = Math.hypot(dx, dz);
      if (d < poi.flattenRadius) {
        const t = smoothstep(poi.radius * 0.55, poi.flattenRadius, d);
        h = lerp(poi.y, h, t);
      }
    }

    // 6. River channel and bank carving
    const hit = this.nearestRiverPoint(x, z);
    if (hit !== null) {
      const halfW = hit.width * 0.5;
      const bankW = hit.width * 2.8;
      if (hit.dist < bankW) {
        const bankTarget = hit.waterY + 0.3;
        const bankT = smoothstep(halfW, bankW, hit.dist);
        h = Math.min(h, lerp(bankTarget, h, bankT));
        if (hit.dist < halfW * 1.15) {
          const u = clamp01(hit.dist / (halfW * 1.15));
          const channelProfile = 1 - u * u;
          const bedY = hit.waterY - 0.25 - hit.bedDepth * channelProfile;
          h = Math.min(h, bedY);
        }
      }
    }

    return h;
  }

  /** Computes the unit surface normal at (x, z) by central differences. */
  normal(
    x: number,
    z: number,
    out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 },
  ): { x: number; y: number; z: number } {
    const eps = 0.75;
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    const nx = hL - hR;
    const ny = 2 * eps;
    const nz = hD - hU;
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    out.x = nx * inv;
    out.y = ny * inv;
    out.z = nz * inv;
    return out;
  }

  /** Slope angle in radians at (x, z) (0 = flat, PI/2 = vertical). */
  slopeAngle(x: number, z: number): number {
    const n = this.normal(x, z);
    return Math.acos(clamp(n.y, -1, 1));
  }

  /** Queries water surface height, depth, flow direction, and body kind at (x, z). */
  waterInfo(x: number, z: number): WaterInfo {
    const groundY = this.height(x, z);
    const { lake, waterfall } = this.layout;

    let surfaceY = -Infinity;
    let flowX = 0;
    let flowZ = 0;
    let kind: WaterInfo["kind"] = "none";

    // Check lake domain
    const lx = (x - lake.x) / (lake.radiusX * 1.08);
    const lz = (z - lake.z) / (lake.radiusZ * 1.08);
    if (lx * lx + lz * lz <= 1.0) {
      surfaceY = lake.waterY;
      kind = "lake";
    }

    // Check rivers
    const hit = this.nearestRiverPoint(x, z);
    if (hit !== null && hit.dist <= hit.width * 0.62) {
      if (hit.waterY >= surfaceY) {
        surfaceY = hit.waterY;
        flowX = hit.flowX;
        flowZ = hit.flowZ;
        const nearWaterfall =
          Math.abs(x - waterfall.x) < waterfall.width * 0.9 && Math.abs(z - waterfall.z) < 16;
        kind = nearWaterfall ? "waterfall" : "river";
      }
    }

    const depth = surfaceY > groundY ? surfaceY - groundY : 0;
    if (depth <= 0.01) {
      return { hasWater: false, surfaceY: groundY, depth: 0, flowX: 0, flowZ: 0, kind: "none" };
    }
    return {
      hasWater: true,
      surfaceY,
      depth,
      flowX,
      flowZ,
      kind,
    };
  }

  /** Full sample (height, normal, slope, biome weights, and vertex RGB colour). */
  sample(x: number, z: number): HeightSample {
    const height = this.height(x, z);
    const n = this.normal(x, z);
    const slopeAngle = Math.acos(clamp(n.y, -1, 1));
    const moisture = 0.5 + 0.5 * this.biomeNoise.fbm(x * 0.0025, z * 0.0025, 3);
    const detail = this.biomeNoise.noise2D(x * 0.04, z * 0.04);

    const { lake } = this.layout;
    const waterDist = Math.abs(height - lake.waterY);

    // Raw unnormalized weights
    let sand = (1 - smoothstep(0.0, 2.2, waterDist)) * (1 - smoothstep(0.22, 0.45, slopeAngle));
    if (height < lake.waterY + 0.4) sand = Math.max(sand, 0.75 * (1 - smoothstep(0.3, 0.6, slopeAngle)));

    const rock = smoothstep(0.32, 0.62, slopeAngle) + smoothstep(38, 56, height) * 0.55;
    const snow = smoothstep(46, 58, height) * (1 - smoothstep(0.55, 0.85, slopeAngle));
    const dirt = smoothstep(0.18, 0.38, slopeAngle) * (1 - rock) * 0.45;
    const forestMask = smoothstep(0.45, 0.72, moisture) * (1 - smoothstep(34, 46, height));
    const forest = Math.max(0, (1 - sand - rock - snow) * forestMask);
    const grass = Math.max(0.01, (1 - sand - rock - snow - dirt) * (1 - forestMask * 0.75));

    const sum = grass + forest + dirt + sand + rock + snow || 1;
    const weights: BiomeWeights = {
      grass: grass / sum,
      forest: forest / sum,
      dirt: dirt / sum,
      sand: sand / sum,
      rock: rock / sum,
      snow: snow / sum,
    };

    // Earthy wilderness palette (DESIGN-SYSTEM.md / PRD §5)
    const shade = 0.94 + detail * 0.06;
    const r =
      (weights.grass * 0.33 +
        weights.forest * 0.21 +
        weights.dirt * 0.41 +
        weights.sand * 0.56 +
        weights.rock * 0.43 +
        weights.snow * 0.86) *
      shade;
    const g =
      (weights.grass * 0.45 +
        weights.forest * 0.31 +
        weights.dirt * 0.34 +
        weights.sand * 0.51 +
        weights.rock * 0.42 +
        weights.snow * 0.88) *
      shade;
    const b =
      (weights.grass * 0.24 +
        weights.forest * 0.18 +
        weights.dirt * 0.24 +
        weights.sand * 0.38 +
        weights.rock * 0.39 +
        weights.snow * 0.91) *
      shade;

    return {
      height,
      normalX: n.x,
      normalY: n.y,
      normalZ: n.z,
      slopeAngle,
      weights,
      colorR: clamp01(r),
      colorG: clamp01(g),
      colorB: clamp01(b),
    };
  }

  private nearestRiverPoint(x: number, z: number): RiverHit | null {
    const rivers = this.layout.rivers;
    let bestDistSq = Infinity;
    let bestRiver: RiverSpline | null = null;
    let bestSegIdx = 0;
    let bestT = 0;

    for (let r = 0; r < rivers.length; r++) {
      const river = rivers[r]!;
      if (x < river.minX || x > river.maxX || z < river.minZ || z > river.maxZ) continue;
      const pts = river.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const lenSq = abx * abx + abz * abz;
        const t = lenSq > 0 ? clamp01(((x - a.x) * abx + (z - a.z) * abz) / lenSq) : 0;
        const px = a.x + abx * t;
        const pz = a.z + abz * t;
        const dSq = (x - px) * (x - px) + (z - pz) * (z - pz);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestRiver = river;
          bestSegIdx = i;
          bestT = t;
        }
      }
    }

    if (bestRiver === null) return null;
    const a = bestRiver.points[bestSegIdx]!;
    const b = bestRiver.points[bestSegIdx + 1]!;
    const fx = lerp(a.flowX, b.flowX, bestT);
    const fz = lerp(a.flowZ, b.flowZ, bestT);
    const flen = Math.hypot(fx, fz) || 1;
    return {
      dist: Math.sqrt(bestDistSq),
      width: lerp(a.width, b.width, bestT),
      waterY: lerp(a.waterY, b.waterY, bestT),
      bedDepth: lerp(a.bedDepth, b.bedDepth, bestT),
      flowX: fx / flen,
      flowZ: fz / flen,
    };
  }
}
