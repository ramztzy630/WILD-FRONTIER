/**
 * Procedural landmarks and Point-of-Interest (POI) structures:
 *   - Spawn Camp ("Wanderer's Clearing"): lean-to shelter, stone firepit, log bench, supply crate
 *   - Abandoned Cabin ("Forester's Cabin"): timber walls with open doorway, gable roof, chimney, porch, crate
 *   - Campsite ("Embershore Camp"): canvas A-frame tent, fire ring, drying rack, log seats, supply pack
 *   - Cave ("Mossback Grotto"): hillside rock-shell overhang/grotto with dry interior shelter zone & chest (R7)
 *   - Watchtower ("Redpine Watchtower"): 4-post timber lookout tower, braced frame, elevated deck, roof, crate
 *   - Ruined Bridge ("Old Timber Crossing"): stone abutments, broken timber deck spans, pilings, crate
 *   - Lookout Peak ("Cragwatch Peak"): summit stone cairn monument, signpost, supply cache
 *
 * Pure layout & geometry builders have zero DOM/WebGL side effects so they can
 * be tested deterministically in Node unit tests (PRD §5, §8; ARCHITECTURE.md §6.2, §6.6, R7; Task 4.5).
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Material,
  type Scene,
} from "three";
import type { AssetManager } from "../core/AssetManager.ts";
import type { GraphicsPreset } from "../core/GraphicsSettings.ts";
import { Random, hashInts } from "../core/Random.ts";
import { clamp01, lerp } from "../core/math.ts";
import type { BoxColliderSpec, CircleColliderSpec, CollisionWorld } from "./Collision.ts";
import type { Heightfield } from "./Heightfield.ts";
import type { PoiKind, PointOfInterest } from "./WorldGenerator.ts";

export type LootContainerKind = "crate" | "chest" | "pack";

export interface LootContainerSpec {
  readonly id: string;
  readonly poiId: string;
  readonly name: string;
  readonly kind: LootContainerKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly radius: number;
}

export interface ShelterZone {
  readonly id: string;
  readonly poiId: string;
  readonly kind: PoiKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export type LandmarkColliderSpec =
  | ({ readonly shape: "box" } & BoxColliderSpec)
  | ({ readonly shape: "circle" } & CircleColliderSpec);

export interface LandmarkDescriptor {
  readonly poiId: string;
  readonly kind: PoiKind;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly hasShelter: boolean;
  readonly shelterZones: readonly ShelterZone[];
  readonly containers: readonly LootContainerSpec[];
  readonly colliders: readonly LandmarkColliderSpec[];
}

export interface LandmarkWorldLayout {
  readonly seed: number;
  readonly landmarks: readonly LandmarkDescriptor[];
  readonly shelterZones: readonly ShelterZone[];
  readonly containers: readonly LootContainerSpec[];
}

// --- Pure deterministic Landmark Layout Builder (Task 4.5) -----------------

function localToWorld(
  originX: number,
  originZ: number,
  yaw: number,
  lx: number,
  lz: number,
): { x: number; z: number } {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: originX + lx * cos - lz * sin,
    z: originZ + lx * sin + lz * cos,
  };
}

/**
 * Deterministically builds the physical layout (orientations, shelter zones,
 * loot containers, and colliders) for all POIs in `heightfield.layout.pois`.
 */
export function buildLandmarkLayout(heightfield: Heightfield): LandmarkWorldLayout {
  const seed = heightfield.seed;
  const pois = heightfield.layout.pois;
  const landmarks: LandmarkDescriptor[] = [];
  const allShelters: ShelterZone[] = [];
  const allContainers: LootContainerSpec[] = [];

  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i]!;
    const rng = new Random(hashInts((seed ^ 0x4c4d4b31) + i, poi.x, poi.z));
    const desc = buildSingleLandmarkDescriptor(heightfield, poi, rng);
    landmarks.push(desc);
    for (const s of desc.shelterZones) allShelters.push(s);
    for (const c of desc.containers) allContainers.push(c);
  }

  return {
    seed,
    landmarks,
    shelterZones: allShelters,
    containers: allContainers,
  };
}

