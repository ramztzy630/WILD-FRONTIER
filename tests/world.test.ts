import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SimplexNoise } from "../src/world/Noise.ts";
import {
  WORLD_SIZE,
  WORLD_HALF,
  CHUNK_SIZE,
  BOUNDARY_MARGIN,
  WorldGenerator,
} from "../src/world/WorldGenerator.ts";
import { Heightfield } from "../src/world/Heightfield.ts";
import {
  LOD_SEGMENTS,
  SKIRT_DEPTH,
  buildChunkGeometry,
  type ChunkLod,
} from "../src/world/ChunkWorker.ts";
import {
  Terrain,
  planVisibleChunks,
  selectChunkLod,
} from "../src/world/Terrain.ts";
import {
  SWIM_DEPTH,
  Water,
  queryWaterState,
} from "../src/world/Water.ts";
import {
  CollisionWorld,
  resolveWorldBounds,
} from "../src/world/Collision.ts";
import { Scene } from "three";
import { AssetManager } from "../src/core/AssetManager.ts";
import { getPreset } from "../src/core/GraphicsSettings.ts";

describe("SimplexNoise (Task 3.1)", () => {
  it("is deterministic for the same seed", () => {
    const a = new SimplexNoise(42);
    const b = new SimplexNoise(42);
    for (let i = 0; i < 200; i++) {
      const x = (i - 100) * 1.37;
      const z = (i * 0.73) - 50;
      assert.equal(a.noise2D(x, z), b.noise2D(x, z));
      assert.equal(a.fbm(x * 0.01, z * 0.01, 4), b.fbm(x * 0.01, z * 0.01, 4));
      assert.equal(a.ridged(x * 0.01, z * 0.01, 4), b.ridged(x * 0.01, z * 0.01, 4));
    }
  });

  it("produces different fields for different seeds", () => {
    const a = new SimplexNoise(1001);
    const b = new SimplexNoise(1002);
    let diffs = 0;
    for (let i = 0; i < 100; i++) {
      if (a.noise2D(i * 0.31, i * 0.57) !== b.noise2D(i * 0.31, i * 0.57)) diffs++;
    }
    assert.ok(diffs > 95);
  });

  it("stays bounded in [-1, 1] for noise2D/fbm and [0, 1] for ridged", () => {
    const n = new SimplexNoise(777);
    let minN = Infinity;
    let maxN = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) * 0.17 - 4;
      const z = Math.floor(i / 50) * 0.19 - 4;
      const v = n.noise2D(x, z);
      const f = n.fbm(x, z, 5);
      const r = n.ridged(x, z, 4);
      assert.ok(v >= -1 && v <= 1, `noise2D out of bounds: ${v}`);
      assert.ok(f >= -1 && f <= 1, `fbm out of bounds: ${f}`);
      assert.ok(r >= 0 && r <= 1, `ridged out of bounds: ${r}`);
      if (v < minN) minN = v;
      if (v > maxN) maxN = v;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    assert.ok(minN < -0.5 && maxN > 0.5, `noise2D range too narrow: [${minN}, ${maxN}]`);
    assert.ok(minR < 0.3 && maxR > 0.7, `ridged range too narrow: [${minR}, ${maxR}]`);
  });

  it("is continuous (small input step gives small output change)", () => {
    const n = new SimplexNoise(99);
    const base = n.noise2D(12.34, -56.78);
    const near = n.noise2D(12.3401, -56.7799);
    assert.ok(Math.abs(base - near) < 0.01, `discontinuity: ${base} vs ${near}`);
  });
});

