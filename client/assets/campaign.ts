import * as T from 'three';
import type { CampaignView, EnemyView, StructureView, WarehouseView } from '../../shared/sim/campaign-types';
import { ISLAND } from '../../shared/sim/config';
import type { Vec3 } from '../../shared/sim/types';
import { makeActor, type ActorAssets } from './actors';
import { label, palette as p, type GeometryKit } from './geometry';

const vec = (x: number, y: number, z: number) => new T.Vector3(x, y, z);

function setPosition(object: T.Object3D, position: Vec3) {
  object.position.set(position.x, position.y, position.z);
}

function warehouse(parent: T.Object3D, kit: GeometryKit) {
  const dock = kit.group(parent);
  const pad = kit.tube(dock, 0x71654f, 0, 0.014, 0, 1.37, 0.075);
  pad.castShadow = false;
  for (let index = 0; index < 8; index++) {
    const x = (index - 3.5) * 0.298;
    kit.box(dock, index % 2 ? 0xb98357 : 0xcc995f, x, 0.059, 0, 0.279, 0.095, 2 * Math.sqrt(1.37 ** 2 - x * x));
  }
  // The short timber rack marks the stockpile and leaves the play area visible.
  for (const side of [-1, 1]) {
    for (const z of [-0.37, 0.79]) {
      kit.box(dock, 0x78513d, side * 1.065, 0.39, z, 0.13, 0.74, 0.15);
      kit.box(dock, p.cream, side * 1.065, 0.64, z, 0.14, 0.09, 0.16);
    }
    kit.box(dock, 0xae774c, side * 1.065, 0.52, 0.21, 0.13, 0.112, 1.30);
    kit.box(dock, 0xae774c, side * 1.065, 0.29, 0.21, 0.13, 0.10, 1.30);
  }
  kit.box(dock, 0x875b46, 0, 0.31, 0.79, 2.21, 0.38, 0.13);
  kit.box(dock, 0xb48556, 0, 0.53, 0.79, 2.21, 0.102, 0.19);
  label(dock, '鱼 仓', 1.18, 0.36, 0, 0.34, 0.86);
  const lanterns = [-1.06, 1.06].map(x => {
    kit.box(dock, 0x425351, x, 0.77, 0.79, 0.24, 0.095, 0.24);
    const shell = kit.box(dock, 0xffbf67, x, 0.93, 0.79, 0.16, 0.24, 0.16);
    kit.box(dock, 0x425351, x, 1.08, 0.79, 0.22, 0.081, 0.22);
    kit.box(dock, 0x425351, x, 1.155, 0.79, 0.049, 0.091, 0.049);
    const material = new T.MeshBasicMaterial({ color: 0xffc573 });
    const light = new T.Mesh(shell.geometry, material);
    light.position.copy(shell.position);
    light.scale.copy(shell.scale);
    shell.removeFromParent();
    dock.add(light);
    return light;
  });
  const crates = Array.from({ length: 6 }, (_, index) => {
    const crate = kit.group(dock, ((index % 3) - 1) * 0.65, 0.12 + (index >= 3 ? 0.36 : 0), index >= 3 ? 0.11 : 0.17);
    crate.rotation.y = [-0.08, 0.04, 0.09][index % 3];
    kit.box(crate, 0xab7147, 0, 0.16, 0, 0.57, 0.33, 0.53);
    kit.box(crate, 0xd89855, 0, 0.28, 0, 0.59, 0.091, 0.56);
    for (const x of [-0.215, 0.215]) {
      kit.box(crate, p.cream, x, 0.16, 0, 0.042, 0.35, 0.561);
    }
    kit.box(crate, 0x397663, 0, 0.17, 0.273, 0.16, 0.095, 0.018);
    return crate;
  });
  const glow = new T.PointLight(0xffb565, 0, 6.0, 2.6);
  glow.position.set(0, 1.42, 0.55);
  dock.add(glow);
  let previousLost = 0;
  let lastLoss = -10;

  return (view: WarehouseView, seconds: number, night: number) => {
    setPosition(dock, view.position);
    if (view.lostFish > previousLost) lastLoss = seconds;
    previousLost = view.lostFish;
    const warning = Math.max(0, 1 - (seconds - lastLoss) / 1.2);
    glow.intensity = night * 16 + warning * 10;
    glow.color.setHex(warning > 0 ? 0xff6956 : 0xffb565);
    for (const lamp of lanterns) lamp.material.color.setHex(warning > 0 ? 0xff674e : 0xffc573);
    for (const [index, crate] of crates.entries()) crate.visible = view.stock > index;
  };
}

