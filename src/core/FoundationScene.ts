/**
 * World scene (Phase 3 + Phase 4 Group A: procedural terrain, chunk streaming,
 * lake/rivers/waterfall water system, spatial-hash collision, rule-based
 * instanced forests/rocks/bushes/grass with LOD + wind shader, and third-person
 * Player + CameraController + procedural CharacterModel + AnimationController
 * driven by InputManager).
 */

import {
  BoxGeometry,
  Color,
  DirectionalLight,
  DodecahedronGeometry,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from "three";
import type { AssetManager } from "./AssetManager.ts";
import { getPreset, type GraphicsPreset } from "./GraphicsSettings.ts";
import type { InputStepState } from "./InputManager.ts";
import { lerp } from "./math.ts";
import { Player } from "../player/Player.ts";
import type { PlayerMoveInput } from "../player/PlayerController.ts";
import { CollisionWorld } from "../world/Collision.ts";
import { Environment } from "../world/Environment.ts";
import { Heightfield } from "../world/Heightfield.ts";
import { Terrain, type TerrainStats } from "../world/Terrain.ts";
import { Water } from "../world/Water.ts";
import { CHUNK_SIZE, WorldGenerator } from "../world/WorldGenerator.ts";

const SKY = 0xa9b9b4;

type MatKind = "stone" | "ember";

const IDLE_STEP_INPUT: InputStepState = {
  moveX: 0,
  moveZ: 0,
  sprint: false,
  crouch: false,
  jumpHeld: false,
  jumpPressed: false,
  interactPressed: false,
  inventoryPressed: false,
  pausePressed: false,
};

export class FoundationScene {
  readonly generator: WorldGenerator;
  readonly heightfield: Heightfield;
  readonly collision = new CollisionWorld(8);
  readonly terrain: Terrain;
  readonly water: Water;
  readonly environment: Environment;
  readonly player: Player;
  justDrankWater = false;

  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly root = new Group();
  private readonly fog: Fog;
  private readonly hemi: HemisphereLight;
  private readonly sun: DirectionalLight;
  private readonly probe: Mesh;
  private readonly pedestal: Mesh;
  private standard = false;

  private readonly spawnX: number;
  private readonly spawnY: number;
  private readonly spawnZ: number;
  private readonly pedestalY: number;

  // Fixed-step state of the probe (previous + current for interpolation).
  private probeAngle = 0;
  private probePrevAngle = 0;
  private orbit = 0;
  private readonly lookTarget = new Vector3();

  constructor(scene: Scene, assets: AssetManager, seed: number, renderer?: WebGLRenderer) {
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

    // Balanced daylight hemisphere + sun lighting so forest foliage has warm
    // sunlit crowns and readable moss-tinted shadow undersides (fixes dark trees).
    this.hemi = new HemisphereLight(0xd8e8f0, 0x524c38, 1.55);
    this.sun = new DirectionalLight(0xffe1b5, 2.5);
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
    this.root.add(this.hemi, this.sun, this.sun.target);

    // --- Phase 4 Group A: Rule-based instanced vegetation, rocks, bushes, grass ---
    this.environment = new Environment(
      scene,
      assets,
      this.heightfield,
      this.collision,
      defaultPreset,
      renderer,
    );
    this.environment.warmUp(this.spawnX, this.spawnZ);

    // Place verification pedestal slightly ahead of the player spawn clearing
    const pedX = this.spawnX + 3.0;
    const pedZ = this.spawnZ + 3.5;
    this.pedestalY = this.heightfield.height(pedX, pedZ);
    this.pedestal = new Mesh(
      assets.geometry("p2.pedestal", () => {
        const g = new BoxGeometry(1.6, 0.8, 1.6);
        g.translate(0, 0.4, 0);
        return g;
      }),
      this.material("stone"),
    );
    this.pedestal.position.set(pedX, this.pedestalY, pedZ);
    this.collision.addBox({
      x: pedX,
      z: pedZ,
      halfX: 0.8,
      halfZ: 0.8,
      minY: this.pedestalY,
      maxY: this.pedestalY + 0.8,
      tag: "pedestal",
    });

    this.probe = new Mesh(
      assets.geometry("p2.probe", () => new DodecahedronGeometry(0.7, 0)),
      this.material("ember"),
    );
    this.probe.position.set(pedX, this.pedestalY + 1.75, pedZ);
    for (const mesh of [this.pedestal, this.probe]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    // --- Phase 3 Kelompok B: Player (Controller + Camera + CharacterModel + AnimFSM) ---
    this.player = new Player(
      assets,
      this.heightfield,
      this.collision,
      this.spawnX,
      this.spawnZ,
      this.standard,
    );

    this.root.add(this.pedestal, this.probe, this.player.model.root);
    scene.add(this.root);
  }

  resetPlayerToSpawn(): void {
    this.player.controller.setPosition(this.spawnX, this.spawnZ, 0);
    this.player.camera.snapToTarget(this.spawnX, this.spawnY, this.spawnZ, false);
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
      this.pedestal.material = this.material("stone");
      this.probe.material = this.material("ember");
      this.player.setStandardMaterials(this.standard);
    }
    // Tie fog end distance to chunk view distance so streaming happens inside the fog (ARCHITECTURE.md §6.3)
    const viewMetres = preset.viewDistanceChunks * CHUNK_SIZE;
    this.fog.near = Math.max(35, viewMetres * 0.22);
    this.fog.far = Math.max(180, viewMetres * 0.95);
    this.terrain.applyPreset(preset);
    this.environment.applyPreset(preset);
  }

  /** Fixed 60 Hz step driven by `InputManager`. */
  fixedUpdate(dt: number, stepInput: InputStepState = IDLE_STEP_INPUT): void {
    this.probePrevAngle = this.probeAngle;
    this.probeAngle += dt * 1.6;
    this.justDrankWater = false;

    const moveInput: PlayerMoveInput = {
      moveX: stepInput.moveX,
      moveZ: stepInput.moveZ,
      cameraYaw: this.player.camera.yaw,
      sprint: stepInput.sprint,
      crouch: stepInput.crouch,
      jumpPressed: stepInput.jumpPressed,
    };

    this.player.fixedUpdate(dt, moveInput);

    if (stepInput.interactPressed && this.player.controller.waterState.canDrink) {
      this.player.anim.triggerDrink();
      this.justDrankWater = true;
    }
  }

  /** Per rendered frame: interpolation, third-person camera, chunk & environment streaming, water waves. */
  frameUpdate(frameDt: number, alpha: number, camera: PerspectiveCamera, menu: boolean): void {
    const angle = lerp(this.probePrevAngle, this.probeAngle, alpha);
    this.probe.rotation.set(angle * 0.5, angle, 0);
    this.probe.position.y = this.pedestalY + 1.75 + Math.sin(angle * 0.8) * 0.15;

    if (menu) {
      this.player.frameUpdate(frameDt, alpha, camera, false);
      this.orbit += frameDt * 0.045;
      const radius = 38;
      const camX = this.spawnX + Math.cos(this.orbit) * radius;
      const camZ = this.spawnZ + Math.sin(this.orbit) * radius;
      const groundAtCam = this.heightfield.height(camX, camZ);
      const waterAtCam = this.heightfield.waterInfo(camX, camZ);
      const baseSurface = waterAtCam.hasWater
        ? Math.max(groundAtCam, waterAtCam.surfaceY)
        : groundAtCam;
      const camY = Math.max(baseSurface + 11.0, this.spawnY + 9.0);

      camera.position.set(camX, camY, camZ);
      this.lookTarget.set(this.spawnX, this.spawnY + 1.6, this.spawnZ);
      camera.lookAt(this.lookTarget);

      this.terrain.update(camX, camZ);
      this.environment.update(this.spawnX, this.spawnZ, frameDt);
    } else {
      this.player.frameUpdate(frameDt, alpha, camera, true);
      const px = this.player.controller.x;
      const py = this.player.controller.y;
      const pz = this.player.controller.z;

      // Follow player with directional shadow frustum (snapped to 0.5 m grid)
      const snapX = Math.round(px * 2) * 0.5;
      const snapZ = Math.round(pz * 2) * 0.5;
      this.sun.position.set(snapX + 35, py + 46, snapZ + 22);
      this.sun.target.position.set(snapX, py, snapZ);
      this.sun.target.updateMatrixWorld();

      this.terrain.update(px, pz);
      this.environment.update(px, pz, frameDt);
    }

    this.water.update(frameDt, this.fog.near, this.fog.far, SKY);
  }

  getTerrainStats(): TerrainStats {
    return this.terrain.getStats();
  }

  dispose(): void {
    this.player.dispose();
    this.environment.dispose();
    this.terrain.dispose();
    this.water.dispose();
    this.collision.clear();
    this.scene.remove(this.root);
    this.sun.shadow.map?.dispose();
  }

  private material(kind: MatKind): Material {
    const tier = this.standard ? "std" : "lam";
    const key = `p2.mat.${kind}.${tier}`;
    return this.assets.material(key, () => {
      const params = this.materialParams(kind);
      return this.standard
        ? new MeshStandardMaterial({ ...params, roughness: kind === "ember" ? 0.4 : 0.9, metalness: 0 })
        : new MeshLambertMaterial(params);
    });
  }

  private materialParams(kind: MatKind): { color: number; emissive?: number } {
    switch (kind) {
      case "stone":
        return { color: 0x7d7a70 };
      case "ember":
        return { color: 0xe08a3c, emissive: 0x3a1a05 };
    }
  }
}