function buildSingleLandmarkDescriptor(
  heightfield: Heightfield,
  poi: PointOfInterest,
  rng: Random,
): LandmarkDescriptor {
  const baseY = heightfield.height(poi.x, poi.z);
  const chunkKey = `landmark:${poi.id}`;
  const shelters: ShelterZone[] = [];
  const containers: LootContainerSpec[] = [];
  const colliders: LandmarkColliderSpec[] = [];

  // Default orientation faces roughly toward the central lake or valley center
  const toLakeYaw = Math.atan2(
    heightfield.layout.lake.x - poi.x,
    heightfield.layout.lake.z - poi.z,
  );
  const yaw = poi.kind === "spawn_camp" ? 0 : toLakeYaw + rng.range(-0.25, 0.25);

  const addLocalBox = (
    lx: number,
    lz: number,
    halfX: number,
    halfZ: number,
    height: number,
    localYaw = 0,
    tag = "structure",
    yOffset = 0,
  ): void => {
    const w = localToWorld(poi.x, poi.z, yaw, lx, lz);
    const groundY = heightfield.height(w.x, w.z) + yOffset;
    colliders.push({
      shape: "box",
      x: w.x,
      z: w.z,
      halfX,
      halfZ,
      yaw: yaw + localYaw,
      minY: groundY - 0.3,
      maxY: groundY + height,
      tag,
      chunkKey,
    });
  };

  const addLocalCircle = (
    lx: number,
    lz: number,
    radius: number,
    height: number,
    tag = "structure",
  ): void => {
    const w = localToWorld(poi.x, poi.z, yaw, lx, lz);
    const groundY = heightfield.height(w.x, w.z);
    colliders.push({
      shape: "circle",
      x: w.x,
      z: w.z,
      radius,
      minY: groundY - 0.3,
      maxY: groundY + height,
      tag,
      chunkKey,
    });
  };

  const addLocalContainer = (
    suffix: string,
    name: string,
    kind: LootContainerKind,
    lx: number,
    lz: number,
    localYaw = 0,
    yOffset = 0,
  ): void => {
    const w = localToWorld(poi.x, poi.z, yaw, lx, lz);
    const cy = heightfield.height(w.x, w.z) + yOffset;
    containers.push({
      id: `${poi.id}_${suffix}`,
      poiId: poi.id,
      name,
      kind,
      x: w.x,
      y: cy,
      z: w.z,
      yaw: yaw + localYaw,
      radius: 0.55,
    });
    colliders.push({
      shape: "box",
      x: w.x,
      z: w.z,
      halfX: 0.45,
      halfZ: 0.35,
      yaw: yaw + localYaw,
      minY: cy,
      maxY: cy + 0.75,
      tag: "container",
      chunkKey,
    });
  };

  const addLocalShelter = (suffix: string, lx: number, lz: number, radius: number): void => {
    const w = localToWorld(poi.x, poi.z, yaw, lx, lz);
    shelters.push({
      id: `${poi.id}_${suffix}`,
      poiId: poi.id,
      kind: poi.kind,
      x: w.x,
      y: heightfield.height(w.x, w.z),
      z: w.z,
      radius,
    });
  };

  switch (poi.kind) {
    case "spawn_camp": {
      // Keep (0, 0) completely clear for player spawn!
      // Place lean-to shelter at (-4.5, -4.2), firepit at (0.0, -4.0), log bench at (3.2, -3.6), crate at (-2.4, -4.6)
      addLocalBox(-4.5, -4.8, 1.8, 0.35, 2.2, 0.3, "shelter");
      addLocalShelter("shelter", -4.2, -4.0, 2.8);
      addLocalCircle(0.0, -4.0, 0.85, 0.65, "campfire");
      addLocalBox(3.2, -3.6, 1.3, 0.32, 0.65, -0.45, "bench");
      addLocalContainer("crate", "Wanderer's Supply Crate", "crate", -2.3, -4.5, 0.25);
      break;
    }

    case "abandoned_cabin": {
      // Cabin centered at (0, 0), 6.4 m wide (X: -3.2..+3.2) × 5.2 m deep (Z: -2.6..+2.6).
      // Front doorway opening on +Z wall (doorway gap from X = -0.8 to +0.8).
      // Back wall (-Z)
      addLocalBox(0, -2.45, 3.2, 0.28, 3.4, 0, "cabin_wall");
      // Left wall (-X) and Right wall (+X)
      addLocalBox(-3.05, 0, 0.28, 2.6, 3.4, 0, "cabin_wall");
      addLocalBox(3.05, 0, 0.28, 2.6, 3.4, 0, "cabin_wall");
      // Front wall left & right of doorway (+Z = +2.45)
      addLocalBox(-2.0, 2.45, 1.15, 0.28, 3.2, 0, "cabin_wall");
      addLocalBox(2.0, 2.45, 1.15, 0.28, 3.2, 0, "cabin_wall");
      // Stone chimney on right-back exterior
      addLocalBox(3.45, -1.2, 0.55, 0.65, 4.8, 0, "chimney");

      // Interior counts as shelter
      addLocalShelter("cabin_interior", 0, 0, 3.4);
      // Supply crate inside cabin against back-left corner, plus pack on front porch
      addLocalContainer("chest", "Forester's Footlocker", "chest", -1.8, -1.5, 0.1, 0.18);
      addLocalContainer("porch_crate", "Porch Timber Crate", "crate", 1.9, 3.35, -0.2, 0.15);
      break;
    }

    case "campsite": {
      // A-frame canvas tent at (-3.2, -2.2), stone fire ring at (0.6, 0.4), log seats, supply pack
      addLocalBox(-3.2, -2.2, 1.65, 2.0, 2.1, 0.35, "tent");
      addLocalShelter("tent_shelter", -3.2, -2.2, 2.6);
      addLocalCircle(0.6, 0.4, 0.85, 0.6, "campfire");
      addLocalBox(2.8, -1.2, 1.4, 0.32, 0.6, -0.5, "bench");
      addLocalBox(0.4, 3.1, 1.3, 0.32, 0.6, 0.1, "bench");
      addLocalContainer("pack", "Camper's Canvas Pack", "pack", -1.1, -2.5, 0.4);
      break;
    }

    case "cave": {
      // Rock-shell grotto (ARCHITECTURE.md R7): U-shaped boulder shell opening toward +Z.
      // Left rock wall, right rock wall, back rock arch, leaving the interior (-1.8..+1.8, -2.0..+2.5) walkable!
      addLocalBox(-3.1, -0.4, 1.35, 3.2, 4.2, -0.15, "cave_rock");
      addLocalBox(3.1, -0.4, 1.35, 3.2, 4.2, 0.15, "cave_rock");
      addLocalBox(0, -3.4, 3.4, 1.4, 4.5, 0, "cave_rock");
      // Flanking entrance boulders
      addLocalCircle(-3.6, 2.8, 1.25, 2.8, "cave_rock");
      addLocalCircle(3.6, 2.8, 1.25, 2.8, "cave_rock");

      // Cave interior has shelter flag (counts as shelter for temperature & rain)
      addLocalShelter("grotto_shelter", 0, -0.4, 3.6);
      // Supply chest tucked inside the dry grotto
      addLocalContainer("chest", "Ironbound Grotto Chest", "chest", -1.1, -1.8, 0.25);
      break;
    }

    case "watchtower": {
      // 4 sturdy corner timber legs (4.4 m × 4.4 m footprint) + central base ladder & supply crate
      const legOffset = 2.1;
      addLocalCircle(-legOffset, -legOffset, 0.38, 8.5, "watchtower_post");
      addLocalCircle(legOffset, -legOffset, 0.38, 8.5, "watchtower_post");
      addLocalCircle(-legOffset, legOffset, 0.38, 8.5, "watchtower_post");
      addLocalCircle(legOffset, legOffset, 0.38, 8.5, "watchtower_post");
      // Base structural brace / storage platform
      addLocalBox(0, -2.1, 2.1, 0.28, 1.6, 0, "watchtower_brace");
      // Shelter under the tower deck roof
      addLocalShelter("tower_underdeck", 0, 0, 2.6);
      addLocalContainer("crate", "Watchtower Ration Crate", "crate", 1.1, 0.8, -0.3);
      break;
    }

    case "ruined_bridge": {
      // Stone abutment on the near bank + collapsed timber deck piers + supply crate
      addLocalBox(-2.4, 0, 1.8, 2.1, 1.8, 0, "bridge_abutment");
      addLocalBox(2.8, 0, 1.5, 1.8, 1.5, 0.12, "bridge_pier");
      addLocalCircle(-0.2, -1.7, 0.45, 2.1, "bridge_post");
      addLocalCircle(-0.2, 1.7, 0.45, 2.1, "bridge_post");
      addLocalContainer("crate", "Salvor's River Crate", "crate", -3.2, 2.6, 0.35);
      break;
    }

    case "lookout_peak": {
      // High ridge stone cairn monument + timber signpost + mountaineer's pack
      addLocalCircle(0, 0, 1.35, 3.2, "cairn");
      addLocalCircle(2.4, 1.2, 0.28, 2.4, "signpost");
      addLocalContainer("pack", "Mountaineer's Cache", "pack", -1.8, 1.4, 0.5);
      break;
    }
  }

  return {
    poiId: poi.id,
    kind: poi.kind,
    name: poi.name,
    x: poi.x,
    y: baseY,
    z: poi.z,
    yaw,
    hasShelter: shelters.length > 0,
    shelterZones: shelters,
    containers,
    colliders,
  };
}

