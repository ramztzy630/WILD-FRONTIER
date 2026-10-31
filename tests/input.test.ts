import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KeyboardMouseInput,
  computeKeyboardMoveVector,
  normalizeKeyCode,
} from "../src/core/KeyboardMouseInput.ts";
import {
  DEFAULT_JOYSTICK_DEAD_ZONE,
  DEFAULT_JOYSTICK_RADIUS_PX,
  TouchInput,
  evaluateJoystick,
} from "../src/core/TouchInput.ts";
import { InputManager } from "../src/core/InputManager.ts";
import { CollisionWorld } from "../src/world/Collision.ts";
import { Heightfield } from "../src/world/Heightfield.ts";
import { PlayerController, SPRINT_SPEED, WALK_SPEED } from "../src/player/PlayerController.ts";
import { CameraController } from "../src/player/CameraController.ts";

describe("Joystick dead-zone and direction mapping (Task 3.11)", () => {
  it("outputs zero movement within the radial dead zone while tracking knob pixels", () => {
    const radius = 60;
    const deadZone = 0.2; // 12 px dead zone

    const atCenter = evaluateJoystick(0, 0, radius, deadZone);
    assert.equal(atCenter.moveX, 0);
    assert.equal(atCenter.moveZ, 0);
    assert.equal(atCenter.magnitude, 0);
    assert.equal(atCenter.knobX, 0);
    assert.equal(atCenter.knobY, 0);

    // 10 px right is inside the 12 px dead zone
    const inside = evaluateJoystick(10, 0, radius, deadZone);
    assert.equal(inside.moveX, 0);
    assert.equal(inside.moveZ, 0);
    assert.equal(inside.magnitude, 0);
    assert.ok(Math.abs(inside.knobX - 10) < 1e-6);

    // Exactly on the dead-zone boundary (12 px)
    const boundary = evaluateJoystick(0, -12, radius, deadZone);
    assert.equal(boundary.moveX, 0);
    assert.equal(boundary.moveZ, 0);
    assert.equal(boundary.magnitude, 0);
  });

  it("maps screen directions to camera-relative movement axes and clamps outside max radius", () => {
    const r = DEFAULT_JOYSTICK_RADIUS_PX;
    const dz = DEFAULT_JOYSTICK_DEAD_ZONE;

    // Screen UP (dy < 0) -> forward (+moveZ)
    const up = evaluateJoystick(0, -r, r, dz);
    assert.ok(Math.abs(up.moveX) < 1e-6);
    assert.ok(Math.abs(up.moveZ - 1) < 1e-6);
    assert.ok(Math.abs(up.magnitude - 1) < 1e-6);

    // Screen DOWN (dy > 0) -> backward (-moveZ)
    const down = evaluateJoystick(0, r, r, dz);
    assert.ok(Math.abs(down.moveX) < 1e-6);
    assert.ok(Math.abs(down.moveZ - -1) < 1e-6);
    assert.ok(Math.abs(down.magnitude - 1) < 1e-6);

    // Screen RIGHT (dx > 0) -> strafe right (+moveX)
    const right = evaluateJoystick(r, 0, r, dz);
    assert.ok(Math.abs(right.moveX - 1) < 1e-6);
    assert.ok(Math.abs(right.moveZ) < 1e-6);

    // Screen LEFT (dx < 0) -> strafe left (-moveX)
    const left = evaluateJoystick(-r, 0, r, dz);
    assert.ok(Math.abs(left.moveX - -1) < 1e-6);
    assert.ok(Math.abs(left.moveZ) < 1e-6);

    // Diagonal beyond maxRadius (dx = +200, dy = -200) clamps to unit circle and knob radius
    const diag = evaluateJoystick(200, -200, r, dz);
    assert.ok(Math.abs(diag.magnitude - 1) < 1e-6);
    assert.ok(Math.abs(Math.hypot(diag.moveX, diag.moveZ) - 1) < 1e-6);
    assert.ok(Math.abs(diag.moveX - Math.SQRT1_2) < 1e-5);
    assert.ok(Math.abs(diag.moveZ - Math.SQRT1_2) < 1e-5);
    assert.ok(Math.abs(Math.hypot(diag.knobX, diag.knobY) - r) < 1e-5);
  });

  it("remaps midpoint deflection smoothly between dead zone and max radius", () => {
    const radius = 100;
    const deadZone = 0.2;
    // Halfway between deadZone (20 px) and radius (100 px) is 60 px -> magnitude 0.5
    const half = evaluateJoystick(0, -60, radius, deadZone);
    assert.ok(Math.abs(half.magnitude - 0.5) < 1e-6);
    assert.ok(Math.abs(half.moveZ - 0.5) < 1e-6);
  });
});

