/**
 * Owns the WebGL renderer, the main scene and camera, viewport sizing,
 * pixel ratio, and shadow-map cadence (ARCHITECTURE.md §5.3).
 */

import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import type { GraphicsPreset } from "./GraphicsSettings.ts";

export interface RenderStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  width: number;
  height: number;
}

export interface SceneManagerEvents {
  onContextLost(): void;
  onContextRestored(): void;
}

export class SceneManager {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private renderer: WebGLRenderer;
  private readonly container: HTMLElement;
  private readonly events: SceneManagerEvents;
  private antialias: boolean;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private sizeDirty = true;
  private shadowInterval = 0;
  private frameIndex = 0;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly stats: RenderStats = {
    calls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    pixelRatio: 1,
    width: 1,
    height: 1,
  };

  constructor(container: HTMLElement, preset: GraphicsPreset, events: SceneManagerEvents) {
    this.container = container;
    this.events = events;
    this.antialias = preset.antialias;
    this.camera = new PerspectiveCamera(60, 1, 0.1, 1500);
    this.renderer = this.createRenderer(this.antialias);

    const markDirty = (): void => {
      this.sizeDirty = true;
    };
    window.addEventListener("resize", markDirty);
    window.addEventListener("orientationchange", markDirty);
    window.visualViewport?.addEventListener("resize", markDirty);
    this.resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(markDirty) : null;
    this.resizeObserver?.observe(container);
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Direct access for systems that need it (shader compile, render targets). */
  get webgl(): WebGLRenderer {
    return this.renderer;
  }

  /**
   * Applies the renderer-level part of a preset. Antialiasing can only be set
   * when a WebGL context is created, so toggling it rebuilds the renderer
   * (materials recompile automatically on the next render).
   */
  applyGraphics(preset: GraphicsPreset, pixelRatio: number): void {
    if (preset.antialias !== this.antialias) {
      this.antialias = preset.antialias;
      const old = this.renderer;
      this.renderer = this.createRenderer(this.antialias);
      old.dispose();
      old.domElement.remove();
      this.sizeDirty = true;
    }
    const shadowMap = this.renderer.shadowMap;
    shadowMap.enabled = preset.shadows !== "off";
    // PCFSoftShadowMap is deprecated since three r186; PCF is used for all tiers.
    shadowMap.type = PCFShadowMap;
    shadowMap.autoUpdate = false;
    shadowMap.needsUpdate = true;
    this.shadowInterval = preset.shadowInterval;
    this.setPixelRatio(pixelRatio);
  }

  setPixelRatio(ratio: number): void {
    if (ratio === this.pixelRatio && !this.sizeDirty) return;
    this.pixelRatio = ratio;
    this.sizeDirty = true;
  }

  getPixelRatio(): number {
    return this.pixelRatio;
  }

  /** Forces a shadow-map refresh on the next render (e.g. after the sun moved a lot). */
  requestShadowUpdate(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  render(): void {
    if (this.sizeDirty) this.applySize();
    if (this.renderer.shadowMap.enabled && this.shadowInterval > 0) {
      if (this.frameIndex % this.shadowInterval === 0) this.renderer.shadowMap.needsUpdate = true;
    }
    this.frameIndex++;
    this.renderer.render(this.scene, this.camera);
  }

  /** Compiles every material in the scene now, so first use does not stall a frame. */
  precompile(): void {
    this.renderer.compile(this.scene, this.camera);
  }

  getStats(): RenderStats {
    const info = this.renderer.info;
    this.stats.calls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
    this.stats.pixelRatio = this.pixelRatio;
    this.stats.width = this.width;
    this.stats.height = this.height;
    return this.stats;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private createRenderer(antialias: boolean): WebGLRenderer {
    const renderer = new WebGLRenderer({
      antialias,
      powerPreference: "high-performance",
      stencil: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x0d0f0c, 1);
    const canvas = renderer.domElement;
    canvas.className = "game-canvas";
    canvas.setAttribute("aria-label", "Game view");
    canvas.addEventListener("webglcontextlost", (event) => {
      // Allows the browser to restore the context later.
      event.preventDefault();
      this.events.onContextLost();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.sizeDirty = true;
      this.renderer.shadowMap.needsUpdate = true;
      this.events.onContextRestored();
    });
    this.container.prepend(canvas);
    return renderer;
  }

  private applySize(): void {
    this.sizeDirty = false;
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    // Portrait phones: widen the vertical FOV a little so the scene is not cramped.
    this.camera.fov = w < h ? 70 : 60;
    this.camera.updateProjectionMatrix();
  }
}
