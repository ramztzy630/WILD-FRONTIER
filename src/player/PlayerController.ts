/**
 * Third-person kinematic capsule controller (PRD §6, §8; ARCHITECTURE.md §7).
 *
 * Handles walk/run/sprint/crouch/swim speeds with exponential damping,
 * camera-relative steering, gravity, jump impulse with coyote time and jump
 * buffering, analytic heightfield ground snap, 45° slope limit, spatial-hash
 * obstacle push-out, and world-boundary soft stop.
 */

import { clamp, clamp01, damp, dampAngle, lerp } from "../core/math.ts";
import { CollisionWorld, resolveWorldBounds } from "../world/Collision.ts";
import type { Heightfield } from "../world/Heightfield.ts";
import { queryWaterState, type WaterState } from "../world/Water.ts";

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_CROUCH_HEIGHT = 1.2;

export const CROUCH_SPEED = 1.5;
export const WALK_SPEED = 2.5;
export const RUN_SPEED = 4.5;
export const SPRINT_SPEED = 7.0;
export const SWIM_SPEED = 2.2;

export const GRAVITY = 22.0;
export const JUMP_SPEED = 7.4;
export const COYOTE_TIME = 0.1;
export const JUMP_BUFFER_TIME = 0.1;
export const MAX_SLOPE_ANGLE = Math.PI / 4; // 45 degrees

const ACCEL_GROUND = 14.0;
const DECEL_GROUND = 16.0;
const ACCEL_AIR = 5.5;
const ACCEL_WATER = 7.0;
const TURN_RATE = 14.0;
const GROUND_SNAP_DIST = 0.22;
const SWIM_SUBMERGED_FEET_OFFSET = 1.25;
const MIN_LAND_IMPACT_SPEED = 2.2;
const MAX_LAND_IMPACT_SPEED = 14.0;

export interface PlayerMoveInput {
  /** Strafe input in [-1, 1] (-1 = left, +1 = right). */
  readonly moveX: number;
  /** Forward input in [-1, 1] (+1 = forward along camera yaw, -1 = backward). */
  readonly moveZ: number;
  /** Camera orbit yaw in radians. */
  readonly cameraYaw: number;
  readonly sprint: boolean;
  readonly crouch: boolean;
  /** True on the simulation step where jump was pressed/triggered. */
  readonly jumpPressed: boolean;
}

export interface PlayerKinematicsSnapshot {
  readonly speed: number;
  readonly vy: number;
  readonly grounded: boolean;
  readonly swimming: boolean;
  readonly crouching: boolean;
  readonly sprinting: boolean;
  readonly justJumped: boolean;
  readonly justLanded: boolean;
  readonly landingImpact: number;
}

export interface InterpolatedTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export class PlayerController {
  private readonly heightfield: Heightfield;
  private readonly collision: CollisionWorld;

  x: number;
  y: number;
  z: number;
  yaw = 0;

  prevX: number;
  prevY: number;
  prevZ: number;
  prevYaw = 0;

  vx = 0;
  vy = 0;
  vz = 0;
  speed = 0;

  grounded = true;
  swimming = false;
  crouching = false;
  sprinting = false;

  justJumped = false;
  justLanded = false;
  landingImpact = 0;

  nearBoundary = false;
  boundaryMessage = "";
  waterState: WaterState;

  private coyoteTimer = COYOTE_TIME;
  private jumpBufferTimer = 0;
  private readonly normalScratch = { x: 0, y: 1, z: 0 };
  private readonly interpOut: InterpolatedTransform = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(heightfield: Heightfield, collision: CollisionWorld, startX = 0, startZ = 0) {
    this.heightfield = heightfield;
    this.collision = collision;
    this.x = startX;
    this.z = startZ;
    this.y = heightfield.height(startX, startZ);
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.waterState = queryWaterState(heightfield, this.x, this.z, this.y);
  }

  /** Teleports the player cleanly and resets velocity and interpolation history. */
  setPosition(x: number, z: number, yaw = this.yaw): void {
    this.x = x;
    this.z = z;
    this.y = this.heightfield.height(x, z);
    this.yaw = yaw;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevYaw = yaw;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.speed = 0;
    this.grounded = true;
    this.coyoteTimer = COYOTE_TIME;
    this.jumpBufferTimer = 0;
    this.waterState = queryWaterState(this.heightfield, this.x, this.z, this.y);
    this.swimming = this.waterState.swimming;
  }

  /** Steps player kinematics by fixed `dt` seconds (60 Hz). */
  update(dt: number, input: PlayerMoveInput): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevYaw = this.yaw;

    this.justJumped = false;
    this.justLanded = false;
    this.landingImpact = 0;

    if (input.jumpPressed) {
      this.jumpBufferTimer = JUMP_BUFFER_TIME;
    } else {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    }

    // 1. Check current water state
    this.waterState = queryWaterState(this.heightfield, this.x, this.z, this.y);
    this.swimming = this.waterState.swimming;

