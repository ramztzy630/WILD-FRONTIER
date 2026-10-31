/**
 * Frame statistics + adaptive resolution controller (ARCHITECTURE.md §8.3).
 *
 * Both classes are pure (they are fed timings, they never read clocks),
 * allocation-free per frame, and unit-tested.
 */

import { clamp } from "./math.ts";
import type { FpsCap } from "./GameLoop.ts";

/** Frames longer than this are treated as stalls (tab switch, debugger) and ignored. */
const STALL_MS = 250;

export interface FrameStatsSnapshot {
  fps: number;
  avgFrameMs: number;
  worstFrameMs: number;
  avgWorkMs: number;
}

/** Aggregates frame timings into a snapshot refreshed every `periodMs`. */
export class FrameStats {
  private readonly periodMs: number;
  private elapsed = 0;
  private frames = 0;
  private workSum = 0;
  private worst = 0;
  readonly snapshot: FrameStatsSnapshot = { fps: 0, avgFrameMs: 0, worstFrameMs: 0, avgWorkMs: 0 };
  /** Incremented each time `snapshot` is refreshed. */
  version = 0;

  constructor(periodMs = 500) {
    this.periodMs = periodMs;
  }

  /** Returns true when the snapshot was refreshed by this sample. */
  add(frameDeltaMs: number, workMs: number): boolean {
    if (!(frameDeltaMs > 0) || frameDeltaMs > STALL_MS) return false;
    this.elapsed += frameDeltaMs;
    this.frames++;
    this.workSum += workMs;
    if (frameDeltaMs > this.worst) this.worst = frameDeltaMs;
    if (this.elapsed + 1e-6 < this.periodMs) return false;
    this.snapshot.fps = (this.frames * 1000) / this.elapsed;
    this.snapshot.avgFrameMs = this.elapsed / this.frames;
    this.snapshot.worstFrameMs = this.worst;
    this.snapshot.avgWorkMs = this.workSum / this.frames;
    this.elapsed = 0;
    this.frames = 0;
    this.workSum = 0;
    this.worst = 0;
    this.version++;
    return true;
  }
}

export interface AdaptiveResolutionOptions {
  /** Length of one measurement window. */
  windowMs?: number;
  /** Pixel-ratio change per adjustment. */
  step?: number;
  /** Consecutive over-budget windows needed to step down. */
  downWindows?: number;
  /** Consecutive good windows needed to step up (before backoff). */
  upWindows?: number;
  /** Upper limit for the backoff-extended up-window count. */
  maxUpWindows?: number;
}

/**
 * Lowers the pixel ratio when frames run over budget and raises it again when
 * there is headroom. Hysteresis + backoff prevent oscillation:
 *
 * - Down: average frame time > 120% of budget for `downWindows` windows.
 * - Up (uncapped): average < 70% of budget for `upWindows` windows.
 * - Up (FPS-capped): frames sit at the cap (≤ 105% of budget), because a
 *   capped loop cannot show headroom. Each time a raise is followed by a
 *   drop, the required number of good windows doubles (up to `maxUpWindows`),
 *   so a device that cannot hold a level stops retrying it quickly.
 */
export class AdaptiveResolution {
  private readonly windowMs: number;
  private readonly step: number;
  private readonly downWindows: number;
  private readonly baseUpWindows: number;
  private readonly maxUpWindows: number;

  private min = 1;
  private max = 1;
  private ratio = 1;
  private enabled = true;
  private budgetMs = 1000 / 60;
  private capped = false;

  private windowElapsed = 0;
  private windowFrames = 0;
  private overCount = 0;
  private goodCount = 0;
  private requiredUp: number;
  private lastChange: "up" | "down" | null = null;

  constructor(options: AdaptiveResolutionOptions = {}) {
    this.windowMs = options.windowMs ?? 2000;
    this.step = options.step ?? 0.1;
    this.downWindows = options.downWindows ?? 2;
    this.baseUpWindows = options.upWindows ?? 5;
    this.maxUpWindows = options.maxUpWindows ?? 40;
    this.requiredUp = this.baseUpWindows;
  }

  /** Sets the allowed range and the starting ratio (e.g. when the preset changes). */
  configure(min: number, max: number, initial: number): void {
    this.min = Math.min(min, max);
    this.max = max;
    this.ratio = clamp(initial, this.min, this.max);
    this.resetCounters();
    this.requiredUp = this.baseUpWindows;
    this.lastChange = null;
  }

  /** Frame budget follows the FPS cap (uncapped targets 60 FPS). */
  setFpsCap(cap: FpsCap): void {
    this.capped = cap !== 0;
    this.budgetMs = 1000 / (cap === 0 ? 60 : cap);
    this.resetCounters();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.resetCounters();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getRatio(): number {
    return this.ratio;
  }

  getRange(): { min: number; max: number } {
    return { min: this.min, max: this.max };
  }

  getBudgetMs(): number {
    return this.budgetMs;
  }

  /**
   * Feeds one frame. Returns the new pixel ratio when it changed, otherwise null.
   */
  addFrame(frameDeltaMs: number): number | null {
    if (!this.enabled || !(frameDeltaMs > 0) || frameDeltaMs > STALL_MS) return null;
    this.windowElapsed += frameDeltaMs;
    this.windowFrames++;
    if (this.windowElapsed + 1e-6 < this.windowMs) return null;

    const avg = this.windowElapsed / this.windowFrames;
    // Carry over remainder so windows stay strictly aligned to windowMs
    this.windowElapsed = Math.max(0, this.windowElapsed - this.windowMs);
    this.windowFrames = this.windowElapsed / avg;

    const over = avg > this.budgetMs * 1.2;
    const good = this.capped ? avg <= this.budgetMs * 1.05 : avg < this.budgetMs * 0.7;

    if (over) {
      this.goodCount = 0;
      this.overCount++;
      if (this.overCount >= this.downWindows) {
        this.overCount = 0;
        if (this.lastChange === "up") {
          // The last raise did not hold: wait longer before trying again.
          this.requiredUp = Math.min(this.requiredUp * 2, this.maxUpWindows);
        }
        return this.change(-this.step, "down");
      }
      return null;
    }

    this.overCount = 0;
    if (good) {
      this.goodCount++;
      if (this.goodCount >= this.requiredUp) {
        this.goodCount = 0;
        return this.change(this.step, "up");
      }
    } else {
      this.goodCount = 0;
    }
    return null;
  }

  private change(delta: number, direction: "up" | "down"): number | null {
    // Round to avoid float drift (0.1 steps).
    const next = Math.round(clamp(this.ratio + delta, this.min, this.max) * 100) / 100;
    if (next === this.ratio) return null;
    this.ratio = next;
    this.lastChange = direction;
    return next;
  }

  private resetCounters(): void {
    this.windowElapsed = 0;
    this.windowFrames = 0;
    this.overCount = 0;
    this.goodCount = 0;
  }
}
