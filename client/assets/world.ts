import * as T from 'three';
import type { FishEmotion } from '../../shared/fish-brain/types';
import { FISHING, ISLAND } from '../../shared/sim/config';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { label, palette as p, seededDecor, type GeometryKit, type Tint } from './geometry';
import { makeBoss } from './models';

const shore = [
  [-9.86, -3.25], [-8.97, -3.92], [-6.25, -4.00], [-3.20, -4.02],
  [-0.41, -4.08], [2.14, -4.06], [4.25, -4.06], [7.38, -4.02],
  [9.30, -3.77], [9.95, -3.13], [10.02, 0.13], [9.93, 5.91],
  [9.50, 8.94], [5.0, 9.21], [1.0, 9.2], [-4.87, 9.22],
  [-9.5, 8.86], [-10.02, 6.80], [-10.03, 1.72],
];

function earth(parent: T.Object3D, kit: GeometryKit, tint: Tint, y: number, rim: number[][]) {
  const outline = new T.Shape();
  outline.moveTo(rim[0][0], -rim[0][1]);
  for (const [x, z] of rim.slice(1)) outline.lineTo(x, -z);
  outline.closePath();
  const level = kit.mesh(parent, new T.ShapeGeometry(outline), tint, 0, y, 0);
  level.rotation.x = -Math.PI / 2;
}

function oval(parent: T.Object3D, color: Tint, x: number, y: number, z: number, rx: number, rz: number, opacity: number) {
  const material = new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const shape = new T.Mesh(new T.CircleGeometry(1, 28), material);
  shape.scale.set(rx, rz, 1);
  shape.rotation.x = -Math.PI / 2;
  shape.position.set(x, y, z);
  parent.add(shape);
  return shape;
}

function ring(parent: T.Object3D, color: Tint, x: number, y: number, z: number, rx: number, rz: number, width: number, opacity: number) {
  const material = new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: T.DoubleSide });
  const shape = new T.Mesh(new T.RingGeometry(1 - width, 1, 36, 1), material);
  shape.scale.set(rx, rz, 1);
  shape.rotation.x = -Math.PI / 2;
  shape.position.set(x, y, z);
  parent.add(shape);
  return shape;
}

function water(parent: T.Object3D) {
  const uniform = { value: 0 };
  const material = new T.MeshBasicMaterial({ vertexColors: true });
  material.onBeforeCompile = shader => {
    shader.uniforms.tide = uniform;
    shader.vertexShader = 'uniform float tide;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n transformed.y += 0.037*sin(position.x*0.58 + position.z*0.52 + tide*1.35) + 0.034*cos(position.z*0.54 - tide*1.1);',
    );
  };
  const geom = new T.PlaneGeometry(166, 124, 65, 66);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, ISLAND.seaY - 0.02, -29);
  const random = seededDecor(8493);
  const vertices = geom.attributes.position;
  for (let index = 0; index < vertices.count; index++) {
    vertices.setX(index, vertices.getX(index) + (random() - 0.5) * 0.95);
    vertices.setZ(index, vertices.getZ(index) + (random() - 0.5) * 0.75);
    vertices.setY(index, vertices.getY(index) + (random() - 0.5) * 0.032);
  }
  const cells = geom.toNonIndexed();
  geom.dispose();
  const color = cells.attributes.position;
  const channel = [];
  const deep = new T.Color(0x297c82);
  const shallows = new T.Color(0x76bca7);
  const tone = new T.Color();
  for (let i = 0; i < color.count; i += 3) {
    const centerX = (color.getX(i) + color.getX(i + 1) + color.getX(i + 2)) / 3;
    const centerZ = (color.getZ(i) + color.getZ(i + 1) + color.getZ(i + 2)) / 3;
    const depth = Math.hypot(Math.max(Math.abs(centerX) - 9, 0), Math.max(-4 - centerZ, centerZ - 8, 0));
    tone.copy(shallows).lerp(deep, Math.min(1, depth / 13)).multiplyScalar(0.93 + random() * 0.13);
    for (let corner = 0; corner < 3; corner++) channel.push(tone.r, tone.g, tone.b);
  }
  cells.setAttribute('color', new T.Float32BufferAttribute(channel, 3));
  parent.add(new T.Mesh(cells, material));

  return uniform;
}

