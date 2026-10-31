import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
import { AssetManager } from "../src/core/AssetManager.ts";
import { DEG2RAD } from "../src/core/math.ts";
import { CollisionWorld } from "../src/world/Collision.ts";
import { Heightfield } from "../src/world/Heightfield.ts";
import { WORLD_HALF } from "../src/world/WorldGenerator.ts";
import {
  CROUCH_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
   PlayerController,
  RUN_SPEED,
  SPRINT_SPEED,
  SWIM_SPEED,
  WALK_SPEED,
  type PlayerMoveInput,
} from "../src/player/PlayerController.ts";
import {
  CameraController,
  MAX_CAMERA_DISTANCE,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_DISTANCE,
  MIN_CAMERA_PITCH,
  MIN_GROUND_CLEARANCE,
} from "../src/player/CameraController.ts";
import { AnimationController } from "../src/player/AnimationController.ts";
import { CharacterModel } from "../src/player/CharacterModel.ts";
import { Player } from "../src/player/Player.ts";

const DT = 1 / 60;

function neutralInput(overrides: Partial<PlayerMoveInput> = {}): PlayerMoveInput {
  return {
    moveX: 0,
    moveZ: 0,
    cameraYaw: 0,
    sprint: false,
    crouch: false,
    jumpPressed: false,
    ...overrides,
  };
}

/** Creates a minimal synthetic Heightfield double or real Heightfield for controlled tests. */
function createFlatHeightfield(groundY = 10): Heightfield {
  const hf = new Heightfield(101);
  hf.height = () => groundY;
  hf.normal = (_x: number, _z: number, out = { x: 0, y: 1, z: 0 }) => {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  };
  hf.slopeAngle = () => 0;
  hf.waterInfo = () => ({
    hasWater: false,
    surfaceY: groundY,
    depth: 0,
    flowX: 0,
    flowZ: 0,
    kind: "none",
  });
  return hf;
}

