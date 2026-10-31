/**
 * Water rendering and gameplay water-depth queries (PRD §5, §8;
 * ARCHITECTURE.md §6.5).
 *
 * Includes:
 *  - Lake plane mesh with two scrolling procedural ripple layers, Fresnel
 *    sky reflection, depth tinting, and shoreline foam.
 *  - River ribbon meshes extruded along each river spline with downstream UVs.
 *  - Waterfall cascade ribbon + plunge-pool foam ring.
 *  - `queryWaterState` for shallow slowing, deep swimming, and shoreline drinking.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3,
  type Scene,
} from "three";
import type { AssetManager } from "../core/AssetManager.ts";
import { clamp01, lerp } from "../core/math.ts";
import type { Heightfield, WaterInfo } from "./Heightfield.ts";
import type { LakeSpec, RiverSpline, WaterfallSpec } from "./WorldGenerator.ts";

/** Water depth (metres) beyond which a standing player transitions to swimming. */
export const SWIM_DEPTH = 1.15;
/** Minimum water depth (metres) that slows walking movement. */
export const SHALLOW_DEPTH = 0.15;

export interface WaterState {
  readonly inWater: boolean;
  readonly shallow: boolean;
  readonly swimming: boolean;
  /** 0 = dry, 1 = submerged up to chest/neck. */
  readonly submergence: number;
  readonly surfaceY: number;
  readonly depth: number;
  readonly flowX: number;
  readonly flowZ: number;
  /** True when in shallow water or standing within ~2 m of a water shoreline. */
  readonly canDrink: boolean;
  readonly kind: WaterInfo["kind"];
}

/**
 * Evaluates gameplay water state at world coordinates `(x, z)` and optional
 * character foot height `feetY` (defaults to terrain height at `(x, z)`).
 */
export function queryWaterState(
  heightfield: Heightfield,
  x: number,
  z: number,
  feetY?: number,
): WaterState {
  const info = heightfield.waterInfo(x, z);
  const actualFeetY = feetY ?? heightfield.height(x, z);
  const submergedDepth = info.hasWater ? Math.max(0, info.surfaceY - actualFeetY) : 0;
  const inWater = info.hasWater && submergedDepth > 0.05;
  const swimming = inWater && submergedDepth > SWIM_DEPTH;
  const shallow = inWater && !swimming && submergedDepth >= SHALLOW_DEPTH;
  const submergence = inWater ? clamp01(submergedDepth / 1.45) : 0;

  let canDrink = inWater && !swimming;
  if (!canDrink && !swimming) {
    // Check within 2 m around the player for a shoreline edge
    const probe = 2.0;
    if (
      heightfield.waterInfo(x + probe, z).hasWater ||
      heightfield.waterInfo(x - probe, z).hasWater ||
      heightfield.waterInfo(x, z + probe).hasWater ||
      heightfield.waterInfo(x, z - probe).hasWater
    ) {
      canDrink = true;
    }
  }

  return {
    inWater,
    shallow,
    swimming,
    submergence,
    surfaceY: info.surfaceY,
    depth: submergedDepth,
    flowX: info.flowX,
    flowZ: info.flowZ,
    canDrink,
    kind: info.kind,
  };
}