describe("TouchInput multitouch pointer tracking (Task 3.11)", () => {
  it("tracks joystick, camera swipe, and jump button simultaneously by pointerId without cross-talk", () => {
    const touch = new TouchInput(50, 0.1);

    // Finger 1: touch down on left joystick at (80, 250) and push forward-right
    assert.equal(touch.startJoystick(1, 80, 250), true);
    // Rejects a second finger trying to steal the joystick while finger 1 holds it
    assert.equal(touch.startJoystick(99, 100, 250), false);
    touch.handlePointerMove(1, 80, 200); // dy = -50 -> full forward

    // Finger 2: touch down on right camera zone at (500, 200) and swipe right/up
    assert.equal(touch.startCameraLook(2, 500, 200), true);
    touch.handlePointerMove(2, 540, 180); // dx = +40, dy = -20

    // Finger 3: press Jump button at the same time
    assert.equal(touch.handleButtonDown("jump", 3), true);
    assert.equal(touch.isButtonPressed("jump"), true);

    // Verify camera look deltas came ONLY from Finger 2
    const look = touch.consumeLookDelta();
    assert.ok(look.deltaYaw < 0, "swiping right turns camera right (negative yaw delta)");
    assert.ok(look.deltaPitch < 0, "swiping up pitches camera upward (negative pitch delta)");

    // Verify simulation step snapshot has both Finger 1 movement and Finger 3 jump
    const step1 = touch.consumeStepSnapshot();
    assert.ok(Math.abs(step1.moveZ - 1) < 1e-5);
    assert.equal(step1.jumpPressed, true);
    assert.equal(step1.jumpHeld, true);

    // Next step: jumpPressed edge is consumed, but jumpHeld and joystick remain active
    const step2 = touch.consumeStepSnapshot();
    assert.equal(step2.jumpPressed, false);
    assert.equal(step2.jumpHeld, true);
    assert.ok(Math.abs(step2.moveZ - 1) < 1e-5);

    // Release Finger 3 (jump) and Finger 2 (camera); Finger 1 (joystick) stays active
    touch.handlePointerUp(3);
    touch.handlePointerUp(2);
    assert.equal(touch.isButtonPressed("jump"), false);
    assert.equal(touch.getActiveCameraPointerCount(), 0);
    assert.equal(touch.getJoystickVisualState().active, true);

    // Release Finger 1 -> joystick resets cleanly to origin
    touch.handlePointerUp(1);
    const joyAfter = touch.getJoystickVisualState();
    assert.equal(joyAfter.active, false);
    assert.equal(joyAfter.magnitude, 0);
    const step3 = touch.consumeStepSnapshot();
    assert.equal(step3.moveX, 0);
    assert.equal(step3.moveZ, 0);
  });

  it("handles two-finger pinch zoom in the camera zone and transitions cleanly when one finger lifts", () => {
    const touch = new TouchInput();

    // Two fingers placed 100 px apart horizontally in the camera zone
    touch.startCameraLook(10, 400, 200);
    touch.startCameraLook(11, 500, 200);
    assert.equal(touch.getActiveCameraPointerCount(), 2);

    // Spread fingers apart to 160 px -> zoom in (negative deltaZoom)
    touch.handlePointerMove(10, 370, 200);
    touch.handlePointerMove(11, 530, 200);
    const zoomIn = touch.consumeLookDelta();
    assert.ok(zoomIn.deltaZoom < -0.5, `expected negative deltaZoom for pinch-out, got ${zoomIn.deltaZoom}`);

    // Pinch fingers closer to 80 px -> zoom out (positive deltaZoom)
    touch.handlePointerMove(10, 410, 200);
    touch.handlePointerMove(11, 490, 200);
    const zoomOut = touch.consumeLookDelta();
    assert.ok(zoomOut.deltaZoom > 0.5, `expected positive deltaZoom for pinch-in, got ${zoomOut.deltaZoom}`);

    // Lift finger 10 -> finger 11 continues single-finger look without jumping
    touch.handlePointerUp(10);
    assert.equal(touch.getActiveCameraPointerCount(), 1);
    touch.handlePointerMove(11, 510, 210);
    const singleLook = touch.consumeLookDelta();
    assert.equal(singleLook.deltaZoom, 0);
    assert.ok(singleLook.deltaYaw < 0);
    assert.ok(singleLook.deltaPitch > 0);
  });

  it("enforces mutual exclusion between sprint/crouch toggles and gates disabled buttons", () => {
    const touch = new TouchInput(50, 0.1);
    touch.startJoystick(1, 100, 200);
    touch.handlePointerMove(1, 100, 140); // full forward deflection

    // Toggle Sprint ON
    touch.handleButtonDown("sprint", 2);
    touch.handlePointerUp(2);
    assert.equal(touch.isSprintToggled(), true);
    assert.equal(touch.consumeStepSnapshot().sprint, true);

    // Toggle Crouch ON -> automatically turns Sprint OFF
    touch.handleButtonDown("crouch", 3);
    touch.handlePointerUp(3);
    assert.equal(touch.isCrouchToggled(), true);
    assert.equal(touch.isSprintToggled(), false);
    const crouchedSnap = touch.consumeStepSnapshot();
    assert.equal(crouchedSnap.crouch, true);
    assert.equal(crouchedSnap.sprint, false);

    // Pressing Jump stands up from Crouch
    touch.handleButtonDown("jump", 4);
    touch.handlePointerUp(4);
    assert.equal(touch.isCrouchToggled(), false);

    // Interact is ignored when disabled, and fires once when enabled
    touch.setInteractEnabled(false);
    assert.equal(touch.handleButtonDown("interact", 5), false);
    assert.equal(touch.consumeStepSnapshot().interactPressed, false);

    touch.setInteractEnabled(true);
    assert.equal(touch.handleButtonDown("interact", 6), true);
    touch.handlePointerUp(6);
    assert.equal(touch.consumeStepSnapshot().interactPressed, true);
    assert.equal(touch.consumeStepSnapshot().interactPressed, false);

    // Inventory is disabled in Phase 3
    assert.equal(touch.isInventoryEnabled(), false);
    assert.equal(touch.handleButtonDown("inventory", 7), false);
    assert.equal(touch.consumeStepSnapshot().inventoryPressed, false);
  });
});

