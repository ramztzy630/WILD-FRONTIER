/**
 * Mobile multitouch input controller (PRD §7; ARCHITECTURE.md §5.2;
 * DESIGN-SYSTEM.md §7.6; Task 3.11).
 *
 * Tracks every active touch independently by `pointerId` across three zones:
 *  1. Floating virtual joystick (left zone): radial dead zone, smooth response
 *     curve, clamped knob offset, camera-relative `(moveX, moveZ)` output.
 *  2. Camera look & pinch-zoom (right zone): single-finger orbit swipe and
 *     two-finger pinch distance zoom, seamless transition when a finger lifts.
 *  3. Action buttons (`jump`, `sprint`, `crouch`, `interact`, `inventory`,
 *     `pause`): per-pointer press tracking so the player can move, rotate the
 *     camera, and jump/act simultaneously.
 *
 * Pure state machine: zero hard dependency on `window` or `document`, making
 * dead-zone math, direction mapping, and multitouch pointer tracking directly
 * unit-testable in Node.
 */

import { clamp, clamp01 } from "./math.ts";

export const DEFAULT_JOYSTICK_RADIUS_PX = 54;
export const DEFAULT_JOYSTICK_DEAD_ZONE = 0.15;
export const TOUCH_LOOK_RAD_PER_PX = 0.0062;
export const TOUCH_PINCH_ZOOM_PER_PX = 0.018;
const MAX_TOUCH_DELTA_PX = 120;

export type TouchActionButton =
  | "jump"
  | "sprint"
  | "crouch"
  | "interact"
  | "inventory"
  | "pause";

export interface JoystickEvalResult {
  /** Normalized horizontal movement in [-1, 1] (-1 = left, +1 = right). */
  moveX: number;
  /** Normalized forward movement in [-1, 1] (+1 = forward/up, -1 = backward/down). */
  moveZ: number;
  /** Normalized radial deflection outside dead zone in [0, 1]. */
  magnitude: number;
  /** Clamped visual knob X offset in CSS pixels from joystick base center. */
  knobX: number;
  /** Clamped visual knob Y offset in CSS pixels from joystick base center. */
  knobY: number;
}

export interface TouchJoystickVisualState {
  readonly active: boolean;
  readonly pointerId: number | null;
  readonly originX: number;
  readonly originY: number;
  readonly knobX: number;
  readonly knobY: number;
  readonly magnitude: number;
}

export interface TouchStepSnapshot {
  readonly moveX: number;
  readonly moveZ: number;
  readonly magnitude: number;
  readonly sprint: boolean;
  readonly crouch: boolean;
  readonly sprintToggled: boolean;
  readonly crouchToggled: boolean;
  readonly jumpHeld: boolean;
  readonly jumpPressed: boolean;
  readonly interactPressed: boolean;
  readonly inventoryPressed: boolean;
  readonly pausePressed: boolean;
}

export interface TouchLookDelta {
  readonly deltaYaw: number;
  readonly deltaPitch: number;
  readonly deltaZoom: number;
}

interface LookPointerRecord {
  x: number;
  y: number;
}

/**
 * Pure radial joystick evaluator with inner dead-zone remapping.
 *
 * Screen coordinates:
 *  - `dxPx > 0` = thumb moved right -> `moveX > 0`
 *  - `dyPx < 0` = thumb moved up    -> `moveZ > 0` (forward)
 *  - `dyPx > 0` = thumb moved down  -> `moveZ < 0` (backward)
 */