/**
 * Pure query: returns true if `(x, z)` lies within any landmark shelter zone
 * (caves, cabins, camp lean-tos, tents).
 */
export function isPointInLandmarkShelter(
  layout: LandmarkWorldLayout,
  x: number,
  z: number,
): boolean {
  for (let i = 0; i < layout.shelterZones.length; i++) {
    const s = layout.shelterZones[i]!;
    const dx = x - s.x;
    const dz = z - s.z;
    if (dx * dx + dz * dz <= s.radius * s.radius) {
      return true;
    }
  }
  return false;
}

// --- Procedural Landmark Mesh Builders (Task 4.5) --------------------------

interface PartSpec {
  readonly geo: BufferGeometry;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly shadeBottom?: number;
  readonly shadeTop?: number;
  readonly rockTint?: boolean;
}

function mergeLandmarkParts(parts: readonly PartSpec[]): BufferGeometry {
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
  const indices = new Uint16Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    const g = part.geo;
    const pos = g.getAttribute("position") as BufferAttribute;
    const norm = g.getAttribute("normal") as BufferAttribute;
    const count = pos.count;

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanY = Math.max(0.01, maxY - minY);
    const bot = part.shadeBottom ?? 0.82;
    const top = part.shadeTop ?? 1.12;

    for (let i = 0; i < count; i++) {
      const dst3 = (vOffset + i) * 3;
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);

      positions[dst3] = px;
      positions[dst3 + 1] = py;
      positions[dst3 + 2] = pz;

      const nx = norm ? norm.getX(i) : 0;
      const ny = norm ? norm.getY(i) : 1;
      const nz = norm ? norm.getZ(i) : 0;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      normals[dst3] = nx / nLen;
      normals[dst3 + 1] = ny / nLen;
      normals[dst3 + 2] = nz / nLen;

      const tY = clamp01((py - minY) / spanY);
      const grad = lerp(bot, top, tY);
      let cr = part.r * grad;
      let cg = part.g * grad;
      let cb = part.b * grad;

      if (part.rockTint) {
        const facet = 1.0 + 0.08 * Math.sin(nx * 4.1 + nz * 5.2 + py * 1.7);
        const moss = Math.max(0, ny) * tY * 0.22;
        cr = lerp(cr * facet, 0.38, moss);
        cg = lerp(cg * facet, 0.49, moss);
        cb = lerp(cb * facet, 0.29, moss);
      }

      colors[dst3] = clamp01(cr);
      colors[dst3 + 1] = clamp01(cg);
      colors[dst3 + 2] = clamp01(cb);
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
  merged.setIndex(new BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  return merged;
}

function makeBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function makeCyl(
  rTop: number,
  rBot: number,
  h: number,
  segs: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBot, h, segs, 1);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function makeRockMass(
  radius: number,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  phase: number,
): BufferGeometry {
  const g = new DodecahedronGeometry(radius, 1);
  const pos = g.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const len = Math.hypot(vx, vy, vz) || 1;
    const dx = vx / len;
    const dy = vy / len;
    const dz = vz / len;
    const crag =
      1.0 +
      0.14 * Math.sin(dx * 3.8 + dz * 3.1 + phase) +
      0.1 * Math.cos(dy * 4.2 - dx * 2.7 + phase * 1.4);
    const flatBot = dy < -0.2 ? 0.65 : 1.0;
    pos.setXYZ(i, vx * sx * crag + x, vy * sy * crag * flatBot + y, vz * sz * crag + z);
  }
  g.computeVertexNormals();
  return g;
}

