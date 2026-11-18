import * as T from 'three';
import type { FishEmotion } from '../../shared/fish-brain/types';
import { FISH } from '../../shared/sim/config';
import type { FishKind, RagdollLimb } from '../../shared/sim/types';
import { crewColor } from '../crew-colors';
import { label, palette as p, type GeometryKit } from './geometry';

const fishColors = {
  sardine: { back: 0x529eb2, belly: 0xc4ead2, fin: 0x2a6b79 },
  puffer: { back: 0xe5a242, belly: 0xffdc86, fin: 0xbc6345 },
  grouper: { back: 0xec7d62, belly: 0xffb989, fin: 0xb24e53 },
} satisfies Record<FishKind, { back: number; belly: number; fin: number }>;

function finGeometry(points: number[]) {
  const shape = new T.Shape();
  shape.moveTo(points[0], points[1]);
  for (let index = 2; index < points.length; index += 2) {
    shape.lineTo(points[index], points[index + 1]);
  }
  shape.closePath();
  return new T.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: false });
}

function uniform(id: string) {
  const color = new T.Color(crewColor(id));
  return {
    bib: color.getHex(),
    pocket: color.clone().multiplyScalar(0.72).getHex(),
    straps: color.clone().lerp(new T.Color(0xf5d59a), 0.13).getHex(),
    helmet: id === 'player' ? 0xfabd4d : color.clone().lerp(new T.Color(0xffdab5), 0.42).getHex(),
    brim: id === 'player' ? 0xe88736 : color.clone().multiplyScalar(0.8).getHex(),
  };
}

