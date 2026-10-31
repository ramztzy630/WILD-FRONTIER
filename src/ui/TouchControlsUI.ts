/**
 * Mobile touch controls overlay and Phase 3 gameplay HUD prompts
 * (PRD §7, §16; DESIGN-SYSTEM.md §7.5, §7.6; Task 3.11).
 *
 * Features:
 *  - Left floating joystick zone (120 px base ring + 52 px knob, rests at
 *    bottom-left when idle, snaps under thumb on touch).
 *  - Right camera look & two-finger pinch-zoom zone.
 *  - Ergonomic action button cluster (all targets >= 48x48 CSS px, safe-area
 *    aware, responsive across landscape and portrait):
 *      • Jump (64 px primary)
 *      • Interact / Drink (60 px; enabled when `canDrink` is true, visibly
 *        disabled with reason when out of range)
 *      • Sprint (56 px toggle, ember active state)
 *      • Crouch (56 px toggle, ember active state)
 *      • Inventory (52 px; explicitly disabled with "Phase 5" badge so there
 *        are zero fake/silent buttons)
 *  - Contextual HUD water-drinking prompt, boundary soft-stop warning banner,
 *    and brief status toast.
 */

import type { InputScheme } from "../core/InputManager.ts";
import type { TouchActionButton, TouchInput } from "../core/TouchInput.ts";
import { el, setText, setVisible } from "./dom.ts";

const SVG_JUMP =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

const SVG_SPRINT =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M13 3L5.5 13.5h5.5L10 21l8.5-11.5h-5.5L13 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/></svg>';

const SVG_CROUCH =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5.5" r="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 11.5c1.5-1.5 6.5-1.5 8 0l-1.5 4.5H9.5L8 11.5zM7 19.5h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

const SVG_DRINK =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.5c3.5 4.8 6 8.1 6 11.3a6 6 0 0 1-12 0c0-3.2 2.5-6.5 6-11.3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/></svg>';

const SVG_BAG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5" y="7.5" width="14" height="12.5" rx="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M9 7.5V6a3 3 0 0 1 6 0v1.5M9 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';

export interface GameplayHudState {
  readonly visible: boolean;
  readonly scheme: InputScheme;
  readonly canDrink: boolean;
  readonly nearBoundary: boolean;
  readonly boundaryMessage: string;
  readonly sprintActive: boolean;
  readonly crouchActive: boolean;
  readonly jumpPressed: boolean;
}

export class TouchControlsUI {
  private readonly root: HTMLElement;
  private readonly touchLayer: HTMLElement;
  private readonly leftZone: HTMLElement;
  private readonly rightZone: HTMLElement;

  private readonly joyBase: HTMLElement;
  private readonly joyKnob: HTMLElement;
  private readonly lookHint: HTMLElement;
  private readonly desktopHint: HTMLElement;

  private readonly jumpBtn: HTMLButtonElement;
  private readonly interactBtn: HTMLButtonElement;
  private readonly interactSubLabel: HTMLElement;
  private readonly sprintBtn: HTMLButtonElement;
  private readonly crouchBtn: HTMLButtonElement;
  private readonly inventoryBtn: HTMLButtonElement;

  private readonly promptChip: HTMLElement;
  private readonly promptKey: HTMLElement;
  private readonly promptText: HTMLElement;
  private readonly boundaryBanner: HTMLElement;
  private readonly toastChip: HTMLElement;

  private readonly touchInput: TouchInput;
  private readonly unbindWindow: () => void;

  private hasLookedWithTouch = false;
  private toastTimer = 0;

  // Cached DOM state to avoid redundant per-frame style/attribute writes
  private lastVisible = false;
  private lastTouchVisible = false;
  private lastDesktopHintVisible = false;
  private lastJoyActive = false;
  private lastJoyOriginX = -1;
  private lastJoyOriginY = -1;
  private lastJoyKnobX = 0;
  private lastJoyKnobY = 0;
  private lastCanDrink = false;
  private lastScheme: InputScheme = "touch";
  private lastSprint = false;
  private lastCrouch = false;
  private lastJumpActive = false;
  private lastBoundary = false;
  private lastBoundaryMsg = "";

