/**
 * Procedural character animation finite-state machine and pose blender
 * (PRD §6, §11; ARCHITECTURE.md §7).
 *
 * Pure logic: zero Three.js or DOM dependencies so state transitions, action
 * hit events, and pose blending are directly testable in Node.
 */

import { TAU, clamp, clamp01, lerp, smoothstep } from "../core/math.ts";
import type { PlayerKinematicsSnapshot } from "./PlayerController.ts";

export type AnimationState =
  | "idle"
  | "walk"
  | "run"
  | "sprint"
  | "jump"
  | "fall"
  | "land"
  | "crouch"
  | "gather"
  | "swim"
  | "drink";

export type GatherKind = "chop" | "mine" | "pick";

export interface CharacterPose {
  hipsY: number;
  torsoPitch: number;
  torsoRoll: number;
  torsoYaw: number;
  headPitch: number;
  headYaw: number;
  leftShoulderPitch: number;
  leftShoulderRoll: number;
  leftElbowPitch: number;
  rightShoulderPitch: number;
  rightShoulderRoll: number;
  rightElbowPitch: number;
  leftHipPitch: number;
  leftKneePitch: number;
  rightHipPitch: number;
  rightKneePitch: number;
}

const DEFAULT_BLEND_DURATION = 0.18;
const FAST_BLEND_DURATION = 0.11;
const LAND_DURATION = 0.22;
const GATHER_DURATION = 0.65;
const GATHER_HIT_PHASE = 0.55;
const DRINK_DURATION = 0.7;

function createEmptyPose(): CharacterPose {
  return {
    hipsY: 0,
    torsoPitch: 0,
    torsoRoll: 0,
    torsoYaw: 0,
    headPitch: 0,
    headYaw: 0,
    leftShoulderPitch: 0,
    leftShoulderRoll: 0,
    leftElbowPitch: 0,
    rightShoulderPitch: 0,
    rightShoulderRoll: 0,
    rightElbowPitch: 0,
    leftHipPitch: 0,
    leftKneePitch: 0,
    rightHipPitch: 0,
    rightKneePitch: 0,
  };
}

function copyPose(dst: CharacterPose, src: CharacterPose): void {
  dst.hipsY = src.hipsY;
  dst.torsoPitch = src.torsoPitch;
  dst.torsoRoll = src.torsoRoll;
  dst.torsoYaw = src.torsoYaw;
  dst.headPitch = src.headPitch;
  dst.headYaw = src.headYaw;
  dst.leftShoulderPitch = src.leftShoulderPitch;
  dst.leftShoulderRoll = src.leftShoulderRoll;
  dst.leftElbowPitch = src.leftElbowPitch;
  dst.rightShoulderPitch = src.rightShoulderPitch;
  dst.rightShoulderRoll = src.rightShoulderRoll;
  dst.rightElbowPitch = src.rightElbowPitch;
  dst.leftHipPitch = src.leftHipPitch;
  dst.leftKneePitch = src.leftKneePitch;
  dst.rightHipPitch = src.rightHipPitch;
  dst.rightKneePitch = src.rightKneePitch;
}

function blendPoses(out: CharacterPose, a: CharacterPose, b: CharacterPose, t: number): void {
  out.hipsY = lerp(a.hipsY, b.hipsY, t);
  out.torsoPitch = lerp(a.torsoPitch, b.torsoPitch, t);
  out.torsoRoll = lerp(a.torsoRoll, b.torsoRoll, t);
  out.torsoYaw = lerp(a.torsoYaw, b.torsoYaw, t);
  out.headPitch = lerp(a.headPitch, b.headPitch, t);
  out.headYaw = lerp(a.headYaw, b.headYaw, t);
  out.leftShoulderPitch = lerp(a.leftShoulderPitch, b.leftShoulderPitch, t);
  out.leftShoulderRoll = lerp(a.leftShoulderRoll, b.leftShoulderRoll, t);
  out.leftElbowPitch = lerp(a.leftElbowPitch, b.leftElbowPitch, t);
  out.rightShoulderPitch = lerp(a.rightShoulderPitch, b.rightShoulderPitch, t);
  out.rightShoulderRoll = lerp(a.rightShoulderRoll, b.rightShoulderRoll, t);
  out.rightElbowPitch = lerp(a.rightElbowPitch, b.rightElbowPitch, t);
  out.leftHipPitch = lerp(a.leftHipPitch, b.leftHipPitch, t);
  out.leftKneePitch = lerp(a.leftKneePitch, b.leftKneePitch, t);
  out.rightHipPitch = lerp(a.rightHipPitch, b.rightHipPitch, t);
  out.rightKneePitch = lerp(a.rightKneePitch, b.rightKneePitch, t);
}