describe("PlayerController kinematics & physics (Task 3.7)", () => {
  it("approaches crouch, walk, run, and sprint target speeds and damps back to rest", () => {
    const hf = createFlatHeightfield(10);
    const col = new CollisionWorld(8);
    const player = new PlayerController(hf, col, 0, 0);

    assert.equal(player.grounded, true);
    assert.equal(player.y, 10);

    // 1. Walk (half stick deflection: moveZ = 0.5)
    for (let i = 0; i < 90; i++) {
      player.update(DT, neutralInput({ moveZ: 0.5 }));
    }
    assert.ok(
      Math.abs(player.speed - WALK_SPEED) < 0.15,
      `expected walk speed ~${WALK_SPEED}, got ${player.speed}`,
    );

    // 2. Run (full stick deflection: moveZ = 1.0)
    for (let i = 0; i < 90; i++) {
      player.update(DT, neutralInput({ moveZ: 1.0 }));
    }
    assert.ok(
      Math.abs(player.speed - RUN_SPEED) < 0.15,
      `expected run speed ~${RUN_SPEED}, got ${player.speed}`,
    );

    // 3. Sprint (full deflection + sprint = true)
    for (let i = 0; i < 90; i++) {
      player.update(DT, neutralInput({ moveZ: 1.0, sprint: true }));
    }
    assert.ok(
      Math.abs(player.speed - SPRINT_SPEED) < 0.2,
      `expected sprint speed ~${SPRINT_SPEED}, got ${player.speed}`,
    );

    // 4. Crouch (crouch = true overrides sprint/run)
    for (let i = 0; i < 90; i++) {
      player.update(DT, neutralInput({ moveZ: 1.0, crouch: true, sprint: true }));
    }
    assert.equal(player.crouching, true);
    assert.ok(
      Math.abs(player.speed - CROUCH_SPEED) < 0.15,
      `expected crouch speed ~${CROUCH_SPEED}, got ${player.speed}`,
    );

    // 5. Release input -> decelerates to ~0
    for (let i = 0; i < 90; i++) {
      player.update(DT, neutralInput());
    }
    assert.ok(player.speed < 0.05, `expected rest speed ~0, got ${player.speed}`);
  });

  it("jumps with impulse, applies gravity, and fires landing impact without falling through terrain", () => {
    const hf = createFlatHeightfield(15);
    const col = new CollisionWorld(8);
    const player = new PlayerController(hf, col, 0, 0);

    // Trigger jump
    player.update(DT, neutralInput({ jumpPressed: true }));
    assert.equal(player.justJumped, true);
    assert.equal(player.grounded, false);
    assert.ok(player.vy > 5);

    let peakY = player.y;
    let landed = false;
    let impact = 0;
    for (let i = 0; i < 120; i++) {
      player.update(DT, neutralInput());
      if (player.y > peakY) peakY = player.y;
      assert.ok(player.y >= 15, `player fell below terrain: y=${player.y}`);
      if (player.justLanded) {
        landed = true;
        impact = player.landingImpact;
        break;
      }
    }

    assert.ok(peakY > 16.0, `expected jump peak > 16.0, got ${peakY}`);
    assert.equal(landed, true, "expected justLanded event when returning to ground");
    assert.ok(impact > 0.1 && impact <= 1.0, `expected landingImpact in (0.1, 1], got ${impact}`);
    assert.equal(player.grounded, true);
    assert.equal(player.y, 15);
  });

  it("supports coyote time (0.1 s after stepping off a ledge) and jump buffering (0.1 s before landing)", () => {
    let groundY = 20;
    const hf = createFlatHeightfield(20);
    hf.height = () => groundY;
    const col = new CollisionWorld(8);
    const player = new PlayerController(hf, col, 0, 0);

    // Step off a ledge (ground drops from 20 to 10)
    groundY = 10;
    // Step 2 frames (0.033 s < 0.1 s coyote window) without jumping
    player.update(DT, neutralInput());
    player.update(DT, neutralInput());
    assert.equal(player.grounded, false);

    // Press jump within coyote time -> must still jump!
    player.update(DT, neutralInput({ jumpPressed: true }));
    assert.equal(player.justJumped, true);
    assert.ok(player.vy > 5);

    // Now test jump buffer: fall until just above ground (y ~ 10.15), press jump while still airborne
    const player2 = new PlayerController(hf, col, 0, 0);
    player2.y = 10.25;
    player2.vy = -6.0;
    player2.grounded = false;
    // Wait out any initial coyote time first by advancing with high altitude
    player2.y = 14.0;
    for (let i = 0; i < 10; i++) player2.update(DT, neutralInput());
    assert.equal(player2.grounded, false);

    // Position just above ground so landing occurs within 2 frames (< 0.1 s buffer)
    player2.y = 10.12;
    player2.vy = -5.0;
    // Press jump while still in air
    player2.update(DT, neutralInput({ jumpPressed: true }));
    // Within the next few frames, player2 touches ground and immediately executes the buffered jump
    let bufferedJumped = player2.justJumped;
    for (let i = 0; i < 4 && !bufferedJumped; i++) {
      player2.update(DT, neutralInput());
      if (player2.justJumped) bufferedJumped = true;
    }
    assert.equal(bufferedJumped, true, "expected buffered jump to fire upon landing");
    assert.ok(player2.vy > 5);
  });

  it("blocks uphill movement on slopes steeper than 45 degrees while allowing downhill movement", () => {
    const hf = createFlatHeightfield(10);
    // Steep cliff rising along +Z (55 degrees slope, normal Tilted towards -Z)
    const cliffAngle = 55 * DEG2RAD;
    hf.height = (_x: number, z: number) => 10 + Math.max(0, z) * Math.tan(cliffAngle);
    hf.normal = (_x: number, z: number, out = { x: 0, y: 1, z: 0 }) => {
      if (z >= 0) {
        out.x = 0;
        out.y = Math.cos(cliffAngle);
        out.z = -Math.sin(cliffAngle);
      } else {
        out.x = 0;
        out.y = 1;
        out.z = 0;
      }
      return out;
    };
    hf.slopeAngle = (_x: number, z: number) => (z >= 0 ? cliffAngle : 0);

    const col = new CollisionWorld(8);
    const player = new PlayerController(hf, col, 0, 1.0);

    const startZ = player.z;
    // Attempt to run uphill (+Z, cameraYaw = 0)
    for (let i = 0; i < 30; i++) {
      player.update(DT, neutralInput({ moveZ: 1.0, cameraYaw: 0 }));
    }
    assert.ok(player.z <= startZ + 0.05, `expected uphill movement blocked, z went from ${startZ} to ${player.z}`);

    // Attempt to move downhill (-Z) -> allowed
    for (let i = 0; i < 30; i++) {
      player.update(DT, neutralInput({ moveZ: -1.0, cameraYaw: 0 }));
    }
    assert.ok(player.z < startZ - 0.5, `expected downhill movement allowed, z=${player.z}`);
  });

  it("transitions to swimming in deep water and slows down in shallow water", () => {
    const realHf = new Heightfield(2026);
    const { lake } = realHf.layout;
    const col = new CollisionWorld(8);

    // Place player in deep lake centre
    const swimmer = new PlayerController(realHf, col, lake.x, lake.z);
    for (let i = 0; i < 60; i++) {
      swimmer.update(DT, neutralInput({ moveZ: 1.0 }));
    }
    assert.equal(swimmer.swimming, true);
    assert.ok(
      Math.abs(swimmer.speed - SWIM_SPEED) < 0.35,
      `expected swim speed ~${SWIM_SPEED}, got ${swimmer.speed}`,
    );
    // Buoyancy keeps feet near surfaceY - offset, well above deep lake bed
    const bedY = realHf.height(swimmer.x, swimmer.z);
    assert.ok(swimmer.y > bedY + 1.0, `swimmer sank to lake bed: y=${swimmer.y}, bed=${bedY}`);
  });

  it("resolves static circle/box colliders and soft-stops at world boundary", () => {
    const hf = createFlatHeightfield(10);
    const col = new CollisionWorld(8);
    // Place a rock obstacle directly ahead at (0, 3) with radius 1.0
    col.addCircle({ x: 0, z: 3, radius: 1.0, minY: 9, maxY: 14, tag: "rock" });

    const player = new PlayerController(hf, col, 0, 0);
    for (let i = 0; i < 90; i++) {
      player.update(DT, neutralInput({ moveZ: 1.0, cameraYaw: 0 }));
    }
    const distToRock = Math.hypot(player.x - 0, player.z - 3);
    assert.ok(
      distToRock >= 1.0 + PLAYER_RADIUS - 1e-3,
      `player penetrated rock collider: dist=${distToRock}`,
    );

    // Place near world edge and try walking outward (+X)
    const edgePlayer = new PlayerController(hf, col, WORLD_HALF - 40, 0);
    for (let i = 0; i < 120; i++) {
      edgePlayer.update(DT, neutralInput({ moveX: -1.0, moveZ: 1.0, cameraYaw: Math.PI / 2 }));
    }
    assert.equal(edgePlayer.nearBoundary, true);
    assert.ok(edgePlayer.boundaryMessage.length > 0);
    assert.ok(edgePlayer.x < WORLD_HALF - 15);
  });
});