function makeFence(root: T.Group, kit: GeometryKit) {
  for (const x of [-0.61, 0, 0.61]) {
    kit.rock(root, 0xc1ac92, x, 0.072, 0.01, 0.25, 0.13, 0.218);
    kit.box(root, 0x9b6746, x, 0.45, 0, 0.15, 0.91, 0.22).rotation.z = x * 0.17;
    kit.box(root, p.cream, x * 0.98, 0.74, 0.002, 0.162, 0.12, 0.236).rotation.z = x * 0.17;
  }
  kit.box(root, 0xb58262, 0, 0.62, 0.09, 1.72, 0.17, 0.11).rotation.z = -0.047;
  kit.box(root, 0x9d7051, 0, 0.36, -0.085, 1.68, 0.14, 0.111).rotation.z = 0.055;
  kit.beam(root, 0xcd9874, vec(-0.70, 0.20, 0.01), vec(0.72, 0.82, 0.01), 0.13);
}

function makeTrap(root: T.Group, kit: GeometryKit) {
  kit.tube(root, 0x46556c, 0, 0.065, 0, 0.66, 0.14);
  kit.tube(root, 0x79959f, 0, 0.147, 0, 0.37, 0.11);
  kit.tube(root, 0xf6c87a, 0, 0.207, 0, 0.24, 0.064);
  for (const side of [-1, 1]) {
    kit.box(root, 0x95a4a9, side * 0.38, 0.162, 0, 0.12, 0.10, 0.95);
    for (const z of [-0.35, -0.12, 0.12, 0.35]) {
      kit.orb(root, 0xe0ebdf, side * 0.47, 0.22, z, 0.095, 0.18, 0.088, true).rotation.z = side * 0.58;
    }
    kit.tube(root, 0xad7852, 0, 0.174, side * 0.51, 0.135, 0.46).rotateZ(Math.PI / 2);
  }
}

function makeLure(root: T.Group, kit: GeometryKit) {
  kit.tube(root, 0x684f78, 0, 0.081, 0, 0.44, 0.15);
  kit.box(root, 0xa17a60, -0.21, 0.51, 0, 0.14, 1.06, 0.13).rotation.z = -0.19;
  kit.beam(root, 0xc89460, vec(-0.31, 0.96, 0), vec(0.37, 0.88, 0), 0.099);
  kit.box(root, p.cream, 0.29, 0.70, 0, 0.025, 0.37, 0.025);
  const bait = kit.group(root, 0.29, 0.50, 0);
  kit.orb(bait, 0xfbb273, 0, 0, 0, 0.24, 0.126, 0.079, true);
  kit.orb(bait, 0xf7d39b, 0.21, 0, 0, 0.16, 0.118, 0.035, true).rotation.z = 0.08;
  kit.orb(bait, p.ink, -0.13, 0.04, 0.068, 0.034, 0.031, 0.016);
  kit.orb(bait, p.ink, -0.13, 0.04, -0.068, 0.034, 0.031, 0.016);
  return bait;
}

function makeStructure(parent: T.Object3D, kit: GeometryKit, view: StructureView) {
  const root = kit.group(parent);
  if (view.kind === 'fence') makeFence(root, kit);
  if (view.kind === 'trap') makeTrap(root, kit);
  const bait = view.kind === 'lure' ? makeLure(root, kit) : null;
  return {
    root,
    animate(state: StructureView, seconds: number) {
      setPosition(root, state.position);
      root.rotation.y = state.yaw;
      root.rotation.z = (1 - state.hp / state.maxHp) * 0.16;
      if (bait) {
        bait.rotation.x = Math.sin(seconds * 6) * 0.22;
        bait.rotation.y = Math.sin(seconds * 2.9) * 0.37;
      }
    },
  };
}