function addFireRingParts(parts: PartSpec[], cx: number, cz: number): void {
  const stoneCount = 8;
  for (let i = 0; i < stoneCount; i++) {
    const a = (i / stoneCount) * Math.PI * 2;
    const sx = cx + Math.cos(a) * 0.62;
    const sz = cz + Math.sin(a) * 0.62;
    const stone = new DodecahedronGeometry(0.18, 0);
    stone.scale(1.15, 0.72, 0.95);
    stone.rotateY(a);
    stone.translate(sx, 0.1, sz);
    stone.computeVertexNormals();
    parts.push({ geo: stone, r: 0.5, g: 0.48, b: 0.44, shadeBottom: 0.75, shadeTop: 1.12 });
  }
  // Charred firewood logs & warm glowing ember bed in center
  parts.push(
    {
      geo: makeCyl(0.08, 0.09, 0.95, 5, cx, 0.14, cz, 0, 0.4, Math.PI * 0.44),
      r: 0.28,
      g: 0.2,
      b: 0.14,
    },
    {
      geo: makeCyl(0.08, 0.09, 0.95, 5, cx, 0.16, cz, 0, -0.65, Math.PI * 0.44),
      r: 0.3,
      g: 0.21,
      b: 0.15,
    },
    {
      geo: makeCyl(0.28, 0.34, 0.08, 6, cx, 0.05, cz),
      r: 0.78,
      g: 0.36,
      b: 0.14,
      shadeBottom: 0.9,
      shadeTop: 1.2,
    },
  );
}

/**
 * Builds procedural geometry for each `PoiKind` (Task 4.5).
 */