const SURFACE_VERT = /* glsl */ `
  attribute float aDepth;
  uniform float uTime;
  uniform float uFlowSpeed;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vDepth;
  varying float vFogDepth;

  void main() {
    vUv = uv;
    vDepth = aDepth;
    vec3 pos = position;
    // Gentle vertical wave displacement scaled by depth so shorelines stay pinned
    float waveMask = clamp(aDepth * 0.8, 0.0, 1.0);
    float w1 = sin(pos.x * 0.35 + pos.z * 0.25 + uTime * 1.8) * 0.045;
    float w2 = cos(pos.x * 0.22 - pos.z * 0.41 + uTime * 1.3) * 0.035;
    pos.y += (w1 + w2) * waveMask;

    vec4 worldPosition = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPosition.xyz;
    vNormal = normalize(vec3(
      -0.025 * cos(pos.x * 0.35 + uTime * 1.8),
      1.0,
      -0.025 * sin(pos.z * 0.41 + uTime * 1.3)
    ));
    vec4 mvPosition = viewMatrix * worldPosition;
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SURFACE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uFlowSpeed;
  uniform vec3 uSkyColor;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform vec3 uFoamColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vDepth;
  varying float vFogDepth;

  // Cheap procedural dual-layer ripple pattern
  float ripple(vec2 p) {
    vec2 uv1 = p * 0.42 + vec2(uTime * 0.08, -uTime * (0.12 + uFlowSpeed * 0.35));
    vec2 uv2 = p * 0.67 + vec2(-uTime * 0.06, -uTime * (0.09 + uFlowSpeed * 0.25));
    float r1 = sin(uv1.x * 6.2831) * cos(uv1.y * 6.2831);
    float r2 = sin((uv2.x + uv2.y) * 6.2831) * cos((uv2.x - uv2.y) * 6.2831);
    return (r1 + r2) * 0.5;
  }

  void main() {
    if (vDepth <= 0.005) discard;

    float rip = ripple(vWorldPos.xz + vUv * 6.0);
    vec3 N = normalize(vNormal + vec3(rip * 0.09, 0.0, rip * 0.09));
    vec3 V = normalize(cameraPosition - vWorldPos);
    float NoV = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - NoV, 3.0) * 0.65 + 0.12;

    float depthFactor = clamp(vDepth / 4.2, 0.0, 1.0);
    vec3 waterCol = mix(uShallowColor, uDeepColor, depthFactor);
    vec3 col = mix(waterCol, uSkyColor, fresnel);

    // Shoreline and river-rapid foam band
    float shoreFoam = (1.0 - smoothstep(0.04, 0.72, vDepth)) * (0.55 + 0.45 * sin(vWorldPos.x * 1.7 + vWorldPos.z * 1.9 + uTime * 2.6));
    float rapidFoam = uFlowSpeed * smoothstep(0.45, 0.85, rip) * 0.38;
    float foam = clamp(shoreFoam + rapidFoam, 0.0, 1.0);
    col = mix(col, uFoamColor, foam);

    // Distance fog matching Scene.fog
    float fogFactor = smoothstep(uFogNear, uFogFar, vFogDepth);
    col = mix(col, uFogColor, fogFactor);

    float alpha = clamp(0.68 + depthFactor * 0.24 + foam * 0.2, 0.0, 0.94);
    gl_FragColor = vec4(col, alpha);
  }
`;

const WATERFALL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFogDepth;

  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const WATERFALL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFoamColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec2 vUv;
  varying float vFogDepth;

  void main() {
    float scroll = vUv.y * 4.5 - uTime * 3.4;
    float streak1 = sin(vUv.x * 28.0 + sin(scroll * 2.0)) * 0.5 + 0.5;
    float streak2 = cos(vUv.x * 15.0 - scroll * 3.2) * 0.5 + 0.5;
    float foam = clamp(0.45 + streak1 * 0.35 + streak2 * 0.3, 0.0, 1.0);
    float edgeFade = smoothstep(0.0, 0.14, vUv.x) * (1.0 - smoothstep(0.86, 1.0, vUv.x));

    vec3 col = mix(uShallowColor, uFoamColor, foam);
    float fogFactor = smoothstep(uFogNear, uFogFar, vFogDepth);
    col = mix(col, uFogColor, fogFactor);

    gl_FragColor = vec4(col, edgeFade * 0.9);
  }
