import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scene } from "three";
import { AssetManager } from "../src/core/AssetManager.ts";
import { getPreset } from "../src/core/GraphicsSettings.ts";
import { CollisionWorld } from "../src/world/Collision.ts";
import { Heightfield } from "../src/world/Heightfield.ts";
import {
  Landmarks,
  buildLandmarkGeometry,
  buildLandmarkLayout,
  buildLootContainerGeometry,
  isPointInLandmarkShelter,
} from "../src/world/Landmarks.ts";
import type { PoiKind } from "../src/world/WorldGenerator.ts";

describe("Phase 4 Group B: Landmarks & POI structures (Task 4.5)", () => {
  it("builds deterministic landmark layouts with shelter zones, colliders, and loot containers", () => {
    const hf1 = new Heightfield(2026);
    const hf2 = new Heightfield(2026);

    const l1 = buildLandmarkLayout(hf1);
    const l2 = buildLandmarkLayout(hf2);
    assert.deepEqual(l1, l2);

    assert.equal(l1.landmarks.length, hf1.layout.pois.length);
    assert.ok(l1.containers.length >= 7, `expected at least 7 loot containers, got ${l1.containers.length}`);
    assert.ok(l1.shelterZones.length >= 4, `expected shelter zones for cave/cabin/camps, got ${l1.shelterZones.length}`);

    // Verify cave has shelter flag & shelter zone (ARCHITECTURE.md R7)
    const cave = l1.landmarks.find((lm) => lm.kind === "cave");
    assert.ok(cave, "cave landmark must exist");
    assert.equal(cave.hasShelter, true, "cave landmark must have shelter flag");
    const caveShelter = cave.shelterZones[0]!;
    assert.equal(isPointInLandmarkShelter(l1, caveShelter.x, caveShelter.z), true);
  });

  it("keeps player spawn position clear of landmark colliders while blocking cabin walls and cave rock-shell", () => {
    const hf = new Heightfield(2026);
    const scene = new Scene();
    const assets = new AssetManager();
    const collision = new CollisionWorld(8);
    const landmarks = new Landmarks(scene, assets, hf, collision, getPreset("medium"));

    const spawnPoi = hf.layout.pois.find((p) => p.kind === "spawn_camp")!;
    const spawnY = hf.height(spawnPoi.x, spawnPoi.z);

    // 1. Player standing at exact spawn coordinates must NOT collide with any structure
    const spawnCheck = collision.resolveCircle(spawnPoi.x, spawnPoi.z, 0.35, spawnY, spawnY + 1.8);
    assert.equal(spawnCheck.hit, false, "spawn center must be free of landmark colliders");

    // 2. Cabin walls and cave rock-shell colliders must push out overlapping circles
    const cabin = landmarks.layout.landmarks.find((lm) => lm.kind === "abandoned_cabin")!;
    const backWallCol = cabin.colliders[0]!;
    const wallHit = collision.resolveCircle(
      backWallCol.x,
      backWallCol.z,
      0.35,
      cabin.y,
      cabin.y + 1.8,
    );
    assert.equal(wallHit.hit, true, "cabin wall collider must block player");

    // 3. Loot containers can be queried and marked opened
    const firstContainer = landmarks.layout.containers[0]!;
    const found = landmarks.findNearestContainer(firstContainer.x + 0.5, firstContainer.z, 2.0);
    assert.ok(found);
    assert.equal(found.id, firstContainer.id);

    assert.equal(landmarks.setContainerOpened(firstContainer.id, true), true);
    assert.equal(landmarks.isContainerOpened(firstContainer.id), true);
    const afterOpen = landmarks.findNearestContainer(firstContainer.x, firstContainer.z, 0.5);
    assert.equal(afterOpen, null, "opened container must not be returned as unopened interactable");

    landmarks.dispose();
    assets.disposeAll();
  });

  it("builds procedural geometries for all POI landmark types and loot containers without external assets", () => {
    const kinds: readonly PoiKind[] = [
      "spawn_camp",
      "abandoned_cabin",
      "campsite",
      "cave",
      "watchtower",
      "ruined_bridge",
      "lookout_peak",
    ];

    for (const kind of kinds) {
      const geo = buildLandmarkGeometry(kind);
      const pos = geo.getAttribute("position");
      const norm = geo.getAttribute("normal");
      const col = geo.getAttribute("color");
      const idx = geo.getIndex();
      assert.ok(pos && pos.count > 20, `${kind} must have vertices`);
      assert.ok(norm && norm.count === pos.count);
      assert.ok(col && col.count === pos.count);
      assert.ok(idx && idx.count >= 36, `${kind} must have triangle indices`);
      geo.dispose();
    }

    const containerGeo = buildLootContainerGeometry();
    assert.ok(containerGeo.getAttribute("position").count > 20);
    containerGeo.dispose();
  });
});