export function createModels(kit: GeometryKit) {
  const tailFin = finGeometry([0, 0, -0.26, 0.18, -0.3, 0.03, -0.24, -0.05, -0.29, -0.17]);
  const dorsalFin = finGeometry([-0.20, 0.0, -0.19, 0.13, -0.03, 0.21, 0.10, 0.0]);
  const sideFin = finGeometry([0.07, 0.04, -0.19, 0.03, -0.11, -0.11, 0.01, -0.07]);
  const warningCone = new T.ConeGeometry(1, 1, 7);
  const warningDecal = new T.Group();
  label(warningDecal, '待优化', 0.57, 0.225, 0, 0, 0);

  function fish(parent: T.Object3D, kind: FishKind) {
    const { back, belly, fin } = fishColors[kind];
    const animal = kit.group(parent);
    animal.scale.setScalar(FISH[kind].size);
    const blimp = kind === 'puffer';
    kit.orb(animal, back, 0, 0.04, 0, blimp ? 0.34 : 0.46, blimp ? 0.29 : 0.21, 0.205);
    kit.orb(animal, belly, 0.07, -0.075, 0, blimp ? 0.29 : 0.39, 0.14, 0.194);
    kit.orb(animal, fin, blimp ? 0.306 : 0.421, -0.065, 0, 0.076, 0.045, 0.086);
    kit.orb(animal, p.ink, blimp ? 0.37 : 0.481, -0.065, 0, 0.023, 0.021, 0.056);
    kit.mesh(animal, dorsalFin, fin, -0.036, blimp ? 0.235 : 0.152, -0.017);
    const tail = kit.group(animal, blimp ? -0.29 : -0.39, 0.025);
    kit.mesh(tail, tailFin, fin, 0, 0, -0.019);
    for (const side of [-1, 1]) {
      const eyeX = blimp ? 0.181 : 0.265;
      kit.orb(animal, 0xfff7cf, eyeX, 0.065, side * 0.163, 0.087, 0.085, 0.057);
      kit.orb(animal, p.ink, eyeX + 0.014, 0.067, side * 0.212, 0.038, 0.043, 0.020);
      kit.orb(animal, 0xfff7cf, eyeX + 0.029, 0.081, side * 0.227, 0.015, 0.014, 0.008);
      const flipper = kit.mesh(animal, sideFin, fin, 0.025, -0.075, side * 0.179);
      flipper.rotation.y = side * 0.6;
      if (blimp) {
        for (let spot = 0; spot < 4; spot++) {
          kit.orb(animal, 0xa96c3f, -0.12 + spot * 0.066, 0.163 + (spot % 2) * 0.050, side * (0.135 - (spot % 2) * 0.048), 0.026, 0.026, 0.018, true);
        }
      }
    }
    return { animal, tail };
  }

  function safetyStripe(parent: T.Object3D, z: number) {
    kit.box(parent, p.ink, 0, 0.07, z, 0.92, 0.21, 0.026);
    for (let index = -2; index <= 2; index++) {
      kit.box(parent, p.mustard, index * 0.17, 0.07, z * 1.03, 0.075, 0.22, 0.026).rotation.z = -0.38;
    }
  }

  function crate(parent: T.Object3D, training = false) {
    const object = kit.group(parent);
    kit.box(object, training ? 0x9e5535 : 0x9c6b45, 0, 0, 0, 0.92, 0.82, 0.92);
    for (const vertical of [-1, 1]) {
      const y = vertical * 0.35;
      kit.box(object, 0xcf9656, 0, y, 0, 0.98, 0.112, 0.98);
      for (const x of [-0.37, 0.37]) {
        kit.box(object, p.rust, x, y + vertical * 0.06, 0, 0.08, 0.019, 0.91);
      }
    }
    for (const side of [-1, 1]) {
      for (const x of [-0.37, 0.37]) {
        kit.box(object, 0xe7ae63, x, 0, side * 0.473, 0.10, 0.68, 0.052);
      }
      kit.box(object, 0xc18a51, 0, 0, side * 0.472, 0.08, 0.65, 0.047).rotation.z = side * 0.85;
      kit.box(object, 0xc18a51, side * 0.472, 0, 0, 0.047, 0.65, 0.08).rotation.x = -side * 0.85;
      if (training) safetyStripe(object, side * 0.51);
      else {
        const red = 0xd77d4a;
        kit.box(object, red, side * 0.525, 0.05, 0, 0.083, 0.13, 0.94);
      }
    }
    return object;
  }

  function shell(part: RagdollLimb, parent: T.Object3D, colors: ReturnType<typeof uniform>) {
    const object = kit.group(parent);
    if (part === 'torso') {
      kit.orb(object, 0xeaced0, 0, 0.078, 0.015, 0.302, 0.28, 0.226);
      kit.box(object, colors.bib, 0, -0.078, 0.016, 0.49, 0.27, 0.383);
      kit.box(object, colors.bib, 0, -0.045, -0.192, 0.35, 0.35, 0.08);
      kit.box(object, colors.pocket, 0, -0.114, 0.244, 0.29, 0.170, 0.087);
      kit.box(object, p.mustard, 0, -0.114, 0.295, 0.18, 0.073, 0.029);
      for (const side of [-1, 1]) {
        kit.box(object, colors.straps, side * 0.147, 0.141, 0.017, 0.08, 0.129, 0.45);
        kit.orb(object, p.mustard, side * 0.14, 0.047, -0.239, 0.035, 0.035, 0.022);
      }
    } else if (part === 'head') {
      kit.orb(object, 0xefaf75, 0, -0.026, 0, 0.215, 0.215, 0.19);
      kit.orb(object, 0xf5be84, 0, -0.046, -0.176, 0.073, 0.068, 0.063);
      for (const side of [-1, 1]) {
        kit.orb(object, p.ink, side * 0.082, 0.012, -0.172, 0.025, 0.038, 0.016);
      }
      kit.orb(object, colors.helmet, 0, 0.128, 0, 0.26, 0.170, 0.225);
      kit.tube(object, colors.brim, 0, 0.087, -0.019, 0.28, 0.043, 0.253);
      kit.box(object, colors.helmet, 0, 0.245, 0, 0.08, 0.047, 0.236);
      kit.box(object, 0xf7ead0, 0, 0.129, 0.204, 0.09, 0.065, 0.02);
    } else if (part === 'leftArm' || part === 'rightArm') {
      kit.orb(object, 0xf6d3af, 0, 0.075, 0, 0.116, 0.151, 0.127);
      kit.orb(object, 0xeba872, 0, -0.139, 0, 0.088, 0.17, 0.093);
      kit.orb(object, 0xe79a60, 0, -0.236, -0.012, 0.106, 0.095, 0.094);
    } else {
      kit.orb(object, colors.bib, 0, -0.01, 0.032, 0.132, 0.205, 0.140);
      kit.box(object, p.ink, 0, -0.194, -0.044, 0.242, 0.13, 0.37);
      kit.box(object, 0x40554a, 0, -0.247, -0.045, 0.243, 0.028, 0.371);
    }
    for (const mesh of object.children) {
      if (Math.max(mesh.scale.x, mesh.scale.y, mesh.scale.z) < 0.2) mesh.castShadow = false;
    }
    return object;
  }

  function optimizationHat(head: T.Group) {
    const hat = kit.group(head, 0.02, 0.21, 0.01);
    hat.rotation.z = -0.12;
    const cone = kit.mesh(hat, warningCone, 0xf18334, 0, 0.30, 0);
    cone.scale.set(0.295, 0.59, 0.27);
    kit.tube(hat, 0xffcc69, 0, 0.073, 0, 0.28, 0.047, 0.259);
    for (const side of [-1, 1]) {
      const decal = warningDecal.clone();
      decal.position.set(0, 0.16, side * 0.243);
      decal.rotation.y = side < 0 ? Math.PI : 0;
      hat.add(decal);
    }
    hat.visible = false;
    return hat;
  }

  function worker(parent: T.Object3D, id: string) {
    const yaw = kit.group(parent);
    const body = kit.group(yaw);
    const colors = uniform(id);
    const offsets: Record<RagdollLimb, [number, number, number]> = {
      torso: [0, 0, 0],
      head: [0, 0.48, -0.015],
      leftArm: [-0.349, 0.073, 0],
      rightArm: [0.349, 0.073, 0],
      leftLeg: [-0.14, -0.395, 0],
      rightLeg: [0.14, -0.395, 0],
    };
    const limbs = Object.keys(offsets) as RagdollLimb[];
    const standing = new Map(limbs.map(name => [name, shell(name, body, colors)]));
    const ragdoll = new Map(limbs.map(name => [name, shell(name, parent, colors)]));
    for (const [name, member] of standing) member.position.set(...offsets[name]);
    for (const member of ragdoll.values()) member.visible = false;
    const hats = [optimizationHat(standing.get('head')!), optimizationHat(ragdoll.get('head')!)];

    const rod = kit.group(body, 0.40, -0.02, -0.34);
    kit.beam(rod, 0x854d32, new T.Vector3(0, -0.13, 0.20), new T.Vector3(0.12, 0.54, -0.74), 0.033);
    kit.beam(rod, p.mustard, new T.Vector3(0.12, 0.54, -0.74), new T.Vector3(0.12, 0.58, -0.98), 0.024);
    kit.tube(rod, p.ink, 0.018, -0.108, 0.015, 0.067, 0.05).rotation.z = 1.57;
    const tip = kit.group(rod, 0.12, 0.58, -0.98);

    const paddle = kit.group(body, 0.34, -0.075, -0.22);
    kit.box(paddle, 0x9a5f36, 0, 0.08, 0, 0.073, 0.79, 0.073);
    kit.orb(paddle, p.mustard, 0, 0.60, 0, 0.162, 0.282, 0.049);
    kit.box(paddle, p.rust, 0, 0.73, 0, 0.196, 0.062, 0.087);
    paddle.visible = false;
    return { yaw, body, standing, ragdoll, rod, tip, paddle, hats };
  }

  return { fish, crate, worker };
}

