/**
 * Seeded pseudo-random number generation.
 *
 * World generation must be deterministic from a single uint32 seed
 * (PRD §8), so nothing in the world code may call Math.random().
 * mulberry32 is small, fast, and has good statistical quality for games.
 */

/** Hashes an arbitrary string to a uint32 (FNV-1a). Useful for named sub-seeds. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combines integers into one well-mixed uint32 (for per-chunk / per-cell seeds). */
export function hashInts(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Current internal state; restoring it with `setState` replays the same sequence. */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Picks one element. Throws on an empty array (a programming error, not a runtime state). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Random.pick: empty array");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  /** Approximately normal (Box–Muller), mean 0, standard deviation 1. */
  gaussian(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A new independent generator derived from this one (e.g. one per subsystem). */
  fork(salt = 0): Random {
    return new Random(hashInts(Math.floor(this.next() * 4294967296), salt));
  }
}