function makeShore(parent: T.Group, kit: GeometryKit) {
  const lowerRim = shore.map(([x, z]) => [x * 1.06, (z - 2.5) * 1.09 + 2.5]);
  earth(parent, kit, 0xb48249, -0.29, lowerRim);
  const edge = [];
  for (let index = 0; index < shore.length; index++) {
    const [x, z] = shore[index];
    const [nx, nz] = shore[(index + 1) % shore.length];
    const [lx, lz] = lowerRim[index];
    const [nlx, nlz] = lowerRim[(index + 1) % shore.length];
    edge.push(x, -0.023, z, lx, -0.29, lz, nx, -0.023, nz, nx, -0.023, nz, lx, -0.29, lz, nlx, -0.29, nlz);
  }
  const bank = new T.BufferGeometry();
  bank.setAttribute('position', new T.Float32BufferAttribute(edge, 3));
  bank.computeVertexNormals();
  kit.mesh(parent, bank, 0xaa7748, 0, 0, 0).material.side = T.DoubleSide;
  earth(parent, kit, 0xe3b575, -0.020, shore);
  earth(parent, kit, 0xf2d097, -0.010, [
    [-9.40, -3.16], [-7.17, -3.32], [-4.14, -3.38], [-1.79, -3.31],
    [1.00, -3.58], [4.00, -3.63], [7.40, -3.21], [9.18, -3.29],
    [9.84, -1.09], [9.44, 4.9], [7.83, 7.92], [5.82, 8.58], [0.46, 8.04],
    [-4.10, 8.58], [-8.77, 7.40], [-9.26, 5.84], [-8.91, 1.83],
  ]);
  earth(parent, kit, 0x9eab68, -0.005, [
    [-9.8, 4.61], [-8.9, 4.91], [-7.4, 5.08], [-6.3, 6.33], [-5.0, 6.37],
    [-3.0, 7.6], [-0.5, 7.45], [2.06, 8.6], [3.8, 8.26], [5.26, 7.12],
    [7.1, 6.42], [8.6, 6.67], [9.84, 5.82], [9.47, 8.88], [-8.66, 8.72], [-9.7, 8.43],
  ]);
  const random = seededDecor(74822);
  for (let index = 0; index < 190; index++) {
    const x = (random() * 2 - 1) * 9.5;
    const z = random() * 11.2 - 3.1;
    const w = random() * 0.055 + 0.022;
    kit.orb(parent, index % 4 === 0 ? 0xd9a96d : 0xe7bc83, x, -0.018, z, w, 0.024, w * 0.6, true).castShadow = false;
  }
}

function plank(parent: T.Object3D, kit: GeometryKit, x: number, y: number, z: number, w: number, d: number, index: number) {
  const colors = [0xc58448, 0xa97146, 0xd09858, 0xbe8451];
  return kit.box(parent, colors[index % colors.length], x, y, z, w, 0.105, d);
}

function palm(parent: T.Object3D, kit: GeometryKit, x: number, z: number, size: number, angle: number) {
  const tree = kit.group(parent, x, -0.12, z);
  tree.scale.setScalar(size);
  tree.rotation.y = angle;

  let bottom = new T.Vector3(0, 0, 0);
  for (let segment = 1; segment <= 6; segment++) {
    const top = new T.Vector3(segment * segment * 0.014, segment * 0.415, 0);
    const width = 0.16 - segment * 0.009;
    const trunk = kit.tube(tree, segment % 2 ? 0x905a43 : 0xb2764a, 0, 0, 0, width, bottom.distanceTo(top) + 0.035);
    trunk.position.copy(bottom).lerp(top, 0.5);
    trunk.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), top.clone().sub(bottom).normalize());
    bottom = top;
  }
  kit.orb(tree, 0x8b5e3d, bottom.x, bottom.y, bottom.z, 0.22, 0.22, 0.23, true);
  for (let leaf = 0; leaf < 7; leaf++) {
    const node = kit.group(tree, bottom.x, bottom.y, bottom.z);
    node.rotation.y = leaf * Math.PI * 2 / 7;
    const tip = 1.15 + (leaf % 3) * 0.29;
    const fan = new T.BufferGeometry();
    fan.setAttribute('position', new T.Float32BufferAttribute([
      0, 0, 0, tip * 0.52, 0.39, 0.33, tip * 0.55, 0.49, 0,
      0, 0, 0, tip * 0.55, 0.49, 0, tip * 0.52, 0.39, -0.33,
      tip * 0.55, 0.49, 0, tip * 0.52, 0.39, 0.33, tip, -0.12, 0,
      tip * 0.55, 0.49, 0, tip, -0.12, 0, tip * 0.52, 0.39, -0.33,
    ], 3));
    fan.computeVertexNormals();
    kit.mesh(node, fan, leaf % 2 ? 0x558754 : 0x658c53, 0, 0, 0).material.side = T.DoubleSide;
  }
}

