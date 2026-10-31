/**
 * Device detection and default graphics preset (ARCHITECTURE.md §8.2).
 *
 * `selectDefaultPreset` is pure (unit-tested); `detectDevice` reads browser
 * APIs and must only run in the browser.
 */

import type { PresetName } from "./GraphicsSettings.ts";

export interface DeviceInfo {
  /** Primary input is touch (`pointer: coarse`) or the UA reports a mobile device. */
  readonly mobile: boolean;
  readonly touch: boolean;
  /** navigator.deviceMemory in GB (Chrome only); null when unknown. */
  readonly memoryGB: number | null;
  /** navigator.hardwareConcurrency; null when unknown. */
  readonly cores: number | null;
  readonly devicePixelRatio: number;
  /** Unmasked GPU renderer string if exposed, else the masked one, else "". */
  readonly gpu: string;
  readonly webgl2: boolean;
  /** Largest texture size reported by the GPU. */
  readonly maxTextureSize: number;
}

/**
 * GPU families that struggle with our Medium preset. Matching is
 * case-insensitive substring. Kept short and conservative: when unsure,
 * the device gets Medium and adaptive resolution handles the rest.
 */
const WEAK_GPU_PATTERNS: readonly RegExp[] = [
  /mali-[4t][0-9]{2}\b/i, // Mali-400/450, Mali-T6xx/T7xx/T8xx
  /mali-g(31|51|52)\b/i, // entry-level Bifrost (G57 = mid-range, stays Medium)
  /adreno \(tm\) [3-5][0-9]{2}\b/i, // Adreno 3xx–5xx
  /adreno [3-5][0-9]{2}\b/i,
  /powervr (sgx|rogue g[e0-9][0-9]{3})/i,
  /powervr b-series bxe/i,
  /intel.*(hd graphics [2-5][0-9]{2,3}|gma)/i,
  /swiftshader|llvmpipe|software/i, // software renderers
];

export function isWeakGpu(gpu: string): boolean {
  return WEAK_GPU_PATTERNS.some((re) => re.test(gpu));
}

export function selectDefaultPreset(info: DeviceInfo): PresetName {
  if (isWeakGpu(info.gpu)) return "low";
  if (info.mobile) {
    const lowMemory = info.memoryGB !== null && info.memoryGB <= 3;
    const fewCores = info.cores !== null && info.cores <= 4;
    if (lowMemory || fewCores || !info.webgl2) return "low";
    return "medium";
  }
  // Desktop: weak integrated chips were caught above.
  if (!info.webgl2) return "medium";
  return "high";
}

interface NavigatorExtras {
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
}

/** Reads device information. Creates (and releases) a throwaway WebGL context for the GPU query. */
export function detectDevice(): DeviceInfo {
  const nav = navigator as Navigator & NavigatorExtras;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const touch = coarse || (nav.maxTouchPoints ?? 0) > 0;
  const uaMobile =
    nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
  // iPadOS reports a desktop UA; treat a touch-primary "Mac" as mobile.
  const iPadLike = /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;

  let gpu = "";
  let webgl2 = false;
  let maxTextureSize = 0;
  try {
    const canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2");
    const gl: WebGLRenderingContext | WebGL2RenderingContext | null = gl2 ?? canvas.getContext("webgl");
    webgl2 = gl2 !== null;
    if (gl) {
      maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = String(
        (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "",
      );
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // Leave defaults; the WebGL capability check reports real failures.
  }

  return {
    mobile: coarse || uaMobile || iPadLike,
    touch,
    memoryGB: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null,
    devicePixelRatio: window.devicePixelRatio || 1,
    gpu,
    webgl2,
    maxTextureSize,
  };
}
