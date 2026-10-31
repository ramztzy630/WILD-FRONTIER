/**
 * Procedural hierarchical 3D character rig built from low-poly primitives
 * with zero external assets (PRD §5, §6; ARCHITECTURE.md R5, §7).
 *
 * Proportions match `PLAYER_HEIGHT` (1.80 m) with feet at local `y = 0` and
 * front facing `+Z`.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from "three";
import type { AssetManager } from "../core/AssetManager.ts";
import type { CharacterPose } from "./AnimationController.ts";

const BASE_HIP_HEIGHT = 0.92;

type RigColorSlot = "jacket" | "trousers" | "boots" | "skin" | "hair" | "pack" | "bedroll" | "accent";

const PALETTE: Record<RigColorSlot, number> = {
  jacket: 0x4b5d43, // weathered ranger olive
  trousers: 0x2e353b, // dark slate trousers
  boots: 0x4a3324, // worn leather boots
  skin: 0xd9a986, // warm skin tone
  hair: 0x2b211a, // dark brown hair / beanie
  pack: 0x6e5339, // canvas rucksack
  bedroll: 0x8f7d63, // rolled blanket atop pack
  accent: 0x994636, // rust collar scarf
};

export class CharacterModel {
  readonly root = new Group();
  readonly hips = new Group();
  readonly torso = new Group();
  readonly head = new Group();
  readonly leftUpperArm = new Group();
  readonly leftLowerArm = new Group();
  readonly rightUpperArm = new Group();
  readonly rightLowerArm = new Group();
  readonly rightHandToolSocket = new Group();
  readonly leftUpperLeg = new Group();
  readonly leftLowerLeg = new Group();
  readonly rightUpperLeg = new Group();
  readonly rightLowerLeg = new Group();

  readonly triangleCount: number;

  private readonly assets: AssetManager;
  private readonly meshes: { mesh: Mesh; slot: RigColorSlot }[] = [];
  private standardMaterials = false;

  constructor(assets: AssetManager, standardMaterials = false) {
    this.assets = assets;
    this.standardMaterials = standardMaterials;
    this.root.name = "PlayerCharacter";

    // --- Hips / Pelvis ---
    this.hips.position.set(0, BASE_HIP_HEIGHT, 0);
    this.root.add(this.hips);
    this.addPart(
      this.hips,
      "p3.char.pelvis",
      () => new BoxGeometry(0.34, 0.16, 0.22),
      "trousers",
      0,
      0,
      0,
    );

    // --- Torso + Collar + Backpack ---
    this.torso.position.set(0, 0.08, 0);
    this.hips.add(this.torso);
    this.addPart(
      this.torso,
      "p3.char.chest",
      () => new BoxGeometry(0.38, 0.46, 0.24),
      "jacket",
      0,
      0.23,
      0,
    );
    this.addPart(
      this.torso,
      "p3.char.scarf",
      () => new BoxGeometry(0.32, 0.08, 0.26),
      "accent",
      0,
      0.45,
      0.01,
    );
    // Rucksack on back (-Z)
    this.addPart(
      this.torso,
      "p3.char.pack",
      () => new BoxGeometry(0.3, 0.36, 0.16),
      "pack",
      0,
      0.24,
      -0.19,
    );
    this.addPart(
      this.torso,
      "p3.char.bedroll",
      () => {
        const g = new CylinderGeometry(0.065, 0.065, 0.32, 8);
        g.rotateZ(Math.PI / 2);
        return g;
      },
      "bedroll",
      0,
      0.45,
      -0.19,
    );

    // --- Head ---
    this.head.position.set(0, 0.48, 0);
    this.torso.add(this.head);
    this.addPart(
      this.head,
      "p3.char.neck",
      () => new CylinderGeometry(0.065, 0.075, 0.09, 8),
      "skin",
      0,
      0.04,
      0,
    );
    this.addPart(
      this.head,
      "p3.char.headBox",
      () => new BoxGeometry(0.22, 0.24, 0.22),
      "skin",
      0,
      0.18,
      0.01,
    );
    this.addPart(
      this.head,
      "p3.char.hair",
      () => new BoxGeometry(0.235, 0.11, 0.235),
      "hair",
      0,
      0.27,
      -0.005,
    );

    // --- Left Arm (+X) ---
    this.leftUpperArm.position.set(0.24, 0.42, 0);
    this.torso.add(this.leftUpperArm);
    this.addPart(
      this.leftUpperArm,
      "p3.char.upperArm",
      () => new CylinderGeometry(0.062, 0.055, 0.27, 8),
      "jacket",
      0,
      -0.13,
      0,
    );

    this.leftLowerArm.position.set(0, -0.26, 0);
    this.leftUpperArm.add(this.leftLowerArm);
    this.addPart(
      this.leftLowerArm,
      "p3.char.lowerArm",
      () => new CylinderGeometry(0.052, 0.045, 0.25, 8),
      "skin",
      0,
      -0.12,
      0,
    );
    this.addPart(
      this.leftLowerArm,
      "p3.char.hand",
      () => new BoxGeometry(0.08, 0.09, 0.09),
      "skin",
      0,
      -0.25,
      0,
    );

    // --- Right Arm (-X) + Tool Socket ---
    this.rightUpperArm.position.set(-0.24, 0.42, 0);
    this.torso.add(this.rightUpperArm);
    this.addPart(
      this.rightUpperArm,
      "p3.char.upperArm",
      () => new CylinderGeometry(0.062, 0.055, 0.27, 8),
      "jacket",
      0,
      -0.13,
      0,
    );

    this.rightLowerArm.position.set(0, -0.26, 0);
    this.rightUpperArm.add(this.rightLowerArm);
    this.addPart(
      this.rightLowerArm,
      "p3.char.lowerArm",
      () => new CylinderGeometry(0.052, 0.045, 0.25, 8),
      "skin",
      0,
      -0.12,
      0,
    );
    this.addPart(
      this.rightLowerArm,
      "p3.char.hand",
      () => new BoxGeometry(0.08, 0.09, 0.09),
      "skin",
      0,
      -0.25,
      0,
    );

    this.rightHandToolSocket.name = "RightHandToolSocket";
    this.rightHandToolSocket.position.set(0, -0.25, 0.04);
    this.rightLowerArm.add(this.rightHandToolSocket);

    // --- Left Leg (+X) ---
    this.leftUpperLeg.position.set(0.1, -0.04, 0);
    this.hips.add(this.leftUpperLeg);
    this.addPart(
      this.leftUpperLeg,
      "p3.char.upperLeg",
      () => new CylinderGeometry(0.082, 0.068, 0.42, 8),
      "trousers",
      0,
      -0.21,
      0,
    );

    this.leftLowerLeg.position.set(0, -0.42, 0);
    this.leftUpperLeg.add(this.leftLowerLeg);
    this.addPart(
      this.leftLowerLeg,
      "p3.char.lowerLeg",
      () => new CylinderGeometry(0.066, 0.055, 0.38, 8),
      "trousers",
      0,
      -0.19,
      0,
    );
    this.addPart(
      this.leftLowerLeg,
      "p3.char.boot",
      () => new BoxGeometry(0.12, 0.11, 0.23),
      "boots",
      0,
      -0.41,
      0.035,
    );

    // --- Right Leg (-X) ---
    this.rightUpperLeg.position.set(-0.1, -0.04, 0);
    this.hips.add(this.rightUpperLeg);
    this.addPart(
      this.rightUpperLeg,
      "p3.char.upperLeg",
      () => new CylinderGeometry(0.082, 0.068, 0.42, 8),
      "trousers",
      0,
      -0.21,
      0,
    );

    this.rightLowerLeg.position.set(0, -0.42, 0);
    this.rightUpperLeg.add(this.rightLowerLeg);
    this.addPart(
      this.rightLowerLeg,
      "p3.char.lowerLeg",
      () => new CylinderGeometry(0.066, 0.055, 0.38, 8),
      "trousers",
      0,
      -0.19,
      0,
    );
    this.addPart(
      this.rightLowerLeg,
      "p3.char.boot",
      () => new BoxGeometry(0.12, 0.11, 0.23),
      "boots",
      0,
      -0.41,
      0.035,
    );

    // Compute total triangle count across the procedural rig
    let tris = 0;
    for (const { mesh } of this.meshes) {
      const idx = mesh.geometry.getIndex();
      const pos = mesh.geometry.getAttribute("position");
      tris += idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    }
    this.triangleCount = Math.round(tris);
  }

  /** Updates world transform of the character root group. */
  setTransform(x: number, y: number, z: number, yaw: number): void {
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, yaw, 0);
  }

  /** Applies joint angles and hip offset from `AnimationController`. */
  applyPose(pose: Readonly<CharacterPose>): void {
    this.hips.position.y = BASE_HIP_HEIGHT + pose.hipsY;

    this.torso.rotation.set(pose.torsoPitch, pose.torsoYaw, pose.torsoRoll);
    this.head.rotation.set(pose.headPitch, pose.headYaw, 0);

    this.leftUpperArm.rotation.set(pose.leftShoulderPitch, 0, pose.leftShoulderRoll);
    this.leftLowerArm.rotation.set(pose.leftElbowPitch, 0, 0);

    this.rightUpperArm.rotation.set(pose.rightShoulderPitch, 0, pose.rightShoulderRoll);
    this.rightLowerArm.rotation.set(pose.rightElbowPitch, 0, 0);

    this.leftUpperLeg.rotation.set(pose.leftHipPitch, 0, 0);
    this.leftLowerLeg.rotation.set(pose.leftKneePitch, 0, 0);

    this.rightUpperLeg.rotation.set(pose.rightHipPitch, 0, 0);
    this.rightLowerLeg.rotation.set(pose.rightKneePitch, 0, 0);
  }

  /** Switches between Lambert (Low/Medium) and Standard (High/Ultra) materials. */
  setStandardMaterials(standard: boolean): void {
    if (this.standardMaterials === standard) return;
    this.standardMaterials = standard;
    for (const item of this.meshes) {
      item.mesh.material = this.getMaterial(item.slot);
    }
  }

  dispose(): void {
    this.meshes.length = 0;
    this.root.clear();
  }

  private addPart(
    parent: Group,
    geoKey: string,
    factory: () => BufferGeometry,
    slot: RigColorSlot,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const geo = this.assets.geometry(geoKey, factory);
    const mat = this.getMaterial(slot);
    const mesh = new Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.meshes.push({ mesh, slot });
    return mesh;
  }

  private getMaterial(slot: RigColorSlot): Material {
    const tier = this.standardMaterials ? "std" : "lam";
    const key = `p3.char.mat.${slot}.${tier}`;
    return this.assets.material(key, () => {
      const color = PALETTE[slot];
      return this.standardMaterials
        ? new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0 })
        : new MeshLambertMaterial({ color });
    });
  }
}
