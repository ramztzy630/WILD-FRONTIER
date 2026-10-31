/**
 * Desktop keyboard and mouse input controller (PRD §7; ARCHITECTURE.md §5.2;
 * Task 3.10).
 *
 * Key bindings:
 *  - WASD / Arrow keys: camera-relative movement (normalized diagonal vector;
 *    hold Alt for walk speed, default full deflection for run, Shift for sprint)
 *  - Mouse: camera orbit look (via Pointer Lock on canvas click, with mouse-drag
 *    fallback when Pointer Lock is inactive) + mouse wheel zoom
 *  - Space: jump
 *  - Shift: sprint
 *  - C: toggle crouch (or hold Control)
 *  - E: interact (e.g. drink water when at a shoreline)
 *  - I: inventory
 *  - Escape: pause / resume
 *
 * State and key-mapping methods are pure so they can be unit-tested in Node
 * without a browser DOM. `attach()` wires DOM listeners in the browser.
 */

import { clamp } from "./math.ts";

export const MOUSE_LOOK_RAD_PER_PX = 0.0026;
export const MOUSE_DRAG_RAD_PER_PX = 0.0055;
export const WHEEL_ZOOM_PER_STEP = 0.45;
const MAX_MOUSE_DELTA_PX = 120;

export interface KeyboardMoveVector {
  moveX: number;
  moveZ: number;
  magnitude: number;
}

export interface KeyboardStepSnapshot {
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

export interface MouseLookDelta {
  readonly deltaYaw: number;
  readonly deltaPitch: number;
  readonly deltaZoom: number;
}

/**
 * Computes normalized `(moveX, moveZ)` from cardinal key state.
 * `moveX`: -1 = left (A), +1 = right (D)
 * `moveZ`: +1 = forward (W), -1 = backward (S)
 */
export function computeKeyboardMoveVector(
  forward: boolean,
  backward: boolean,
  left: boolean,
  right: boolean,
  walkModifier = false,
  out: KeyboardMoveVector = { moveX: 0, moveZ: 0, magnitude: 0 },
): KeyboardMoveVector {
  const rawX = (right ? 1 : 0) - (left ? 1 : 0);
  const rawZ = (forward ? 1 : 0) - (backward ? 1 : 0);
  const len = Math.hypot(rawX, rawZ);
  if (len < 1e-5) {
    out.moveX = 0;
    out.moveZ = 0;
    out.magnitude = 0;
    return out;
  }
  const scale = walkModifier ? 0.5 : 1.0;
  out.moveX = (rawX / len) * scale;
  out.moveZ = (rawZ / len) * scale;
  out.magnitude = scale;
  return out;
}

export class KeyboardMouseInput {
  private readonly heldCodes = new Set<string>();
  private crouchToggled = false;

  private jumpQueued = false;
  private interactQueued = false;
  private inventoryQueued = false;
  private pauseQueued = false;

  private accumYaw = 0;
  private accumPitch = 0;
  private accumZoom = 0;

  private pointerLocked = false;
  private mouseDragging = false;
  private lastDragX = 0;
  private lastDragY = 0;
  private enabled = true;
  private onActivityCallback: (() => void) | null = null;

  private readonly moveScratch: KeyboardMoveVector = { moveX: 0, moveZ: 0, magnitude: 0 };

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

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  isCrouchToggled(): boolean {
    return this.crouchToggled;
  }

  /** Pure keydown handler (accepts standard `KeyboardEvent.code` or normalized key name). */
  handleKeyDown(code: string, repeat = false): boolean {
    const norm = normalizeKeyCode(code);
    if (!norm) return false;

    // Escape always works even when gameplay input is paused so the user can resume.
    if (norm === "Escape") {
      if (!repeat) {
        this.pauseQueued = true;
        this.onActivityCallback?.();
      }
      return true;
    }

    if (!this.enabled) return false;

    this.heldCodes.add(norm);
    this.onActivityCallback?.();

    if (!repeat) {
      switch (norm) {
        case "Space":
          this.jumpQueued = true;
          this.crouchToggled = false;
          break;
        case "KeyC":
          this.crouchToggled = !this.crouchToggled;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          this.crouchToggled = false;
          break;
        case "KeyE":
          this.interactQueued = true;
          break;
        case "KeyI":
          this.inventoryQueued = true;
          break;
      }
    }
    return true;
  }

