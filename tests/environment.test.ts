import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Heightfield } from "../src/world/Heightfield.ts";
import {
  buildBushGeometry,
  buildDeadTreeGeometry,
  buildDeciduousTreeGeometry,
  buildGrassClumpGeometry,
  buildPineTreeGeometry,
  buildRockGeometry,
  evaluateClearingMask,
  generateChunkScatter,
  type ScatterKind,
} from "../src/world/Environment.ts";
import { CHUNK_SIZE } from "../src/world/WorldGenerator.ts";

describe("Phase 4 Group A: Rule-based scatter & clearings (Task 4.2)", () => {
  it("produces byte-identical scatter lists for the same seed and chunk coordinates", () => {
    const hf1 = new Heightfield(2026);
    const hf2 = new Heightfield(2026);

    for (const [cx, cz] of [
      [0, 0],
      [-2, -1],
      [3, -4],
    ] as const) {
      const s1 = generateChunkScatter(hf1, cx, cz);
      const s2 = generateChunkScatter(hf2, cx, cz);
      assert.deepEqual(s1, s2);
    }
  });

  it("keeps POI footprints, lake water, and river channels clear of trees", () => {
    const hf = new Heightfield(2026);
    const { pois, lake, rivers } = hf.layout;

    // 1. Inside every POI footprint, evaluateClearingMask must be 0
    for (const poi of pois) {
      const maskCenter = evaluateClearingMask(hf, poi.x, poi.z);
      assert.equal(maskCenter, 0, `POI ${poi.id} center must have clearing mask 0`);

      const cx = Math.floor(poi.x / CHUNK_SIZE);
      const cz = Math.floor(poi.z / CHUNK_SIZE);
      const scatter = generateChunkScatter(hf, cx, cz);
      for (const p of scatter.placements) {
        const d = Math.hypot(p.x - poi.x, p.z - poi.z);
        assert.ok(
          d > poi.radius + 1.5,
          `Placement ${p.id} (${p.kind}) intruded inside POI ${poi.id} at distance ${d.toFixed(2)}m`,
        );
      }
    }

    // 2. Lake centre has clearing mask 0 and zero trees
    assert.equal(evaluateClearingMask(hf, lake.x, lake.z), 0);
    const lakeCx = Math.floor(lake.x / CHUNK_SIZE);
    const lakeCz = Math.floor(lake.z / CHUNK_SIZE);
    const lakeScatter = generateChunkScatter(hf, lakeCx, lakeCz);
    for (const p of lakeScatter.placements) {
      const w = hf.waterInfo(p.x, p.z);
      if (p.kind === "pine" || p.kind === "deciduous" || p.kind === "dead_tree") {
        assert.equal(w.hasWater, false, `Tree ${p.id} spawned in water`);
      }
    }

    // 3. River channel points have clearing mask 0
    const riverMid = rivers[0]!.points[Math.floor(rivers[0]!.points.length / 2)]!;
    assert.equal(evaluateClearingMask(hf, riverMid.x, riverMid.z), 0);
  });

  it("assigns stable deterministic instance IDs and spawns all species across the valley", () => {
    const hf = new Heightfield(2026);
    const counts: Record<ScatterKind, number> = {
      pine: 0,
      deciduous: 0,
      dead_tree: 0,
      boulder: 0,
      rock: 0,
      bush_berry: 0,
      bush_fiber: 0,
    };

    const seenIds = new Set<string>();
    for (let cz = -6; cz <= 5; cz++) {
      for (let cx = -6; cx <= 5; cx++) {
        const scatter = generateChunkScatter(hf, cx, cz);
        for (let i = 0; i < scatter.placements.length; i++) {
          const p = scatter.placements[i]!;
          assert.equal(p.id, `${cx},${cz}:${i}`);
          assert.equal(seenIds.has(p.id), false, `duplicate instance ID ${p.id}`);
          seenIds.add(p.id);
          counts[p.kind]++;
        }
      }
    }

    assert.ok(counts.pine > 150, `expected abundant pines, got ${counts.pine}`);
    assert.ok(counts.deciduous > 10, `expected deciduous trees, got ${counts.deciduous}`);
    assert.ok(counts.dead_tree > 5, `expected dead trees, got ${counts.dead_tree}`);
    assert.ok(counts.boulder > 20, `expected boulders, got ${counts.boulder}`);
    assert.ok(counts.rock > 40, `expected rocks, got ${counts.rock}`);
    assert.ok(counts.bush_berry > 30, `expected berry bushes, got ${counts.bush_berry}`);
    assert.ok(counts.bush_fiber > 30, `expected fiber bushes, got ${counts.bush_fiber}`);
  });
});

describe("Phase 4 Group A: Procedural vegetation & rock geometries (Tasks 4.1 & 4.4)", () => {
  it("builds 3 pine LODs with strictly decreasing triangle counts and bright vertex colours", () => {
    const lod0 = buildPineTreeGeometry(0);
    const lod1 = buildPineTreeGeometry(1);
    const lod2 = buildPineTreeGeometry(2);

    const tris0 = lod0.getIndex()!.count / 3;
    const tris1 = lod1.getIndex()!.count / 3;
    const tris2 = lod2.getIndex()!.count / 3;

    assert.ok(tris0 > tris1, `expected LOD0 tris (${tris0}) > LOD1 tris (${tris1})`);
    assert.ok(tris1 > tris2, `expected LOD1 tris (${tris1}) > LOD2 tris (${tris2})`);
    assert.equal(tris2, 4, "LOD2 crossed billboard must be 4 triangles");

    // Verify vertex colours are non-dark and normals are normalized
    const col0 = lod0.getAttribute("color");
    const norm0 = lod0.getAttribute("normal");
    let maxGreen = 0;
    for (let i = 0; i < col0.count; i++) {
      const g = col0.getY(i);
      if (g > maxGreen) maxGreen = g;
      const nLen = Math.hypot(norm0.getX(i), norm0.getY(i), norm0.getZ(i));
      assert.ok(Math.abs(nLen - 1) < 1e-3);
    }
    assert.ok(maxGreen > 0.45, `expected sunlit foliage green > 0.45, got ${maxGreen}`);

    lod0.dispose();
    lod1.dispose();
    lod2.dispose();
  });

  it("builds deciduous, dead tree, boulder, rock, berry/fiber bush, and grass clump geometries", () => {
    const geometries = [
      buildDeciduousTreeGeometry(0),
      buildDeciduousTreeGeometry(1),
      buildDeadTreeGeometry(0),
      buildDeadTreeGeometry(1),
      buildRockGeometry(true, 0),
      buildRockGeometry(false, 1),
      buildBushGeometry(true),
      buildBushGeometry(false),
      buildGrassClumpGeometry(),
    ];

    for (const geo of geometries) {
      const pos = geo.getAttribute("position");
      const col = geo.getAttribute("color");
      const uv = geo.getAttribute("uv");
      const idx = geo.getIndex();
      assert.ok(pos && pos.count > 0);
      assert.ok(col && col.count === pos.count);
      assert.ok(uv && uv.count === pos.count);
      assert.ok(idx && idx.count >= 6);
      geo.dispose();
    }
  });
});
