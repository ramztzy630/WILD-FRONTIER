/**
 * Unified action map merging `KeyboardMouseInput` and `TouchInput`
 * (ARCHITECTURE.md §4, §5.2).
 *
 * Exposes:
 *  - `consumeStepState()` for the 60 Hz simulation step (movement, jump, sprint,
 *    crouch, interact, inventory, pause).
 *  - `consumeLookDelta()` for per-frame camera orbit and zoom.
 *  - Automatic scheme detection (`"touch" | "keyboard"`) initialized from
 *    `DeviceInfo.touchPrimary` and updated on actual input activity.
 */

import { KeyboardMouseInput } from "./KeyboardMouseInput.ts";
import { TouchInput } from "./TouchInput.ts";

export type InputScheme = "touch" | "keyboard";

export interface InputStepState {
  readonly moveX: number;
  readonly moveZ: number;
  readonly sprint: boolean;
  readonly crouch: boolean;
  readonly jumpHeld: boolean;
  readonly jumpPressed: boolean;
  readonly interactPressed: boolean;
  readonly inventoryPressed: boolean;
  readonly pausePressed: boolean;
}

export interface InputLookDelta {
  readonly deltaYaw: number;
  readonly deltaPitch: number;
  readonly deltaZoom: number;
}

export class InputManager {
  readonly keyboard = new KeyboardMouseInput();
  readonly touch = new TouchInput();

  private scheme: InputScheme;
  private onSchemeChangeCallback: ((scheme: InputScheme) => void) | null = null;

  constructor(touchPrimary = false) {
    this.scheme = touchPrimary ? "touch" : "keyboard";

    this.keyboard.setOnActivity(() => this.setScheme("keyboard"));
    this.touch.setOnActivity(() => this.setScheme("touch"));
  }

  get activeScheme(): InputScheme {
    return this.scheme;
  }

  setOnSchemeChange(cb: ((scheme: InputScheme) => void) | null): void {
    this.onSchemeChangeCallback = cb;
  }

  setScheme(scheme: InputScheme): void {
    if (this.scheme === scheme) return;
    this.scheme = scheme;
    this.onSchemeChangeCallback?.(scheme);
  }

  setGameplayEnabled(enabled: boolean): void {
    this.keyboard.setEnabled(enabled);
    this.touch.setEnabled(enabled);
  }

  setInteractAvailable(available: boolean): void {
    this.touch.setInteractEnabled(available);
  }

  setInventoryAvailable(available: boolean): void {
    this.touch.setInventoryEnabled(available);
  }

  /** Consumes combined per-frame camera look and zoom deltas from mouse + touch. */
  consumeLookDelta(): InputLookDelta {
    const kb = this.keyboard.consumeLookDelta();
    const tc = this.touch.consumeLookDelta();
    return {
      deltaYaw: kb.deltaYaw + tc.deltaYaw,
      deltaPitch: kb.deltaPitch + tc.deltaPitch,
      deltaZoom: kb.deltaZoom + tc.deltaZoom,
    };
  }

  /** Consumes combined 60 Hz simulation step input state from keyboard + touch. */
  consumeStepState(): InputStepState {
    const kb = this.keyboard.consumeStepSnapshot();
    const tc = this.touch.consumeStepSnapshot();

    // Combine movement vectors, clamping total deflection to unit circle
    let moveX = kb.moveX + tc.moveX;
    let moveZ = kb.moveZ + tc.moveZ;
    const mag = Math.hypot(moveX, moveZ);
    if (mag > 1.0) {
      moveX /= mag;
      moveZ /= mag;
    }

    // Keep crouch state synchronized if toggled from either input source
    const crouch = kb.crouch || tc.crouch;
    const sprint = !crouch && (kb.sprint || tc.sprint);

    return {
      moveX,
      moveZ,
      sprint,
      crouch,
      jumpHeld: kb.jumpHeld || tc.jumpHeld,
      jumpPressed: kb.jumpPressed || tc.jumpPressed,
      interactPressed: kb.interactPressed || tc.interactPressed,
      inventoryPressed: kb.inventoryPressed || tc.inventoryPressed,
      pausePressed: kb.pausePressed || tc.pausePressed,
    };
  }

  /** Clears all active keys, touch pointers, and pending one-shot actions. */
  resetAll(keepToggles = false): void {
    this.keyboard.resetState(keepToggles);
    this.touch.resetState(keepToggles);
  }
}
