import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWeakGpu, selectDefaultPreset, type DeviceInfo } from "../src/core/DeviceProfile.ts";
import { PRESET_NAMES, getPreset, isPresetName, resolvePixelRatio } from "../src/core/GraphicsSettings.ts";
import { AdaptiveResolution, FrameStats } from "../src/core/PerformanceMonitor.ts";
import { generateTilingNoiseRGBA } from "../src/core/proceduralTextures.ts";

const baseDevice: DeviceInfo = {
  mobile: true,
  touch: true,
  memoryGB: 8,
  cores: 8,
  devicePixelRatio: 2.75,
  gpu: "ANGLE (ARM, Mali-G57 MC2, OpenGL ES 3.2)",
  webgl2: true,
  maxTextureSize: 8192,
};

describe("DeviceProfile.selectDefaultPreset", () => {
  it("mid-range Android → medium", () => {
    assert.equal(selectDefaultPreset(baseDevice), "medium");
  });

  it("low memory or few cores on mobile → low", () => {
    assert.equal(selectDefaultPreset({ ...baseDevice, memoryGB: 2 }), "low");
    assert.equal(selectDefaultPreset({ ...baseDevice, cores: 4 }), "low");
  });

  it("unknown memory/cores (Safari/Firefox) does not force low", () => {
    assert.equal(selectDefaultPreset({ ...baseDevice, memoryGB: null, cores: null }), "medium");
  });

  it("mobile without WebGL2 → low", () => {
    assert.equal(selectDefaultPreset({ ...baseDevice, webgl2: false }), "low");
  });

  it("weak GPU strings → low, even on desktop", () => {
    for (const gpu of [
      "Mali-G52 MC2",
      "Adreno (TM) 506",
      "PowerVR Rogue GE8320",
      "Google SwiftShader",
      "Intel(R) HD Graphics 520",
    ]) {
      assert.ok(isWeakGpu(gpu), gpu);
      assert.equal(selectDefaultPreset({ ...baseDevice, mobile: false, gpu }), "low", gpu);
    }
  });

  it("capable GPUs are not flagged", () => {
    for (const gpu of ["Adreno (TM) 730", "Mali-G710", "Apple GPU", "NVIDIA GeForce RTX 3060", "Mali-G57 MC2"]) {
      assert.equal(isWeakGpu(gpu), false, gpu);
    }
  });

  it("desktop → high", () => {
    assert.equal(
      selectDefaultPreset({ ...baseDevice, mobile: false, touch: false, gpu: "NVIDIA GeForce GTX 1060", devicePixelRatio: 1 }),
      "high",
    );
  });
});

describe("GraphicsSettings", () => {
  it("presets get strictly heavier from low to ultra", () => {
    for (let i = 1; i < PRESET_NAMES.length; i++) {
      const a = getPreset(PRESET_NAMES[i - 1] as (typeof PRESET_NAMES)[number]);
      const b = getPreset(PRESET_NAMES[i] as (typeof PRESET_NAMES)[number]);
      assert.ok(b.viewDistanceChunks > a.viewDistanceChunks, `${a.name}→${b.name} view distance`);
      assert.ok(b.rainParticles > a.rainParticles, `${a.name}→${b.name} rain`);
      assert.ok(b.maxPixelRatio > a.maxPixelRatio, `${a.name}→${b.name} pixel ratio`);
    }
  });

  it("every preset has a consistent adaptive range", () => {
    for (const name of PRESET_NAMES) {
      const p = getPreset(name);
      assert.ok(p.adaptiveMin <= p.adaptiveMax, name);
      assert.ok(p.adaptiveMax <= p.maxPixelRatio + 1e-9, name);
      assert.equal(p.shadows === "off", p.shadowMapSize === 0, name);
    }
  });

  it("isPresetName validates", () => {
    assert.ok(isPresetName("medium"));
    assert.equal(isPresetName("epic"), false);
    assert.equal(isPresetName(3), false);
  });

  it("resolvePixelRatio never exceeds the device ratio", () => {
    const ultraOnLowDpr = resolvePixelRatio(getPreset("ultra"), 1);
    assert.deepEqual(ultraOnLowDpr, { initial: 1, min: 1, max: 1 });
    const mediumOnPhone = resolvePixelRatio(getPreset("medium"), 2.75);
    assert.deepEqual(mediumOnPhone, { initial: 1, min: 0.6, max: 1 });
    const bad = resolvePixelRatio(getPreset("high"), Number.NaN);
    assert.ok(bad.max <= 1 && bad.min <= bad.initial && bad.initial <= bad.max);
  });
});

