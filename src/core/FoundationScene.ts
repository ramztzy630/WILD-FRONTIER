/**
 * World scene (Phase 3 Kelompok A: procedural terrain, chunk streaming,
 * lake/rivers/waterfall water system, and spatial-hash collision).
 *
 * Keeps the rotating fixed-step probe at the spawn clearing so fixed-step
 * interpolation remains visually verifiable alongside the procedural terrain
 * and water until the player controller arrives in Kelompok B.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Material,
  type PerspectiveCamera,
  type Scene,
} from "three";
import type { AssetManager } from "./AssetManager.ts";
import { getPreset, type GraphicsPreset } from "./GraphicsSettings.ts";
import { Random } from "./Random.ts";
import { TAU, lerp } from "./math.ts";
import { CollisionWorld } from "../world/Collision.ts";
import { Heightfield } from "../world/Heightfield.ts";
import { Terrain, type TerrainStats } from "../world/Terrain.ts";
import { Water } from "../world/Water.ts";
import { CHUNK_SIZE, WorldGenerator } from "../world/WorldGenerator.ts";

const TREE_COUNT = 260;
const SKY = 0xa9b9b4;

type MatKind = "foliage" | "bark" | "stone";

export class FoundationScene {
  readonly generator: WorldGenerator;
  readonly heightfield: Heightfield;
  readonly collision = new CollisionWorld(8);
  readonly terrain: Terrain;
  readonly water: Water;

  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly root = new Group();
  private readonly fog: Fog;
  private readonly sun: DirectionalLight;
  private readonly foliage: InstancedMesh;
  private readonly trunks: InstancedMesh;
  private readonly probe: Mesh;
  private readonly pedestal: Mesh;
  private standard = false;

  private readonly spawnX: number;
  private readonly spawnY: number;
  private readonly spawnZ: number;

  // Fixed-step state of the probe (previous + current for interpolation).
  private probeAngle = 0;
  private probePrevAngle = 0;
  private orbit = 0;
  private readonly lookTarget = new Vector3();

  constructor(scene: Scene, assets: AssetManager, seed: number) {
    this.scene = scene;
    this.assets = assets;
    scene.background = new Color(SKY);
    this.fog = new Fog(SKY, 45, 360);
    scene.fog = this.fog;

    this.generator = new WorldGenerator(seed);
    this.heightfield = new Heightfield(seed, this.generator.layout);
    const spawn =
      this.generator.layout.pois.find((p) => p.kind === "spawn_camp") ??
      this.generator.layout.pois[0]!;
    this.spawnX = spawn.x;
    this.spawnZ = spawn.z;
    this.spawnY = this.heightfield.height(this.spawnX, this.spawnZ);
    this.lookTarget.set(this.spawnX, this.spawnY + 1.6, this.spawnZ);

    const defaultPreset = getPreset("medium");
    this.terrain = new Terrain(scene, assets, this.heightfield, defaultPreset);
    this.terrain.warmUp(this.spawnX, this.spawnZ, 9);
    this.water = new Water(scene, assets, this.heightfield);

    const hemi = new HemisphereLight(0xcfe0ea, 0x3b3424, 1.3);
    this.sun = new DirectionalLight(0xffdcab, 2.4);
    this.sun.position.set(this.spawnX + 35, this.spawnY + 46, this.spawnZ + 22);
    this.sun.target.position.set(this.spawnX, this.spawnY, this.spawnZ);
    const cam = this.sun.shadow.camera;
    cam.left = -55;
    cam.right = 55;
    cam.top = 55;
    cam.bottom = -55;
    cam.near = 1;
    cam.far = 160;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.root.add(hemi, this.sun, this.sun.target);

    const rng = new Random(seed);
    const coneGeo = assets.geometry("p2.cone", () => {
      const g = new ConeGeometry(1.5, 4.2, 7, 1);
      g.translate(0, 4.1, 0);
      return g;
    });
    const trunkGeo = assets.geometry("p2.trunk", () => {
      const g = new CylinderGeometry(0.18, 0.26, 2.2, 6, 1);
      g.translate(0, 1.1, 0);
      return g;
    });
    this.foliage = new InstancedMesh(coneGeo, this.material("foliage"), TREE_COUNT);
    this.trunks = new InstancedMesh(trunkGeo, this.material("bark"), TREE_COUNT);
    const m = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    const up = new Vector3(0, 1, 0);

    let placed = 0;
    let attempts = 0;
    while (placed < TREE_COUNT && attempts < TREE_COUNT * 6) {
      attempts++;
      const a = rng.range(0, TAU);
      const r = 14 + Math.pow(rng.next(), 0.75) * 180;
      const tx = this.spawnX + Math.cos(a) * r;
      const tz = this.spawnZ + Math.sin(a) * r;
      if (this.heightfield.waterInfo(tx, tz).hasWater) continue;
      const ty = this.heightfield.height(tx, tz);
      const s = rng.range(0.75, 1.5) * (r > 45 ? 1.15 : 1);
      pos.set(tx, ty, tz);
      scl.set(s, s * rng.range(0.9, 1.25), s);
      q.setFromAxisAngle(up, rng.range(0, TAU));
      m.compose(pos, q, scl);
      this.foliage.setMatrixAt(placed, m);
      this.trunks.setMatrixAt(placed, m);
      this.collision.addCircle({
        x: tx,
        z: tz,
        radius: 0.28 * s,
        minY: ty,
        maxY: ty + 6 * s,
        tag: "tree",
      });
      placed++;
    }
    this.foliage.count = placed;
    this.trunks.count = placed;
    this.foliage.castShadow = this.trunks.castShadow = true;
    this.foliage.receiveShadow = true;
    this.foliage.computeBoundingSphere();
    this.trunks.computeBoundingSphere();

    this.pedestal = new Mesh(
      assets.geometry("p2.pedestal", () => {
        const g = new BoxGeometry(1.6, 0.8, 1.6);
        g.translate(0, 0.4, 0);
        return g;
      }),
      this.material("stone"),
    );
    this.pedestal.position.set(this.spawnX, this.spawnY, this.spawnZ);
    this.collision.addBox({
      x: this.spawnX,
      z: this.spawnZ,
      halfX: 0.8,
      halfZ: 0.8,
      minY: this.spawnY,
      maxY: this.spawnY + 0.8,
      tag: "pedestal",
    });

    this.probe = new Mesh(
      assets.geometry("p2.probe", () => new DodecahedronGeometry(0.7, 0)),
      this.material("ember"),
    );
    this.probe.position.set(this.spawnX, this.spawnY + 1.75, this.spawnZ);
    for (const mesh of [this.pedestal, this.probe]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    this.root.add(this.foliage, this.trunks, this.pedestal, this.probe);
    scene.add(this.root);
  }

  /** Applies the scene-level part of a graphics preset (shadows, material tier, view distance). */
  applyPreset(preset: GraphicsPreset): void {
    const shadows = preset.shadows !== "off";
    this.sun.castShadow = shadows;
    if (shadows && this.sun.shadow.mapSize.x !== preset.shadowMapSize) {
      this.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    if (preset.standardMaterials !== this.standard) {
      this.standard = preset.standardMaterials;
      this.foliage.material = this.material("foliage");
      this.trunks.material = this.material("bark");
      this.pedestal.material = this.material("stone");
      this.probe.material = this.material("ember");
    }
    // Tie fog end distance to chunk view distance so streaming happens inside the fog (ARCHITECTURE.md §6.3)
    const viewMetres = preset.viewDistanceChunks * CHUNK_SIZE;
    this.fog.near = Math.max(35, viewMetres * 0.22);
    this.fog.far = Math.max(180, viewMetres * 0.95);
    this.terrain.applyPreset(preset);
  }

  /** Fixed 60 Hz step. */
  fixedUpdate(dt: number): void {
    this.probePrevAngle = this.probeAngle;
    this.probeAngle += dt * 1.6;
  }

  /** Per rendered frame: interpolation, chunk streaming, water waves, and scenic camera. */
  frameUpdate(frameDt: number, alpha: number, camera: PerspectiveCamera, menu: boolean): void {
    const angle = lerp(this.probePrevAngle, this.probeAngle, alpha);
    this.probe.rotation.set(angle * 0.5, angle, 0);
    this.probe.position.y = this.spawnY + 1.75 + Math.sin(angle * 0.8) * 0.15;

    this.orbit += frameDt * (menu ? 0.045 : 0.11);
    const radius = menu ? 38 : 22;
    const camX = this.spawnX + Math.cos(this.orbit) * radius;
    const camZ = this.spawnZ + Math.sin(this.orbit) * radius;
    const groundAtCam = this.heightfield.height(camX, camZ);
    const waterAtCam = this.heightfield.waterInfo(camX, camZ);
    const baseSurface = waterAtCam.hasWater ? Math.max(groundAtCam, waterAtCam.surfaceY) : groundAtCam;
    const camY = Math.max(baseSurface + (menu ? 11.0 : 5.5), this.spawnY + (menu ? 9.0 : 4.5));

    camera.position.set(camX, camY, camZ);
    this.lookTarget.set(this.spawnX, this.spawnY + 1.6, this.spawnZ);
    camera.lookAt(this.lookTarget);

    this.terrain.update(camX, camZ);
    this.water.update(frameDt, this.fog.near, this.fog.far, SKY);
  }

  getTerrainStats(): TerrainStats {
    return this.terrain.getStats();
  }

  dispose(): void {
    this.terrain.dispose();
    this.water.dispose();
    this.collision.clear();
    this.scene.remove(this.root);
    this.foliage.dispose();
    this.trunks.dispose();
    this.sun.shadow.map?.dispose();
  }

  private material(kind: MatKind | "ember"): Material {
    const tier = this.standard ? "std" : "lam";
    const key = `p2.mat.${kind}.${tier}`;
    return this.assets.material(key, () => {
      const params = this.materialParams(kind);
      return this.standard
        ? new MeshStandardMaterial({ ...params, roughness: kind === "ember" ? 0.4 : 0.9, metalness: 0 })
        : new MeshLambertMaterial(params);
    });
  }

  private materialParams(kind: MatKind | "ember"): { color: number; emissive?: number } {
    switch (kind) {
      case "foliage":
        return { color: 0x2f4a2c };
      case "bark":
        return { color: 0x5a4330 };
      case "stone":
        return { color: 0x7d7a70 };
      case "ember":
        return { color: 0xe08a3c, emissive: 0x3a1a05 };
    }
  }
}