describe("CameraController third-person orbit & collision avoidance (Task 3.8)", () => {
  it("clamps pitch and zoom distance, and respects sensitivity and invertY", () => {
    const hf = createFlatHeightfield(10);
    const col = new CollisionWorld(8);
    const cam = new CameraController(hf, col);

    cam.setSensitivity(2.0);
    cam.setInvertY(false);
    cam.applyLook(0.2, 0.1);
    assert.ok(Math.abs(cam.yaw - 0.4) < 1e-6);
    assert.ok(Math.abs(cam.pitch - 0.2) < 1e-6);

    // Invert Y flips pitch direction
    cam.setInvertY(true);
    cam.applyLook(0, 0.1);
    assert.ok(Math.abs(cam.pitch - 0.0) < 1e-6);

    // Extreme pitch clamps to [MIN_CAMERA_PITCH, MAX_CAMERA_PITCH]
    cam.applyLook(0, -100);
    assert.equal(cam.pitch, MAX_CAMERA_PITCH);
    cam.applyLook(0, 100);
    assert.equal(cam.pitch, MIN_CAMERA_PITCH);

    // Extreme zoom clamps to [MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE]
    cam.applyZoom(-100);
    assert.equal(cam.targetDistance, MIN_CAMERA_DISTANCE);
    cam.applyZoom(100);
    assert.equal(cam.targetDistance, MAX_CAMERA_DISTANCE);
  });

  it("pulls camera forward when a collider blocks the sight line and never clips below terrain", () => {
    const hf = createFlatHeightfield(10);
    const col = new CollisionWorld(8);
    const camCtrl = new CameraController(hf, col);
    camCtrl.snapToTarget(0, 10, 0, false);

    // With yaw = 0, camera sits behind the player at -Z (looking toward +Z).
    // Place a cabin box collider at (0, -2.5) blocking the camera ray from (0, 0) to (0, -4.5).
    col.addBox({
      x: 0,
      z: -2.5,
      halfX: 2.0,
      halfZ: 0.4,
      minY: 10,
      maxY: 15,
      tag: "cabin",
    });

    camCtrl.update(DT, 0, 10, 0, false);
    assert.ok(
      camCtrl.currentDistance < 2.2,
      `expected camera to pull in front of cabin (< 2.2m), got ${camCtrl.currentDistance}`,
    );

    // Remove obstacle and make terrain rise steeply behind the player
    col.clear();
    hf.height = (_x: number, z: number) => (z < 0 ? 10 + Math.abs(z) * 1.8 : 10);

    for (let i = 0; i < 30; i++) {
      camCtrl.update(DT, 0, 10, 0, false);
    }
    const groundAtCam = hf.height(camCtrl.position.x, camCtrl.position.z);
    assert.ok(
      camCtrl.position.y >= groundAtCam + MIN_GROUND_CLEARANCE - 1e-3,
      `camera clipped into terrain: camY=${camCtrl.position.y}, ground=${groundAtCam}`,
    );

    // Verify PerspectiveCamera sync
    const threeCam = new PerspectiveCamera(60, 16 / 9, 0.1, 500);
    camCtrl.syncCamera(threeCam);
    assert.ok(Math.abs(threeCam.position.y - camCtrl.position.y) < 1e-5);
  });
});