function makeDock(parent: T.Group, kit: GeometryKit) {
  const landing = kit.group(parent, -0.15, 0, -3.11);
  for (let i = 0; i < 7; i++) plank(landing, kit, -1.47 + i * 0.49, 0.005, 0, 0.455, 1.49, i);
  for (const x of [-1.99, 1.99]) {
    kit.tube(landing, 0x9c6641, x, 0.29, -0.63, 0.12, 0.71);
    kit.tube(landing, 0xe9c586, x, 0.42, -0.63, 0.123, 0.115);
    kit.tube(landing, 0x6e5141, x, 0.281, -0.63, 0.125, 0.033);
  }
  const sign = kit.group(parent, -3.70, 0, -3.21);
  sign.rotation.y = 0.12;
  kit.box(sign, 0x9d693f, 0, 0.42, 0, 0.11, 0.86, 0.15);
  kit.box(sign, 0xb99762, 0, 0.91, 0, 1.93, 0.54, 0.08);
  label(sign, '抛竿区 →', 1.89, 0.48, 0, 0.91, 0.045);

  const pier = kit.group(parent, 8.07, 0, -3.71);
  for (let z = 0; z > -3.02; z -= 0.29) plank(pier, kit, 0.25, 0.015, z, 2.15, 0.265, Math.floor(-z * 4));
  for (const x of [-0.83, 1.31]) {
    for (const z of [-2.63, -0.82]) {
      kit.box(pier, 0x915d40, x, 0.13, z, 0.17, 1.28, 0.19);
      kit.box(pier, 0xe5bf7e, x, 0.61, z, 0.178, 0.15, 0.20);
    }
    kit.box(pier, 0xa27445, x, 0.53, -1.81, 0.10, 0.09, 2.12);
  }

  const crane = kit.group(parent, 7.92, -0.03, -3.90);
  kit.tube(crane, p.darkTeal, 0, 0.22, 0, 0.30, 0.51);
  kit.box(crane, p.orange, 0, 1.33, 0, 0.26, 2.77, 0.25);
  kit.box(crane, p.mustard, -0.54, 2.68, 0, 1.6, 0.16, 0.26);
  kit.beam(crane, p.rust, new T.Vector3(0, 2.18, 0), new T.Vector3(-0.99, 2.68, 0), 0.085);
  kit.tube(crane, p.ink, -1.22, 2.03, 0, 0.018, 1.22);
  kit.tube(crane, p.darkTeal, -1.22, 1.40, 0, 0.12, 0.1);
  const store = kit.group(parent, -7.75, 0, -2.28);
  const awning = kit.group(store, 0, 1.98, 0);
  awning.rotation.x = -0.14;
  for (let index = 0; index < 8; index++) {
    const tint = index % 2 ? 0xf6c572 : 0xaf6647;
    kit.box(awning, tint, -1.16 + index * 0.33, 0, 0, 0.326, 0.09, 1.71);
    kit.box(awning, tint, -1.16 + index * 0.33, -0.07, 0.843, 0.326, 0.13, 0.034);
  }
  for (const x of [-1.19, 1.19]) {
    for (const z of [-0.66, 0.67]) kit.box(store, 0x895d49, x, 0.95, z, 0.124, 1.91, 0.124);
  }
  kit.box(store, 0x81543b, 0, 0.52, -0.48, 2.2, 0.89, 0.394);
  kit.box(store, 0xbe885a, 0, 0.95, -0.47, 2.29, 0.14, 0.53);
  kit.box(store, 0xb67e4a, -0.73, 0.19, 0.40, 0.48, 0.40, 0.46);
  kit.tube(store, 0x487367, 0.74, 0.27, 0.43, 0.239, 0.58);
  kit.tube(store, 0xbba979, 0.74, 0.16, 0.43, 0.246, 0.05);
  kit.tube(store, 0xbba979, 0.74, 0.39, 0.43, 0.246, 0.05);

  palm(parent, kit, -9.03, -0.48, 1.27, 0.7);
  palm(parent, kit, 9.02, -1.08, 1.10, -0.83);
  palm(parent, kit, -8.74, 5.13, 0.96, 1.15);
  palm(parent, kit, 8.66, 6.7, 1.04, 0.45);
}

