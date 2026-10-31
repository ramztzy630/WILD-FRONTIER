/**
 * Pure procedural texture data generators (no three.js, no DOM).
 * Safe for Web Workers and node unit tests.
 */

import { Random } from "./Random.ts";

/**
 * Pure helper (no three/DOM): tiling value noise with 4 octaves.
 * Periodic lattice makes the texture wrap seamlessly.
 */
export function generateTilingNoiseRGBA(
  size: number,
  seed: number,
  tint: (n: number, x: number, y: number) => readonly [number, number, number],
): Uint8Array {
  const rng = new Random(seed);
  const octaves = 4;
  const lattices: Float32Array[] = [];
  const periods: number[] = [];
  for (let o = 0; o < octaves; o++) {
    const period = 4 << o;
    periods.push(period);
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
    lattices.push(lattice);
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      let amp = 0.5;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        const p = periods[o] as number;
        const lat = lattices[o] as Float32Array;
        const fx = (x / size) * p;
        const fy = (y / size) * p;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const x1 = (x0 + 1) % p;
        const y1 = (y0 + 1) % p;
        const a = lat[y0 * p + x0] as number;
        const b = lat[y0 * p + x1] as number;
        const c = lat[y1 * p + x0] as number;
        const d = lat[y1 * p + x1] as number;
        n += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        norm += amp;
        amp *= 0.5;
      }
      const [r, g, bl] = tint(n / norm, x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = bl;
      data[i + 3] = 255;
    }
  }
  return data;
}
