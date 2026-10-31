/**
 * Deterministic 2D Simplex noise, fractional Brownian motion (fBm),
 * ridged multifractal noise, and domain-warped fBm (ARCHITECTURE.md §4, §6.1).
 *
 * Pure and allocation-free per sample: safe in Web Workers and unit tests.
 */

import { Random } from "../core/Random.ts";
import { clamp, clamp01 } from "../core/math.ts";

// 2D simplex skew/unskew constants: F2 = 0.5*(sqrt(3)-1), G2 = (3-sqrt(3))/6
const F2 = 0.3660254037844386;
const G2 = 0.21132486540518713;

// 12 unit-circle gradient pairs (gx, gz)
const GRAD2: readonly number[] = [
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
  1, 1, -1, 1, 0, -1, 0, 1,
];

export class SimplexNoise {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Random(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const tmp = p[i] as number;
      p[i] = p[j] as number;
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) {
      const v = p[i & 255] as number;
      this.perm[i] = v;
      this.permMod12[i] = v % 12;
    }
  }

  /** Evaluates 2D simplex noise in [-1, 1]. */
  noise2D(x: number, z: number): number {
    const s = (x + z) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(z + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const z0 = z - (j - t);

    let i1 = 0;
    let j1 = 1;
    if (x0 > z0) {
      i1 = 1;
      j1 = 0;
    }

    const x1 = x0 - i1 + G2;
    const z1 = z0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const z2 = z0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;
    const gi0 = (this.permMod12[ii + (this.perm[jj] as number)] as number) * 2;
    const gi1 = (this.permMod12[ii + i1 + (this.perm[jj + j1] as number)] as number) * 2;
    const gi2 = (this.permMod12[ii + 1 + (this.perm[jj + 1] as number)] as number) * 2;

    let n0 = 0;
    let t0 = 0.5 - x0 * x0 - z0 * z0;
    if (t0 > 0) {
      t0 *= t0;
      n0 = t0 * t0 * ((GRAD2[gi0] as number) * x0 + (GRAD2[gi0 + 1] as number) * z0);
    }

    let n1 = 0;
    let t1 = 0.5 - x1 * x1 - z1 * z1;
    if (t1 > 0) {
      t1 *= t1;
      n1 = t1 * t1 * ((GRAD2[gi1] as number) * x1 + (GRAD2[gi1 + 1] as number) * z1);
    }

    let n2 = 0;
    let t2 = 0.5 - x2 * x2 - z2 * z2;
    if (t2 > 0) {
      t2 *= t2;
      n2 = t2 * t2 * ((GRAD2[gi2] as number) * x2 + (GRAD2[gi2 + 1] as number) * z2);
    }

    return clamp(70 * (n0 + n1 + n2), -1, 1);
  }

  /** Normalized multi-octave fractional Brownian motion in [-1, 1]. */
  fbm(x: number, z: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      // Domain shift per octave avoids coherent axial artifacts.
      sum += amp * this.noise2D(x * freq + o * 17.3, z * freq - o * 11.7);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? clamp(sum / norm, -1, 1) : 0;
  }

  /** Ridged multifractal noise in [0, 1] for sharp mountain crests. */
  ridged(x: number, z: number, octaves = 4, lacunarity = 2.05, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let weight = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      let signal = 1 - Math.abs(this.noise2D(x * freq - o * 23.1, z * freq + o * 19.7));
      signal *= signal * weight;
      weight = clamp01(signal * 1.8);
      sum += signal * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? clamp01(sum / norm) : 0;
  }

  /** Domain-warped fBm in [-1, 1] for organic terrain valleys and biome masks. */
  warpedFbm(x: number, z: number, warpScale = 0.5, warpStrength = 0.65, octaves = 4): number {
    const wx = this.fbm(x * warpScale + 5.2, z * warpScale + 1.3, 2);
    const wz = this.fbm(x * warpScale - 9.1, z * warpScale + 4.7, 2);
    return this.fbm(x + wx * warpStrength, z + wz * warpStrength, octaves);
  }
}