describe("WorldGenerator & Heightfield (Task 3.2)", () => {
  it("exposes expected world dimensions", () => {
    assert.equal(WORLD_SIZE, 2048);
    assert.equal(WORLD_HALF, 1024);
    assert.equal(CHUNK_SIZE, 64);
    assert.equal(BOUNDARY_MARGIN, 128);
  });

  it("produces identical layout and heightfield for the same seed", () => {
    const g1 = new WorldGenerator(123456);
    const g2 = new WorldGenerator(123456);
    assert.deepEqual(g1.layout, g2.layout);

    const h1 = new Heightfield(123456, g1.layout);
    const h2 = new Heightfield(123456, g2.layout);
    for (let i = 0; i < 100; i++) {
      const x = (i - 50) * 19.25;
      const z = ((i * 37) % 100 - 50) * 18.5;
      assert.equal(h1.height(x, z), h2.height(x, z));
      assert.deepEqual(h1.sample(x, z), h2.sample(x, z));
      assert.deepEqual(h1.waterInfo(x, z), h2.waterInfo(x, z));
    }
  });

  it("carves lake basin, rivers, waterfall step, and mountain boundaries", () => {
    const gen = new WorldGenerator(2026);
    const hf = new Heightfield(2026, gen.layout);
    const { lake, rivers, waterfall } = gen.layout;

    // Lake centre is underwater with meaningful depth
    const lakeWater = hf.waterInfo(lake.x, lake.z);
    assert.equal(lakeWater.hasWater, true);
    assert.equal(lakeWater.kind, "lake");
    assert.ok(lakeWater.depth > 2.5, `expected deep lake centre, got depth ${lakeWater.depth}`);
    assert.ok(hf.height(lake.x, lake.z) < lake.waterY);

    // At least 2 rivers traced into the valley
    assert.ok(rivers.length >= 2, `expected >= 2 rivers, got ${rivers.length}`);
    for (const river of rivers) {
      assert.ok(river.points.length >= 12);
      const mid = river.points[Math.floor(river.points.length / 2)]!;
      const rw = hf.waterInfo(mid.x, mid.z);
      assert.equal(rw.hasWater, true, `river point (${mid.x}, ${mid.z}) should have water`);
      assert.ok(rw.depth > 0.2, `river depth ${rw.depth}`);
    }

    // Waterfall has a real vertical drop
    assert.ok(waterfall.topY - waterfall.bottomY >= 5, `waterfall drop ${waterfall.topY - waterfall.bottomY}`);

    // Boundary ring rises higher than central valley
    const valleyH = hf.height(0, 0);
    const northMountainH = hf.height(0, -WORLD_HALF + 32);
    const eastEdgeH = hf.height(WORLD_HALF - 24, 0);
    assert.ok(northMountainH > valleyH + 25, `north mountain ${northMountainH} vs valley ${valleyH}`);
    assert.ok(eastEdgeH > valleyH + 15, `east boundary ${eastEdgeH} vs valley ${valleyH}`);
  });

  it("places required POIs with spacing and flat dry ground at spawn_camp", () => {
    const gen = new WorldGenerator(98765);
    const hf = new Heightfield(98765, gen.layout);
    const pois = gen.layout.pois;
    const kinds = new Set(pois.map((p) => p.kind));
    for (const req of [
      "spawn_camp",
      "abandoned_cabin",
      "campsite",
      "cave",
      "watchtower",
      "ruined_bridge",
      "lookout_peak",
    ] as const) {
      assert.ok(kinds.has(req), `missing POI kind ${req}`);
    }

    // Pairwise spacing check (at least 60 m apart)
    for (let i = 0; i < pois.length; i++) {
      const a = pois[i]!;
      assert.ok(Math.abs(a.x) < WORLD_HALF - BOUNDARY_MARGIN);
      assert.ok(Math.abs(a.z) < WORLD_HALF - BOUNDARY_MARGIN);
      for (let j = i + 1; j < pois.length; j++) {
        const b = pois[j]!;
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        assert.ok(dist >= 60, `POIs ${a.id} and ${b.id} too close: ${dist}m`);
      }
    }

    const spawn = pois.find((p) => p.kind === "spawn_camp")!;
    const spawnWater = hf.waterInfo(spawn.x, spawn.z);
    assert.equal(spawnWater.hasWater, false, "spawn_camp must not be underwater");
    const spawnSample = hf.sample(spawn.x, spawn.z);
    assert.ok(spawnSample.slopeAngle < 0.28, `spawn_camp slope too steep: ${spawnSample.slopeAngle}`);
  });

  it("returns normalized normals and biome weights summing to 1", () => {
    const hf = new Heightfield(555);
    for (let i = 0; i < 60; i++) {
      const s = hf.sample((i - 30) * 28, ((i * 19) % 60 - 30) * 25);
      const nLen = Math.hypot(s.normalX, s.normalY, s.normalZ);
      assert.ok(Math.abs(nLen - 1) < 1e-3, `normal length ${nLen}`);
      assert.ok(s.normalY > 0);
      const w = s.weights;
      const sum = w.grass + w.forest + w.dirt + w.sand + w.rock + w.snow;
      assert.ok(Math.abs(sum - 1) < 1e-4, `weights sum ${sum}`);
      assert.ok(s.colorR >= 0 && s.colorR <= 1);
      assert.ok(s.colorG >= 0 && s.colorG <= 1);
      assert.ok(s.colorB >= 0 && s.colorB <= 1);
    }
  });
});