function makeRaider(root: T.Group, kit: GeometryKit) {
  const body = kit.group(root);
  kit.rock(body, 0x287f6c, 0, 0.47, 0.04, 0.49, 0.42, 0.42);
  kit.orb(body, 0x7acaa0, 0, 0.325, -0.255, 0.35, 0.24, 0.24, true);
  kit.rock(body, 0x37a886, 0, 0.77, -0.13, 0.43, 0.30, 0.36);
  kit.orb(body, 0x1c4e58, 0, 0.665, -0.399, 0.23, 0.045, 0.069);
  for (const side of [-1, 1]) {
    kit.rock(body, 0x956ba8, side * 0.35, 0.76, 0.08, 0.26, 0.158, 0.15).rotation.z = side * 0.47;
    kit.orb(body, 0xffe5a1, side * 0.18, 0.89, -0.373, 0.125, 0.13, 0.105, true);
    kit.orb(body, 0x1b3842, side * 0.18, 0.884, -0.465, 0.044, 0.059, 0.03);
    kit.orb(body, 0xffeac5, side * 0.13, 0.64, -0.46, 0.043, 0.068, 0.02, true);
  }
  kit.orb(body, 0x679ad0, 0, 0.93, 0.12, 0.10, 0.29, 0.19, true).rotation.x = -0.39;
  kit.orb(body, 0x6597c1, 0, 0.28, 0.44, 0.14, 0.10, 0.27, true).rotation.x = -0.42;
  const feet = [-1, 1].map(side => {
    const leg = kit.group(body, side * 0.23, 0.20, -0.01);
    kit.orb(leg, 0x52947b, 0, -0.126, -0.13, 0.17, 0.093, 0.26, true);
    return leg;
  });
  const arms = [-1, 1].map(side => {
    const arm = kit.group(body, side * 0.39, 0.52, -0.04);
    kit.rock(arm, 0x70a989, side * 0.13, -0.07, -0.09, 0.247, 0.103, 0.122);
    kit.orb(arm, 0x9cc6a2, side * 0.23, -0.07, -0.17, 0.124, 0.08, 0.137, true);
    return arm;
  });
  return (view: EnemyView, tick: number) => {
    const stride = Math.sin(tick * 18);
    body.position.y = Math.abs(stride) * 0.114;
    body.rotation.z = stride * 0.13;
    for (const [index, leg] of feet.entries()) leg.rotation.x = stride * (index === 0 ? 0.61 : -0.61);
    for (const [index, arm] of arms.entries()) {
      const reach = view.state === 'windup' ? 0.7 : 0.25;
      arm.rotation.x = reach + stride * (index === 0 ? 0.3 : -0.3);
    }
  };
}

