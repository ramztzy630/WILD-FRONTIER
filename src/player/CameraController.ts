/**
 * Collision-aware third-person orbit camera controller (PRD §6;
 * ARCHITECTURE.md §7).
 *
 * Orbits around a smoothed shoulder pivot with configurable sensitivity,
 * invert-Y, and zoom distance (2.5–8.0 m). Avoids clipping into terrain or
 * static obstacles by sphere-casting against `CollisionWorld` and sampling
 * `Heightfield` along the sight ray.
 */

import { Vector3, type PerspectiveCamera } from "three";
import { DEG2RAD, clamp, damp, wrapAngle } from "../core/math.ts";
import type { CollisionWorld } from "../world/Collision.ts";
import type { Heightfield } from "../world/Heightfield.ts";

export const MIN_CAMERA_PITCH = -60 * DEG2RAD;
export const MAX_CAMERA_PITCH = 70 * DEG2RAD;
export const MIN_CAMERA_DISTANCE = 2.5;
export const MAX_CAMERA_DISTANCE = 8.0;
export const DEFAULT_CAMERA_DISTANCE = 4.5;
export const MIN_GROUND_CLEARANCE = 0.35;

const STAND_PIVOT_HEIGHT = 1.48;
const CROUCH_PIVOT_HEIGHT = 1.05;
const CAMERA_SPHERE_RADIUS = 0.25;
const COLLIDER_MARGIN = 0.12;
const TERRAIN_RAY_SAMPLES = 8;
const PIVOT_FOLLOW_RATE = 16.0;
const DISTANCE_RECOVERY_RATE = 8.0;
const LANDING_DIP_RECOVERY_RATE = 10.0;

export class CameraController {
  private readonly heightfield: Heightfield;
  private readonly collision: CollisionWorld;

  yaw = 0;
  pitch = 0;
  targetDistance = DEFAULT_CAMERA_DISTANCE;
  currentDistance = DEFAULT_CAMERA_DISTANCE;

  sensitivity = 1.0;
  invertY = false;

  readonly pivot = new Vector3();
  readonly position = new Vector3();
  readonly lookTarget = new Vector3();

  private landingDip = 0;
  private initialized = false;

