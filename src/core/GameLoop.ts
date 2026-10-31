/**
 * Main loop: one requestAnimationFrame callback driving
 *  - a fixed 60 Hz simulation step (accumulator, capped substeps), and
 *  - a variable-rate render with an interpolation factor.
 *
 * The timing logic lives in two small pure classes (FixedStepper,
 * FrameLimiter) so it can be unit-tested in node without a browser.
 */

export const FIXED_DT = 1 / 60;
/** Longest frame delta accepted; a tab resume never fast-forwards the world. */
export const MAX_FRAME_DT = 0.1;
export const MAX_SUBSTEPS = 4;

export interface StepResult {
  /** Number of fixed steps to run this frame. */
  steps: number;
  /** Interpolation factor in [0, 1) between the previous and current sim state. */
  alpha: number;
  /** Frame delta after clamping, in seconds. */
  frameDt: number;
}

/** Fixed-timestep accumulator. Pure logic, no timers. */
export class FixedStepper {
  readonly step: number;
  readonly maxFrameDt: number;
  readonly maxSubsteps: number;
  private accumulator = 0;
  private readonly result: StepResult = { steps: 0, alpha: 0, frameDt: 0 };

  constructor(step = FIXED_DT, maxFrameDt = MAX_FRAME_DT, maxSubsteps = MAX_SUBSTEPS) {
    this.step = step;
    this.maxFrameDt = maxFrameDt;
    this.maxSubsteps = maxSubsteps;
  }

  /**
   * Adds a frame's elapsed time and returns how many fixed steps to run.
   * The returned object is reused between calls (no per-frame allocation).
   */
  advance(rawDt: number): StepResult {
    const frameDt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, this.maxFrameDt) : 0;
    this.accumulator += frameDt;
    // Tiny epsilon so 1/60 accumulated in float still yields a full step.
    let steps = Math.floor((this.accumulator + 1e-9) / this.step);
    if (steps > this.maxSubsteps) {
      // Spiral-of-death guard: drop the excess time instead of catching up.
      steps = this.maxSubsteps;
      this.accumulator = steps * this.step;
    }
    this.accumulator = Math.max(0, this.accumulator - steps * this.step);
    this.result.steps = steps;
    this.result.alpha = Math.min(this.accumulator / this.step, 0.999999);
    this.result.frameDt = frameDt;
    return this.result;
  }

  reset(): void {
    this.accumulator = 0;
  }

  get pending(): number {
    return this.accumulator;
  }
}

/** FPS cap: 0 means uncapped. */
export type FpsCap = 0 | 30 | 60;

/**
 * Decides whether a rAF callback should produce a frame under an FPS cap.
 * Uses a small tolerance because rAF timestamps jitter around the display rate.
 */
export class FrameLimiter {
  private cap: FpsCap;
  private nextFrameAt = -Infinity;

  constructor(cap: FpsCap = 0) {
    this.cap = cap;
  }

  setCap(cap: FpsCap): void {
    this.cap = cap;
    this.nextFrameAt = -Infinity;
  }

  getCap(): FpsCap {
    return this.cap;
  }

  /** `nowMs` is a rAF/performance timestamp in milliseconds. */
  shouldRender(nowMs: number): boolean {
    if (this.cap === 0) return true;
    const interval = 1000 / this.cap;
    const tolerance = interval * 0.25;
    if (nowMs + tolerance < this.nextFrameAt) return false;
    // Advance on a fixed grid to avoid drift; resync if we fell far behind.
    this.nextFrameAt = nowMs - this.nextFrameAt > interval * 2 ? nowMs + interval : this.nextFrameAt + interval;
    if (this.nextFrameAt < nowMs) this.nextFrameAt = nowMs + interval;
    return true;
  }

  reset(): void {
    this.nextFrameAt = -Infinity;
  }
}

export interface LoopCallbacks {
  /** Called 0..MAX_SUBSTEPS times per frame with the fixed step (seconds). Skipped while the simulation is paused. */
  fixedUpdate(dt: number): void;
  /** Called once per produced frame, even while the simulation is paused (menus, camera, visuals). */
  frameUpdate(frameDt: number, alpha: number): void;
  /** Called once per produced frame after frameUpdate. */
  render(alpha: number): void;
  /** Optional: called with the real frame delta (ms) and the time spent in this frame's callbacks (ms). */
  frameStats?(frameDeltaMs: number, workMs: number): void;
}

export interface LoopEnvironment {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
}

function browserEnvironment(): LoopEnvironment {
  return {
    now: () => performance.now(),
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (h) => cancelAnimationFrame(h),
  };
}

export class GameLoop {
  private readonly callbacks: LoopCallbacks;
  private readonly env: LoopEnvironment;
  private readonly stepper = new FixedStepper();
  private readonly limiter = new FrameLimiter();
  private handle: number | null = null;
  private lastFrameTime: number | null = null;
  private simulationPaused = false;
  private running = false;

  constructor(callbacks: LoopCallbacks, env: LoopEnvironment = browserEnvironment()) {
    this.callbacks = callbacks;
    this.env = env;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resetTiming();
    this.handle = this.env.requestFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) this.env.cancelFrame(this.handle);
    this.handle = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Pauses the fixed-step simulation; rendering and frameUpdate continue. */
  setSimulationPaused(paused: boolean): void {
    if (this.simulationPaused === paused) return;
    this.simulationPaused = paused;
    this.stepper.reset();
  }

  isSimulationPaused(): boolean {
    return this.simulationPaused;
  }

  setFpsCap(cap: FpsCap): void {
    this.limiter.setCap(cap);
  }

  getFpsCap(): FpsCap {
    return this.limiter.getCap();
  }

  /** Forget the previous timestamp (after a hidden tab, a long load, etc.). */
  resetTiming(): void {
    this.lastFrameTime = null;
    this.stepper.reset();
    this.limiter.reset();
  }

  private readonly tick = (time: number): void => {
    if (!this.running) return;
    this.handle = this.env.requestFrame(this.tick);
    if (!this.limiter.shouldRender(time)) return;

    const last = this.lastFrameTime;
    this.lastFrameTime = time;
    const frameDeltaMs = last === null ? 0 : time - last;
    const workStart = this.env.now();

    let alpha = 0;
    let frameDt = Math.min(frameDeltaMs / 1000, MAX_FRAME_DT);
    if (!this.simulationPaused) {
      const r = this.stepper.advance(frameDeltaMs / 1000);
      for (let i = 0; i < r.steps; i++) this.callbacks.fixedUpdate(this.stepper.step);
      alpha = r.alpha;
      frameDt = r.frameDt;
    }
    this.callbacks.frameUpdate(frameDt, alpha);
    this.callbacks.render(alpha);

    if (this.callbacks.frameStats && last !== null) {
      this.callbacks.frameStats(frameDeltaMs, this.env.now() - workStart);
    }
  };
}
