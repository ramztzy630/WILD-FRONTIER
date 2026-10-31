/**
 * Top-level wiring and lifecycle (ARCHITECTURE.md §3).
 *
 * Phase 2 scope: state machine, loop, renderer, presets, adaptive resolution,
 * diagnostics, and the foundation verification scene. Later phases plug the
 * world, player, systems, and full UI into the same hooks.
 */

import { AssetManager } from "./AssetManager.ts";
import type { DeviceInfo } from "./DeviceProfile.ts";
import { selectDefaultPreset } from "./DeviceProfile.ts";
import { EventBus } from "./EventBus.ts";
import { FoundationScene } from "./FoundationScene.ts";
import { GameLoop, type FpsCap } from "./GameLoop.ts";
import { GameStateMachine, type GameStateName } from "./GameState.ts";
import {
  PRESET_LABELS,
  getPreset,
  resolvePixelRatio,
  type GraphicsPreset,
  type PresetName,
} from "./GraphicsSettings.ts";
import { AdaptiveResolution, FrameStats } from "./PerformanceMonitor.ts";
import { SceneManager } from "./SceneManager.ts";
import { DiagnosticsUI, type DiagnosticsData } from "../ui/DiagnosticsUI.ts";
import type { ErrorOverlay } from "../ui/ErrorOverlay.ts";
import { FoundationScreens } from "../ui/FoundationScreens.ts";

export interface GameEvents {
  "state:changed": { to: GameStateName; from: GameStateName };
  "graphics:changed": { preset: PresetName; fpsCap: FpsCap; adaptive: boolean };
  "renderer:pixelRatio": { ratio: number };
}

export interface GameOptions {
  device: DeviceInfo;
  errors: ErrorOverlay;
  diagnosticsExpanded: boolean;
  seed: number;
}

interface PerformanceMemory {
  memory?: { usedJSHeapSize: number };
}

export class Game {
  readonly bus = new EventBus<GameEvents>();
  readonly assets = new AssetManager();
  private readonly device: DeviceInfo;
  private readonly errors: ErrorOverlay;
  private readonly sceneManager: SceneManager;
  private readonly loop: GameLoop;
  private readonly states: GameStateMachine;
  private readonly frameStats = new FrameStats(500);
  private readonly adaptive = new AdaptiveResolution();
  private readonly diagnostics: DiagnosticsUI;
  private readonly screens: FoundationScreens;
  private readonly world: FoundationScene;

  private readonly detectedPreset: PresetName;
  private preset: GraphicsPreset;
  private pixelRange = { min: 1, max: 1, initial: 1 };
  private simStepsThisSecond = 0;
  private simStepsPerSecond = 0;
  private simCounterMs = 0;
  private lastStatsVersion = -1;
  private readonly diagData: DiagnosticsData;

