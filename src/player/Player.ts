/**
 * Player aggregate (ARCHITECTURE.md §4, §7): combines `PlayerController`,
 * `CameraController`, `CharacterModel`, and `AnimationController`.
 *
 * Phase 5 adds `PlayerStats` to this aggregate.
 */

import type { PerspectiveCamera } from "three";
import type { AssetManager } from "../core/AssetManager.ts";
import type { CollisionWorld } from "../world/Collision.ts";
import type { Heightfield } from "../world/Heightfield.ts";
import { AnimationController } from "./AnimationController.ts";
import { CameraController } from "./CameraController.ts";
import { CharacterModel } from "./CharacterModel.ts";
import { PlayerController, type PlayerMoveInput } from "./PlayerController.ts";

export class Player {
  readonly controller: PlayerController;
  readonly camera: CameraController;
  readonly model: CharacterModel;
  readonly anim: AnimationController;

  constructor(
    assets: AssetManager,
    heightfield: Heightfield,
    collision: CollisionWorld,
    startX = 0,
    startZ = 0,
    standardMaterials = false,
  ) {
    this.controller = new PlayerController(heightfield, collision, startX, startZ);
    this.camera = new CameraController(heightfield, collision);
    this.model = new CharacterModel(assets, standardMaterials);
    this.anim = new AnimationController();

    this.model.setTransform(this.controller.x, this.controller.y, this.controller.z, this.controller.yaw);
    this.camera.snapToTarget(this.controller.x, this.controller.y, this.controller.z, false);
    const initialPose = this.anim.update(0, this.controller.getSnapshot());
    this.model.applyPose(initialPose);
  }

  /** Fixed 60 Hz simulation step: kinematics, landing camera dip, and FSM pose. */
  fixedUpdate(dt: number, input: PlayerMoveInput): void {
    this.controller.update(dt, input);
    if (this.controller.justLanded) {
      this.camera.notifyLanding(this.controller.landingImpact);
    }
    const pose = this.anim.update(dt, this.controller.getSnapshot());
    this.model.applyPose(pose);
  }

  /**
   * Per-frame visual update: interpolates character root transform and updates
   * smoothed collision-aware third-person camera.
   */
  frameUpdate(
    frameDt: number,
    alpha: number,
    threeCamera: PerspectiveCamera,
    syncThreeCamera = true,
  ): void {
    const t = this.controller.getInterpolatedTransform(alpha);
    this.model.setTransform(t.x, t.y, t.z, t.yaw);
    this.camera.update(frameDt, t.x, t.y, t.z, this.controller.crouching);
    if (syncThreeCamera) {
      this.camera.syncCamera(threeCamera);
    }
  }

  setStandardMaterials(standard: boolean): void {
    this.model.setStandardMaterials(standard);
  }

  dispose(): void {
    this.model.dispose();
  }
}