export function evaluateJoystick(
  dxPx: number,
  dyPx: number,
  maxRadiusPx = DEFAULT_JOYSTICK_RADIUS_PX,
  deadZone = DEFAULT_JOYSTICK_DEAD_ZONE,
  out: JoystickEvalResult = { moveX: 0, moveZ: 0, magnitude: 0, knobX: 0, knobY: 0 },
): JoystickEvalResult {
  const safeRadius = Math.max(1, maxRadiusPx);
  const safeDeadZone = clamp(deadZone, 0, 0.85);
  const dist = Math.hypot(dxPx, dyPx);

  if (dist < 1e-5) {
    out.moveX = 0;
    out.moveZ = 0;
    out.magnitude = 0;
    out.knobX = 0;
    out.knobY = 0;
    return out;
  }

  const clampedDist = Math.min(dist, safeRadius);
  const ux = dxPx / dist;
  const uy = dyPx / dist;
  out.knobX = ux * clampedDist;
  out.knobY = uy * clampedDist;

  const rawNorm = clampedDist / safeRadius;
  if (rawNorm <= safeDeadZone) {
    out.moveX = 0;
    out.moveZ = 0;
    out.magnitude = 0;
    return out;
  }

  const remapped = clamp01((rawNorm - safeDeadZone) / (1 - safeDeadZone));
  out.moveX = ux * remapped;
  // Invert screen Y so pushing thumb up (-Y) maps to forward (+Z)
  out.moveZ = -uy * remapped;
  out.magnitude = remapped;
  return out;
}

export class TouchInput {
  private joystickRadiusPx: number;
  private deadZone: number;

  private joystickPointerId: number | null = null;
  private joyOriginX = 0;
  private joyOriginY = 0;
  private readonly joyState: JoystickEvalResult = {
    moveX: 0,
    moveZ: 0,
    magnitude: 0,
    knobX: 0,
    knobY: 0,
  };

  private readonly lookPointers = new Map<number, LookPointerRecord>();
  private readonly buttonPointers = new Map<number, TouchActionButton>();

  private sprintToggled = false;
  private crouchToggled = false;
  private interactEnabled = false;
  private inventoryEnabled = false;

  private jumpQueued = false;
  private interactQueued = false;
  private inventoryQueued = false;
  private pauseQueued = false;

  private accumYaw = 0;
  private accumPitch = 0;
  private accumZoom = 0;

  private enabled = true;
  private onActivityCallback: (() => void) | null = null;

  constructor(
    joystickRadiusPx = DEFAULT_JOYSTICK_RADIUS_PX,
    deadZone = DEFAULT_JOYSTICK_DEAD_ZONE,
  ) {
    this.joystickRadiusPx = Math.max(16, joystickRadiusPx);
    this.deadZone = clamp(deadZone, 0, 0.85);
  }