describe("ChunkWorker / buildChunkGeometry (Task 3.3)", () => {
  it("builds 3 LODs (32, 16, 8) with skirts and valid indices", () => {
    const hf = new Heightfield(4242);
    const lods: readonly ChunkLod[] = [0, 1, 2];
    for (const lod of lods) {
      const S = LOD_SEGMENTS[lod];
      const data = buildChunkGeometry(hf, 0, 0, lod);
      const expectedVerts = (S + 1) * (S + 5);
      const expectedIndices = 6 * S * (S + 4);
      assert.equal(data.positions.length, expectedVerts * 3);
      assert.equal(data.normals.length, expectedVerts * 3);
      assert.equal(data.colors.length, expectedVerts * 3);
      assert.equal(data.uvs.length, expectedVerts * 2);
      assert.equal(data.indices.length, expectedIndices);
      assert.ok(data.minY <= data.maxY);

      for (let i = 0; i < data.indices.length; i++) {
        const idx = data.indices[i]!;
        assert.ok(idx >= 0 && idx < expectedVerts, `index out of range: ${idx}`);
      }

      // First skirt vertex drops by SKIRT_DEPTH below the first top-grid border vertex
      const topVertCount = (S + 1) * (S + 1);
      const topY = data.positions[1]!;
      const skirtY = data.positions[topVertCount * 3 + 1]!;
      assert.ok(Math.abs(topY - skirtY - SKIRT_DEPTH) < 1e-4);
    }
  });

  it("matches shared border vertex heights between adjacent LOD0 chunks", () => {
    const hf = new Heightfield(4242);
    const left = buildChunkGeometry(hf, 0, 0, 0);
    const right = buildChunkGeometry(hf, 1, 0, 0);
    const S = LOD_SEGMENTS[0];
    for (let row = 0; row <= S; row++) {
      const leftIdx = (row * (S + 1) + S) * 3;
      const rightIdx = (row * (S + 1) + 0) * 3;
      assert.ok(Math.abs(left.positions[leftIdx]! - right.positions[rightIdx]!) < 1e-5);
      assert.ok(Math.abs(left.positions[leftIdx + 1]! - right.positions[rightIdx + 1]!) < 1e-5);
      assert.ok(Math.abs(left.positions[leftIdx + 2]! - right.positions[rightIdx + 2]!) < 1e-5);
    }
  });
});

describe("Terrain chunk manager & pooling (Task 3.4)", () => {
  it("selects LOD rings by distance and sorts closest chunks first", () => {
    assert.equal(selectChunkLod(0, 0, 6), 0);
    assert.equal(selectChunkLod(1, -1, 6), 0);
    assert.equal(selectChunkLod(2, 1, 6), 1);
    assert.equal(selectChunkLod(5, 0, 6), 2);
    assert.equal(selectChunkLod(7, 0, 6), null);

    const targets = planVisibleChunks(10, 10, 4);
    assert.ok(targets.length > 0);
    // First target must be the chunk containing (10, 10) -> (0, 0) at LOD 0
    assert.equal(targets[0]!.chunkX, 0);
    assert.equal(targets[0]!.chunkZ, 0);
    assert.equal(targets[0]!.lod, 0);
    // Distances are monotonically non-decreasing
    for (let i = 1; i < targets.length; i++) {
      assert.ok(targets[i]!.distSq >= targets[i - 1]!.distSq);
    }
  });

  it("time-slices chunk uploads and recycles geometries through the per-LOD pool", () => {
    const scene = new Scene();
    const assets = new AssetManager();
    const hf = new Heightfield(777);
    const terrain = new Terrain(scene, assets, hf, getPreset("low"), { useWorker: false, maxUploadsPerFrame: 2 });

    // One update should upload at most maxUploadsPerFrame chunks (2)
    terrain.update(0, 0, 100);
    const s1 = terrain.getStats();
    assert.equal(s1.activeChunks, 2);
    assert.ok(s1.pendingChunks > 0);

    // Pump several frames at (0, 0)
    for (let i = 0; i < 6; i++) terrain.update(0, 0, 100);
    const s2 = terrain.getStats();
    assert.ok(s2.activeChunks >= 10);

    // Teleport far away -> old chunks unload into the geometry pool
    terrain.update(640, 640, 100);
    const s3 = terrain.getStats();
    assert.ok(s3.pooledGeometries > 0, `expected pooled geometries > 0, got ${s3.pooledGeometries}`);

    terrain.dispose();
  });
});

