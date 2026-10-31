/**
 * Small, allocation-free math helpers shared by every system.
 * Pure functions only: safe in workers and in node unit tests.
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse of lerp: where `value` lies between a and b (unclamped). */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/** Maps value from [inMin, inMax] to [outMin, outMax], clamped. */
export function remapClamped(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, value)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the decay rate per second (higher = snappier).
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Wraps an angle in radians to (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = (angle + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference from angle a to angle b, in radians. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Frame-rate independent smoothing for angles (takes the short way round). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon;
}
