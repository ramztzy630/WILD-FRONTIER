import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedStepper, FrameLimiter, GameLoop, FIXED_DT, type LoopEnvironment } from "../src/core/GameLoop.ts";
import { GameStateMachine, type GameStateName } from "../src/core/GameState.ts";

describe("FixedStepper", () => {
  it("runs one step per 1/60 s frame", () => {
    const s = new FixedStepper();
    let total = 0;
    for (let i = 0; i < 60; i++) total += s.advance(FIXED_DT).steps;
    assert.equal(total, 60);
  });

  it("runs one step every other frame at 120 Hz with alpha ≈ 0.5 in between", () => {
    const s = new FixedStepper();
    const r1 = s.advance(1 / 120);
    assert.equal(r1.steps, 0);
    assert.ok(Math.abs(r1.alpha - 0.5) < 1e-6);
    const r2 = s.advance(1 / 120);
    assert.equal(r2.steps, 1);
    assert.ok(r2.alpha < 1e-6);
  });

  it("runs two steps per 1/30 s frame (30 FPS cap) and keeps simulated time exact", () => {
    const s = new FixedStepper();
    let total = 0;
    for (let i = 0; i < 30; i++) total += s.advance(1 / 30).steps;
    assert.equal(total, 60);
  });

  it("clamps huge deltas (tab resume) and caps substeps", () => {
    const s = new FixedStepper();
    const r = s.advance(5);
    assert.equal(r.frameDt, 0.1);
    assert.ok(r.steps <= 4);
    // The excess is dropped, not carried into later frames.
    assert.ok(s.pending < FIXED_DT);
  });

  it("ignores negative, zero, and NaN deltas", () => {
    const s = new FixedStepper();
    for (const dt of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = s.advance(dt);
      assert.equal(r.steps, 0);
      assert.equal(r.frameDt, 0);
    }
  });

  it("alpha always stays in [0, 1)", () => {
    const s = new FixedStepper();
    for (let i = 0; i < 500; i++) {
      const r = s.advance(0.005 + ((i * 7919) % 30) / 1000);
      assert.ok(r.alpha >= 0 && r.alpha < 1, `alpha ${r.alpha}`);
    }
  });
});

describe("FrameLimiter", () => {
  const countFrames = (limiter: FrameLimiter, hz: number, seconds: number, jitterMs = 0): number => {
    let rendered = 0;
    const frames = Math.round(hz * seconds);
    for (let i = 0; i < frames; i++) {
      const jitter = jitterMs ? Math.sin(i * 12.9898) * jitterMs : 0;
      if (limiter.shouldRender((i * 1000) / hz + jitter)) rendered++;
    }
    return rendered;
  };

  it("uncapped renders every frame", () => {
    assert.equal(countFrames(new FrameLimiter(0), 60, 2), 120);
  });

  it("30 cap on a 60 Hz display renders ~30 FPS", () => {
    const n = countFrames(new FrameLimiter(30), 60, 4);
    assert.ok(Math.abs(n - 120) <= 2, `rendered ${n}`);
  });

  it("30 cap holds with ±2 ms timestamp jitter", () => {
    const n = countFrames(new FrameLimiter(30), 60, 4, 2);
    assert.ok(Math.abs(n - 120) <= 3, `rendered ${n}`);
  });

  it("60 cap on a 120 Hz display renders ~60 FPS", () => {
    const n = countFrames(new FrameLimiter(60), 120, 4);
    assert.ok(Math.abs(n - 240) <= 2, `rendered ${n}`);
  });

  it("60 cap on a 60 Hz display does not drop frames", () => {
    const n = countFrames(new FrameLimiter(60), 60, 4, 1.5);
    assert.ok(n >= 238, `rendered ${n}`);
  });
});

/** Fake rAF clock so the real GameLoop class can be driven deterministically. */
function fakeEnvironment(): LoopEnvironment & { advance(ms: number): void } {
  let now = 0;
  let pending: ((t: number) => void) | null = null;
  let handle = 0;
  return {
    now: () => now,
    requestFrame(cb) {
      pending = cb;
      return ++handle;
    },
    cancelFrame() {
      pending = null;
    },
    advance(ms: number) {
      now += ms;
      const cb = pending;
      pending = null;
      cb?.(now);
    },
  };
}

describe("GameLoop (fake clock)", () => {
  it("runs fixed steps, frame updates, and renders; pauses only the simulation", () => {
    const env = fakeEnvironment();
    let steps = 0;
    let frames = 0;
    let renders = 0;
    const loop = new GameLoop(
      {
        fixedUpdate: () => steps++,
        frameUpdate: () => frames++,
        render: () => renders++,
      },
      env,
    );
    loop.start();
    for (let i = 0; i < 61; i++) env.advance(1000 / 60);
    // First frame has no previous timestamp (0 steps); 60 frames × 1 step after it.
    assert.equal(steps, 60);
    assert.equal(frames, 61);
    assert.equal(renders, 61);

    loop.setSimulationPaused(true);
    for (let i = 0; i < 30; i++) env.advance(1000 / 60);
    assert.equal(steps, 60, "no steps while paused");
    assert.equal(renders, 91, "still renders while paused");

    loop.stop();
    env.advance(16);
    assert.equal(renders, 91, "nothing after stop");
  });

  it("FPS cap 30 halves renders but keeps 60 sim steps per second", () => {
    const env = fakeEnvironment();
    let steps = 0;
    let renders = 0;
    const loop = new GameLoop({ fixedUpdate: () => steps++, frameUpdate: () => {}, render: () => renders++ }, env);
    loop.setFpsCap(30);
    loop.start();
    for (let i = 0; i < 121; i++) env.advance(1000 / 60);
    assert.ok(Math.abs(renders - 61) <= 1, `renders ${renders}`);
    assert.ok(Math.abs(steps - 120) <= 2, `steps ${steps}`);
  });
});

describe("GameStateMachine", () => {
  it("follows the allowed flow", () => {
    const seen: string[] = [];
    const sm = new GameStateMachine((to, from) => seen.push(`${from}>${to}`));
    const path: GameStateName[] = ["mainMenu", "loading", "playing", "paused", "playing", "dead", "loading", "playing", "paused", "mainMenu"];
    for (const s of path) assert.ok(sm.transition(s), `transition to ${s}`);
    assert.equal(seen.length, path.length);
    assert.equal(sm.state, "mainMenu");
  });

  it("rejects invalid transitions without changing state", () => {
    const sm = new GameStateMachine();
    assert.equal(sm.transition("playing"), false);
    assert.equal(sm.state, "boot");
    sm.transition("mainMenu");
    assert.equal(sm.transition("paused"), false);
    assert.equal(sm.transition("mainMenu"), false, "self-transition is not allowed");
    assert.equal(sm.state, "mainMenu");
  });

  it("dead is never a stuck state", () => {
    const sm = new GameStateMachine();
    sm.transition("mainMenu");
    sm.transition("loading");
    sm.transition("playing");
    sm.transition("dead");
    assert.ok(sm.canTransition("loading") && sm.canTransition("mainMenu"));
  });
});