  constructor(root: HTMLElement, options: GameOptions) {
    this.device = options.device;
    this.errors = options.errors;
    this.detectedPreset = selectDefaultPreset(this.device);
    this.preset = getPreset(this.detectedPreset);

    const viewport = root.querySelector<HTMLElement>("#viewport");
    const ui = root.querySelector<HTMLElement>("#ui-root");
    if (!viewport || !ui) throw new Error("Game: #viewport or #ui-root missing from index.html");

    this.sceneManager = new SceneManager(viewport, this.preset, {
      onContextLost: () => {
        this.errors.report("WebGL context lost — the GPU was reset. Waiting for the browser to restore it…");
        this.loop.stop();
      },
      onContextRestored: () => {
        this.loop.start();
      },
    });

    this.states = new GameStateMachine((to, from) => this.onStateChanged(to, from));
    this.world = new FoundationScene(this.sceneManager.scene, this.assets, options.seed);

    this.screens = new FoundationScreens(ui, {
      onStart: () => this.startSession(),
      onPause: () => this.states.transition("paused"),
      onResume: () => this.states.transition("playing"),
      onQuitToMenu: () => this.states.transition("mainMenu"),
      onPreset: (p) => this.setPreset(p),
      onFpsCap: (c) => this.setFpsCap(c),
      onAdaptive: (on) => this.setAdaptive(on),
    });
    this.diagnostics = new DiagnosticsUI(ui, options.diagnosticsExpanded);

    this.loop = new GameLoop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      frameUpdate: (dt, alpha) => this.frameUpdate(dt, alpha),
      render: () => this.sceneManager.render(),
      frameStats: (deltaMs, workMs) => this.onFrameStats(deltaMs, workMs),
    });

    this.diagData = {
      fps: 0,
      avgFrameMs: 0,
      worstFrameMs: 0,
      avgWorkMs: 0,
      calls: 0,
      triangles: 0,
      geometries: 0,
      textures: 0,
      textureMB: 0,
      pixelRatio: 1,
      pixelRange: "",
      adaptive: true,
      width: 0,
      height: 0,
      preset: "",
      fpsCap: "",
      state: "boot",
      simSteps: 0,
      gpu: this.device.gpu,
      webgl2: this.device.webgl2,
      heapMB: null,
    };

    this.applyPreset(this.preset, this.preset.defaultFpsCap);
    this.bindGlobalInput();
  }

  start(): void {
    this.loop.start();
    this.states.transition("mainMenu");
  }

  get state(): GameStateName {
    return this.states.state;
  }

  // --- State flow -------------------------------------------------------

  private startSession(): void {
    if (!this.states.transition("loading")) return;
    // Give the browser one frame to paint the loading veil, then compile
    // shaders up front so the first gameplay frame does not stall.
    requestAnimationFrame(() => {
      try {
        this.sceneManager.precompile();
      } catch (error) {
        this.errors.report(`Shader pre-compile failed: ${String(error)}`);
      }
      this.loop.resetTiming();
      this.states.transition("playing");
    });
  }

  private onStateChanged(to: GameStateName, from: GameStateName): void {
    this.loop.setSimulationPaused(to === "paused");
    this.screens.showState(to);
    this.diagData.state = to;
    this.bus.emit("state:changed", { to, from });
  }

  // --- Loop callbacks -----------------------------------------------------

  private fixedUpdate(dt: number): void {
    this.simStepsThisSecond++;
    this.world.fixedUpdate(dt);
  }

  private frameUpdate(frameDt: number, alpha: number): void {
    this.world.frameUpdate(frameDt, alpha, this.sceneManager.camera, this.states.state !== "playing");
  }

  private onFrameStats(deltaMs: number, workMs: number): void {
    this.simCounterMs += deltaMs;
    if (this.simCounterMs >= 1000) {
      this.simStepsPerSecond = Math.round((this.simStepsThisSecond * 1000) / this.simCounterMs);
      this.simStepsThisSecond = 0;
      this.simCounterMs = 0;
    }

    const newRatio = this.adaptive.addFrame(deltaMs);
    if (newRatio !== null) {
      this.sceneManager.setPixelRatio(newRatio);
      this.bus.emit("renderer:pixelRatio", { ratio: newRatio });
    }

    this.frameStats.add(deltaMs, workMs);
    if (this.frameStats.version !== this.lastStatsVersion) {
      this.lastStatsVersion = this.frameStats.version;
      this.refreshDiagnostics();
    }
  }

  private refreshDiagnostics(): void {
    const s = this.frameStats.snapshot;
    const r = this.sceneManager.getStats();
    const a = this.assets.stats();
    const d = this.diagData;
    d.fps = s.fps;
    d.avgFrameMs = s.avgFrameMs;
    d.worstFrameMs = s.worstFrameMs;
    d.avgWorkMs = s.avgWorkMs;
    d.calls = r.calls;
    d.triangles = r.triangles;
    d.geometries = r.geometries;
    d.textures = r.textures;
    d.textureMB = a.textureBytes / (1024 * 1024);
    d.pixelRatio = r.pixelRatio;
    d.pixelRange = `${this.pixelRange.min.toFixed(2)}–${this.pixelRange.max.toFixed(2)}`;
    d.adaptive = this.adaptive.isEnabled();
    d.width = r.width;
    d.height = r.height;
    d.preset = PRESET_LABELS[this.preset.name];
    const cap = this.loop.getFpsCap();
    d.fpsCap = cap === 0 ? "none" : String(cap);
    d.simSteps = this.simStepsPerSecond;
    const mem = (performance as Performance & PerformanceMemory).memory;
    d.heapMB = mem ? mem.usedJSHeapSize / (1024 * 1024) : null;
    this.diagnostics.update(d);
  }

  // --- Graphics -------------------------------------------------------------

  private setPreset(name: PresetName): void {
    const preset = getPreset(name);
    this.applyPreset(preset, preset.defaultFpsCap);
  }

  private setFpsCap(cap: FpsCap): void {
    this.loop.setFpsCap(cap);
    this.adaptive.setFpsCap(cap);
    this.publishGraphics();
  }

  private setAdaptive(enabled: boolean): void {
    this.adaptive.setEnabled(enabled);
    if (!enabled) {
      // Return to the preset's nominal resolution.
      this.adaptive.configure(this.pixelRange.min, this.pixelRange.max, this.pixelRange.initial);
      this.sceneManager.setPixelRatio(this.pixelRange.initial);
    }
    this.publishGraphics();
  }

  private applyPreset(preset: GraphicsPreset, fpsCap: FpsCap): void {
    this.preset = preset;
    this.pixelRange = resolvePixelRatio(preset, this.device.devicePixelRatio);
    this.adaptive.configure(this.pixelRange.min, this.pixelRange.max, this.pixelRange.initial);
    this.sceneManager.applyGraphics(preset, this.pixelRange.initial);
    this.world.applyPreset(preset);
    this.loop.setFpsCap(fpsCap);
    this.adaptive.setFpsCap(fpsCap);
    this.publishGraphics();
  }

  private publishGraphics(): void {
    const view = {
      preset: this.preset.name,
      fpsCap: this.loop.getFpsCap(),
      adaptive: this.adaptive.isEnabled(),
    };
    this.screens.setGraphics({ ...view, detected: this.detectedPreset });
    this.bus.emit("graphics:changed", view);
    this.lastStatsVersion = -1;
  }

  // --- Browser integration -------------------------------------------------

  private bindGlobalInput(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (this.states.state === "playing") this.states.transition("paused");
        this.loop.stop();
      } else {
        this.loop.start();
      }
    });
    window.addEventListener("keydown", (event) => {
      if (event.repeat) return;
      if (event.key === "Escape") {
        if (this.states.state === "playing") this.states.transition("paused");
        else if (this.states.state === "paused") this.states.transition("playing");
      } else if (event.key === "`" || event.key === "F3") {
        event.preventDefault();
        this.diagnostics.toggleExpanded();
        this.lastStatsVersion = -1;
      }
    });
  }
}