describe("Water system & depth queries (Task 3.5)", () => {
  it("detects deep swimming water in lake centre, shallow/river flow, and shoreline drinkable spots", () => {
    const hf = new Heightfield(2026);
    const { lake, rivers } = hf.layout;

    // Deep lake centre -> swimming
    const deep = queryWaterState(hf, lake.x, lake.z);
    assert.equal(deep.inWater, true);
    assert.equal(deep.swimming, true);
    assert.equal(deep.shallow, false);
    assert.ok(deep.depth > SWIM_DEPTH);

    // Near lake shoreline -> shallow or drinkable
    let foundShallowOrDrink = false;
    for (let r = 0.75; r <= 1.1; r += 0.02) {
      const st = queryWaterState(hf, lake.x + lake.radiusX * r, lake.z);
      if (st.shallow || st.canDrink) {
        foundShallowOrDrink = true;
        break;
      }
    }
    assert.equal(foundShallowOrDrink, true, "expected shallow/drinkable shoreline zone");

    // River midpoint -> has downstream flow vector
    const riverMid = rivers[0]!.points[Math.floor(rivers[0]!.points.length / 2)]!;
    const riverState = queryWaterState(hf, riverMid.x, riverMid.z);
    assert.equal(riverState.inWater, true);
    assert.ok(Math.hypot(riverState.flowX, riverState.flowZ) > 0.5);
  });

  it("builds lake, river ribbons, and waterfall meshes and updates time uniform", () => {
    const scene = new Scene();
    const assets = new AssetManager();
    const hf = new Heightfield(2026);
    const water = new Water(scene, assets, hf);
    assert.ok(water.meshCount >= 4, `expected lake + 2 rivers + waterfall meshes, got ${water.meshCount}`);
    water.update(0.5);
    water.dispose();
  });
});

describe("CollisionWorld & spatial hash (Task 3.6)", () => {
  it("pushes out overlapping circles cleanly", () => {
    const col = new CollisionWorld(8);
    const id = col.addCircle({ x: 10, z: 10, radius: 1.5, tag: "tree" });
    assert.ok(id > 0);
    assert.equal(col.count, 1);

    // Inside circle -> pushed outside to distance >= 1.5 + 0.4 = 1.9
    const res = col.resolveCircle(11.0, 10.0, 0.4);
    assert.equal(res.hit, true);
    assert.equal(res.tag, "tree");
    const dist = Math.hypot(res.x - 10, res.z - 10);
    assert.ok(Math.abs(dist - 1.9) < 1e-4, `expected dist 1.9, got ${dist}`);
    assert.ok(res.normalX > 0.99);
  });

  it("pushes out from oriented boxes and respects Y bounds", () => {
    const col = new CollisionWorld(8);
    const angle = Math.PI / 4; // rotated 45 deg
    col.addBox({
      x: 0,
      z: 0,
      halfX: 2.0,
      halfZ: 1.0,
      yaw: angle,
      minY: 0,
      maxY: 3.0,
      tag: "cabin",
    });

    // Above maxY -> no collision
    const high = col.resolveCircle(0.2, 0.2, 0.4, 3.5, 5.0);
    assert.equal(high.hit, false);

    // At ground level -> pushed out of rotated box
    const hit = col.resolveCircle(0.5, -0.5, 0.4, 0, 1.8);
    assert.equal(hit.hit, true);
    assert.equal(hit.tag, "cabin");

    // Re-resolving from the pushed-out position should not penetrate
    const check = col.resolveCircle(hit.x, hit.z, 0.4, 0, 1.8);
    assert.ok(Math.hypot(check.x - hit.x, check.z - hit.z) < 1e-4);
  });

  it("removes colliders by id and by chunkKey, and supports sphere-cast", () => {
    const col = new CollisionWorld(8);
    const a = col.addCircle({ x: 5, z: 0, radius: 1.0, chunkKey: "0,0" });
    col.addCircle({ x: 12, z: 0, radius: 1.0, chunkKey: "1,0" });
    assert.equal(col.count, 2);

    const sweep = col.sweepCircle(0, 0, 1, 0, 10, 0.3);
    assert.equal(sweep.hit, true);
    assert.equal(sweep.colliderId, a);
    assert.ok(Math.abs(sweep.distance - (5 - 1.3)) < 1e-3, `sweep dist ${sweep.distance}`);

    assert.equal(col.removeByChunk("0,0"), 1);
    assert.equal(col.count, 1);
    const sweep2 = col.sweepCircle(0, 0, 1, 0, 8, 0.3);
    assert.equal(sweep2.hit, false);
  });

  it("soft-stops and clamps at world boundaries with HUD hint", () => {
    const inside = resolveWorldBounds(100, -200, 0.35);
    assert.equal(inside.nearBoundary, false);
    assert.equal(inside.clamped, false);

    const warningZone = resolveWorldBounds(WORLD_HALF - 60, 0, 0.35);
    assert.equal(warningZone.nearBoundary, true);
    assert.ok(warningZone.pushX < 0);
    assert.ok(warningZone.message.length > 0);

    const outside = resolveWorldBounds(WORLD_HALF + 50, -WORLD_HALF - 20, 0.35);
    assert.equal(outside.clamped, true);
    assert.ok(Math.abs(outside.x) <= WORLD_HALF);
    assert.ok(Math.abs(outside.z) <= WORLD_HALF);
  });
});