  /** Pure keyup handler. */
  handleKeyUp(code: string): boolean {
    const norm = normalizeKeyCode(code);
    if (!norm) return false;
    this.heldCodes.delete(norm);
    return true;
  }

  /** Pure mouse movement handler (supports Pointer Lock relative movement or drag movement). */
  handleMouseMove(dxPx: number, dyPx: number, isPointerLocked = this.pointerLocked): void {
    if (!this.enabled) return;
    if (!isPointerLocked && !this.mouseDragging) return;
    const clampedDx = clamp(dxPx, -MAX_MOUSE_DELTA_PX, MAX_MOUSE_DELTA_PX);
    const clampedDy = clamp(dyPx, -MAX_MOUSE_DELTA_PX, MAX_MOUSE_DELTA_PX);
    if (clampedDx === 0 && clampedDy === 0) return;

    const scale = isPointerLocked ? MOUSE_LOOK_RAD_PER_PX : MOUSE_DRAG_RAD_PER_PX;
    // Moving mouse right (+dx) rotates camera view right (-deltaYaw in our right-handed coords)
    this.accumYaw += -clampedDx * scale;
    // Moving mouse down (+dy) pitches camera downward (+deltaPitch)
    this.accumPitch += clampedDy * scale;
    this.onActivityCallback?.();
  }

  /** Pure mouse wheel handler (`deltaY > 0` scrolls down = zoom out). */
  handleWheel(deltaY: number): void {
    if (!this.enabled || deltaY === 0) return;
    const step = clamp(deltaY / 100, -3, 3);
    this.accumZoom += step * WHEEL_ZOOM_PER_STEP;
    this.onActivityCallback?.();
  }

