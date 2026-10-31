/**
 * Diagnostics overlay (ARCHITECTURE.md R1, §8): FPS, frame time, CPU work
 * time, draw calls, triangles, GPU memory objects, pixel ratio, preset.
 *
 * A compact FPS chip is always visible (when diagnostics are enabled); tapping
 * it expands the full panel. DOM text is refreshed at most when FrameStats
 * produces a new snapshot (every 500 ms), and only changed lines are written.
 */

import { el, onClick, setText, setVisible } from "./dom.ts";

export interface DiagnosticsData {
  fps: number;
  avgFrameMs: number;
  worstFrameMs: number;
  avgWorkMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  textureMB: number;
  pixelRatio: number;
  pixelRange: string;
  adaptive: boolean;
  width: number;
  height: number;
  preset: string;
  fpsCap: string;
  state: string;
  simSteps: number;
  gpu: string;
  webgl2: boolean;
  heapMB: number | null;
}

const LINE_KEYS = ["frame", "work", "draw", "mem", "res", "preset", "state", "gpu"] as const;
type LineKey = (typeof LINE_KEYS)[number];

export class DiagnosticsUI {
  private readonly root: HTMLElement;
  private readonly chip: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly lines: Record<LineKey, HTMLElement>;
  private expanded = false;
  private enabled = true;

  constructor(parent: HTMLElement, startExpanded: boolean) {
    this.chip = el("button", {
      class: "diag-chip",
      type: "button",
      "aria-expanded": "false",
      "aria-label": "Toggle diagnostics details",
      text: "FPS --",
    });
    const lines = {} as Record<LineKey, HTMLElement>;
    for (const key of LINE_KEYS) lines[key] = el("div", { class: "diag-line" });
    this.lines = lines;
    this.panel = el("div", { class: "diag-panel", hidden: true }, LINE_KEYS.map((k) => lines[k]));
    this.root = el("aside", { class: "diagnostics", "aria-label": "Diagnostics" }, [this.chip, this.panel]);
    onClick(this.chip, () => this.setExpanded(!this.expanded));
    parent.append(this.root);
    this.setExpanded(startExpanded);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    setVisible(this.root, enabled);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.chip.setAttribute("aria-expanded", String(expanded));
    setVisible(this.panel, expanded);
  }

  toggleExpanded(): void {
    this.setExpanded(!this.expanded);
  }

  update(d: DiagnosticsData): void {
    if (!this.enabled) return;
    const fps = Math.round(d.fps);
    setText(this.chip, `FPS ${fps}`);
    this.chip.dataset["level"] = fps >= 50 ? "good" : fps >= 26 ? "ok" : "bad";
    if (!this.expanded) return;
    const l = this.lines;
    setText(l.frame, `frame ${d.avgFrameMs.toFixed(1)} ms · worst ${d.worstFrameMs.toFixed(1)} ms`);
    setText(l.work, `cpu ${d.avgWorkMs.toFixed(2)} ms · sim ${d.simSteps}/s`);
    setText(l.draw, `calls ${d.calls} · tris ${formatCount(d.triangles)}`);
    setText(
      l.mem,
      `geo ${d.geometries} · tex ${d.textures} (${d.textureMB.toFixed(1)} MB)` +
        (d.heapMB !== null ? ` · heap ${d.heapMB.toFixed(0)} MB` : ""),
    );
    setText(
      l.res,
      `${d.width}×${d.height} @${d.pixelRatio.toFixed(2)} [${d.pixelRange}]${d.adaptive ? " auto" : ""}`,
    );
    setText(l.preset, `preset ${d.preset} · cap ${d.fpsCap}`);
    setText(l.state, `state ${d.state}`);
    setText(l.gpu, `${d.webgl2 ? "WebGL2" : "WebGL1"} · ${d.gpu || "GPU hidden"}`);
  }
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