export function buildLandmarkGeometry(kind: PoiKind): BufferGeometry {
  const parts: PartSpec[] = [];

  switch (kind) {
    case "spawn_camp": {
      // 1. Timber lean-to shelter at (-4.5, -4.2) facing the firepit
      const sx = -4.5;
      const sz = -4.2;
      parts.push(
        // Front support posts
        { geo: makeCyl(0.09, 0.11, 2.0, 6, sx - 1.5, 1.0, sz + 0.8), r: 0.46, g: 0.33, b: 0.22 },
        { geo: makeCyl(0.09, 0.11, 2.0, 6, sx + 1.5, 1.0, sz + 0.8), r: 0.46, g: 0.33, b: 0.22 },
        // Sloped timber & pine-bough roof
        {
          geo: makeBox(3.4, 0.16, 2.4, sx, 1.15, sz - 0.1, 0.52, 0, 0),
          r: 0.42,
          g: 0.31,
          b: 0.2,
        },
        {
          geo: makeBox(3.5, 0.14, 2.45, sx, 1.26, sz - 0.1, 0.52, 0, 0),
          r: 0.31,
          g: 0.46,
          b: 0.24,
        },
        // Dry bedroll platform under shelter
        { geo: makeBox(2.2, 0.14, 1.1, sx, 0.08, sz + 0.1), r: 0.52, g: 0.42, b: 0.28 },
      );

      // 2. Central stone firepit at (0.0, -4.0)
      addFireRingParts(parts, 0.0, -4.0);

      // 3. Split-log bench at (3.2, -3.6)
      parts.push(
        {
          geo: makeBox(2.4, 0.18, 0.48, 3.2, 0.42, -3.6, 0, -0.45, 0),
          r: 0.48,
          g: 0.35,
          b: 0.23,
        },
        { geo: makeCyl(0.12, 0.14, 0.4, 6, 2.4, 0.2, -3.2), r: 0.42, g: 0.3, b: 0.2 },
        { geo: makeCyl(0.12, 0.14, 0.4, 6, 4.0, 0.2, -4.0), r: 0.42, g: 0.3, b: 0.2 },
      );
      break;
    }

    case "abandoned_cabin": {
      // Stone foundation plinth (6.6 m × 5.6 m) + front porch deck
      parts.push(
        { geo: makeBox(6.6, 0.45, 5.6, 0, 0.12, 0), r: 0.5, g: 0.48, b: 0.44 },
        { geo: makeBox(6.2, 0.18, 1.8, 0, 0.16, 3.5), r: 0.47, g: 0.35, b: 0.24 },
        // Cabin interior plank floor
        { geo: makeBox(6.2, 0.12, 5.2, 0, 0.32, 0), r: 0.48, g: 0.36, b: 0.25 },
      );

      // Log walls (back, left, right, and front with open doorway)
      const wallR = 0.46;
      const wallG = 0.33;
      const wallB = 0.21;
      parts.push(
        // Back wall (-Z = -2.45)
        { geo: makeBox(6.4, 2.7, 0.32, 0, 1.68, -2.45), r: wallR, g: wallG, b: wallB },
        // Left & right walls (X = ±3.05)
        { geo: makeBox(0.32, 2.7, 5.2, -3.05, 1.68, 0), r: wallR, g: wallG, b: wallB },
        { geo: makeBox(0.32, 2.7, 5.2, 3.05, 1.68, 0), r: wallR, g: wallG, b: wallB },
        // Front wall segments leaving a 1.5 m wide × 2.15 m tall doorway in the center
        { geo: makeBox(2.3, 2.7, 0.32, -1.95, 1.68, 2.45), r: wallR, g: wallG, b: wallB },
        { geo: makeBox(2.3, 2.7, 0.32, 1.95, 1.68, 2.45), r: wallR, g: wallG, b: wallB },
        { geo: makeBox(1.8, 0.55, 0.34, 0, 2.76, 2.45), r: wallR, g: wallG, b: wallB },
      );

      // Pitched gable roof slopes + porch overhang posts
      parts.push(
        {
          geo: makeBox(4.0, 0.22, 7.2, -1.65, 3.65, 0.6, 0, 0, 0.52),
          r: 0.32,
          g: 0.24,
          b: 0.17,
        },
        {
          geo: makeBox(4.0, 0.22, 7.2, 1.65, 3.65, 0.6, 0, 0, -0.52),
          r: 0.34,
          g: 0.25,
          b: 0.18,
        },
        // Ridge beam
        { geo: makeBox(0.35, 0.32, 7.3, 0, 4.52, 0.6), r: 0.38, g: 0.27, b: 0.18 },
        // Porch support posts
        { geo: makeCyl(0.11, 0.13, 2.6, 6, -2.8, 1.5, 4.1), r: 0.45, g: 0.32, b: 0.21 },
        { geo: makeCyl(0.11, 0.13, 2.6, 6, 2.8, 1.5, 4.1), r: 0.45, g: 0.32, b: 0.21 },
      );

      // Weathered stone chimney on right wall (X = +3.45, Z = -1.2)
      parts.push(
        {
          geo: makeBox(0.95, 4.9, 1.15, 3.45, 2.35, -1.2),
          r: 0.52,
          g: 0.5,
          b: 0.46,
          shadeBottom: 0.76,
          shadeTop: 1.12,
        },
        { geo: makeBox(1.1, 0.28, 1.3, 3.45, 4.85, -1.2), r: 0.44, g: 0.42, b: 0.38 },
      );
      break;
    }

    case "campsite": {
      // 1. Canvas A-frame tent at (-3.2, -2.2) rotated by +0.35 rad
      const tx = -3.2;
      const tz = -2.2;
      const tyaw = 0.35;
      const tentSlopeL = makeBox(1.85, 0.1, 3.6, -0.7, 1.05, 0, 0, 0, 0.88);
      tentSlopeL.rotateY(tyaw);
      tentSlopeL.translate(tx, 0, tz);

      const tentSlopeR = makeBox(1.85, 0.1, 3.6, 0.7, 1.05, 0, 0, 0, -0.88);
      tentSlopeR.rotateY(tyaw);
      tentSlopeR.translate(tx, 0, tz);

      const tentRidge = makeCyl(0.06, 0.06, 3.8, 5, 0, 1.78, 0, Math.PI * 0.5, 0, 0);
      tentRidge.rotateY(tyaw);
      tentRidge.translate(tx, 0, tz);

      parts.push(
        { geo: tentSlopeL, r: 0.72, g: 0.66, b: 0.52, shadeBottom: 0.82, shadeTop: 1.12 },
        { geo: tentSlopeR, r: 0.74, g: 0.68, b: 0.54, shadeBottom: 0.82, shadeTop: 1.12 },
        { geo: tentRidge, r: 0.46, g: 0.33, b: 0.21 },
      );

      // 2. Stone firepit at (0.6, 0.4)
      addFireRingParts(parts, 0.6, 0.4);

      // 3. Log benches & wooden tripod drying rack
      parts.push(
        {
          geo: makeBox(2.5, 0.22, 0.46, 2.8, 0.38, -1.2, 0, -0.5, 0),
          r: 0.48,
          g: 0.35,
          b: 0.23,
        },
        {
          geo: makeBox(2.4, 0.22, 0.46, 0.4, 0.38, 3.1, 0, 0.1, 0),
          r: 0.46,
          g: 0.34,
          b: 0.22,
        },
        // Drying tripod poles over fire
        { geo: makeCyl(0.04, 0.05, 2.1, 5, 0.1, 0.95, 0.0, 0.28, 0, -0.28), r: 0.44, g: 0.32, b: 0.2 },
        { geo: makeCyl(0.04, 0.05, 2.1, 5, 1.1, 0.95, 0.0, 0.28, 0, 0.28), r: 0.44, g: 0.32, b: 0.2 },
        { geo: makeCyl(0.04, 0.05, 2.1, 5, 0.6, 0.95, 0.9, -0.32, 0, 0), r: 0.44, g: 0.32, b: 0.2 },
      );
      break;
    }

    case "cave": {
      // Rock-shell grotto (ARCHITECTURE.md R7): massive overlapping craggy rock
      // masses forming a U-shaped hillside cavern with a sheltered roof arch.
      parts.push(
        // Dry packed-stone interior floor
        {
          geo: makeBox(5.6, 0.3, 5.8, 0, 0.02, -0.3),
          r: 0.38,
          g: 0.36,
          b: 0.33,
          shadeBottom: 0.85,
          shadeTop: 1.0,
        },
        // Left rock wall shell
        {
          geo: makeRockMass(2.2, 0.85, 1.15, 1.55, -3.1, 1.65, -0.4, 0.4),
          r: 0.5,
          g: 0.49,
          b: 0.44,
          rockTint: true,
        },
        // Right rock wall shell
        {
          geo: makeRockMass(2.2, 0.85, 1.15, 1.55, 3.1, 1.65, -0.4, 1.7),
          r: 0.49,
          g: 0.48,
          b: 0.43,
          rockTint: true,
        },
        // Back cavern wall
        {
          geo: makeRockMass(2.5, 1.45, 1.2, 0.85, 0, 1.85, -3.4, 2.9),
          r: 0.47,
          g: 0.46,
          b: 0.42,
          rockTint: true,
        },
        // Overhanging roof arch spanning across the top (y = 3.6 m, walkable underneath!)
        {
          geo: makeRockMass(2.6, 1.55, 0.68, 1.35, 0, 3.75, -0.5, 4.1),
          r: 0.52,
          g: 0.51,
          b: 0.46,
          rockTint: true,
        },
        // Entrance flanking boulders
        {
          geo: makeRockMass(1.3, 1.0, 0.9, 1.0, -3.6, 0.95, 2.8, 5.2),
          r: 0.53,
          g: 0.52,
          b: 0.47,
          rockTint: true,
        },
        {
          geo: makeRockMass(1.3, 1.0, 0.9, 1.0, 3.6, 0.95, 2.8, 6.0),
          r: 0.53,
          g: 0.52,
          b: 0.47,
          rockTint: true,
        },
      );
      // Old fire ring near cave mouth
      addFireRingParts(parts, 0.8, 1.1);
      break;
    }

    case "watchtower": {
      const leg = 2.1;
      const deckY = 6.2;
      const roofY = 8.9;
      // 4 tall corner timber posts
      for (const [lx, lz] of [
        [-leg, -leg],
        [leg, -leg],
        [-leg, leg],
        [leg, leg],
      ] as const) {
        parts.push({
          geo: makeCyl(0.18, 0.24, 8.6, 6, lx, 4.2, lz),
          r: 0.45,
          g: 0.32,
          b: 0.21,
        });
      }

      // Cross-bracing beams at mid-level (y = 3.1) and deck level (y = 6.2)
      parts.push(
        { geo: makeBox(4.6, 0.22, 0.22, 0, 3.1, -leg), r: 0.42, g: 0.3, b: 0.2 },
        { geo: makeBox(4.6, 0.22, 0.22, 0, 3.1, leg), r: 0.42, g: 0.3, b: 0.2 },
        { geo: makeBox(0.22, 0.22, 4.6, -leg, 3.1, 0), r: 0.42, g: 0.3, b: 0.2 },
        { geo: makeBox(0.22, 0.22, 4.6, leg, 3.1, 0), r: 0.42, g: 0.3, b: 0.2 },
        // Diagonal X braces
        { geo: makeBox(5.6, 0.16, 0.16, 0, 3.1, -leg, 0, 0, 0.68), r: 0.4, g: 0.28, b: 0.18 },
        { geo: makeBox(5.6, 0.16, 0.16, 0, 3.1, leg, 0, 0, -0.68), r: 0.4, g: 0.28, b: 0.18 },
        // Elevated observation deck platform & railings
        { geo: makeBox(5.4, 0.28, 5.4, 0, deckY, 0), r: 0.48, g: 0.35, b: 0.23 },
        { geo: makeBox(5.4, 0.18, 0.18, 0, deckY + 1.05, -2.5), r: 0.46, g: 0.33, b: 0.22 },
        { geo: makeBox(5.4, 0.18, 0.18, 0, deckY + 1.05, 2.5), r: 0.46, g: 0.33, b: 0.22 },
        { geo: makeBox(0.18, 0.18, 5.4, -2.5, deckY + 1.05, 0), r: 0.46, g: 0.33, b: 0.22 },
        { geo: makeBox(0.18, 0.18, 5.4, 2.5, deckY + 1.05, 0), r: 0.46, g: 0.33, b: 0.22 },
        // Sloped ladder reaching from ground (+Z) to deck
        { geo: makeBox(0.9, 6.6, 0.16, 0, 3.1, 2.85, -0.24, 0, 0), r: 0.47, g: 0.34, b: 0.22 },
      );

      // Pyramidal lookout roof cap
      const roof = new ConeGeometry(3.9, 2.1, 4, 1);
      roof.rotateY(Math.PI * 0.25);
      roof.translate(0, roofY, 0);
      parts.push({
        geo: roof,
        r: 0.36,
        g: 0.24,
        b: 0.16,
        shadeBottom: 0.85,
        shadeTop: 1.15,
      });
      break;
    }

    case "ruined_bridge": {
      // Weathered stone masonry abutment on near bank + collapsed timber deck & river pilings
      parts.push(
        {
          geo: makeBox(3.6, 1.6, 4.2, -2.4, 0.65, 0),
          r: 0.51,
          g: 0.49,
          b: 0.45,
          shadeBottom: 0.78,
          shadeTop: 1.12,
        },
        // Intact near-side timber deck planks
        { geo: makeBox(3.8, 0.24, 3.6, -0.8, 1.48, 0, 0, 0, -0.05), r: 0.45, g: 0.33, b: 0.22 },
        // Tilted collapsed middle span dipping toward the water
        { geo: makeBox(3.2, 0.22, 3.4, 2.4, 0.85, 0, 0.08, 0.1, -0.28), r: 0.42, g: 0.3, b: 0.2 },
        // Stone pier ruin on far side
        { geo: makeBox(2.6, 1.35, 3.4, 3.1, 0.5, 0, 0, 0.12, 0), r: 0.49, g: 0.47, b: 0.43 },
        // Timber railing posts
        { geo: makeCyl(0.14, 0.16, 2.1, 6, -0.2, 1.8, -1.7), r: 0.44, g: 0.31, b: 0.2 },
        { geo: makeCyl(0.14, 0.16, 2.1, 6, -0.2, 1.8, 1.7), r: 0.44, g: 0.31, b: 0.2 },
        { geo: makeCyl(0.13, 0.15, 1.8, 6, -2.8, 1.8, -1.7), r: 0.44, g: 0.31, b: 0.2 },
        { geo: makeCyl(0.13, 0.15, 1.8, 6, -2.8, 1.8, 1.7), r: 0.44, g: 0.31, b: 0.2 },
      );
      break;
    }

    case "lookout_peak": {
      // Stacked stone cairn monument + weathered timber directional signpost
      parts.push(
        {
          geo: makeRockMass(1.35, 1.15, 0.65, 1.1, 0, 0.45, 0, 0.5),
          r: 0.54,
          g: 0.53,
          b: 0.49,
          rockTint: true,
        },
        {
          geo: makeRockMass(0.95, 1.05, 0.7, 1.0, 0.05, 1.25, -0.04, 1.8),
          r: 0.56,
          g: 0.55,
          b: 0.51,
          rockTint: true,
        },
        {
          geo: makeRockMass(0.62, 0.95, 0.8, 0.95, -0.03, 1.95, 0.02, 3.1),
          r: 0.58,
          g: 0.57,
          b: 0.53,
          rockTint: true,
        },
        {
          geo: makeRockMass(0.36, 0.85, 0.95, 0.85, 0, 2.52, 0, 4.4),
          r: 0.62,
          g: 0.6,
          b: 0.56,
          rockTint: true,
        },
        // Timber signpost at (2.4, 1.2)
        { geo: makeCyl(0.09, 0.12, 2.3, 6, 2.4, 1.1, 1.2), r: 0.46, g: 0.33, b: 0.22 },
        { geo: makeBox(1.15, 0.26, 0.1, 2.7, 1.95, 1.2, 0, 0.3, 0), r: 0.52, g: 0.39, b: 0.26 },
      );
      break;
    }
  }

  return mergeLandmarkParts(parts);
}