function makeCrab(root: T.Group, kit: GeometryKit) {
  const shell = kit.group(root);
  kit.rock(shell, 0xb64e44, 0, 0.87, 0, 1.37, 0.65, 0.99);
  kit.rock(shell, 0xe78754, 0, 1.12, 0.10, 1.18, 0.60, 0.87);
  kit.rock(shell, 0xf6bd70, 0.07, 1.51, 0.13, 0.77, 0.20, 0.45).rotation.y = -0.23;
  kit.orb(shell, 0xf2af67, 0, 0.69, -0.59, 0.92, 0.31, 0.47, true);
  kit.orb(shell, 0x6a333c, 0, 0.65, -1.014, 0.38, 0.056, 0.032).rotation.z = 0.1;
  for (const side of [-1, 1]) {
    kit.orb(shell, 0x985748, side * 0.9, 1.39, 0.26, 0.16, 0.065, 0.15, true);
    kit.orb(shell, 0xa55743, side * 0.68, 1.54, 0.42, 0.13, 0.062, 0.115, true);
    kit.beam(shell, 0xd76c4c, vec(side * 0.36, 1.08, -0.77), vec(side * 0.51, 1.72, -0.79), 0.15);
    kit.orb(shell, 0xffe4a5, side * 0.52, 1.75, -0.84, 0.23, 0.22, 0.21, true);
    kit.orb(shell, 0x452a39, side * 0.52, 1.75, -1.02, 0.113, 0.123, 0.068);
    kit.orb(shell, 0xfff0cc, side * 0.56, 1.81, -1.07, 0.041, 0.041, 0.025);
  }
  const legs: T.Group[] = [];
  const claws: { arm: T.Group; jaw: T.Group }[] = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < 4; index++) {
      const z = -0.54 + index * 0.39;
      const stretch = 1 - Math.abs(index - 1.5) * 0.15;
      const leg = kit.group(root, 0.93 * side, 0.52, z);
      const elbow = vec(0.65 * side * stretch, 0.25, 0.11 + index * 0.08);
      const tip = vec(1.18 * side * stretch, -0.49, 0.13 + index * 0.14);
      kit.beam(leg, 0xb86953, vec(0, 0, 0), elbow, 0.20);
      kit.orb(leg, 0xf39c66, elbow.x, elbow.y, elbow.z, 0.152, 0.155, 0.151, true);
      kit.beam(leg, 0xa45145, elbow, tip, 0.17, 0.15);
      legs.push(leg);
    }
    const arm = kit.group(root, side * 0.95, 0.68, -0.57);
    kit.rock(arm, 0xd16b4b, side * 0.32, 0.18, -0.26, 0.41, 0.22, 0.38);
    const claw = kit.group(arm, side * 0.62, 0.31, -0.58);
    claw.scale.set(side < 0 ? 0.87 : 1.09, 1, 1);
    kit.rock(claw, 0xe47250, 0, 0.04, -0.135, 0.55, 0.34, 0.49);
    kit.orb(claw, 0xffa65f, 0.065 * side, 0.20, -0.18, 0.405, 0.172, 0.36, true);
    kit.rock(claw, 0xef8f57, 0.36 * side, 0.02, -0.54, 0.26, 0.26, 0.49).rotation.y = 0.095 * side;
    kit.orb(claw, 0xffc779, 0.24 * side, 0.028, -0.83, 0.23, 0.162, 0.26, true).rotation.y = -0.49 * side;
    const jaw = kit.group(claw, -0.21 * side, 0.02, -0.35);
    kit.rock(jaw, 0xc2544a, -0.18 * side, -0.048, -0.22, 0.235, 0.20, 0.39).rotation.y = -0.11 * side;
    kit.orb(jaw, 0xfaad69, -0.085 * side, -0.04, -0.48, 0.184, 0.142, 0.21, true).rotation.y = 0.48 * side;
    claws.push({ arm, jaw });
  }
  return (view: EnemyView, seconds: number) => {
    const windup = view.state === 'windup';
    const advancing = view.state === 'advance';
    const stride = advancing ? Math.sin(seconds * 12) : 0;
    shell.position.y = windup ? 0.11 + Math.sin(seconds * 22) * 0.035 : Math.abs(stride) * 0.13;
    shell.rotation.z = stride * 0.035;
    for (const [index, leg] of legs.entries()) {
      leg.rotation.y = advancing ? Math.sin(seconds * 12 + index * 1.18) * 0.27 : 0;
      leg.rotation.x = advancing ? Math.sin(seconds * 12 + index * 1.18) * 0.16 : 0.11;
    }
    for (const [index, { arm, jaw }] of claws.entries()) {
      const side = index === 0 ? -1 : 1;
      arm.rotation.x = windup ? 0.73 + Math.sin(seconds * 22) * 0.09 : advancing ? stride * 0.13 : -0.36;
      arm.rotation.z = side * (windup ? 0.29 : 0.09);
      jaw.rotation.y = side * (windup ? 0.65 : advancing ? 0.16 + stride * 0.10 : 0);
    }
  };
}