  constructor(parent: HTMLElement, touchInput: TouchInput) {
    this.touchInput = touchInput;

    // --- Floating virtual joystick (left zone) ---
    this.joyKnob = el("div", { class: "touch-joy-knob" });
    this.joyBase = el("div", { class: "touch-joy-base", "data-active": "false" }, [this.joyKnob]);
    this.leftZone = el(
      "div",
      {
        class: "touch-zone-left",
        "aria-label": "Movement joystick zone",
      },
      [this.joyBase],
    );

    // --- Camera swipe + pinch zone (right zone) ---
    this.lookHint = el("div", {
      class: "touch-look-hint",
      text: "Swipe to look · Pinch to zoom",
    });
    this.rightZone = el(
      "div",
      {
        class: "touch-zone-right",
        "aria-label": "Camera look zone",
      },
      [this.lookHint],
    );

    // --- Action buttons (right cluster; all >= 48x48 px) ---
    this.jumpBtn = this.createActionButton("jump", "touch-btn touch-btn-jump", SVG_JUMP, "Jump", "");
    this.interactSubLabel = el("span", { class: "touch-btn-sub", text: "No water" });
    this.interactBtn = this.createActionButton(
      "interact",
      "touch-btn touch-btn-interact",
      SVG_DRINK,
      "Drink",
      "No water",
      this.interactSubLabel,
    );
    this.interactBtn.disabled = true;
    this.interactBtn.setAttribute("aria-disabled", "true");
    this.interactBtn.title = "Stand at a lake or river edge to drink water";

    this.sprintBtn = this.createActionButton(
      "sprint",
      "touch-btn touch-btn-sprint",
      SVG_SPRINT,
      "Sprint",
      "",
    );
    this.sprintBtn.setAttribute("aria-pressed", "false");

    this.crouchBtn = this.createActionButton(
      "crouch",
      "touch-btn touch-btn-crouch",
      SVG_CROUCH,
      "Crouch",
      "",
    );
    this.crouchBtn.setAttribute("aria-pressed", "false");

    this.inventoryBtn = this.createActionButton(
      "inventory",
      "touch-btn touch-btn-inventory",
      SVG_BAG,
      "Bag",
      "Phase 5",
    );
    this.inventoryBtn.disabled = true;
    this.inventoryBtn.setAttribute("aria-disabled", "true");
    this.inventoryBtn.title = "Inventory system unlocks in Phase 5";

    const actionsCluster = el(
      "div",
      { class: "touch-actions", role: "group", "aria-label": "Gameplay actions" },
      [this.inventoryBtn, this.crouchBtn, this.sprintBtn, this.interactBtn, this.jumpBtn],
    );

    this.touchLayer = el("div", { class: "touch-controls-layer", hidden: true }, [
      this.leftZone,
      this.rightZone,
      actionsCluster,
    ]);

    // --- Contextual HUD elements (water drink prompt, boundary warning, toast, desktop hint) ---
    this.promptKey = el("span", { class: "hud-prompt-key", text: "E" });
    this.promptText = el("span", { class: "hud-prompt-text", text: "Drink Water" });
    this.promptChip = el(
      "button",
      {
        class: "hud-prompt",
        type: "button",
        hidden: true,
        "aria-label": "Drink Water",
      },
      [this.promptKey, this.promptText],
    );
    this.promptChip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.touchInput.handleButtonDown("interact", e.pointerId);
    });

    this.boundaryBanner = el("div", {
      class: "hud-boundary-banner",
      role: "status",
      "aria-live": "polite",
      hidden: true,
    });

    this.toastChip = el("div", {
      class: "hud-toast-chip",
      role: "status",
      "aria-live": "polite",
      hidden: true,
    });

    this.desktopHint = el("div", {
      class: "hud-desktop-hint",
      hidden: true,
      text: "WASD Move · Mouse Look (Click Canvas) · Space Jump · Shift Sprint · C Crouch · E Drink · Esc Pause",
    });

    this.root = el("div", { class: "gameplay-input-hud", hidden: true }, [
      this.touchLayer,
      this.promptChip,
      this.boundaryBanner,
      this.toastChip,
      this.desktopHint,
    ]);

    parent.append(this.root);
    this.unbindWindow = this.bindEvents();
  }

  /** Shows a short status message at the bottom-center of the HUD. */
  showToast(message: string, durationSec = 1.8): void {
    setText(this.toastChip, message);
    setVisible(this.toastChip, true);
    this.toastTimer = durationSec;
  }

  /** Per-frame update of joystick knob transform, button states, and HUD prompts. */
  update(dt: number, state: GameplayHudState): void {
    if (state.visible !== this.lastVisible) {
      this.lastVisible = state.visible;
      setVisible(this.root, state.visible);
    }
    if (!state.visible) return;

    // Toast countdown
    if (this.toastTimer > 0) {
      this.toastTimer = Math.max(0, this.toastTimer - dt);
      if (this.toastTimer <= 0) {
        setVisible(this.toastChip, false);
      }
    }

    const showTouch = state.scheme === "touch";
    if (showTouch !== this.lastTouchVisible) {
      this.lastTouchVisible = showTouch;
      setVisible(this.touchLayer, showTouch);
    }

    const showDesktopHint = state.scheme === "keyboard";
    if (showDesktopHint !== this.lastDesktopHintVisible) {
      this.lastDesktopHintVisible = showDesktopHint;
      setVisible(this.desktopHint, showDesktopHint);
    }

    // Update floating joystick position and knob deflection (only when changed)
    const joy = this.touchInput.getJoystickVisualState();
    if (joy.active !== this.lastJoyActive) {
      this.lastJoyActive = joy.active;
      this.joyBase.setAttribute("data-active", String(joy.active));
      if (!joy.active) {
        this.joyBase.style.transform = "";
        this.joyKnob.style.transform = "translate3d(0px, 0px, 0)";
        this.lastJoyOriginX = -1;
        this.lastJoyOriginY = -1;
        this.lastJoyKnobX = 0;
        this.lastJoyKnobY = 0;
      }
    }

    if (joy.active) {
      // Clamp floating center so the 120 px base ring stays inside the left zone
      const pad = 64;
      const maxX = Math.max(pad, window.innerWidth * 0.45 - pad);
      const maxY = Math.max(pad, window.innerHeight - pad);
      const cx = Math.min(Math.max(pad, joy.originX), maxX);
      const cy = Math.min(Math.max(pad, joy.originY), maxY);

      if (Math.abs(cx - this.lastJoyOriginX) > 0.5 || Math.abs(cy - this.lastJoyOriginY) > 0.5) {
        this.lastJoyOriginX = cx;
        this.lastJoyOriginY = cy;
        this.joyBase.style.left = `${cx.toFixed(1)}px`;
        this.joyBase.style.top = `${cy.toFixed(1)}px`;
      }

      if (
        Math.abs(joy.knobX - this.lastJoyKnobX) > 0.25 ||
        Math.abs(joy.knobY - this.lastJoyKnobY) > 0.25
      ) {
        this.lastJoyKnobX = joy.knobX;
        this.lastJoyKnobY = joy.knobY;
        this.joyKnob.style.transform = `translate3d(${joy.knobX.toFixed(1)}px, ${joy.knobY.toFixed(1)}px, 0)`;
      }
    }

    // Dismiss camera swipe hint after the player uses the camera look zone
    if (!this.hasLookedWithTouch && this.touchInput.getActiveCameraPointerCount() > 0) {
      this.hasLookedWithTouch = true;
      setVisible(this.lookHint, false);
    }

    // Update Interact / Drink button and HUD prompt
    if (state.canDrink !== this.lastCanDrink || state.scheme !== this.lastScheme) {
      this.lastCanDrink = state.canDrink;
      this.lastScheme = state.scheme;

      this.interactBtn.disabled = !state.canDrink;
      this.interactBtn.setAttribute("aria-disabled", String(!state.canDrink));
      setText(this.interactSubLabel, state.canDrink ? "Water" : "No water");

      setVisible(this.promptChip, state.canDrink);
      setText(this.promptKey, state.scheme === "keyboard" ? "E" : "Tap");
      setText(this.promptText, "Drink Water");
    }

    // Update Sprint / Crouch / Jump button active states
    if (state.sprintActive !== this.lastSprint) {
      this.lastSprint = state.sprintActive;
      this.sprintBtn.setAttribute("aria-pressed", String(state.sprintActive));
    }
    if (state.crouchActive !== this.lastCrouch) {
      this.lastCrouch = state.crouchActive;
      this.crouchBtn.setAttribute("aria-pressed", String(state.crouchActive));
    }
    if (state.jumpPressed !== this.lastJumpActive) {
      this.lastJumpActive = state.jumpPressed;
      this.jumpBtn.setAttribute("data-pressed", String(state.jumpPressed));
    }

    // Update world boundary soft-stop banner
    if (state.nearBoundary !== this.lastBoundary || state.boundaryMessage !== this.lastBoundaryMsg) {
      this.lastBoundary = state.nearBoundary;
      this.lastBoundaryMsg = state.boundaryMessage;
      setVisible(this.boundaryBanner, state.nearBoundary && state.boundaryMessage.length > 0);
      if (state.nearBoundary) {
        setText(this.boundaryBanner, state.boundaryMessage);
      }
    }
  }

  dispose(): void {
    this.unbindWindow();
    this.root.remove();
  }

  private createActionButton(
    action: TouchActionButton,
    className: string,
    svgIcon: string,
    label: string,
    subLabel: string,
    customSubEl?: HTMLElement,
  ): HTMLButtonElement {
    const iconWrap = el("span", { class: "touch-btn-icon" });
    iconWrap.innerHTML = svgIcon;
    const textWrap = el("span", { class: "touch-btn-label", text: label });
    const subEl =
      customSubEl ?? (subLabel ? el("span", { class: "touch-btn-sub", text: subLabel }) : null);

    const btn = el(
      "button",
      {
        class: className,
        type: "button",
        "aria-label": subLabel ? `${label} (${subLabel})` : label,
      },
      [iconWrap, textWrap, subEl],
    );

    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      if (btn.disabled) return;
      const accepted = this.touchInput.handleButtonDown(action, e.pointerId);
      if (accepted) {
        try {
          btn.setPointerCapture(e.pointerId);
        } catch {
          // Ignore on platforms where synthetic pointer capture is unsupported
        }
      }
    });

    const release = (e: PointerEvent): void => {
      e.stopPropagation();
      this.touchInput.handlePointerUp(e.pointerId);
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("lostpointercapture", release);

    return btn;
  }

  private bindEvents(): () => void {
    this.leftZone.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.cancelable) e.preventDefault();
      if (this.touchInput.startJoystick(e.pointerId, e.clientX, e.clientY)) {
        try {
          this.leftZone.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if unsupported
        }
      }
    });

    this.rightZone.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.cancelable) e.preventDefault();
      if (this.touchInput.startCameraLook(e.pointerId, e.clientX, e.clientY)) {
        try {
          this.rightZone.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if unsupported
        }
      }
    });

    const onWindowPointerMove = (e: PointerEvent): void => {
      this.touchInput.handlePointerMove(e.pointerId, e.clientX, e.clientY);
    };

    const onWindowPointerUp = (e: PointerEvent): void => {
      this.touchInput.handlePointerUp(e.pointerId);
    };

    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
    window.addEventListener("pointerup", onWindowPointerUp, { passive: true });
    window.addEventListener("pointercancel", onWindowPointerUp, { passive: true });

    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerUp);
    };
  }
}