/**
 * Builds shared procedural wooden supply crate / chest geometry for the
 * world container `InstancedMesh` (Task 4.5).
 */
export function buildLootContainerGeometry(): BufferGeometry {
  return mergeLandmarkParts([
    // Main wooden crate/chest body
    {
      geo: makeBox(0.84, 0.54, 0.64, 0, 0.27, 0),
      r: 0.54,
      g: 0.39,
      b: 0.24,
      shadeBottom: 0.78,
      shadeTop: 1.12,
    },
    // Top lid with warm rim highlight
    {
      geo: makeBox(0.88, 0.12, 0.68, 0, 0.58, 0),
      r: 0.6,
      g: 0.44,
      b: 0.27,
      shadeBottom: 0.88,
      shadeTop: 1.15,
    },
    // Iron/bronze corner straps & clasp
    {
      geo: makeBox(0.9, 0.58, 0.08, -0.28, 0.3, 0),
      r: 0.32,
      g: 0.31,
      b: 0.29,
    },
    {
      geo: makeBox(0.9, 0.58, 0.08, 0.28, 0.3, 0),
      r: 0.32,
      g: 0.31,
      b: 0.29,
    },
    {
      geo: makeBox(0.14, 0.16, 0.71, 0, 0.52, 0),
      r: 0.78,
      g: 0.62,
      b: 0.28,
    },
  ]);
}