function makeScale(parent: T.Group, kit: GeometryKit) {
  const station = kit.group(parent, ISLAND.scale.x, ISLAND.groundY, ISLAND.scale.z);
  const corner = kit.group(station, 0, 0, -0.20);
  for (let i = 0; i < 10; i++) plank(corner, kit, 0, 0.017, -1.38 + i * 0.30, 3.45, 0.28, i);
  kit.tube(station, 0x674d37, 0, 0.15, 0, 1.30, 0.29);
  kit.tube(station, 0xc67c37, 0, 0.25, 0, 1.30, 0.24);
  kit.tube(station, p.orange, 0, 0.418, 0, 1.29, 0.115);
  kit.tube(station, p.mustard, 0, 0.479, 0, 1.12, 0.064);
  kit.tube(station, 0xc58a40, 0, 0.52, 0, 0.98, 0.03);
  const hoop = new T.Mesh(new T.TorusGeometry(1.116, 0.066, 4, 32), kit.material(p.cream));
  hoop.rotateX(Math.PI / 2);
  hoop.position.y = 0.529;
  station.add(hoop);
  hoop.receiveShadow = true;
  for (const x of [-0.75, 0.75]) {
    kit.box(station, 0x4b6760, x, 0.705, -1.047, 0.14, 1.32, 0.19);
    kit.box(station, p.orange, x, 1.24, -1.047, 0.19, 0.13, 0.20);
  }
  kit.box(station, p.darkTeal, 0, 1.56, -1.043, 1.86, 0.61, 0.22);
  label(station, '过 秤 处', 1.78, 0.51, 0, 1.56, -0.927);
  const gauge = kit.group(station, 0, 1.0, -0.991);
  kit.tube(gauge, p.ink, 0, 0, 0, 0.29, 0.15).rotateX(Math.PI / 2);
  kit.tube(gauge, p.cream, 0, 0, 0.087, 0.225, 0.032).rotateX(Math.PI / 2);
  for (let mark = -3; mark <= 3; mark++) {
    const angle = mark * 0.32;
    kit.box(gauge, p.ink, Math.sin(angle) * 0.174, Math.cos(angle) * 0.174, 0.107, 0.021, 0.049, 0.018).rotateZ(-angle);
  }
  kit.box(gauge, p.rust, 0.033, 0.04, 0.126, 0.023, 0.143, 0.027).rotateZ(-0.72);
  kit.orb(gauge, p.ink, 0, -0.019, 0.142, 0.042, 0.042, 0.022);
}

function shorelineFoam(parent: T.Object3D) {
  const random = seededDecor(7712);
  const bits: ReturnType<typeof oval>[] = [];
  for (let index = 0; index < 44; index++) {
    const x = index < 27 ? index * 0.79 - 10 : (index % 2 ? -1 : 1) * (10.5 + random() * 0.35);
    const z = index < 27 ? -4.60 - random() * 0.19 : -3.4 + (index - 27) * 0.64;
    const light = oval(parent, index % 5 ? 0xc1e4be : 0xe0e8bb, x, -0.422, z, 0.26 + random() * 0.48, 0.014 + random() * 0.060, 0.57);
    if (index >= 27) light.rotation.z = 1.52;
    bits.push(light);
  }
  for (let i = 0; i < 46; i++) {
    const pass = oval(parent, i % 3 ? 0x95c6a5 : 0xceebc4, (random() - 0.5) * 63, -0.42, -6.4 - random() * 35, 0.31 + random() * 0.62, 0.013 + random() * 0.023, 0.41);
    bits.push(pass);
  }
  return bits;
}

function background(parent: T.Group, kit: GeometryKit) {
  for (const [x, z, scaleValue] of [[-18, -20, 1], [20, -28, 0.92], [-13, -30, 0.51], [16, -44, 1.07], [-35, -31, 1.35]]) {
    const isle = kit.group(parent, x, -0.55, z);
    isle.scale.setScalar(scaleValue);
    kit.rock(isle, 0xb8ab75, 0, -0.29, 0, 5.63, 0.65, 2.95);
    kit.rock(isle, 0x72947c, -0.38, -0.16, -0.49, 4.98, 1.36, 2.34);
    kit.rock(isle, 0x6c927d, 1.26, 0.52, -0.41, 2.95, 2.69, 2.21);
    kit.rock(isle, 0x69907f, -1.9, 0.21, 0.06, 1.82, 1.52, 1.45);
    kit.rock(isle, 0x86a586, 2.73, 0.11, 0.63, 1.96, 1.12, 1.66);
  }
  for (const [x, y, z, s] of [[-12, 3.42, -27, 0.93], [11, 4.3, -37, 1.43], [0, 6.5, -58, 1.06], [-24, 5.4, -37, 1.13], [28, 5.3, -47, 1.26]]) {
    const bank = kit.group(parent, x, y, z);
    bank.scale.setScalar(s);
    kit.rock(bank, 0xf9e8bc, 0, 0, 0, 2.77, 0.38, 0.78);
    kit.rock(bank, 0xffecc3, -0.53, 0.27, 0.04, 1.37, 0.60, 0.74);
    kit.rock(bank, 0xfdeac4, 0.55, 0.15, 0, 1.33, 0.65, 0.57);
  }
}