export class AnimationController {
  state: AnimationState = "idle";
  gatherKind: GatherKind = "chop";
  /** True on the single step where a gather swing crosses its impact frame. */
  justHitGather = false;

  private phase = 0;
  private stateTimer = 0;
  private landImpact = 0.4;
  private gatherHitFired = false;

  private blendElapsed = DEFAULT_BLEND_DURATION;
  private blendDuration = DEFAULT_BLEND_DURATION;
  private readonly fromPose = createEmptyPose();
  private readonly targetPose = createEmptyPose();
  private readonly currentPose = createEmptyPose();

  /** Starts a resource-gathering animation cycle (`chop`, `mine`, or `pick`). */
  triggerGather(kind: GatherKind = "chop"): void {
    this.gatherKind = kind;
    this.gatherHitFired = false;
    this.justHitGather = false;
    this.transitionTo("gather", FAST_BLEND_DURATION, true);
  }

  /** Starts a water-drinking animation cycle. */
  triggerDrink(): void {
    this.justHitGather = false;
    this.transitionTo("drink", DEFAULT_BLEND_DURATION, true);
  }

  /** Advances the FSM and procedural pose blender by `dt` seconds. */
  update(dt: number, kin: PlayerKinematicsSnapshot): Readonly<CharacterPose> {
    this.justHitGather = false;
    this.stateTimer += dt;

    // 1. Evaluate state transitions
    const desired = this.selectNextState(kin);
    if (desired !== this.state) {
      const fast = desired === "jump" || desired === "land" || desired === "fall";
      this.transitionTo(desired, fast ? FAST_BLEND_DURATION : DEFAULT_BLEND_DURATION, false);
    }

    // 2. Advance cycle phase & action events
    this.advancePhase(dt, kin);

    // 3. Evaluate procedural target pose for active state
    this.evaluateStatePose(this.targetPose, kin);

    // 4. Blend from previous pose into active state pose
    this.blendElapsed = Math.min(this.blendDuration, this.blendElapsed + dt);
    const blendT =
      this.blendDuration > 1e-5 ? smoothstep(0, this.blendDuration, this.blendElapsed) : 1;
    blendPoses(this.currentPose, this.fromPose, this.targetPose, blendT);

    return this.currentPose;
  }

  private selectNextState(kin: PlayerKinematicsSnapshot): AnimationState {
    if (kin.swimming) {
      return "swim";
    }
    if (kin.justJumped) {
      return "jump";
    }
    if (!kin.grounded) {
      return kin.vy >= 0.4 ? "jump" : "fall";
    }
    if (kin.justLanded) {
      this.landImpact = clamp(kin.landingImpact, 0.2, 1.0);
      return "land";
    }

    // Non-looping action states run to completion unless interrupted by air/swim/move
    if (this.state === "gather") {
      if (this.stateTimer < GATHER_DURATION && kin.speed < 1.2) {
        return "gather";
      }
    }
    if (this.state === "drink") {
      if (this.stateTimer < DRINK_DURATION && kin.speed < 1.2) {
        return "drink";
      }
    }
    if (this.state === "land") {
      if (this.stateTimer < LAND_DURATION && kin.speed < 3.5) {
        return "land";
      }
    }

    if (kin.crouching) {
      return "crouch";
    }
    if (kin.speed < 0.25) {
      return "idle";
    }
    if (kin.sprinting || kin.speed > 5.6) {
      return "sprint";
    }
    if (kin.speed > 3.2) {
      return "run";
    }
    return "walk";
  }

  private transitionTo(next: AnimationState, duration: number, forceRestart: boolean): void {
    if (this.state === next && !forceRestart) return;
    copyPose(this.fromPose, this.currentPose);
    this.state = next;
    this.stateTimer = 0;
    this.blendElapsed = 0;
    this.blendDuration = duration;
    if (next === "jump" || next === "land" || next === "gather" || next === "drink") {
      this.phase = 0;
    }
  }