// --- Runtime Landmarks Manager (Task 4.5) ----------------------------------

const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

export class Landmarks {
  readonly layout: LandmarkWorldLayout;

  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly collision: CollisionWorld;
  private readonly root = new Group();
  private readonly structureMeshes: Mesh[] = [];
  private containerMesh: InstancedMesh | null = null;
  private readonly containerBaseMatrices: Matrix4[] = [];
  private readonly containerIndexById = new Map<string, number>();
  private readonly openedContainerIds = new Set<string>();

  private standardMaterials: boolean;

  constructor(
    scene: Scene,
    assets: AssetManager,
    heightfield: Heightfield,
    collision: CollisionWorld,
    preset: GraphicsPreset,
  ) {
    this.scene = scene;
    this.assets = assets;
    this.collision = collision;
    this.standardMaterials = preset.standardMaterials;
    this.layout = buildLandmarkLayout(heightfield);

    this.root.name = "Landmarks";
    this.buildSceneObjects(preset);
    this.registerColliders();
    this.scene.add(this.root);
  }

  /** Updates shadow casting and material tier when graphics preset changes. */
  applyPreset(preset: GraphicsPreset): void {
    const shadows = preset.shadows !== "off";
    const matChanged = preset.standardMaterials !== this.standardMaterials;
    this.standardMaterials = preset.standardMaterials;

    const mat = this.getLandmarkMaterial();
    for (let i = 0; i < this.structureMeshes.length; i++) {
      const m = this.structureMeshes[i]!;
      m.castShadow = shadows;
      if (matChanged) m.material = mat;
    }

    if (this.containerMesh) {
      this.containerMesh.castShadow = shadows;
      if (matChanged) this.containerMesh.material = mat;
    }
  }