`;

export class Water {
  private readonly scene: Scene;
  private readonly root = new Group();
  private readonly materials: ShaderMaterial[] = [];
  private readonly meshes: Mesh[] = [];
  private elapsed = 0;

  constructor(scene: Scene, assets: AssetManager, heightfield: Heightfield) {
    this.scene = scene;
    this.root.name = "Water";

    const lakeMat = this.createSurfaceMaterial(assets, "p3.mat.water.lake", 0.0);
    const riverMat = this.createSurfaceMaterial(assets, "p3.mat.water.river", 1.0);
    const waterfallMat = this.createWaterfallMaterial(assets, "p3.mat.water.waterfall");

    // 1. Lake mesh
    const lakeGeo = buildLakeGeometry(heightfield.layout.lake, heightfield);
    const lakeMesh = new Mesh(lakeGeo, lakeMat);
    lakeMesh.name = "WaterLake";
    lakeMesh.renderOrder = 1;
    this.root.add(lakeMesh);
    this.meshes.push(lakeMesh);

    // 2. River ribbon meshes
    for (const river of heightfield.layout.rivers) {
      const riverGeo = buildRiverRibbonGeometry(river);
      const riverMesh = new Mesh(riverGeo, riverMat);
      riverMesh.name = `WaterRiver_${river.id}`;
      riverMesh.renderOrder = 1;
      this.root.add(riverMesh);
      this.meshes.push(riverMesh);
    }

    // 3. Waterfall cascade mesh
    const wfGeo = buildWaterfallGeometry(heightfield.layout.waterfall);
    const wfMesh = new Mesh(wfGeo, waterfallMat);
    wfMesh.name = "WaterWaterfall";
    wfMesh.renderOrder = 2;
    this.root.add(wfMesh);
    this.meshes.push(wfMesh);

    this.scene.add(this.root);
  }

  get meshCount(): number {
    return this.meshes.length;
  }

  /** Advances scrolling wave/cascade uniforms and syncs fog parameters. */
  update(dt: number, fogNear = 45, fogFar = 280, fogColorHex = 0xa9b9b4): void {
    this.elapsed += dt;
    for (const mat of this.materials) {
      const u = mat.uniforms;
      if (u["uTime"]) u["uTime"].value = this.elapsed;
      if (u["uFogNear"]) u["uFogNear"].value = fogNear;
      if (u["uFogFar"]) u["uFogFar"].value = fogFar;
      if (u["uFogColor"]) (u["uFogColor"].value as Color).setHex(fogColorHex);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.length = 0;
    this.materials.length = 0;
    this.scene.remove(this.root);
  }

  private createSurfaceMaterial(assets: AssetManager, key: string, flowSpeed: number): ShaderMaterial {
    const mat = assets.material(key, () => {
      return new ShaderMaterial({
        vertexShader: SURFACE_VERT,
        fragmentShader: SURFACE_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uFlowSpeed: { value: flowSpeed },
          uSkyColor: { value: new Color(0x9ec2d4) },
          uShallowColor: { value: new Color(0x3f8896) },
          uDeepColor: { value: new Color(0x163c48) },
          uFoamColor: { value: new Color(0xe8efe8) },
          uFogColor: { value: new Color(0xa9b9b4) },
          uFogNear: { value: 45 },
          uFogFar: { value: 280 },
        },
      });
    });
    this.materials.push(mat);
    return mat;
  }

  private createWaterfallMaterial(assets: AssetManager, key: string): ShaderMaterial {
    const mat = assets.material(key, () => {
      return new ShaderMaterial({
        vertexShader: WATERFALL_VERT,
        fragmentShader: WATERFALL_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uShallowColor: { value: new Color(0x4c97a8) },
          uFoamColor: { value: new Color(0xf2f7f5) },
          uFogColor: { value: new Color(0xa9b9b4) },
          uFogNear: { value: 45 },
          uFogFar: { value: 280 },
        },
      });
    });
    this.materials.push(mat);
    return mat;
  }
}

export function buildLakeGeometry(lake: LakeSpec, heightfield: Heightfield): BufferGeometry {
  const segs = 36;
  const stride = segs + 1;
  const vertCount = stride * stride;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const depths = new Float32Array(vertCount);
  const indices = new Uint16Array(segs * segs * 6);

  const rx = lake.radiusX * 1.12;
  const rz = lake.radiusZ * 1.12;

  let v = 0;
  for (let row = 0; row <= segs; row++) {
    const tz = row / segs;
    const wz = lake.z + lerp(-rz, rz, tz);
    for (let col = 0; col <= segs; col++) {
      const tx = col / segs;
      const wx = lake.x + lerp(-rx, rx, tx);
      const groundY = heightfield.height(wx, wz);
      const depth = Math.max(0, lake.waterY - groundY);

      const p3 = v * 3;
      const p2 = v * 2;
      positions[p3] = wx;
      positions[p3 + 1] = lake.waterY;
      positions[p3 + 2] = wz;
      uvs[p2] = tx * 8;
      uvs[p2 + 1] = tz * 8;
      depths[v] = depth;
      v++;
    }
  }

  let idx = 0;
  for (let row = 0; row < segs; row++) {
    for (let col = 0; col < segs; col++) {
      const i00 = row * stride + col;
      const i10 = i00 + 1;
      const i01 = (row + 1) * stride + col;
      const i11 = i01 + 1;
      indices[idx++] = i00;
      indices[idx++] = i01;
      indices[idx++] = i10;
      indices[idx++] = i10;
      indices[idx++] = i01;
      indices[idx++] = i11;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setAttribute("aDepth", new BufferAttribute(depths, 1));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export function buildRiverRibbonGeometry(river: RiverSpline): BufferGeometry {
  const pts = river.points;
  const cols = 5; // cross-section vertices from left bank to right bank
  const rows = pts.length;
  const vertCount = rows * cols;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const depths = new Float32Array(vertCount);
  const indices = new Uint16Array((rows - 1) * (cols - 1) * 6);

  let arcLength = 0;
  let v = 0;
  for (let r = 0; r < rows; r++) {
    const pt = pts[r]!;
    if (r > 0) {
      const prev = pts[r - 1]!;
      arcLength += Math.hypot(pt.x - prev.x, pt.z - prev.z);
    }
    // Perpendicular vector (-flowZ, flowX) in XZ
    const nx = -pt.flowZ;
    const nz = pt.flowX;
    const halfW = pt.width * 0.56;

    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1); // 0..1 across river width
      const s = u * 2 - 1; // -1..+1
      const wx = pt.x + nx * s * halfW;
      const wz = pt.z + nz * s * halfW;
      const wy = pt.waterY + 0.04;
      const profile = 1 - s * s * 0.88;

      const p3 = v * 3;
      const p2 = v * 2;
      positions[p3] = wx;
      positions[p3 + 1] = wy;
      positions[p3 + 2] = wz;
      uvs[p2] = u;
      uvs[p2 + 1] = arcLength / 8;
      depths[v] = Math.max(0.08, pt.bedDepth * profile);
      v++;
    }
  }

  let idx = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = (r + 1) * cols + c;
      const i11 = i01 + 1;
      indices[idx++] = i00;
      indices[idx++] = i01;
      indices[idx++] = i10;
      indices[idx++] = i10;
      indices[idx++] = i01;
      indices[idx++] = i11;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setAttribute("aDepth", new BufferAttribute(depths, 1));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export function buildWaterfallGeometry(wf: WaterfallSpec): BufferGeometry {
  const cols = 8;
  const rows = 12;
  const stride = cols + 1;
  const vertCount = (rows + 1) * stride;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint16Array(rows * cols * 6);

  const halfW = wf.width * 0.55;
  let v = 0;
  for (let r = 0; r <= rows; r++) {
    const ty = r / rows; // 0 = top lip, 1 = plunge pool
    // Parabolic forward arc over the cliff step
    const forward = Math.sin(ty * Math.PI * 0.5) * 6.5;
    const wy = lerp(wf.topY + 0.1, wf.bottomY - 0.2, ty * ty);
    const wz = wf.z - 3.5 + forward * wf.dirZ;

    for (let c = 0; c <= cols; c++) {
      const tx = c / cols;
      const wx = wf.x + lerp(-halfW, halfW, tx);
      const p3 = v * 3;
      const p2 = v * 2;
      positions[p3] = wx;
      positions[p3 + 1] = wy;
      positions[p3 + 2] = wz;
      uvs[p2] = tx;
      uvs[p2 + 1] = ty;
      v++;
    }
  }

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * stride + c;
      const i10 = i00 + 1;
      const i01 = (r + 1) * stride + c;
      const i11 = i01 + 1;
      indices[idx++] = i00;
      indices[idx++] = i01;
      indices[idx++] = i10;
      indices[idx++] = i10;
      indices[idx++] = i01;
      indices[idx++] = i11;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export const WATER_UP = new Vector3(0, 1, 0);
