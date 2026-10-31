/**
 * Graphics preset tables (ARCHITECTURE.md §8.2).
 *
 * This file is pure data + pure helpers so it can be unit-tested and shared.
 * Applying a preset to the renderer happens in SceneManager.applyGraphics();
 * later phases (terrain, vegetation, weather) read the same object.
 */

import type { FpsCap } from "./GameLoop.ts";

export type PresetName = "low" | "medium" | "high" | "ultra";

export const PRESET_NAMES: readonly PresetName[] = ["low", "medium", "high", "ultra"];

export const PRESET_LABELS: Readonly<Record<PresetName, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

export type ShadowQuality = "off" | "medium" | "high" | "ultra";

export interface GraphicsPreset {
  readonly name: PresetName;
  /** Upper bound for the device pixel ratio actually used. `Infinity` = use the device ratio. */
  readonly maxPixelRatio: number;
  /** Adaptive resolution range (absolute pixel ratios), clamped to the device ratio at runtime. */
  readonly adaptiveMin: number;
  readonly adaptiveMax: number;
  /** View distance in 64 m terrain chunks. */
  readonly viewDistanceChunks: number;
  readonly shadows: ShadowQuality;
  readonly shadowMapSize: number;
  /** Render the shadow map every N frames (1 = every frame). */
  readonly shadowInterval: number;
  /** Grass radius in metres; 0 = off. */
  readonly grassRadius: number;
  readonly grassDensity: number;
  /** Multiplier for tree LOD switch distances. */
  readonly lodDistanceScale: number;
  readonly standardMaterials: boolean;
  readonly antialias: boolean;
  readonly rainParticles: number;
  readonly maxPointLights: number;
  readonly postGrade: boolean;
  readonly defaultFpsCap: FpsCap;
  /** Wildlife pool size (ARCHITECTURE.md §9). */
  readonly animalPool: number;
}

const PRESETS: Readonly<Record<PresetName, GraphicsPreset>> = {
  low: {
    name: "low",
    maxPixelRatio: 0.75,
    adaptiveMin: 0.5,
    adaptiveMax: 0.75,
    viewDistanceChunks: 4,
    shadows: "off",
    shadowMapSize: 0,
    shadowInterval: 0,
    grassRadius: 0,
    grassDensity: 0,
    lodDistanceScale: 0.6,
    standardMaterials: false,
    antialias: false,
    rainParticles: 300,
    maxPointLights: 1,
    postGrade: false,
    defaultFpsCap: 30,
    animalPool: 12,
  },
  medium: {
    name: "medium",
    maxPixelRatio: 1.0,
    adaptiveMin: 0.6,
    adaptiveMax: 1.0,
    viewDistanceChunks: 6,
    shadows: "medium",
    shadowMapSize: 1024,
    shadowInterval: 2,
    grassRadius: 30,
    grassDensity: 0.5,
    lodDistanceScale: 1.0,
    standardMaterials: false,
    antialias: false,
    rainParticles: 800,
    maxPointLights: 2,
    postGrade: false,
    defaultFpsCap: 30,
    animalPool: 20,
  },
  high: {
    name: "high",
    maxPixelRatio: 1.5,
    adaptiveMin: 0.75,
    adaptiveMax: 1.5,
    viewDistanceChunks: 8,
    shadows: "high",
    shadowMapSize: 2048,
    shadowInterval: 1,
    grassRadius: 45,
    grassDensity: 0.8,
    lodDistanceScale: 1.4,
    standardMaterials: true,
    antialias: true,
    rainParticles: 1500,
    maxPointLights: 4,
    postGrade: false,
    defaultFpsCap: 60,
    animalPool: 30,
  },
  ultra: {
    name: "ultra",
    maxPixelRatio: 2.0,
    adaptiveMin: 1.0,
    adaptiveMax: 2.0,
    viewDistanceChunks: 10,
    shadows: "ultra",
    shadowMapSize: 2048,
    shadowInterval: 1,
    grassRadius: 60,
    grassDensity: 1.0,
    lodDistanceScale: 1.8,
    standardMaterials: true,
    antialias: true,
    rainParticles: 2500,
    maxPointLights: 4,
    postGrade: true,
    defaultFpsCap: 0,
    animalPool: 30,
  },
};

export function getPreset(name: PresetName): GraphicsPreset {
  return PRESETS[name];
}

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === "string" && (PRESET_NAMES as readonly string[]).includes(value);
}

export interface PixelRatioRange {
  readonly initial: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Resolves the preset's pixel-ratio limits against the real device ratio.
 * Never renders above the device's native ratio (wasted fill-rate), and keeps
 * min ≤ initial ≤ max.
 */
export function resolvePixelRatio(preset: GraphicsPreset, devicePixelRatio: number): PixelRatioRange {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const max = Math.min(preset.adaptiveMax, preset.maxPixelRatio, dpr);
  const min = Math.min(preset.adaptiveMin, max);
  const initial = Math.min(preset.maxPixelRatio, dpr, max);
  return { initial, min, max };
}