  /** Returns true if `(x, z)` is inside a cave rock-shell, cabin, or camp shelter. */
  isSheltered(x: number, z: number): boolean {
    return isPointInLandmarkShelter(this.layout, x, z);
  }

  /** Marks a loot container as opened/empty (or restores it). */
  setContainerOpened(containerId: string, opened: boolean): boolean {
    const idx = this.containerIndexById.get(containerId);
    if (idx === undefined) return false;

    if (opened) {
      this.openedContainerIds.add(containerId);
    } else {
      this.openedContainerIds.delete(containerId);
    }

    if (this.containerMesh) {
      const mat = opened ? ZERO_MATRIX : this.containerBaseMatrices[idx]!;
      this.containerMesh.setMatrixAt(idx, mat);
      this.containerMesh.instanceMatrix.needsUpdate = true;
    }
    return true;
  }

  isContainerOpened(containerId: string): boolean {
    return this.openedContainerIds.has(containerId);
  }

  /** Finds the nearest unopened loot container within `maxDist` metres of `(x, z)`. */
  findNearestContainer(x: number, z: number, maxDist = 2.6): LootContainerSpec | null {
    let best: LootContainerSpec | null = null;
    let bestSq = maxDist * maxDist;
    for (let i = 0; i < this.layout.containers.length; i++) {
      const c = this.layout.containers[i]!;
      if (this.openedContainerIds.has(c.id)) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      const dSq = dx * dx + dz * dz;
      if (dSq <= bestSq) {
        bestSq = dSq;
        best = c;
      }
    }
    return best;
  }

  dispose(): void {
    for (const lm of this.layout.landmarks) {
      this.collision.removeByChunk(`landmark:${lm.poiId}`);
    }
    if (this.containerMesh) {
      this.root.remove(this.containerMesh);
      this.containerMesh.dispose();
      this.containerMesh = null;
    }
    this.structureMeshes.length = 0;
    this.scene.remove(this.root);
  }

  // --- Internal setup ------------------------------------------------------

  private buildSceneObjects(preset: GraphicsPreset): void {
    const mat = this.getLandmarkMaterial();
    const shadows = preset.shadows !== "off";

    for (let i = 0; i < this.layout.landmarks.length; i++) {
      const lm = this.layout.landmarks[i]!;
      const geo = this.assets.geometry(`p4.geo.landmark.${lm.kind}`, () =>
        buildLandmarkGeometry(lm.kind),
      );
      const mesh = new Mesh(geo, mat);
      mesh.position.set(lm.x, lm.y, lm.z);
      mesh.rotation.y = lm.yaw;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = `Landmark_${lm.poiId}`;
      this.structureMeshes.push(mesh);
      this.root.add(mesh);
    }

    // Single InstancedMesh for all loot containers across all landmarks
    const count = this.layout.containers.length;
    if (count > 0) {
      const cGeo = this.assets.geometry("p4.geo.lootContainer", () => buildLootContainerGeometry());
      const inst = new InstancedMesh(cGeo, mat, count);
      const pos = new Vector3();
      const quat = new Quaternion();
      const scale = new Vector3(1, 1, 1);
      const up = new Vector3(0, 1, 0);

      for (let i = 0; i < count; i++) {
        const c = this.layout.containers[i]!;
        pos.set(c.x, c.y, c.z);
        quat.setFromAxisAngle(up, c.yaw);
        const s = c.kind === "chest" ? 1.05 : c.kind === "pack" ? 0.82 : 1.0;
        scale.set(s, s, s);
        const m = new Matrix4().compose(pos, quat, scale);
        this.containerBaseMatrices.push(m);
        this.containerIndexById.set(c.id, i);
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = shadows;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.containerMesh = inst;
      this.root.add(inst);
    }
  }

  private registerColliders(): void {
    for (let i = 0; i < this.layout.landmarks.length; i++) {
      const lm = this.layout.landmarks[i]!;
      for (let j = 0; j < lm.colliders.length; j++) {
        const c = lm.colliders[j]!;
        if (c.shape === "box") {
          this.collision.addBox(c);
        } else {
          this.collision.addCircle(c);
        }
      }
    }
  }

  private getLandmarkMaterial(): Material {
    const tier = this.standardMaterials ? "std" : "lam";
    return this.assets.material(`p4.mat.landmark.${tier}`, () => {
      return this.standardMaterials
        ? new MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.88,
            metalness: 0.02,
            emissive: new Color(0x080705),
          })
        : new MeshLambertMaterial({
            color: 0xffffff,
            vertexColors: true,
            emissive: new Color(0x080705),
          });
    });
  }
}
