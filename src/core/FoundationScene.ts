/**
 * Phase 2 verification scene.
 *
 * Purpose: prove that the loop, renderer, presets, shadows, instancing,
 * procedural textures, and interpolation all work on the device before the
 * real world exists. It is replaced by the procedural world in Phase 3.
 *
 * The central "probe" rotates inside fixedUpdate (60 Hz) and is drawn with
 * render interpolation, so a smooth spin at any FPS cap shows the fixed-step
 * loop is correct.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
  type PerspectiveCamera,
  type Scene,
} from "three";
import type { AssetManager } from "./AssetManager.ts";
import type { GraphicsPreset } from "./GraphicsSettings.ts";
import { Random } from "./Random.ts";
import { TAU, lerp } from "./math.ts";

const TREE_COUNT = 260;
const SKY = 0xa9b9b4;

type MatKind = "ground" | "foliage" | "bark" | "stone";

export class FoundationScene {
  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly root = new Group();
  private readonly sun: DirectionalLight;
  private readonly ground: Mesh;
  private readonly foliage: InstancedMesh;
  private readonly trunks: InstancedMesh;
  private readonly probe: Mesh;
  private readonly pedestal: Mesh;
  private standard = false;

  // Fixed-step state of the probe (previous + current for interpolation).
  private probeAngle = 0;
  private probePrevAngle = 0;
  private orbit = 0;
  private readonly lookTarget = new Vector3(0, 1.6, 0);

  constructor(scene: Scene, assets: AssetManager, seed: number) {
    this.scene = scene;
    this.assets = assets;
    scene.background = new Color(SKY);
    scene.fog = new Fog(SKY, 35, 170);

    const hemi = new HemisphereLight(0xcfe0ea, 0x3b3424, 1.3);
    this.sun = new DirectionalLight(0xffdcab, 2.4);
    this.sun.position.set(30, 38, 18);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = -40;
    cam.right = 40;
    cam.top = 40;
    cam.bottom = -40;
    cam.near = 1;
    cam.far = 120;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.root.add(hemi, this.sun, this.sun.target);

    const groundGeo = assets.geometry("p2.ground", () => {
      const g = new PlaneGeometry(400, 400, 1, 1);
      g.rotateX(-Math.PI / 2);
      return g;
    });
    this.ground = new Mesh(groundGeo, this.material("ground"));
    this.ground.receiveShadow = true;

    const rng = new Random(seed);
    const coneGeo = assets.geometry("p2.cone", () => {
      const g = new ConeGeometry(1.5, 4.2, 7, 1);
      g.translate(0, 4.1, 0);
      return g;
    });
    const trunkGeo = assets.geometry("p2.trunk", () => {
      const g = new CylinderGeometry(0.18, 0.26, 2.2, 6, 1);
      g.translate(0, 1.1, 0);
      return g;
    });
    this.foliage = new InstancedMesh(coneGeo, this.material("foliage"), TREE_COUNT);
    this.trunks = new InstancedMesh(trunkGeo, this.material("bark"), TREE_COUNT);
    const m = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < TREE_COUNT; i++) {
      // Clustered ring: clear centre, denser groves further out.
      const a = rng.range(0, TAU);
      const r = 10 + Math.pow(rng.next(), 0.7) * 95;
      pos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      const s = rng.range(0.7, 1.5) * (r > 40 ? 1.15 : 1);
      scl.set(s, s * rng.range(0.9, 1.25), s);
      q.setFromAxisAngle(up, rng.range(0, TAU));
      m.compose(pos, q, scl);
      this.foliage.setMatrixAt(i, m);
      this.trunks.setMatrixAt(i, m);
    }
    this.foliage.castShadow = this.trunks.castShadow = true;
    this.foliage.receiveShadow = true;
    this.foliage.computeBoundingSphere();
    this.trunks.computeBoundingSphere();

    this.pedestal = new Mesh(
      assets.geometry("p2.pedestal", () => {
        const g = new BoxGeometry(1.6, 0.8, 1.6);
        g.translate(0, 0.4, 0);
        return g;
      }),
      this.material("stone"),
    );
    this.probe = new Mesh(
      assets.geometry("p2.probe", () => new DodecahedronGeometry(0.7, 0)),
      this.material("ember"),
    );
    this.probe.position.set(0, 1.75, 0);
    for (const mesh of [this.pedestal, this.probe]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    this.root.add(this.ground, this.foliage, this.trunks, this.pedestal, this.probe);
    scene.add(this.root);
  }

  /** Applies the scene-level part of a graphics preset (shadows, material tier). */
  applyPreset(preset: GraphicsPreset): void {
    const shadows = preset.shadows !== "off";
    this.sun.castShadow = shadows;
    if (shadows && this.sun.shadow.mapSize.x !== preset.shadowMapSize) {
      this.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      // The shadow render target must be recreated at the new size.
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    if (preset.standardMaterials !== this.standard) {
      this.standard = preset.standardMaterials;
      this.ground.material = this.material("ground");
      this.foliage.material = this.material("foliage");
      this.trunks.material = this.material("bark");
      this.pedestal.material = this.material("stone");
      this.probe.material = this.material("ember");
    }
  }

  /** Fixed 60 Hz step. */
  fixedUpdate(dt: number): void {
    this.probePrevAngle = this.probeAngle;
    this.probeAngle += dt * 1.6;
  }

  /** Per rendered frame: interpolation + cinematic camera. */
  frameUpdate(frameDt: number, alpha: number, camera: PerspectiveCamera, menu: boolean): void {
    const angle = lerp(this.probePrevAngle, this.probeAngle, alpha);
    this.probe.rotation.set(angle * 0.5, angle, 0);
    this.probe.position.y = 1.75 + Math.sin(angle * 0.8) * 0.15;

    this.orbit += frameDt * (menu ? 0.05 : 0.12);
    const radius = menu ? 18 : 12;
    camera.position.set(Math.cos(this.orbit) * radius, menu ? 6.5 : 4.2, Math.sin(this.orbit) * radius);
    camera.lookAt(this.lookTarget);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.foliage.dispose();
    this.trunks.dispose();
    this.sun.shadow.map?.dispose();
  }

  private material(kind: MatKind | "ember"): Material {
    const tier = this.standard ? "std" : "lam";
    const key = `p2.mat.${kind}.${tier}`;
    return this.assets.material(key, () => {
      const params = this.materialParams(kind);
      return this.standard
        ? new MeshStandardMaterial({ ...params, roughness: kind === "ember" ? 0.4 : 0.9, metalness: 0 })
        : new MeshLambertMaterial(params);
    });
  }

  private materialParams(kind: MatKind | "ember"): { color: number; map?: ReturnType<AssetManager["noiseTexture"]>; emissive?: number } {
    switch (kind) {
      case "ground": {
        const map = this.assets.noiseTexture("p2.tex.ground", 128, 1337, (n) => {
          const g = 0.55 + n * 0.6;
          return [Math.round(70 * g), Math.round(96 * g), Math.round(48 * g)];
        });
        map.repeat.set(60, 60);
        return { color: 0xffffff, map };
      }
      case "foliage":
        return { color: 0x2f4a2c };
      case "bark":
        return { color: 0x5a4330 };
      case "stone":
        return { color: 0x7d7a70 };
      case "ember":
        return { color: 0xe08a3c, emissive: 0x3a1a05 };
    }
  }
}