    if (this.swimming) {
      this.crouching = false;
      this.sprinting = false;
      this.grounded = false;
      this.coyoteTimer = 0;
    } else {
      this.crouching = input.crouch && this.grounded;
    }

    // 2. Compute camera-relative desired movement vector in XZ
    const rawMag = Math.hypot(input.moveX, input.moveZ);
    const inputMag = Math.min(1, rawMag);
    const normX = rawMag > 1e-5 ? input.moveX / rawMag : 0;
    const normZ = rawMag > 1e-5 ? input.moveZ / rawMag : 0;

    // Camera forward = (sin(yaw), cos(yaw)), right = (-cos(yaw), sin(yaw))
    const fwdX = Math.sin(input.cameraYaw);
    const fwdZ = Math.cos(input.cameraYaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;

    const moveDirX = rightX * normX + fwdX * normZ;
    const moveDirZ = rightZ * normX + fwdZ * normZ;

    // 3. Select target speed tier
    let targetSpeed = 0;
    this.sprinting = false;
    if (inputMag > 1e-3) {
      if (this.swimming) {
        targetSpeed = SWIM_SPEED * inputMag;
      } else if (this.crouching) {
        targetSpeed = CROUCH_SPEED * clamp01(inputMag / 0.5);
      } else if (input.sprint && inputMag > 0.65) {
        targetSpeed = SPRINT_SPEED;
        this.sprinting = true;
      } else if (inputMag > 0.65) {
        targetSpeed = RUN_SPEED * inputMag;
      } else {
        targetSpeed = WALK_SPEED * clamp01(inputMag / 0.5);
      }

      if (this.waterState.shallow) {
        targetSpeed *= 0.78;
      }
    }

    let targetVx = moveDirX * targetSpeed;
    let targetVz = moveDirZ * targetSpeed;

    if (this.waterState.inWater) {
      targetVx += this.waterState.flowX * 0.45;
      targetVz += this.waterState.flowZ * 0.45;
    }

    // 4. Steep slope limit (> 45° blocks uphill velocity component)
    if (!this.swimming) {
      const slopeHere = this.heightfield.slopeAngle(this.x, this.z);
      const probeX = this.x + moveDirX * 0.45;
      const probeZ = this.z + moveDirZ * 0.45;
      const slopeAhead = this.heightfield.slopeAngle(probeX, probeZ);
      if (slopeHere > MAX_SLOPE_ANGLE || slopeAhead > MAX_SLOPE_ANGLE) {
        const n =
          slopeHere >= slopeAhead
            ? this.heightfield.normal(this.x, this.z, this.normalScratch)
            : this.heightfield.normal(probeX, probeZ, this.normalScratch);
        const nhLen = Math.hypot(n.x, n.z);
        if (nhLen > 1e-5) {
          // Uphill unit vector in XZ points opposite the surface normal's XZ projection
          const upX = -n.x / nhLen;
          const upZ = -n.z / nhLen;
          const dotTarget = targetVx * upX + targetVz * upZ;
          if (dotTarget > 0) {
            targetVx -= upX * dotTarget;
            targetVz -= upZ * dotTarget;
          }
          const dotCurr = this.vx * upX + this.vz * upZ;
          if (dotCurr > 0) {
            this.vx -= upX * dotCurr;
            this.vz -= upZ * dotCurr;
          }
        }
      }
    }

    // 5. Exponential velocity damping
    const lambda = this.swimming
      ? ACCEL_WATER
      : !this.grounded
        ? ACCEL_AIR
        : inputMag > 1e-3
          ? ACCEL_GROUND
          : DECEL_GROUND;

    this.vx = damp(this.vx, targetVx, lambda, dt);
    this.vz = damp(this.vz, targetVz, lambda, dt);

    // Rotate character toward horizontal movement direction
    if (inputMag > 1e-3 && Math.hypot(moveDirX, moveDirZ) > 1e-4) {
      const desiredYaw = Math.atan2(moveDirX, moveDirZ);
      this.yaw = dampAngle(this.yaw, desiredYaw, TURN_RATE, dt);
    }

    // 6. Coyote timer & jump impulse (before vertical integration)
    if (this.grounded) {
      this.coyoteTimer = COYOTE_TIME;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }

    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0 && !this.swimming) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
      this.crouching = false;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      this.justJumped = true;
    }

    // 7. Integrate XZ and prevent climbing > 45° slopes
    let nextX = this.x + this.vx * dt;
    let nextZ = this.z + this.vz * dt;
    const stepHoriz = Math.hypot(nextX - this.x, nextZ - this.z);
    if (!this.swimming && stepHoriz > 1e-5) {
      const currGround = this.heightfield.height(this.x, this.z);
      const nextGround = this.heightfield.height(nextX, nextZ);
      const rise = nextGround - currGround;
      if (rise > 0 && Math.atan2(rise, stepHoriz) > MAX_SLOPE_ANGLE) {
        const n = this.heightfield.normal(nextX, nextZ, this.normalScratch);
        const nhLen = Math.hypot(n.x, n.z);
        if (nhLen > 1e-5) {
          const upX = -n.x / nhLen;
          const upZ = -n.z / nhLen;
          const dx = nextX - this.x;
          const dz = nextZ - this.z;
          const dot = dx * upX + dz * upZ;
          if (dot > 0) {
            nextX -= upX * dot;
            nextZ -= upZ * dot;
          }
          const vDot = this.vx * upX + this.vz * upZ;
          if (vDot > 0) {
            this.vx -= upX * vDot;
            this.vz -= upZ * vDot;
          }
        }
      }
    }

    // 8. Resolve static obstacle colliders in XZ
    const capsuleHeight = this.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
    const colRes = this.collision.resolveCircle(
      nextX,
      nextZ,
      PLAYER_RADIUS,
      this.y + 0.05,
      this.y + capsuleHeight,
    );
    nextX = colRes.x;
    nextZ = colRes.z;
    if (colRes.hit) {
      const vn = this.vx * colRes.normalX + this.vz * colRes.normalZ;
      if (vn < 0) {
        this.vx -= colRes.normalX * vn;
        this.vz -= colRes.normalZ * vn;
      }
    }

    // 9. World boundary soft pushback & hard clamp
    const bounds = resolveWorldBounds(nextX, nextZ, PLAYER_RADIUS);
    this.nearBoundary = bounds.nearBoundary;
    this.boundaryMessage = bounds.message;
    if (bounds.nearBoundary) {
      const pushAccel = 18.0;
      this.vx += bounds.pushX * pushAccel * dt;
      this.vz += bounds.pushZ * pushAccel * dt;
      nextX = bounds.x + bounds.pushX * 2.5 * dt;
      nextZ = bounds.z + bounds.pushZ * 2.5 * dt;
      const rebounded = resolveWorldBounds(nextX, nextZ, PLAYER_RADIUS);
      nextX = rebounded.x;
      nextZ = rebounded.z;
    }

    this.x = nextX;
    this.z = nextZ;
    this.speed = Math.hypot(this.vx, this.vz);

    // 10. Vertical integration, buoyancy, and ground snap
    const groundY = this.heightfield.height(this.x, this.z);
    this.waterState = queryWaterState(this.heightfield, this.x, this.z, this.y);
    this.swimming = this.waterState.swimming;

    if (this.swimming) {
      const targetSwimY = Math.max(groundY, this.waterState.surfaceY - SWIM_SUBMERGED_FEET_OFFSET);
      this.y = damp(this.y, targetSwimY, 8.0, dt);
      this.vy = 0;
      this.grounded = false;
      if (this.y < groundY) this.y = groundY;
      return;
    }

    const wasGrounded = this.grounded;
    const preStepVy = this.vy;
    this.vy -= GRAVITY * dt;
    this.y += this.vy * dt;

    // Ground snap when walking down gentle slopes or touching terrain
    const snapMargin = wasGrounded && this.vy <= 0 ? GROUND_SNAP_DIST : 0.0;
    if (this.y <= groundY + snapMargin && this.vy <= 0) {
      if (!wasGrounded && -preStepVy >= MIN_LAND_IMPACT_SPEED) {
        this.justLanded = true;
        this.landingImpact = clamp(
          (-preStepVy - MIN_LAND_IMPACT_SPEED) / (MAX_LAND_IMPACT_SPEED - MIN_LAND_IMPACT_SPEED),
          0.12,
          1.0,
        );
      }
      this.y = groundY;
      this.vy = 0;
      this.grounded = true;
      this.coyoteTimer = COYOTE_TIME;

      // Execute buffered jump immediately on touchdown if jump was pressed just before landing
      if (this.jumpBufferTimer > 0) {
        this.vy = JUMP_SPEED;
        this.grounded = false;
        this.coyoteTimer = 0;
        this.jumpBufferTimer = 0;
        this.justJumped = true;
      }
    } else {
      this.grounded = false;
      if (this.y < groundY) {
        this.y = groundY;
        this.vy = 0;
        this.grounded = true;
      }
    }
  }

  /** Returns a read-only kinematics snapshot for `AnimationController`. */
  getSnapshot(): PlayerKinematicsSnapshot {
    return {
      speed: this.speed,
      vy: this.vy,
      grounded: this.grounded,
      swimming: this.swimming,
      crouching: this.crouching,
      sprinting: this.sprinting,
      justJumped: this.justJumped,
      justLanded: this.justLanded,
      landingImpact: this.landingImpact,
    };
  }

  /** Computes the interpolated render transform for fixed-step `alpha` in [0, 1). */
  getInterpolatedTransform(alpha: number, out = this.interpOut): InterpolatedTransform {
    out.x = lerp(this.prevX, this.x, alpha);
    out.y = lerp(this.prevY, this.y, alpha);
    out.z = lerp(this.prevZ, this.z, alpha);
    out.yaw = dampAngle(this.prevYaw, this.yaw, 60, alpha * (1 / 60));
    return out;
  }
}