  /** Consumes accumulated per-frame camera look and zoom deltas. */
  consumeLookDelta(): MouseLookDelta {
    const out: MouseLookDelta = {
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
   * Samples current held movement keys and consumes one-shot action presses
   * (`jumpPressed`, `interactPressed`, `inventoryPressed`, `pausePressed`).
   */
  consumeStepSnapshot(): KeyboardStepSnapshot {
    const forward = this.heldCodes.has("KeyW") || this.heldCodes.has("ArrowUp");
    const backward = this.heldCodes.has("KeyS") || this.heldCodes.has("ArrowDown");
    const left = this.heldCodes.has("KeyA") || this.heldCodes.has("ArrowLeft");
    const right = this.heldCodes.has("KeyD") || this.heldCodes.has("ArrowRight");
    const walkMod = this.heldCodes.has("AltLeft") || this.heldCodes.has("AltRight");

    const mv = computeKeyboardMoveVector(forward, backward, left, right, walkMod, this.moveScratch);
    const sprintHeld = this.heldCodes.has("ShiftLeft") || this.heldCodes.has("ShiftRight");
    const ctrlHeld = this.heldCodes.has("ControlLeft") || this.heldCodes.has("ControlRight");
    const jumpHeld = this.heldCodes.has("Space");

    const crouch = (this.crouchToggled || ctrlHeld) && !sprintHeld;
    const sprint = sprintHeld && !crouch && mv.magnitude > 0.65;

    const snap: KeyboardStepSnapshot = {
      moveX: mv.moveX,
      moveZ: mv.moveZ,
      sprint,
      crouch,
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

  /** Clears held keys, drag state, and pending one-shot actions. */
  resetState(keepCrouchToggle = false): void {
    this.heldCodes.clear();
    if (!keepCrouchToggle) {
      this.crouchToggled = false;
    }
    this.jumpQueued = false;
    this.interactQueued = false;
    this.inventoryQueued = false;
    this.pauseQueued = false;
    this.accumYaw = 0;
    this.accumPitch = 0;
    this.accumZoom = 0;
    this.mouseDragging = false;
  }

  /**
   * Attaches DOM listeners to `viewport` and `window`/`document`.
   * Returns a cleanup function that removes all listeners.
   */
  attach(viewport: HTMLElement, win: Window = window, doc: Document = document): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Ignore shortcuts with Ctrl/Meta so browser reload/devtools still work
      if (event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
        return;
      }
      const code = event.code || event.key;
      if (this.handleKeyDown(code, event.repeat)) {
        if (code === "Space" || code.startsWith("Arrow")) {
          event.preventDefault();
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const code = event.code || event.key;
      this.handleKeyUp(code);
    };

    const onMouseDown = (event: MouseEvent): void => {
      if (!this.enabled) return;
      if (event.button !== 0 && event.button !== 2) return;
      this.onActivityCallback?.();
      this.mouseDragging = true;
      this.lastDragX = event.clientX;
      this.lastDragY = event.clientY;

      // Request Pointer Lock on left-click inside viewport when supported
      const canvas = viewport.querySelector("canvas") ?? viewport;
      if (event.button === 0 && typeof canvas.requestPointerLock === "function" && doc.pointerLockElement !== canvas) {
        try {
          const maybePromise = canvas.requestPointerLock() as unknown;
          if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
            (maybePromise as Promise<void>).catch(() => {
              // Silent fallback to drag-look if browser declines pointer lock
            });
          }
        } catch {
          // Silent fallback to drag-look
        }
      }
    };

    const onMouseMove = (event: MouseEvent): void => {
      if (!this.enabled) return;
      const locked = Boolean(doc.pointerLockElement && viewport.contains(doc.pointerLockElement));
      this.pointerLocked = locked;
      if (locked) {
        this.handleMouseMove(event.movementX, event.movementY, true);
      } else if (this.mouseDragging) {
        const dx = event.clientX - this.lastDragX;
        const dy = event.clientY - this.lastDragY;
        this.lastDragX = event.clientX;
        this.lastDragY = event.clientY;
        this.handleMouseMove(dx, dy, false);
      }
    };

    const onMouseUp = (): void => {
      this.mouseDragging = false;
    };

    const onPointerLockChange = (): void => {
      const locked = Boolean(doc.pointerLockElement && viewport.contains(doc.pointerLockElement));
      this.pointerLocked = locked;
      if (!locked) {
        this.mouseDragging = false;
      }
    };

    const onWheel = (event: WheelEvent): void => {
      if (!this.enabled || event.ctrlKey) return;
      event.preventDefault();
      this.handleWheel(event.deltaY);
    };

    const onBlur = (): void => {
      this.resetState(true);
    };

    win.addEventListener("keydown", onKeyDown);
    win.addEventListener("keyup", onKeyUp);
    win.addEventListener("blur", onBlur);
    viewport.addEventListener("mousedown", onMouseDown);
    win.addEventListener("mousemove", onMouseMove);
    win.addEventListener("mouseup", onMouseUp);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    doc.addEventListener("pointerlockchange", onPointerLockChange);

    return () => {
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
      win.removeEventListener("blur", onBlur);
      viewport.removeEventListener("mousedown", onMouseDown);
      win.removeEventListener("mousemove", onMouseMove);
      win.removeEventListener("mouseup", onMouseUp);
      viewport.removeEventListener("wheel", onWheel);
      doc.removeEventListener("pointerlockchange", onPointerLockChange);
    };
  }
}

/** Maps both standard `KeyboardEvent.code` and fallback `KeyboardEvent.key` strings. */
export function normalizeKeyCode(codeOrKey: string): string | null {
  switch (codeOrKey) {
    case "KeyW":
    case "w":
    case "W":
      return "KeyW";
    case "KeyS":
    case "s":
    case "S":
      return "KeyS";
    case "KeyA":
    case "a":
    case "A":
      return "KeyA";
    case "KeyD":
    case "d":
    case "D":
      return "KeyD";
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return codeOrKey;
    case "Space":
    case " ":
      return "Space";
    case "ShiftLeft":
    case "ShiftRight":
    case "Shift":
      return codeOrKey === "Shift" ? "ShiftLeft" : codeOrKey;
    case "ControlLeft":
    case "ControlRight":
    case "Control":
      return codeOrKey === "Control" ? "ControlLeft" : codeOrKey;
    case "AltLeft":
    case "AltRight":
    case "Alt":
      return codeOrKey === "Alt" ? "AltLeft" : codeOrKey;
    case "KeyC":
    case "c":
    case "C":
      return "KeyC";
    case "KeyE":
    case "e":
    case "E":
      return "KeyE";
    case "KeyI":
    case "i":
    case "I":
      return "KeyI";
    case "Escape":
    case "Esc":
      return "Escape";
    default:
      return null;
  }
}