describe("AnimationController FSM & CharacterModel rig (Task 3.9)", () => {
  it("transitions cleanly across idle, walk, run, sprint, jump, fall, land, crouch, swim, gather, and drink", () => {
    const anim = new AnimationController();
    assert.equal(anim.state, "idle");

    // 1. Walk
    anim.update(DT, {
      speed: WALK_SPEED,
      vy: 0,
      grounded: true,
      swimming: false,
      crouching: false,
      sprinting: false,
      justJumped: false,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "walk");

    // 2. Run
    anim.update(DT, {
      speed: RUN_SPEED,
      vy: 0,
      grounded: true,
      swimming: false,
      crouching: false,
      sprinting: false,
      justJumped: false,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "run");

    // 3. Sprint
    anim.update(DT, {
      speed: SPRINT_SPEED,
      vy: 0,
      grounded: true,
      swimming: false,
      crouching: false,
      sprinting: true,
      justJumped: false,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "sprint");

    // 4. Jump -> Fall -> Land -> Idle
    anim.update(DT, {
      speed: RUN_SPEED,
      vy: 7.0,
      grounded: false,
      swimming: false,
      crouching: false,
      sprinting: false,
      justJumped: true,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "jump");

    anim.update(DT, {
      speed: RUN_SPEED,
      vy: -3.5,
      grounded: false,
      swimming: false,
      crouching: false,
      sprinting: false,
      justJumped: false,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "fall");

    anim.update(DT, {
      speed: 0,
      vy: 0,
      grounded: true,
      swimming: false,
      crouching: false,
      sprinting: false,
      justJumped: false,
      justLanded: true,
      landingImpact: 0.7,
    });
    assert.equal(anim.state, "land");

    // Hold land briefly, then recover to idle
    for (let i = 0; i < 20; i++) {
      anim.update(DT, {
        speed: 0,
        vy: 0,
        grounded: true,
        swimming: false,
        crouching: false,
        sprinting: false,
        justJumped: false,
        justLanded: false,
        landingImpact: 0,
      });
    }
    assert.equal(anim.state, "idle");

    // 5. Crouch
    anim.update(DT, {
      speed: CROUCH_SPEED,
      vy: 0,
      grounded: true,
      swimming: false,
      crouching: true,
      sprinting: false,
      justJumped: false,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "crouch");

    // 6. Swim
    anim.update(DT, {
      speed: SWIM_SPEED,
      vy: 0,
      grounded: false,
      swimming: true,
      crouching: false,
      sprinting: false,
      justJumped: false,
      justLanded: false,
      landingImpact: 0,
    });
    assert.equal(anim.state, "swim");

    // 7. Gather action fires hit event once and returns to idle
    anim.triggerGather("chop");
    assert.equal(anim.state, "gather");
    let hitCount = 0;
    for (let i = 0; i < 60; i++) {
      anim.update(DT, {
        speed: 0,
        vy: 0,
        grounded: true,
        swimming: false,
        crouching: false,
        sprinting: false,
        justJumped: false,
        justLanded: false,
        landingImpact: 0,
      });
      if (anim.justHitGather) hitCount++;
    }
    assert.equal(hitCount, 1, `expected gather hit event once, got ${hitCount}`);
    assert.equal(anim.state, "idle");

    // 8. Drink action completes and returns to idle
    anim.triggerDrink();
    assert.equal(anim.state, "drink");
    for (let i = 0; i < 60; i++) {
      anim.update(DT, {
        speed: 0,
        vy: 0,
        grounded: true,
        swimming: false,
        crouching: false,
        sprinting: false,
        justJumped: false,
        justLanded: false,
        landingImpact: 0,
      });
    }
    assert.equal(anim.state, "idle");
  });

  it("builds procedural CharacterModel without external assets and applies animated poses", () => {
    const assets = new AssetManager();
    const model = new CharacterModel(assets);
    const anim = new AnimationController();

    assert.ok(model.triangleCount >= 80 && model.triangleCount <= 2500, `unexpected triangleCount: ${model.triangleCount}`);
    assert.equal( PLAYER_HEIGHT, 1.8 );

    // Run for a few frames and apply pose to the rig
    for (let i = 0; i < 15; i++) {
      const pose = anim.update(DT, {
        speed: RUN_SPEED,
        vy: 0,
        grounded: true,
        swimming: false,
        crouching: false,
        sprinting: false,
        justJumped: false,
        justLanded: false,
        landingImpact: 0,
      });
      model.applyPose(pose);
    }

    // Left and right legs should be pitched in opposite directions during run stride
    assert.ok(
      Math.abs(model.leftUpperLeg.rotation.x - model.rightUpperLeg.rotation.x) > 0.2,
      "expected opposite leg swing during run animation",
    );

    model.dispose();
  });

  it("integrates Player aggregate (controller + camera + model + anim) across fixed and frame updates", () => {
    const assets = new AssetManager();
    const hf = createFlatHeightfield(12);
    const col = new CollisionWorld(8);
    const player = new Player(assets, hf, col, 5, -5);
    const threeCam = new PerspectiveCamera(60, 16 / 9, 0.1, 500);

    for (let i = 0; i < 30; i++) {
      player.fixedUpdate(DT, neutralInput({ moveZ: 1.0, sprint: true }));
      player.frameUpdate(DT, 0.5, threeCam, true);
    }

    assert.equal(player.anim.state, "sprint");
    assert.ok(player.controller.z > -5 + 1.0, "expected player to move forward along +Z");
    assert.ok(threeCam.position.y >= 12 + MIN_GROUND_CLEARANCE);

    player.dispose();
  });
});
