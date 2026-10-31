/**
 * Phase 2/3 screens: a minimal main menu, loading veil, pause button, pause
 * panel with live graphics controls, and a clearly marked temporary debug strip
 * for Phase 3 Kelompok B (Tasks 3.7–3.9) before Kelompok C (3.10–3.12) arrives.
 *
 * Every button is wired to a real action.
 */

import type { TempDebugLocomotionMode } from "../core/FoundationScene.ts";
import type { FpsCap } from "../core/GameLoop.ts";
import type { GameStateName } from "../core/GameState.ts";
import { PRESET_LABELS, PRESET_NAMES, type PresetName } from "../core/GraphicsSettings.ts";
import { el, onClick, setText, setVisible } from "./dom.ts";

export interface ScreenHandlers {
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onQuitToMenu(): void;
  onPreset(preset: PresetName): void;
  onFpsCap(cap: FpsCap): void;
  onAdaptive(enabled: boolean): void;
  // TEMP DEBUG (Phase 3 Kelompok B only — replaced by 3.10/3.11 in Kelompok C)
  onTempDebugMode(mode: TempDebugLocomotionMode): void;
  onTempDebugJump(): void;
  onTempDebugGather(): void;
  onTempDebugDrink(): void;
  onTempDebugReset(): void;
}

export interface GraphicsViewState {
  preset: PresetName;
  detected: PresetName;
  fpsCap: FpsCap;
  adaptive: boolean;
}

const CAP_OPTIONS: readonly { value: FpsCap; label: string }[] = [
  { value: 30, label: "30" },
  { value: 60, label: "60" },
  { value: 0, label: "Uncapped" },
];

const DEBUG_MODES: readonly { mode: TempDebugLocomotionMode; label: string }[] = [
  { mode: "idle", label: "Idle" },
  { mode: "walk", label: "Walk" },
  { mode: "run", label: "Run" },
  { mode: "sprint", label: "Sprint" },
  { mode: "crouch", label: "Crouch" },
];

const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8.5 5.5v13M15.5 5.5v13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';

export class FoundationScreens {
  private readonly menu: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly pausePanel: HTMLElement;
  private readonly tempDebugBar: HTMLElement;
  private readonly detectedLabel: HTMLElement;
  private readonly presetButtons = new Map<PresetName, HTMLButtonElement>();
  private readonly capButtons = new Map<FpsCap, HTMLButtonElement>();
  private readonly debugModeButtons = new Map<TempDebugLocomotionMode, HTMLButtonElement>();
  private readonly adaptiveSwitch: HTMLButtonElement;
  private readonly startButton: HTMLButtonElement;
  private readonly resumeButton: HTMLButtonElement;