function makeEnemy(parent: T.Object3D, kit: GeometryKit, assets: ActorAssets, view: EnemyView) {
  const group = kit.group(parent);
  const root = kit.group(group);
  const crab = view.kind === 'crab';
  const scale = crab ? 1.1 : 1;
  root.scale.setScalar(scale);
  const fallback = kit.group(root);
  const motion = crab ? makeCrab(fallback, kit) : makeRaider(fallback, kit);
  const rig = crab ? kit.group(root) : null;
  const model = rig && makeActor(rig, assets, 2.30, Math.PI);
  model?.use('crab');
  const bar = kit.group(group, 0, (crab ? 3.04 : 1.22) * scale, 0);
  const w = crab ? 2.45 : 0.72;
  kit.box(bar, 0x36464b, 0, 0, 0, w + 0.08, crab ? 0.17 : 0.104, 0.02).castShadow = false;
  const fill = kit.box(bar, crab ? 0xfaa961 : 0xd7e090, 0, 0, 0.02, w, crab ? 0.105 : 0.062, 0.025);
  fill.castShadow = false;
  const phase = Math.abs(view.id.charCodeAt(view.id.length - 1)) * 0.19;
  return {
    group,
    disposeModel() { model?.dispose(); },
    get hasModel() { return model?.ready ?? false; },
    animate(state: EnemyView, seconds: number, camera: T.Camera) {
      setPosition(group, state.position);
      root.rotation.y = state.yaw;
      bar.visible = crab || state.hp < state.maxHp;
      bar.quaternion.copy(camera.quaternion);
      const health = Math.max(0, state.hp / state.maxHp);
      fill.scale.x = w * health;
      fill.position.x = (fill.scale.x - w) / 2;
      fallback.visible = !model?.ready;
      if (fallback.visible) motion(state, seconds + phase);
      if (rig && model?.ready) {
        const windup = state.state === 'windup';
        const advancing = state.state === 'advance';
        const stride = advancing ? Math.sin(seconds * 13) : 0;
        rig.position.y = windup ? 0.19 + Math.sin(seconds * 24) * 0.051 : Math.abs(stride) * 0.10;
        rig.rotation.x = windup ? 0.24 + Math.sin(seconds * 24) * 0.035 : advancing ? -0.04 : -0.12;
        rig.rotation.z = stride * 0.057;
      }
    },
  };
}

export function makeCampaignArt(parent: T.Scene, kit: GeometryKit, assets: ActorAssets) {
  const updateWarehouse = warehouse(parent, kit);
  const enemies = new Map<string, ReturnType<typeof makeEnemy>>();
  const structures = new Map<string, ReturnType<typeof makeStructure>>();
  let crabModel: 'none' | 'procedural' | 'crab' = 'none';
  const tell = kit.group(parent);
  tell.visible = false;
  const ring = new T.Mesh(
    new T.RingGeometry(0.952, 1, 56),
    new T.MeshBasicMaterial({ color: 0xff6650, transparent: true, depthWrite: false, toneMapped: false }),
  );
  const area = new T.Mesh(
    new T.CircleGeometry(0.952, 56),
    new T.MeshBasicMaterial({ color: 0xff543c, transparent: true, depthWrite: false, toneMapped: false }),
  );
  ring.rotateX(-Math.PI / 2);
  area.rotateX(-Math.PI / 2);
  area.renderOrder = 2;
  ring.renderOrder = 3;
  tell.add(ring, area);
  function animate(view: CampaignView, seconds: number, night: number, camera: T.Camera) {
    updateWarehouse(view.warehouse, seconds, night);
    const liveEnemies = new Set<string>();
    tell.visible = false;
    crabModel = 'none';
    for (const enemy of view.enemies) {
      liveEnemies.add(enemy.id);
      let art = enemies.get(enemy.id);
      if (!art) {
        art = makeEnemy(parent, kit, assets, enemy);
        enemies.set(enemy.id, art);
      }
      art.animate(enemy, seconds, camera);
      if (enemy.kind === 'crab') crabModel = art.hasModel ? 'crab' : 'procedural';
      if (enemy.kind === 'crab' && enemy.attack && enemy.state === 'windup') {
        const { position, radius } = enemy.attack;
        tell.position.set(position.x, ISLAND.groundY + 0.028, position.z);
        tell.scale.setScalar(radius);
        tell.visible = true;
        ring.material.opacity = 0.88 + Math.sin(seconds * 21) * 0.12;
        area.material.opacity = 0.21 + Math.sin(seconds * 21) * 0.085;
      }
    }
    for (const [id, enemy] of enemies) {
      if (liveEnemies.has(id)) continue;
      enemy.disposeModel();
      enemy.group.removeFromParent();
      enemies.delete(id);
    }
    const liveStructures = new Set<string>();
    for (const structure of view.structures) {
      liveStructures.add(structure.id);
      let art = structures.get(structure.id);
      if (!art) {
        art = makeStructure(parent, kit, structure);
        structures.set(structure.id, art);
      }
      art.animate(structure, seconds);
    }
    for (const [id, structure] of structures) {
      if (liveStructures.has(id)) continue;
      structure.root.removeFromParent();
      structures.delete(id);
    }
  }
  return {
    animate,
    get crabModel() { return crabModel; },
    dispose() {
      for (const enemy of enemies.values()) enemy.disposeModel();
    },
  };
}

