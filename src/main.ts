/**
 * Boot: error capture → browser gesture blocking → WebGL capability check →
 * Game. If WebGL is unavailable a styled fallback screen explains why and
 * offers a Retry that genuinely re-runs the check (ARCHITECTURE.md R13).
 *
 * Test flags (URL query):
 *   ?nowebgl=1     always simulate "no WebGL" (Retry keeps failing)
 *   ?nowebgl=once  simulate failure on the first check only (Retry succeeds)
 *   ?diag=0        start with the diagnostics panel collapsed
 *   ?seed=1234     seed for the foundation scene
 */

import "./styles/main.css";
import { detectDevice } from "./core/DeviceProfile.ts";
import { Game } from "./core/Game.ts";
import { hashString } from "./core/Random.ts";
import { el, errorMessage, onClick } from "./ui/dom.ts";
import { ErrorOverlay } from "./ui/ErrorOverlay.ts";

const params = new URLSearchParams(location.search);
const forceNoWebGL = params.get("nowebgl");
let webglChecks = 0;

function bootstrap(): void {
  const app = document.getElementById("app");
  if (!app) throw new Error("index.html is missing #app");
  const overlayLayer = document.getElementById("overlay-root") ?? app;

  const errors = new ErrorOverlay(overlayLayer);
  errors.install();
  blockBrowserGestures(app);

  /** Returns null on success, or the reason the game could not start. */
  const tryStart = (): string | null => {
    const check = checkWebGL();
    if (!check.ok) return check.reason;
    try {
      const seedParam = params.get("seed");
      const seed = seedParam !== null && /^\d+$/.test(seedParam) ? Number(seedParam) >>> 0 : hashString("wild-frontier");
      const game = new Game(app, {
        device: detectDevice(),
        errors,
        diagnosticsExpanded: params.get("diag") !== "0",
        seed,
      });
      document.querySelector(".fallback")?.remove();
      game.start();
      // Exposed for debugging from a remote devtools session.
      (window as unknown as { __game?: Game }).__game = game;
      return null;
    } catch (error) {
      errors.report(`Failed to start: ${errorMessage(error)}`, error instanceof Error ? (error.stack ?? "") : "");
      // Remove a half-created canvas so a retry starts clean.
      document.querySelectorAll("#viewport canvas").forEach((c) => c.remove());
      document.getElementById("ui-root")?.replaceChildren();
      return `The renderer could not start (${errorMessage(error)}).`;
    }
  };
  const failure = tryStart();
  if (failure !== null) showNoWebGL(app, failure, tryStart);
}

interface WebGLCheck {
  ok: boolean;
  reason: string;
}

function checkWebGL(): WebGLCheck {
  webglChecks++;
  if (forceNoWebGL === "1" || (forceNoWebGL === "once" && webglChecks === 1)) {
    return { ok: false, reason: "WebGL failure simulated by the ?nowebgl test flag." };
  }
  if (typeof WebGLRenderingContext === "undefined") {
    return { ok: false, reason: "This browser does not support WebGL." };
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) {
      return {
        ok: false,
        reason: "WebGL is supported but could not be started. It may be disabled, or the GPU is blocklisted.",
      };
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: `WebGL failed to initialise: ${errorMessage(error)}` };
  }
}

function showNoWebGL(app: HTMLElement, reason: string, retry: () => string | null): void {
  const retryBtn = el("button", { class: "btn btn-primary", type: "button", text: "Retry" });
  const status = el("p", { class: "fallback-status", "aria-live": "polite" });
  const reasonText = el("p", { class: "fallback-reason", text: reason });
  onClick(retryBtn, () => {
    retryBtn.disabled = true;
    status.textContent = "Checking again…";
    // Let the status paint before the (synchronous) check runs.
    setTimeout(() => {
      const failure = retry();
      if (failure === null) return; // Game started; fallback already removed.
      reasonText.textContent = failure;
      status.textContent = `Still unavailable (checked ${new Date().toLocaleTimeString()}).`;
      retryBtn.disabled = false;
    }, 50);
  });
  const screen = el("section", { class: "fallback", role: "alert", "data-scroll": true }, [
    el("div", { class: "panel fallback-panel" }, [
      el("h1", { class: "wordmark wordmark-sm", text: "Wild Frontier" }),
      el("h2", { class: "panel-title", text: "3D graphics are unavailable" }),
      reasonText,
      el("ul", { class: "fallback-tips" }, [
        el("li", { text: "Update your browser (Chrome, Firefox, Safari, or Edge)." }),
        el("li", { text: "Turn on hardware acceleration in the browser settings." }),
        el("li", { text: "Close other tabs or apps that use the GPU, then retry." }),
      ]),
      el("div", { class: "panel-actions" }, [retryBtn]),
      status,
    ]),
  ]);
  app.append(screen);
}

/** Stops scroll, pinch-zoom, pull-to-refresh, double-tap zoom, long-press menus (ARCHITECTURE.md R11). */
function blockBrowserGestures(app: HTMLElement): void {
  const prevent = (event: Event): void => {
    // Scrollable panels opt out with data-scroll.
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-scroll]")) return;
    if (event.cancelable) event.preventDefault();
  };
  app.addEventListener("touchmove", prevent, { passive: false });
  document.addEventListener("gesturestart", prevent as EventListener, { passive: false });
  document.addEventListener("gesturechange", prevent as EventListener, { passive: false });
  document.addEventListener("dblclick", prevent, { passive: false });
  app.addEventListener("contextmenu", prevent);
  // Ctrl/⌘ + wheel zoom on desktop.
  window.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false },
  );
}

bootstrap();