  constructor(parent: HTMLElement, handlers: ScreenHandlers) {
    // --- Main menu ---
    this.startButton = el("button", { class: "btn btn-primary btn-lg", type: "button", text: "Start test scene" });
    this.detectedLabel = el("p", { class: "menu-note" });
    this.menu = el("section", { class: "screen screen-menu", "aria-label": "Main menu", hidden: true }, [
      el("div", { class: "menu-inner" }, [
        el("h1", { class: "wordmark", text: "Wild Frontier" }),
        el("p", { class: "menu-sub", text: "Phase 3 Kelompok B · World, Player, Camera & Rig" }),
        el("div", { class: "menu-actions" }, [this.startButton]),
        this.detectedLabel,
      ]),
    ]);
    onClick(this.startButton, () => handlers.onStart());

    // --- Loading veil ---
    this.loading = el("section", { class: "screen screen-loading", "aria-live": "polite", hidden: true }, [
      el("p", { class: "loading-text", text: "Preparing the wilderness…" }),
    ]);

    // --- Pause button (HUD) ---
    this.pauseButton = el("button", { class: "icon-btn hud-pause", type: "button", "aria-label": "Pause", hidden: true });
    this.pauseButton.innerHTML = PAUSE_ICON;
    onClick(this.pauseButton, () => handlers.onPause());

    // --- TEMP DEBUG strip (Phase 3 Kelompok B only — removed in Kelompok C) ---
    const modeRow = el("div", { class: "temp-debug-row" });
    for (const item of DEBUG_MODES) {
      const b = el("button", {
        class: "temp-debug-btn",
        type: "button",
        text: item.label,
        "aria-pressed": String(item.mode === "idle"),
      });
      onClick(b, () => {
        this.setTempDebugMode(item.mode);
        handlers.onTempDebugMode(item.mode);
      });
      this.debugModeButtons.set(item.mode, b);
      modeRow.append(b);
    }

    const jumpBtn = el("button", { class: "temp-debug-btn", type: "button", text: "Jump" });
    const gatherBtn = el("button", { class: "temp-debug-btn", type: "button", text: "Gather" });
    const drinkBtn = el("button", { class: "temp-debug-btn", type: "button", text: "Drink" });
    const resetBtn = el("button", { class: "temp-debug-btn", type: "button", text: "Spawn" });

    onClick(jumpBtn, () => handlers.onTempDebugJump());
    onClick(gatherBtn, () => {
      this.setTempDebugMode("idle");
      handlers.onTempDebugMode("idle");
      handlers.onTempDebugGather();
    });
    onClick(drinkBtn, () => {
      this.setTempDebugMode("idle");
      handlers.onTempDebugMode("idle");
      handlers.onTempDebugDrink();
    });
    onClick(resetBtn, () => {
      this.setTempDebugMode("idle");
      handlers.onTempDebugReset();
    });

    modeRow.append(jumpBtn, gatherBtn, drinkBtn, resetBtn);

    this.tempDebugBar = el(
      "aside",
      {
        class: "temp-debug-bar",
        "aria-label": "Temporary debug controls for Phase 3 Group B",
        hidden: true,
      },
      [
        el("div", {
          class: "temp-debug-tag",
          text: "TEMP DEBUG (3.7–3.9 only · drag screen to orbit camera · not 3.10–3.12)",
        }),
        modeRow,
      ],
    );

    // --- Pause panel ---
    this.resumeButton = el("button", { class: "btn btn-primary", type: "button", text: "Resume" });
    const quit = el("button", { class: "btn btn-secondary", type: "button", text: "Quit to menu" });
    onClick(this.resumeButton, () => handlers.onResume());
    onClick(quit, () => handlers.onQuitToMenu());

    const presetGroup = el("div", { class: "segmented", role: "group", "aria-label": "Graphics preset" });
    for (const name of PRESET_NAMES) {
      const b = el("button", { class: "seg-btn", type: "button", text: PRESET_LABELS[name], "aria-pressed": "false" });
      onClick(b, () => handlers.onPreset(name));
      this.presetButtons.set(name, b);
      presetGroup.append(b);
    }
    const capGroup = el("div", { class: "segmented", role: "group", "aria-label": "Frame rate cap" });
    for (const opt of CAP_OPTIONS) {
      const b = el("button", { class: "seg-btn", type: "button", text: opt.label, "aria-pressed": "false" });
      onClick(b, () => handlers.onFpsCap(opt.value));
      this.capButtons.set(opt.value, b);
      capGroup.append(b);
    }
    this.adaptiveSwitch = el("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": "false",
      "aria-label": "Adaptive resolution",
    });
    this.adaptiveSwitch.append(el("span", { class: "switch-thumb" }));
    onClick(this.adaptiveSwitch, () => handlers.onAdaptive(this.adaptiveSwitch.getAttribute("aria-checked") !== "true"));

    this.pausePanel = el("section", { class: "screen screen-modal", role: "dialog", "aria-modal": "true", "aria-label": "Paused", hidden: true }, [
      el("div", { class: "panel pause-panel", "data-scroll": true }, [
        el("h2", { class: "panel-title", text: "Paused" }),
        el("div", { class: "field" }, [el("span", { class: "field-label", text: "Graphics preset" }), presetGroup]),
        el("div", { class: "field" }, [el("span", { class: "field-label", text: "Frame rate cap" }), capGroup]),
        el("div", { class: "field field-row" }, [el("span", { class: "field-label", text: "Adaptive resolution" }), this.adaptiveSwitch]),
        el("p", { class: "panel-note", text: "Graphics choices apply immediately. They are not saved yet (saving arrives in Phase 6)." }),
        el("div", { class: "panel-actions" }, [quit, this.resumeButton]),
      ]),
    ]);

    parent.append(this.menu, this.loading, this.pauseButton, this.tempDebugBar, this.pausePanel);
  }

  showState(state: GameStateName): void {
    setVisible(this.menu, state === "mainMenu");
    setVisible(this.loading, state === "loading");
    setVisible(this.pauseButton, state === "playing");
    setVisible(this.tempDebugBar, state === "playing");
    setVisible(this.pausePanel, state === "paused");
    if (state === "mainMenu") this.startButton.focus({ preventScroll: true });
    if (state === "paused") this.resumeButton.focus({ preventScroll: true });
  }

  setTempDebugMode(mode: TempDebugLocomotionMode): void {
    for (const [m, b] of this.debugModeButtons) {
      b.setAttribute("aria-pressed", String(m === mode));
    }
  }

  setGraphics(view: GraphicsViewState): void {
    for (const [name, b] of this.presetButtons) b.setAttribute("aria-pressed", String(name === view.preset));
    for (const [cap, b] of this.capButtons) b.setAttribute("aria-pressed", String(cap === view.fpsCap));
    this.adaptiveSwitch.setAttribute("aria-checked", String(view.adaptive));
    setText(this.detectedLabel, `Detected default graphics: ${PRESET_LABELS[view.detected]}`);
  }
}