describe("FrameStats", () => {
  it("produces an fps snapshot every period and ignores stalls", () => {
    const s = new FrameStats(500);
    let refreshed = 0;
    for (let i = 0; i < 60; i++) if (s.add(1000 / 60, 2)) refreshed++;
    assert.equal(refreshed, 2);
    assert.ok(Math.abs(s.snapshot.fps - 60) < 0.5, `fps ${s.snapshot.fps}`);
    assert.ok(Math.abs(s.snapshot.avgWorkMs - 2) < 1e-9);
    assert.equal(s.add(5000, 1), false);
  });
});

describe("AdaptiveResolution", () => {
  /** Feeds `seconds` worth of frames at `frameMs`; returns every ratio change. */
  const feed = (ar: AdaptiveResolution, frameMs: number, seconds: number): number[] => {
    const changes: number[] = [];
    const n = Math.round((seconds * 1000) / frameMs);
    for (let i = 0; i < n; i++) {
      const r = ar.addFrame(frameMs);
      if (r !== null) changes.push(r);
    }
    return changes;
  };

  it("steps down after two slow windows, not after one", () => {
    const ar = new AdaptiveResolution();
    ar.configure(0.6, 1.0, 1.0);
    ar.setFpsCap(30);
    assert.deepEqual(feed(ar, 50, 2), [], "one slow window is tolerated");
    assert.deepEqual(feed(ar, 50, 2), [0.9]);
  });

  it("never leaves the configured range", () => {
    const ar = new AdaptiveResolution();
    ar.configure(0.6, 1.0, 1.0);
    ar.setFpsCap(30);
    feed(ar, 80, 60);
    assert.equal(ar.getRatio(), 0.6);
    feed(ar, 1000 / 30, 600);
    assert.equal(ar.getRatio(), 1.0);
  });

  it("uncapped: raises only with real headroom (< 70% of budget)", () => {
    const ar = new AdaptiveResolution();
    ar.configure(0.6, 1.0, 0.8);
    ar.setFpsCap(0);
    assert.deepEqual(feed(ar, 15, 30), [], "at budget: no raise");
    const up = feed(ar, 10, 10);
    assert.deepEqual(up, [0.9], "5 good windows → one step up");
  });

  it("does not oscillate: a failed raise doubles the wait before the next try", () => {
    const ar = new AdaptiveResolution();
    ar.configure(0.6, 1.0, 1.0);
    ar.setFpsCap(30);
    feed(ar, 50, 4); // down to 0.9
    assert.equal(ar.getRatio(), 0.9);
    assert.deepEqual(feed(ar, 1000 / 30, 10), [1.0], "raise after 5 good windows");
    feed(ar, 50, 4); // fails again → 0.9, backoff to 10 windows
    assert.equal(ar.getRatio(), 0.9);
    assert.deepEqual(feed(ar, 1000 / 30, 18), [], "no retry before 10 windows");
    assert.deepEqual(feed(ar, 1000 / 30, 2), [1.0]);
  });

  it("disabled controller never changes the ratio", () => {
    const ar = new AdaptiveResolution();
    ar.configure(0.6, 1.0, 1.0);
    ar.setEnabled(false);
    assert.deepEqual(feed(ar, 100, 20), []);
    assert.equal(ar.getRatio(), 1.0);
  });

  it("ignores stall frames (tab resume)", () => {
    const ar = new AdaptiveResolution();
    ar.configure(0.6, 1.0, 1.0);
    ar.setFpsCap(30);
    for (let i = 0; i < 20; i++) assert.equal(ar.addFrame(2000), null);
    assert.equal(ar.getRatio(), 1.0);
  });
});

describe("proceduralTextures", () => {
  it("noise texture is deterministic, opaque, and seamless", () => {
    const tint = (n: number): [number, number, number] => {
      const v = Math.round(n * 255);
      return [v, v, v];
    };
    const size = 64;
    const a = generateTilingNoiseRGBA(size, 7, tint);
    const b = generateTilingNoiseRGBA(size, 7, tint);
    const c = generateTilingNoiseRGBA(size, 8, tint);
    assert.equal(a.length, size * size * 4);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    for (let i = 3; i < a.length; i += 4) assert.equal(a[i], 255);
    // Seamless: the last column is close to the first (wrap-around continuity).
    let maxJump = 0;
    for (let y = 0; y < size; y++) {
      const first = a[(y * size) * 4] as number;
      const last = a[(y * size + size - 1) * 4] as number;
      maxJump = Math.max(maxJump, Math.abs(first - last));
    }
    assert.ok(maxJump < 40, `edge discontinuity ${maxJump}`);
  });
});