  private advancePhase(dt: number, kin: PlayerKinematicsSnapshot): void {
    switch (this.state) {
      case "idle":
        this.phase = (this.phase + dt * 1.9) % TAU;
        break;
      case "walk": {
        const rate = clamp(kin.speed / 2.5, 0.6, 1.4) * 7.2;
        this.phase = (this.phase + dt * rate) % TAU;
        break;
      }
      case "run": {
        const rate = clamp(kin.speed / 4.5, 0.7, 1.35) * 10.5;
        this.phase = (this.phase + dt * rate) % TAU;
        break;
      }
      case "sprint": {
        const rate = clamp(kin.speed / 7.0, 0.8, 1.3) * 13.5;
        this.phase = (this.phase + dt * rate) % TAU;
        break;
      }
      case "crouch": {
        const rate = kin.speed > 0.2 ? 6.2 : 1.6;
        this.phase = (this.phase + dt * rate) % TAU;
        break;
      }
      case "swim":
        this.phase = (this.phase + dt * 5.2) % TAU;
        break;
      case "jump":
      case "fall":
        this.phase = (this.phase + dt * 4.0) % TAU;
        break;
      case "land":
        this.phase = clamp01(this.stateTimer / LAND_DURATION);
        break;
      case "gather": {
        const prevNorm = this.phase;
        const nextNorm = clamp01(this.stateTimer / GATHER_DURATION);
        this.phase = nextNorm;
        if (!this.gatherHitFired && prevNorm < GATHER_HIT_PHASE && nextNorm >= GATHER_HIT_PHASE) {
          this.gatherHitFired = true;
          this.justHitGather = true;
        }
        break;
      }
      case "drink":
        this.phase = clamp01(this.stateTimer / DRINK_DURATION);
        break;
    }
  }