  setOnActivity(cb: (() => void) | null): void {
    this.onActivityCallback = cb;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.resetState(false);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setInteractEnabled(enabled: boolean): void {
    this.interactEnabled = enabled;
    if (!enabled) {
      this.interactQueued = false;
    }
  }

  isInteractEnabled(): boolean {
    return this.interactEnabled;
  }

  setInventoryEnabled(enabled: boolean): void {
    this.inventoryEnabled = enabled;
    if (!enabled) {
      this.inventoryQueued = false;
    }
  }

  isInventoryEnabled(): boolean {
    return this.inventoryEnabled;
  }

  isSprintToggled(): boolean {
    return this.sprintToggled;
  }

  isCrouchToggled(): boolean {
    return this.crouchToggled;
  }

  setSprintToggled(active: boolean): void {
    this.sprintToggled = active;
    if (active) {
      this.crouchToggled = false;
    }
  }

  setCrouchToggled(active: boolean): void {
    this.crouchToggled = active;
    if (active) {
      this.sprintToggled = false;
    }
  }

  /** Returns the current floating joystick state for rendering `TouchControlsUI`. */
  getJoystickVisualState(): TouchJoystickVisualState {
    return {
      active: this.joystickPointerId !== null,
      pointerId: this.joystickPointerId,
      originX: this.joyOriginX,
      originY: this.joyOriginY,
      knobX: this.joyState.knobX,
      knobY: this.joyState.knobY,
      magnitude: this.joyState.magnitude,
    };
  }

  /** Returns true if `button` currently has at least one active touch pointer pressing it. */
  isButtonPressed(button: TouchActionButton): boolean {
    for (const b of this.buttonPointers.values()) {
      if (b === button) return true;
    }
    return false;
  }

  /** Number of active camera-zone fingers currently tracked. */
  getActiveCameraPointerCount(): number {
    return this.lookPointers.size;
  }

  /**
   * Starts tracking the floating joystick with `pointerId` anchored at `(clientX, clientY)`.
   * Returns `false` if disabled or if another pointer already owns the joystick.
   */
  startJoystick(pointerId: number, clientX: number, clientY: number): boolean {
    if (!this.enabled) return false;
    if (this.joystickPointerId !== null && this.joystickPointerId !== pointerId) {
      return false;
    }
    this.onActivityCallback?.();
    this.joystickPointerId = pointerId;
    this.joyOriginX = clientX;
    this.joyOriginY = clientY;
    evaluateJoystick(0, 0, this.joystickRadiusPx, this.deadZone, this.joyState);
    return true;
  }

  /**
   * Starts tracking a finger in the right-side camera swipe / pinch-zoom zone.
   */
  startCameraLook(pointerId: number, clientX: number, clientY: number): boolean {
    if (!this.enabled) return false;
    if (this.joystickPointerId === pointerId || this.buttonPointers.has(pointerId)) {
      return false;
    }
    this.onActivityCallback?.();
    this.lookPointers.set(pointerId, { x: clientX, y: clientY });
    return true;
  }

  /**
   * Starts tracking an action button press by `pointerId`.
   */
  handleButtonDown(button: TouchActionButton, pointerId: number): boolean {
    if (button === "pause") {
      this.onActivityCallback?.();
      this.buttonPointers.set(pointerId, button);
      this.pauseQueued = true;
      return true;
    }

    if (!this.enabled) return false;

    if (button === "interact" && !this.interactEnabled) {
      return false;
    }
    if (button === "inventory" && !this.inventoryEnabled) {
      return false;
    }

    this.onActivityCallback?.();
    this.buttonPointers.set(pointerId, button);

    switch (button) {
      case "jump":
        this.jumpQueued = true;
        this.crouchToggled = false;
        break;
      case "sprint":
        this.sprintToggled = !this.sprintToggled;
        if (this.sprintToggled) {
          this.crouchToggled = false;
        }
        break;
      case "crouch":
        this.crouchToggled = !this.crouchToggled;
        if (this.crouchToggled) {
          this.sprintToggled = false;
        }
        break;
      case "interact":
        this.interactQueued = true;
        break;
      case "inventory":
        this.inventoryQueued = true;
        break;
    }
    return true;
  }

  /**
   * Routes a `pointermove` event to whichever zone (`joystick` or `camera`)
   * owns `pointerId`. Ignores unrelated pointers so multitouch never cross-talks.
   */
  handlePointerMove(pointerId: number, clientX: number, clientY: number): void {
    if (!this.enabled) return;

    if (pointerId === this.joystickPointerId) {
      const dx = clientX - this.joyOriginX;
      const dy = clientY - this.joyOriginY;
      evaluateJoystick(dx, dy, this.joystickRadiusPx, this.deadZone, this.joyState);
      return;
    }

    const lookRec = this.lookPointers.get(pointerId);
    if (!lookRec) return;

    if (this.lookPointers.size === 1) {
      const dx = clamp(clientX - lookRec.x, -MAX_TOUCH_DELTA_PX, MAX_TOUCH_DELTA_PX);
      const dy = clamp(clientY - lookRec.y, -MAX_TOUCH_DELTA_PX, MAX_TOUCH_DELTA_PX);
      lookRec.x = clientX;
      lookRec.y = clientY;
      this.accumYaw += -dx * TOUCH_LOOK_RAD_PER_PX;
      this.accumPitch += dy * TOUCH_LOOK_RAD_PER_PX;
      return;
    }

    // Two-finger pinch zoom + gentle pan on the first two camera pointers
    const iter = this.lookPointers.entries();
    const first = iter.next().value as [number, LookPointerRecord] | undefined;
    const second = iter.next().value as [number, LookPointerRecord] | undefined;
    if (!first || !second) {
      lookRec.x = clientX;
      lookRec.y = clientY;
      return;
    }

    const [idA, ptA] = first;
    const [idB, ptB] = second;
    if (pointerId !== idA && pointerId !== idB) {
      lookRec.x = clientX;
      lookRec.y = clientY;
      return;
    }

    const prevDist = Math.hypot(ptB.x - ptA.x, ptB.y - ptA.y);
    const prevMidX = (ptA.x + ptB.x) * 0.5;
    const prevMidY = (ptA.y + ptB.y) * 0.5;

    lookRec.x = clientX;
    lookRec.y = clientY;

    const newDist = Math.hypot(ptB.x - ptA.x, ptB.y - ptA.y);
    const newMidX = (ptA.x + ptB.x) * 0.5;
    const newMidY = (ptA.y + ptB.y) * 0.5;

    const distDelta = clamp(newDist - prevDist, -MAX_TOUCH_DELTA_PX, MAX_TOUCH_DELTA_PX);
    // Pinching apart (distDelta > 0) zooms IN (reduces target camera distance)
    this.accumZoom += -distDelta * TOUCH_PINCH_ZOOM_PER_PX;

    const midDx = clamp(newMidX - prevMidX, -MAX_TOUCH_DELTA_PX, MAX_TOUCH_DELTA_PX);
    const midDy = clamp(newMidY - prevMidY, -MAX_TOUCH_DELTA_PX, MAX_TOUCH_DELTA_PX);
    this.accumYaw += -midDx * TOUCH_LOOK_RAD_PER_PX * 0.5;
    this.accumPitch += midDy * TOUCH_LOOK_RAD_PER_PX * 0.5;
  }

  /**
   * Releases ownership of `pointerId` on `pointerup` or `pointercancel`.
   */
  handlePointerUp(pointerId: number): void {
    if (pointerId === this.joystickPointerId) {
      this.joystickPointerId = null;
      evaluateJoystick(0, 0, this.joystickRadiusPx, this.deadZone, this.joyState);
    }
    this.lookPointers.delete(pointerId);
    this.buttonPointers.delete(pointerId);
  }

  /** Consumes accumulated per-frame camera look and pinch-zoom deltas. */
  consumeLookDelta(): TouchLookDelta {
    const out: TouchLookDelta = {
      deltaYaw: this.accumYaw,
      deltaPitch: this.accumPitch,
      deltaZoom: this.accumZoom,
    };
    this.accumYaw = 0;
    this.accumPitch = 0;
    this.accumZoom = 0;
    return out;
  }

  /**
   * Samples current joystick vector, toggle states, and consumes one-shot
   * button presses for a 60 Hz simulation step.
   */
  consumeStepSnapshot(): TouchStepSnapshot {
    const jumpHeld = this.isButtonPressed("jump");
    const crouch = this.crouchToggled;
    const sprint = this.sprintToggled && !crouch && this.joyState.magnitude > 0.65;

    const snap: TouchStepSnapshot = {
      moveX: this.joyState.moveX,
      moveZ: this.joyState.moveZ,
      magnitude: this.joyState.magnitude,
      sprint,
      crouch,
      sprintToggled: this.sprintToggled,
      crouchToggled: this.crouchToggled,
      jumpHeld,
      jumpPressed: this.jumpQueued,
      interactPressed: this.interactQueued,
      inventoryPressed: this.inventoryQueued,
      pausePressed: this.pauseQueued,
    };

    this.jumpQueued = false;
    this.interactQueued = false;
    this.inventoryQueued = false;
    this.pauseQueued = false;
    return snap;
  }

  /** Clears active pointers and pending one-shot triggers. */
  resetState(keepToggles = false): void {
    this.joystickPointerId = null;
    evaluateJoystick(0, 0, this.joystickRadiusPx, this.deadZone, this.joyState);
    this.lookPointers.clear();
    this.buttonPointers.clear();
    if (!keepToggles) {
      this.sprintToggled = false;
      this.crouchToggled = false;
    }
    this.jumpQueued = false;
    this.interactQueued = false;
    this.inventoryQueued = false;
    this.pauseQueued = false;
    this.accumYaw = 0;
    this.accumPitch = 0;
    this.accumZoom = 0;
  }
}