export function makeBoss(parent: T.Object3D, kit: GeometryKit) {
  const fish = kit.group(parent, 0.7, 0.25, -18);
  fish.rotation.y = -0.24;
  const green = 0x57927b;
  const pink = 0xca7559;
  kit.rock(fish, green, 0, 0, 0, 2.48, 1.45, 1.19);
  kit.orb(fish, 0x93af78, 0.12, -0.31, 0.5, 1.99, 0.90, 0.83);
  const mouth = kit.group(fish, 0.09, 0.04, 1.14);
  kit.orb(mouth, pink, 0, 0, 0, 0.78, 0.30, 0.29);
  kit.orb(mouth, 0x4e4741, 0, -0.012, 0.234, 0.60, 0.16, 0.088);
  kit.box(mouth, 0xffedbd, 0.09, 0.082, 0.306, 0.13, 0.112, 0.070).rotation.z = 0.05;
  const face = [-1, 1].map(side => {
    const lens = side * 0.54 + 0.04;
    const eye = kit.group(fish, lens, 0.56, 0);
    kit.orb(eye, 0xffecae, 0, 0, 1.11, 0.29, 0.31, 0.237);
    kit.orb(eye, p.ink, 0.048, 0, 1.31, 0.122, 0.16, 0.090);
    kit.orb(eye, 0xffffd1, 0.082, 0.068, 1.37, 0.045, 0.047, 0.046);
    const brow = kit.box(fish, 0x497664, lens - 0.044, 0.87, 1.19, 0.49, 0.115, 0.129);
    brow.rotation.z = side * -0.17;
    kit.orb(fish, 0xa9b581, side * 0.96 + 0.08, 0.06, 1.06, 0.27, 0.17, 0.23);
    kit.orb(fish, 0x437c71, side * 1.94, -0.34, 0.83, 0.84, 0.29, 0.44, true).rotation.y = side * -0.24;
    return { eye, brow, side };
  });
  kit.orb(fish, 0x467e71, -2.28, 0.03, -0.26, 0.63, 0.96, 0.25, true).rotation.z = 0.38;
  kit.orb(fish, 0x467e71, -2.36, -0.24, -0.31, 0.60, 0.51, 0.24, true).rotation.z = 0.37;
  const cap = kit.group(fish, -0.38, 1.22, 0.07);
  cap.rotation.z = 0.19;
  kit.tube(cap, p.ink, 0, 0.0, 0, 0.71, 0.113);
  kit.tube(cap, 0xe7cf90, 0, 0.17, -0.034, 0.54, 0.32, 0.52);
  kit.tube(cap, 0xffe4a1, 0, 0.33, -0.034, 0.65, 0.099, 0.58);
  kit.box(cap, 0xf39836, 0, 0.172, 0.50, 0.15, 0.14, 0.057);

  const speechAnchor = kit.group(fish, -0.26, 1.63, 0.35);
  const expressions = {
    calm:      { eyes: [1, 1], brows: [0, 0], browTilt: -0.17, mouth: [1, 1, 0] },
    happy:     { eyes: [0.58, 0.58], brows: [0.09, 0.09], browTilt: -0.32, mouth: [1.15, 1.12, 0.04] },
    annoyed:   { eyes: [0.71, 0.71], brows: [-0.13, -0.13], browTilt: 0.58, mouth: [0.91, 0.68, -0.07] },
    smug:      { eyes: [0.46, 0.91], brows: [0.04, 0.15], browTilt: -0.27, mouth: [1.04, 0.76, -0.17] },
    surprised: { eyes: [1.26, 1.26], brows: [0.24, 0.24], browTilt: -0.07, mouth: [0.68, 1.48, 0] },
  } as const satisfies Record<FishEmotion, {
    eyes: readonly [number, number];
    brows: readonly [number, number];
    browTilt: number;
    mouth: readonly [number, number, number];
  }>;

  function express(emotion: FishEmotion, seconds: number, speaking: boolean) {
    const expression = expressions[emotion];
    const blink = Math.max(0, 1 - Math.abs((seconds % 5.6) - 5.42) * 17);
    for (const [index, { eye, brow, side }] of face.entries()) {
      eye.scale.y = expression.eyes[index] * (1 - blink * 0.86);
      brow.position.y = 0.87 + expression.brows[index];
      brow.rotation.z = side * expression.browTilt;
    }
    const [width, height, tilt] = expression.mouth;
    mouth.scale.x = width;
    mouth.scale.y = height + (speaking ? Math.sin(seconds * 11) * 0.12 : 0);
    mouth.rotation.z = tilt;
  }

  return { fish, speechAnchor, express };
}