describe("KeyboardMouseInput & InputManager (Task 3.10 & 3.12)", () => {
  it("normalizes WASD/Arrow directions, handles opposing keys, and applies walk/sprint/crouch/actions", () => {
    assert.equal(normalizeKeyCode("w"), "KeyW");
    assert.equal(normalizeKeyCode(" "), "Space");
    assert.equal(normalizeKeyCode("Shift"), "ShiftLeft");
    assert.equal(normalizeKeyCode("Esc"), "Escape");

    // Opposing keys cancel out
    const cancelled = computeKeyboardMoveVector(true, true, false, false);
    assert.equal(cancelled.magnitude, 0);

    // Diagonal W + D is normalized to unit length
    const diag = computeKeyboardMoveVector(true, false, false, true);
    assert.ok(Math.abs(Math.hypot(diag.moveX, diag.moveZ) - 1) < 1e-6);
    assert.ok(Math.abs(diag.moveX - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(diag.moveZ - Math.SQRT1_2) < 1e-6);

    const kb = new KeyboardMouseInput();
    kb.handleKeyDown("KeyW");
    kb.handleKeyDown("ShiftLeft");
    kb.handleKeyDown("Space");
    kb.handleKeyDown("KeyE");
    kb.handleKeyDown("KeyI");

    // Repeated keydown events do not re-trigger one-shot actions
    kb.handleKeyDown("Space", true);
    kb.handleKeyDown("KeyE", true);

    const snap1 = kb.consumeStepSnapshot();
    assert.equal(snap1.moveZ, 1);
    assert.equal(snap1.sprint, true);
    assert.equal(snap1.jumpPressed, true);
    assert.equal(snap1.jumpHeld, true);
    assert.equal(snap1.interactPressed, true);
    assert.equal(snap1.inventoryPressed, true);

    // Second step without new presses clears one-shot flags while keeping held keys
    const snap2 = kb.consumeStepSnapshot();
    assert.equal(snap2.moveZ, 1);
    assert.equal(snap2.sprint, true);
    assert.equal(snap2.jumpPressed, false);
    assert.equal(snap2.jumpHeld, true);
    assert.equal(snap2.interactPressed, false);
    assert.equal(snap2.inventoryPressed, false);

    // Toggle crouch with C after releasing Shift
    kb.handleKeyUp("ShiftLeft");
    kb.handleKeyDown("KeyC");
    assert.equal(kb.consumeStepSnapshot().crouch, true);
    kb.handleKeyDown("KeyC");
    assert.equal(kb.consumeStepSnapshot().crouch, false);

    // Mouse look & wheel zoom
    kb.handleMouseMove(25, -15, true);
    kb.handleWheel(100);
    const look = kb.consumeLookDelta();
    assert.ok(look.deltaYaw < 0);
    assert.ok(look.deltaPitch < 0);
    assert.ok(look.deltaZoom > 0);
  });

  it("merges desktop and touch input in InputManager and drives PlayerController & CameraController", () => {
    const manager = new InputManager(false);
    assert.equal(manager.activeScheme, "keyboard");

    // Touch activity switches scheme to "touch"
    manager.touch.startJoystick(1, 100, 200);
    assert.equal(manager.activeScheme, "touch");

    // Keyboard activity switches scheme back to "keyboard"
    manager.keyboard.handleKeyDown("KeyW");
    assert.equal(manager.activeScheme, "keyboard");

    manager.resetAll();

    // Drive PlayerController + CameraController through InputManager
    const hf = new Heightfield(42);
    hf.height = () => 12;
    hf.normal = (_x: number, _z: number, out = { x: 0, y: 1, z: 0 }) => {
      out.x = 0;
      out.y = 1;
      out.z = 0;
      return out;
    };
    hf.slopeAngle = () => 0;
    hf.waterInfo = () => ({
      hasWater: false,
      surfaceY: 12,
      depth: 0,
      flowX: 0,
      flowZ: 0,
      kind: "none",
    });

    const col = new CollisionWorld(8);
    const player = new PlayerController(hf, col, 0, 0);
    const camera = new CameraController(hf, col);

    // Rotate camera 90 degrees via touch look delta
    manager.touch.startCameraLook(2, 400, 200);
    manager.touch.handlePointerMove(2, 480, 200);
    const look = manager.consumeLookDelta();
    camera.applyLook(look.deltaYaw, look.deltaPitch);
    assert.notEqual(camera.yaw, 0);

    // Move with Alt+W (walk) then Shift+W (sprint)
    manager.keyboard.handleKeyDown("KeyW");
    manager.keyboard.handleKeyDown("AltLeft");
    for (let i = 0; i < 90; i++) {
      const step = manager.consumeStepState();
      player.update(1 / 60, {
        moveX: step.moveX,
        moveZ: step.moveZ,
        cameraYaw: camera.yaw,
        sprint: step.sprint,
        crouch: step.crouch,
        jumpPressed: step.jumpPressed,
      });
    }
    assert.ok(Math.abs(player.speed - WALK_SPEED) < 0.2);

    manager.keyboard.handleKeyUp("AltLeft");
    manager.keyboard.handleKeyDown("ShiftLeft");
    for (let i = 0; i < 90; i++) {
      const step = manager.consumeStepState();
      player.update(1 / 60, {
        moveX: step.moveX,
        moveZ: step.moveZ,
        cameraYaw: camera.yaw,
        sprint: step.sprint,
        crouch: step.crouch,
        jumpPressed: step.jumpPressed,
      });
    }
    assert.ok(Math.abs(player.speed - SPRINT_SPEED) < 0.25);
  });
});