export function makeGhost(parent: T.Object3D, kit: GeometryKit, accent: string) {
  const root = kit.group(parent);
  root.visible = false;
  const body = kit.group(root);
  const upper = kit.rock(body, 0xb2fff1, 0, 0.38, 0, 0.4, 0.45, 0.36);
  const lower = kit.orb(body, 0xb2fff1, 0.08, 0.05, -0.005, 0.27, 0.34, 0.25, true);
  lower.rotation.z = 0.37;
  const spectral = new T.MeshStandardMaterial({
    color: 0x9cead7, emissive: 0x3fffd5, emissiveIntensity: 0.26,
    opacity: 0.72, transparent: true, depthWrite: false, flatShading: true,
  });
  for (const mesh of [upper, lower]) {
    mesh.material = spectral;
    mesh.castShadow = false;
    mesh.renderOrder = 4;
  }
  kit.orb(body, accent, 0, 0.690, 0.006, 0.45, 0.076, 0.39).castShadow = false;
  kit.orb(body, accent, 0, 0.768, 0.035, 0.26, 0.16, 0.251, true).castShadow = false;
  const pupils = new T.MeshStandardMaterial({ color: 0x214853, transparent: true, depthWrite: false });
  // The ghost floats facing the camera so its expression stays readable as it drifts.
  for (const x of [-0.112, 0.112]) {
    const eye = kit.orb(body, p.ink, x, 0.44, 0.318, 0.055, 0.075, 0.035);
    eye.material = pupils;
    eye.castShadow = false;
    eye.renderOrder = 5;
  }
  const aura = new T.Mesh(
    new T.RingGeometry(0.42, 0.51, 28),
    new T.MeshBasicMaterial({ color: 0x61ffe5, transparent: true, depthWrite: false }),
  );
  aura.rotation.x = -Math.PI / 2;
  aura.renderOrder = 3;
  parent.add(aura);
  aura.visible = false;
  return {
    animate(visible: boolean, position: Vec3, seconds: number) {
      root.visible = visible;
      aura.visible = visible;
      if (!visible) return;
      root.position.set(position.x, position.y - 0.17, position.z);
      body.position.y = Math.sin(seconds * 5.6) * 0.135;
      body.rotation.z = Math.sin(seconds * 3.8) * 0.16;
      aura.position.set(position.x, ISLAND.groundY + 0.042, position.z);
      aura.scale.setScalar(1.02 + Math.sin(seconds * 5.6) * 0.16);
      aura.material.opacity = 0.72 + Math.sin(seconds * 5.6) * 0.13;
    },
  };
}