  constructor(heightfield: Heightfield, collision: CollisionWorld) {
    this.heightfield = heightfield;
    this.collision = collision;
  }

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, 0.1, 4.0);
  }

  setInvertY(invert: boolean): void {
    this.invertY = invert;
  }

  /** Applies yaw and pitch look deltas (in radians before sensitivity scaling). */
  applyLook(deltaYaw: number, deltaPitch: number): void {
    this.yaw = wrapAngle(this.yaw + deltaYaw * this.sensitivity);
    const pitchSign = this.invertY ? -1 : 1;
    this.pitch = clamp(
      this.pitch + deltaPitch * this.sensitivity * pitchSign,
      MIN_CAMERA_PITCH,
      MAX_CAMERA_PITCH,
    );
  }

  /** Adjusts desired zoom distance within `[MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE]`. */
  applyZoom(deltaDistance: number): void {
    this.targetDistance = clamp(
      this.targetDistance + deltaDistance,
      MIN_CAMERA_DISTANCE,
      MAX_CAMERA_DISTANCE,
    );
  }

  /** Adds a subtle vertical camera dip when the character lands from a jump/fall. */
  notifyLanding(impact: number): void {
    this.landingDip = Math.max(this.landingDip, clamp(impact, 0, 1) * 0.22);
  }

  /** Immediately snaps pivot and camera to the player position without smoothing lag. */
  snapToTarget(playerX: number, playerY: number, playerZ: number, crouching = false): void {
    const offsetY = crouching ? CROUCH_PIVOT_HEIGHT : STAND_PIVOT_HEIGHT;
    this.pivot.set(playerX, playerY + offsetY, playerZ);
    this.currentDistance = this.targetDistance;
    this.initialized = true;
    this.computeCameraTransform(1 / 60, true);
  }

  /**
   * Updates smoothed pivot, resolves collider & terrain avoidance, and computes
   * final camera world position and look target.
   */
  update(
    dt: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    crouching = false,
  ): void {
    if (!this.initialized) {
      this.snapToTarget(playerX, playerY, playerZ, crouching);
      return;
    }

    this.landingDip = damp(this.landingDip, 0, LANDING_DIP_RECOVERY_RATE, dt);
    const targetPivotY =
      playerY + (crouching ? CROUCH_PIVOT_HEIGHT : STAND_PIVOT_HEIGHT) - this.landingDip;

    this.pivot.x = damp(this.pivot.x, playerX, PIVOT_FOLLOW_RATE, dt);
    this.pivot.y = damp(this.pivot.y, targetPivotY, PIVOT_FOLLOW_RATE, dt);
    this.pivot.z = damp(this.pivot.z, playerZ, PIVOT_FOLLOW_RATE, dt);

    this.computeCameraTransform(dt, false);
  }

  /** Copies the computed transform and lookAt target onto a Three.js `PerspectiveCamera`. */
  syncCamera(camera: PerspectiveCamera): void {
    camera.position.copy(this.position);
    camera.lookAt(this.lookTarget);
  }

  private computeCameraTransform(dt: number, instant: boolean): void {
    const px = this.pivot.x;
    const py = this.pivot.y;
    const pz = this.pivot.z;

    // Forward look direction: (+sin(yaw)*cos(pitch), -sin(pitch), +cos(yaw)*cos(pitch))
    // Camera offset from pivot is opposite the forward vector:
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const rayDirX = -Math.sin(this.yaw) * cosPitch;
    const rayDirY = sinPitch;
    const rayDirZ = -Math.cos(this.yaw) * cosPitch;

    let allowedDist = this.targetDistance;

    // 1. Sphere-cast against static colliders in XZ
    const horizFactor = Math.hypot(rayDirX, rayDirZ);
    const maxHorizDist = this.targetDistance * horizFactor;
    if (maxHorizDist > 1e-4) {
      const endY = py + rayDirY * this.targetDistance;
      const minY = Math.min(py, endY) - CAMERA_SPHERE_RADIUS;
      const maxY = Math.max(py, endY) + CAMERA_SPHERE_RADIUS;
      const sweep = this.collision.sweepCircle(
        px,
        pz,
        rayDirX,
        rayDirZ,
        maxHorizDist,
        CAMERA_SPHERE_RADIUS,
        minY,
        maxY,
      );
      if (sweep.hit) {
        const hitDist3D = Math.max(0.5, (sweep.distance - COLLIDER_MARGIN) / horizFactor);
        allowedDist = Math.min(allowedDist, hitDist3D);
      }
    }

    // 2. Pull in immediately on obstruction; recover smoothly when clear
    if (instant || allowedDist < this.currentDistance) {
      this.currentDistance = allowedDist;
    } else {
      this.currentDistance = damp(this.currentDistance, allowedDist, DISTANCE_RECOVERY_RATE, dt);
    }

    const camX = px + rayDirX * this.currentDistance;
    let camY = py + rayDirY * this.currentDistance;
    const camZ = pz + rayDirZ * this.currentDistance;

    // 3. Sample heightfield along the ray (8 samples) so the sight line and camera
    //    never dip below terrain + MIN_GROUND_CLEARANCE.
    for (let i = 1; i <= TERRAIN_RAY_SAMPLES; i++) {
      const t = i / TERRAIN_RAY_SAMPLES;
      const sx = px + (camX - px) * t;
      const sz = pz + (camZ - pz) * t;
      const minSampleY = this.heightfield.height(sx, sz) + MIN_GROUND_CLEARANCE;
      const rayY = py + (camY - py) * t;
      if (rayY < minSampleY) {
        camY = py + (minSampleY - py) / t;
      }
    }

    const groundAtCam = this.heightfield.height(camX, camZ) + MIN_GROUND_CLEARANCE;
    if (camY < groundAtCam) {
      camY = groundAtCam;
    }

    this.position.set(camX, camY, camZ);
    this.lookTarget.set(px, py, pz);
  }
}
