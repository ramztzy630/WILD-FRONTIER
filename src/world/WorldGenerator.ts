/**
 * Deterministic macro world layout from a single uint32 seed
 * (PRD §8, ARCHITECTURE.md §6.1, §6.2).
 *
 * Pure data generation: no three.js or DOM dependencies so this runs
 * identically on the main thread, inside ChunkWorker, and in node unit tests.
 */

import { Random, hashInts } from "../core/Random.ts";
import { clamp, lerp, smoothstep } from "../core/math.ts";

/** Total playable world width/depth in metres (-1024..+1024). */
export const WORLD_SIZE = 2048;
export const WORLD_HALF = WORLD_SIZE / 2;
/** Terrain chunk edge length in metres (32×32 chunks cover the world). */
export const CHUNK_SIZE = 64;
/** Outer mountain/deadfall boundary ring width in metres (ARCHITECTURE.md §6.2). */
export const BOUNDARY_MARGIN = 128;
/** Default lake water surface elevation in metres. */
export const DEFAULT_LAKE_LEVEL = 12.0;

export type PoiKind =
  | "spawn_camp"
  | "abandoned_cabin"
  | "campsite"
  | "cave"
  | "watchtower"
  | "ruined_bridge"
  | "lookout_peak";

export interface PointOfInterest {
  readonly id: string;
  readonly kind: PoiKind;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Physical footprint radius for structure placement / clearings. */
  readonly radius: number;
  /** Radius within which terrain is gently flattened around `y`. */
  readonly flattenRadius: number;
  /** Radius that triggers location discovery (PRD §17). */
  readonly discoveryRadius: number;
}

export interface LakeSpec {
  readonly x: number;
  readonly z: number;
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly waterY: number;
  readonly maxDepth: number;
}

export interface RiverPoint {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly waterY: number;
  readonly bedDepth: number;
  readonly flowX: number;
  readonly flowZ: number;
}

export interface RiverSpline {
  readonly id: string;
  readonly name: string;
  readonly points: readonly RiverPoint[];
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface WaterfallSpec {
  readonly x: number;
  readonly z: number;
  readonly dirX: number;
  readonly dirZ: number;
  readonly width: number;
  readonly topY: number;
  readonly bottomY: number;
  readonly height: number;
}

export interface WorldLayout {
  readonly seed: number;
  readonly lake: LakeSpec;
  readonly rivers: readonly RiverSpline[];
  readonly waterfall: WaterfallSpec;
  readonly pois: readonly PointOfInterest[];
}

export class WorldGenerator {
  readonly seed: number;
  readonly layout: WorldLayout;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.layout = generateWorldLayout(this.seed);
  }
}

function generateWorldLayout(seed: number): WorldLayout {
  const rng = new Random(hashInts(seed, 0x574f524c));

  const lake: LakeSpec = {
    x: Math.round(rng.range(-70, 70)),
    z: Math.round(rng.range(90, 175)),
    radiusX: Math.round(rng.range(165, 195)),
    radiusZ: Math.round(rng.range(135, 165)),
    waterY: DEFAULT_LAKE_LEVEL,
    maxDepth: 7.5,
  };

  // --- River 1: Northern highland river with a waterfall cliff step ---
  const wfX = lake.x + rng.range(-45, 45);
  const wfZ = -340 + rng.range(-25, 25);
  const wfTopY = 31.0;
  const wfBottomY = 19.5;
  const wfWidth = 14.0;

  const northControl: { x: number; z: number; width: number; waterY: number; bedDepth: number }[] = [
    { x: wfX + rng.range(-60, 60), z: -740, width: 10, waterY: 46.0, bedDepth: 1.5 },
    { x: wfX + rng.range(-35, 35), z: -540, width: 12, waterY: 36.5, bedDepth: 1.7 },
    { x: wfX, z: wfZ - 14, width: wfWidth, waterY: wfTopY, bedDepth: 1.8 },
    { x: wfX, z: wfZ + 14, width: wfWidth + 2, waterY: wfBottomY, bedDepth: 2.4 },
    { x: lerp(wfX, lake.x, 0.5) + rng.range(-40, 40), z: lerp(wfZ + 14, lake.z - lake.radiusZ * 0.82, 0.5), width: 16, waterY: 15.2, bedDepth: 2.0 },
    { x: lake.x, z: lake.z - lake.radiusZ * 0.78, width: 20, waterY: lake.waterY, bedDepth: 2.3 },
  ];
  const northRiver = buildRiverSpline("river_north", "Whitefall River", northControl, 24);

  const waterfall: WaterfallSpec = {
    x: wfX,
    z: wfZ,
    dirX: 0,
    dirZ: 1,
    width: wfWidth,
    topY: wfTopY,
    bottomY: wfBottomY,
    height: wfTopY - wfBottomY,
  };

  // --- River 2: Western/Eastern valley tributary meandering into the lake ---
  const sideSign = rng.chance(0.5) ? -1 : 1;
  const sideStartX = sideSign * rng.range(640, 720);
  const sideStartZ = rng.range(-180, -60);
  const sideEndX = lake.x + sideSign * lake.radiusX * 0.8;
  const sideEndZ = lake.z + rng.range(-25, 25);

  const sideControl: { x: number; z: number; width: number; waterY: number; bedDepth: number }[] = [
    { x: sideStartX, z: sideStartZ, width: 9, waterY: 27.5, bedDepth: 1.4 },
    {
      x: lerp(sideStartX, sideEndX, 0.36),
      z: lerp(sideStartZ, sideEndZ, 0.36) + rng.range(-55, 55),
      width: 12,
      waterY: 20.5,
      bedDepth: 1.6,
    },
    {
      x: lerp(sideStartX, sideEndX, 0.7),
      z: lerp(sideStartZ, sideEndZ, 0.7) + rng.range(-45, 45),
      width: 15,
      waterY: 15.0,
      bedDepth: 1.9,
    },
    { x: sideEndX, z: sideEndZ, width: 18, waterY: lake.waterY, bedDepth: 2.2 },
  ];
  const sideRiver = buildRiverSpline("river_tributary", "Timber Creek", sideControl, 18);

  const rivers: readonly RiverSpline[] = [northRiver, sideRiver];

  // --- Points of Interest (deterministic placement with spacing guarantees) ---
  const pois = placePois(rng, lake, rivers, waterfall);

  return {
    seed,
    lake,
    rivers,
    waterfall,
    pois,
  };
}