  private evaluateStatePose(out: CharacterPose, kin: PlayerKinematicsSnapshot): void {
    copyPose(out, createEmptyPose());
    const p = this.phase;
    const s = Math.sin(p);
    const c = Math.cos(p);

    switch (this.state) {
      case "idle": {
        out.hipsY = s * 0.015;
        out.torsoPitch = 0.03 + s * 0.02;
        out.headPitch = -s * 0.018;
        out.headYaw = Math.sin(p * 0.5) * 0.05;
        out.leftShoulderRoll = 0.08;
        out.rightShoulderRoll = -0.08;
        out.leftShoulderPitch = s * 0.03;
        out.rightShoulderPitch = -s * 0.03;
        out.leftElbowPitch = -0.18;
        out.rightElbowPitch = -0.18;
        break;
      }

      case "walk": {
        const swing = 0.52;
        out.hipsY = Math.abs(c) * 0.035 - 0.015;
        out.torsoPitch = 0.07;
        out.torsoRoll = s * 0.03;
        out.torsoYaw = -s * 0.06;
        out.leftHipPitch = -s * swing;
        out.rightHipPitch = s * swing;
        out.leftKneePitch = Math.max(0, s) * 0.65 + 0.08;
        out.rightKneePitch = Math.max(0, -s) * 0.65 + 0.08;
        out.leftShoulderPitch = s * 0.38;
        out.rightShoulderPitch = -s * 0.38;
        out.leftShoulderRoll = 0.07;
        out.rightShoulderRoll = -0.07;
        out.leftElbowPitch = -0.28 - Math.max(0, -s) * 0.2;
        out.rightElbowPitch = -0.28 - Math.max(0, s) * 0.2;
        break;
      }

      case "run":
      case "sprint": {
        const sprintBoost = this.state === "sprint" ? 1.25 : 1.0;
        const swing = 0.85 * sprintBoost;
        out.hipsY = Math.cos(p * 2) * 0.055 * sprintBoost - 0.03;
        out.torsoPitch = 0.18 * sprintBoost;
        out.torsoRoll = s * 0.05 * sprintBoost;
        out.torsoYaw = -s * 0.11 * sprintBoost;
        out.headPitch = -0.08 * sprintBoost;
        out.leftHipPitch = -s * swing;
        out.rightHipPitch = s * swing;
        out.leftKneePitch = Math.max(0, s) * 1.15 * sprintBoost + 0.15;
        out.rightKneePitch = Math.max(0, -s) * 1.15 * sprintBoost + 0.15;
        out.leftShoulderPitch = s * 0.72 * sprintBoost;
        out.rightShoulderPitch = -s * 0.72 * sprintBoost;
        out.leftShoulderRoll = 0.1;
        out.rightShoulderRoll = -0.1;
        out.leftElbowPitch = -0.85;
        out.rightElbowPitch = -0.85;
        break;
      }

      case "crouch": {
        const moving = kin.speed > 0.2;
        const swing = moving ? 0.38 : 0.0;
        out.hipsY = -0.32 + (moving ? Math.abs(c) * 0.02 : s * 0.01);
        out.torsoPitch = 0.36;
        out.headPitch = -0.22;
        out.leftHipPitch = -0.55 - s * swing;
        out.rightHipPitch = -0.55 + s * swing;
        out.leftKneePitch = 0.95 + Math.max(0, s) * 0.35;
        out.rightKneePitch = 0.95 + Math.max(0, -s) * 0.35;
        out.leftShoulderPitch = -0.18 + s * swing * 0.6;
        out.rightShoulderPitch = -0.18 - s * swing * 0.6;
        out.leftElbowPitch = -0.55;
        out.rightElbowPitch = -0.55;
        break;
      }

      case "jump": {
        out.hipsY = 0.06;
        out.torsoPitch = 0.12;
        out.headPitch = -0.12;
        out.leftHipPitch = -0.55;
        out.rightHipPitch = -0.25;
        out.leftKneePitch = 0.75;
        out.rightKneePitch = 0.45;
        out.leftShoulderPitch = -0.85;
        out.rightShoulderPitch = -0.85;
        out.leftShoulderRoll = 0.22;
        out.rightShoulderRoll = -0.22;
        out.leftElbowPitch = -0.45;
        out.rightElbowPitch = -0.45;
        break;
      }

      case "fall": {
        out.hipsY = 0.02;
        out.torsoPitch = 0.16;
        out.leftHipPitch = -0.35 + s * 0.08;
        out.rightHipPitch = -0.2 - s * 0.08;
        out.leftKneePitch = 0.55;
        out.rightKneePitch = 0.45;
        out.leftShoulderPitch = -1.1 + c * 0.08;
        out.rightShoulderPitch = -1.1 - c * 0.08;
        out.leftShoulderRoll = 0.35;
        out.rightShoulderRoll = -0.35;
        out.leftElbowPitch = -0.35;
        out.rightElbowPitch = -0.35;
        break;
      }

      case "land": {
        const dip = Math.sin(p * Math.PI) * this.landImpact;
        out.hipsY = -0.28 * dip;
        out.torsoPitch = 0.32 * dip;
        out.headPitch = 0.15 * dip;
        out.leftHipPitch = -0.52 * dip;
        out.rightHipPitch = -0.52 * dip;
        out.leftKneePitch = 0.92 * dip;
        out.rightKneePitch = 0.92 * dip;
        out.leftShoulderPitch = 0.25 * dip;
        out.rightShoulderPitch = 0.25 * dip;
        out.leftShoulderRoll = 0.18 * dip;
        out.rightShoulderRoll = -0.18 * dip;
        out.leftElbowPitch = -0.5 * dip;
        out.rightElbowPitch = -0.5 * dip;
        break;
      }

      case "swim": {
        out.hipsY = -0.25 + s * 0.04;
        out.torsoPitch = 0.55;
        out.headPitch = -0.42;
        out.leftHipPitch = -s * 0.35;
        out.rightHipPitch = s * 0.35;
        out.leftKneePitch = 0.35 + Math.max(0, s) * 0.35;
        out.rightKneePitch = 0.35 + Math.max(0, -s) * 0.35;
        out.leftShoulderPitch = -0.7 + s * 0.75;
        out.rightShoulderPitch = -0.7 - s * 0.75;
        out.leftShoulderRoll = 0.38;
        out.rightShoulderRoll = -0.38;
        out.leftElbowPitch = -0.55;
        out.rightElbowPitch = -0.55;
        break;
      }

      case "gather": {
        if (this.gatherKind === "pick") {
          const bend = Math.sin(p * Math.PI);
          out.hipsY = -0.24 * bend;
          out.torsoPitch = 0.48 * bend;
          out.leftHipPitch = -0.45 * bend;
          out.rightHipPitch = -0.45 * bend;
          out.leftKneePitch = 0.8 * bend;
          out.rightKneePitch = 0.8 * bend;
          out.rightShoulderPitch = -0.95 * bend;
          out.rightElbowPitch = -0.45 * bend;
        } else {
          // Wind-up [0..0.45] -> strike [0.45..0.65] -> recover [0.65..1]
          const windUp = smoothstep(0.0, 0.45, p);
          const strike = smoothstep(0.42, 0.62, p);
          const recover = 1 - smoothstep(0.65, 1.0, p);
          const swingArc = lerp(-1.55 * windUp, 0.65, strike) * recover;
          out.torsoPitch = lerp(-0.12 * windUp, 0.28, strike) * recover;
          out.torsoYaw = lerp(0.25 * windUp, -0.22, strike) * recover;
          out.rightShoulderPitch = swingArc;
          out.rightElbowPitch = -0.45 * recover;
          out.leftShoulderPitch = -0.35 * recover;
          out.leftElbowPitch = -0.5 * recover;
        }
        break;
      }

      case "drink": {
        const cup = Math.sin(p * Math.PI);
        out.hipsY = -0.2 * cup;
        out.torsoPitch = 0.25 * cup;
        out.headPitch = -0.28 * cup;
        out.rightShoulderPitch = -1.25 * cup;
        out.rightElbowPitch = -1.1 * cup;
        out.leftShoulderPitch = -0.95 * cup;
        out.leftElbowPitch = -0.95 * cup;
        break;
      }
    }
  }
}