function mergeStatic(root: T.Group) {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { objects: T.Mesh[]; material: T.MeshStandardMaterial }>();
  root.traverse(object => {
    if (!(object instanceof T.Mesh) || !(object.material instanceof T.MeshStandardMaterial)) return;
    const key = [
      object.material.uuid, Object.keys(object.geometry.attributes).sort().join(','),
      object.castShadow, object.receiveShadow,
    ].join(':');
    if (!groups.has(key)) groups.set(key, { objects: [], material: object.material });
    groups.get(key)?.objects.push(object);
  });
  for (const { objects, material } of groups.values()) {
    const source = objects.map(object => {
      const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      return geometry.applyMatrix4(object.matrixWorld);
    });
    const geometry = mergeGeometries(source);
    for (const copy of source) copy.dispose();
    if (!geometry) continue;
    const baked = new T.Mesh(geometry, material);
    baked.castShadow = objects[0].castShadow;
    baked.receiveShadow = objects[0].receiveShadow;
    for (const object of objects) object.removeFromParent();
    root.add(baked);
  }
}

export function makeIsland(parent: T.Scene, kit: GeometryKit) {
  const landscape = kit.group(parent);
  const seaTime = water(parent);
  background(landscape, kit);
  makeShore(landscape, kit);
  makeDock(landscape, kit);
  makeScale(landscape, kit);
  const random = seededDecor(275);
  for (let i = 0; i < 27; i++) {
    const x = i % 2 ? 8.60 + random() * 1.1 : -8.72 - random() * 1.05;
    const z = random() * 11 - 4.0;
    const w = 0.10 + random() * 0.28;
    kit.rock(landscape, i % 3 ? 0xa48a60 : 0xb99a6f, x, 0.03, z, w * 1.3, w * 0.83, w);
  }
  const boss = makeBoss(parent, kit);
  const foam = shorelineFoam(parent);
  const bossRipples = [ring(parent, 0xbbe3b7, 0.7, -0.417, -18, 3.81, 2.16, 0.016, 0.68), ring(parent, 0xa5d5b5, 0.7, -0.419, -18, 5.21, 3.03, 0.012, 0.45)];
  const ripples = FISHING.goodSpots.map(({ x, z }, index) => {
    const surface = ISLAND.seaY + 0.10;
    ring(parent, 0xffe8a5, x, surface, z, 0.67, 0.57, 0.068, 0.7);
    return { ring: ring(parent, 0xffefbe, x, surface + 0.004, z, 0.78, 0.65, 0.05, 0), phase: index * 0.45 };
  });
  mergeStatic(landscape);

  function animate(seconds: number, emotion: FishEmotion, speaking: boolean) {
    seaTime.value = seconds;
    boss.fish.position.y = 0.29 + Math.sin(seconds * 1.1) * 0.13;
    boss.fish.rotation.z = Math.sin(seconds * 0.72) * 0.023;
    boss.express(emotion, seconds, speaking);
    for (const [index, bits] of foam.entries()) {
      bits.material.opacity = 0.23 + Math.sin(seconds * 1.20 + index * 0.57) * 0.13 + 0.17;
    }
    bossRipples.forEach((spot, index) => {
      spot.material.opacity = 0.58 + Math.sin(seconds * 1.13 - index * 1.0) * 0.23 - index * 0.18;
    });
    for (const spot of ripples) {
      const pulse = ((seconds * 0.58 + spot.phase) % 1);
      spot.ring.scale.x = 0.78 + pulse * 0.50;
      spot.ring.scale.y = 0.65 + pulse * 0.40;
      spot.ring.material.opacity = (1 - pulse) * 0.60;
    }
  }

  return { animate, bossSpeechAnchor: boss.speechAnchor };
}