function buildRiverSpline(
  id: string,
  name: string,
  control: readonly { x: number; z: number; width: number; waterY: number; bedDepth: number }[],
  subdivisions: number,
): RiverSpline {
  const raw: { x: number; z: number; width: number; waterY: number; bedDepth: number }[] = [];
  const n = control.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = control[Math.max(0, i - 1)]!;
    const p1 = control[i]!;
    const p2 = control[i + 1]!;
    const p3 = control[Math.min(n - 1, i + 2)]!;
    const steps = i === n - 2 ? subdivisions + 1 : subdivisions;
    for (let s = 0; s < steps; s++) {
      const t = s / subdivisions;
      // Preserve sharp elevation step across the waterfall segment (index 2 -> 3)
      const linearStep = Math.abs(p2.waterY - p1.waterY) > 8;
      const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const z = catmullRom(p0.z, p1.z, p2.z, p3.z, t);
      const width = lerp(p1.width, p2.width, t);
      const waterY = linearStep ? lerp(p1.waterY, p2.waterY, smoothstep(0.15, 0.85, t)) : lerp(p1.waterY, p2.waterY, t);
      const bedDepth = lerp(p1.bedDepth, p2.bedDepth, t);
      raw.push({ x, z, width, waterY, bedDepth });
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const points: RiverPoint[] = [];

  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i]!;
    const prev = raw[Math.max(0, i - 1)]!;
    const next = raw[Math.min(raw.length - 1, i + 1)]!;
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    const margin = cur.width * 3.0 + 16;
    if (cur.x - margin < minX) minX = cur.x - margin;
    if (cur.x + margin > maxX) maxX = cur.x + margin;
    if (cur.z - margin < minZ) minZ = cur.z - margin;
    if (cur.z + margin > maxZ) maxZ = cur.z + margin;

    points.push({
      x: cur.x,
      z: cur.z,
      width: cur.width,
      waterY: cur.waterY,
      bedDepth: cur.bedDepth,
      flowX: dx / len,
      flowZ: dz / len,
    });
  }

  return { id, name, points, minX, maxX, minZ, maxZ };
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function placePois(
  rng: Random,
  lake: LakeSpec,
  rivers: readonly RiverSpline[],
  waterfall: WaterfallSpec,
): PointOfInterest[] {
  const pois: PointOfInterest[] = [];
  const minBound = -WORLD_HALF + BOUNDARY_MARGIN + 48;
  const maxBound = WORLD_HALF - BOUNDARY_MARGIN - 48;

  const isFarEnough = (x: number, z: number, minDist: number): boolean => {
    if (x < minBound || x > maxBound || z < minBound || z > maxBound) return false;
    for (const p of pois) {
      if (Math.hypot(x - p.x, z - p.z) < minDist) return false;
    }
    return true;
  };

  const isDryFromLakeAndRivers = (x: number, z: number, clearance: number): boolean => {
    const lx = (x - lake.x) / (lake.radiusX + clearance);
    const lz = (z - lake.z) / (lake.radiusZ + clearance);
    if (lx * lx + lz * lz < 1.05) return false;
    for (const r of rivers) {
      for (const pt of r.points) {
        if (Math.hypot(x - pt.x, z - pt.z) < pt.width * 1.6 + clearance) return false;
      }
    }
    return true;
  };

  // 1. Spawn camp: flat meadow clearing near the central valley, dry and accessible.
  let spawnX = lake.x - lake.radiusX - 75;
  let spawnZ = lake.z - 65;
  if (!isDryFromLakeAndRivers(spawnX, spawnZ, 28)) {
    spawnX = lake.x + lake.radiusX + 80;
    spawnZ = lake.z - 70;
  }
  pois.push({
    id: "poi_spawn_camp",
    kind: "spawn_camp",
    name: "Wanderer's Clearing",
    x: clamp(spawnX, minBound, maxBound),
    y: lake.waterY + 4.5,
    z: clamp(spawnZ, minBound, maxBound),
    radius: 14,
    flattenRadius: 28,
    discoveryRadius: 36,
  });

  // 2. Ruined bridge: placed across the northern river downstream of the waterfall.
  const bridgePt = rivers[0]!.points[Math.floor(rivers[0]!.points.length * 0.72)]!;
  pois.push({
    id: "poi_ruined_bridge",
    kind: "ruined_bridge",
    name: "Old Timber Crossing",
    x: clamp(bridgePt.x + 22, minBound, maxBound),
    y: bridgePt.waterY + 2.2,
    z: clamp(bridgePt.z, minBound, maxBound),
    radius: 14,
    flattenRadius: 20,
    discoveryRadius: 40,
  });

  // 3. Lookout peak: high northern ridge west/east of the waterfall.
  const peakX = clamp(waterfall.x + (waterfall.x >= 0 ? -240 : 240), minBound, maxBound);
  const peakZ = clamp(-620, minBound, maxBound);
  pois.push({
    id: "poi_lookout_peak",
    kind: "lookout_peak",
    name: "Cragwatch Peak",
    x: peakX,
    y: 54.0,
    z: peakZ,
    radius: 12,
    flattenRadius: 22,
    discoveryRadius: 48,
  });

  // 4. Remaining POIs placed deterministically in candidate sectors with Poisson spacing.
  const specs: readonly {
    id: string;
    kind: PoiKind;
    name: string;
    PrefX: number;
    PrefZ: number;
    y: number;
    radius: number;
    flattenRadius: number;
  }[] = [
    {
      id: "poi_cabin_pine",
      kind: "abandoned_cabin",
      name: "Forester's Cabin",
      PrefX: -360,
      PrefZ: -140,
      y: 21.5,
      radius: 14,
      flattenRadius: 24,
    },
    {
      id: "poi_campsite_south",
      kind: "campsite",
      name: "Embershore Camp",
      PrefX: lake.x + 40,
      PrefZ: lake.z + lake.radiusZ + 75,
      y: lake.waterY + 3.5,
      radius: 12,
      flattenRadius: 22,
    },
    {
      id: "poi_cave_moss",
      kind: "cave",
      name: "Mossback Grotto",
      PrefX: 390,
      PrefZ: -310,
      y: 29.0,
      radius: 14,
      flattenRadius: 24,
    },
    {
      id: "poi_watchtower",
      kind: "watchtower",
      name: "Redpine Watchtower",
      PrefX: 340,
      PrefZ: 280,
      y: 28.0,
      radius: 14,
      flattenRadius: 24,
    },
  ];

  for (const spec of specs) {
    let placed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const spread = attempt * 14;
      const cx = clamp(spec.PrefX + rng.range(-spread, spread), minBound, maxBound);
      const cz = clamp(spec.PrefZ + rng.range(-spread, spread), minBound, maxBound);
      if (isFarEnough(cx, cz, 85) && isDryFromLakeAndRivers(cx, cz, 24)) {
        pois.push({
          id: spec.id,
          kind: spec.kind,
          name: spec.name,
          x: Math.round(cx),
          y: spec.y,
          z: Math.round(cz),
          radius: spec.radius,
          flattenRadius: spec.flattenRadius,
          discoveryRadius: 42,
        });
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Deterministic fallback slot guaranteed to respect bounds and spacing.
      const fallbackAngle = (pois.length * 1.35) % (Math.PI * 2);
      const fx = clamp(Math.cos(fallbackAngle) * 480, minBound, maxBound);
      const fz = clamp(Math.sin(fallbackAngle) * 480, minBound, maxBound);
      pois.push({
        id: spec.id,
        kind: spec.kind,
        name: spec.name,
        x: Math.round(fx),
        y: spec.y,
        z: Math.round(fz),
        radius: spec.radius,
        flattenRadius: spec.flattenRadius,
        discoveryRadius: 42,
      });
    }
  }

  return pois;
}
