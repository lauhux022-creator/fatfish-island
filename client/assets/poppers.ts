import * as T from 'three';
import { POPPER, type PopperView } from '../../shared/sim/popper';
import type { Vec3 } from '../../shared/sim/types';
import type { GeometryKit } from './geometry';

const splashSeconds = 0.60;
const dialSteps = 32;

function flat(parent: T.Object3D, geometry: T.BufferGeometry, color: number, y: number) {
  const face = new T.Mesh(geometry, new T.MeshBasicMaterial({
    color, transparent: true, depthWrite: false, toneMapped: false,
  }));
  face.rotation.x = -Math.PI / 2;
  face.position.y = y;
  parent.add(face);
  return face;
}

function makeBucket(parent: T.Object3D, kit: GeometryKit) {
  const bucket = kit.group(parent);
  kit.tube(bucket, 0x266656, 0, 0.09, 0, 0.31, 0.16);
  kit.tube(bucket, 0x4bada0, 0, 0.28, 0, 0.32, 0.39);
  kit.tube(bucket, 0xf2c270, 0, 0.43, 0, 0.349, 0.085);
  for (const x of [-0.30, 0.30]) {
    kit.box(bucket, 0x2e766c, x, 0.27, 0, 0.12, 0.13, 0.19);
    kit.box(bucket, 0xf5d58c, x, 0.28, 0.02, 0.15, 0.043, 0.20);
  }
  const badge = kit.group(bucket, 0, 0.27, 0.319);
  kit.orb(badge, 0xffe3a0, 0, 0, 0, 0.14, 0.096, 0.039);
  kit.orb(badge, 0xffe3a0, -0.12, 0, 0.011, 0.085, 0.069, 0.02, true);
  kit.orb(badge, 0x1f514c, 0.064, 0.021, 0.037, 0.027, 0.025, 0.011);
  const lid = kit.group(bucket, 0, 0.53, 0);
  kit.tube(lid, 0xffd579, 0, 0, 0, 0.358, 0.10);
  kit.tube(lid, 0xea9560, 0, 0.051, 0, 0.289, 0.049);
  kit.orb(lid, 0xe9f5c3, 0, 0.095, 0, 0.14, 0.064, 0.13, true);
  return { bucket, lid };
}

function makePopper(parent: T.Scene, kit: GeometryKit) {
  const root = kit.group(parent);
  const { bucket, lid } = makeBucket(root, kit);
  const perimeter = flat(root, new T.RingGeometry(0.970, 1, 56), 0xf2805a, 0.045);
  const shade = flat(root, new T.CircleGeometry(0.970, 56), 0xf4a45f, 0.044);
  const dial = flat(root, new T.RingGeometry(0.52, 0.61, dialSteps, 1, Math.PI / 2), 0xffeb9c, 0.051);
  const wave = flat(root, new T.RingGeometry(0.90, 1, 40), 0xb7fff2, 0.068);
  const splashes = Array.from({ length: 14 }, (_, index) => {
    const palette = [0xe4fff0, 0x6de5d8, 0x92dddc, 0xffe59b];
    const drop = kit.orb(root, palette[index % palette.length], 0, 0, 0, 0.10, 0.22, 0.09, true);
    drop.castShadow = false;
    return drop;
  });
  let burstAt: number | undefined;
  let radius: number = POPPER.radius;

  function setRadius(nextRadius: number) {
    radius = nextRadius;
    perimeter.scale.setScalar(radius);
    shade.scale.setScalar(radius);
  }

  function burst(seconds: number) {
    if (burstAt === undefined) return false;
    const age = (seconds - burstAt) / splashSeconds;
    if (age >= 1) return false;
    bucket.visible = false;
    dial.visible = false;
    wave.visible = true;
    perimeter.visible = false;
    wave.scale.setScalar(radius * (0.24 + age * 0.91));
    wave.material.opacity = 0.93 * (1 - age);
    shade.material.color.setHex(0x83e1ce);
    shade.material.opacity = 0.23 * (1 - age);
    for (const [index, drop] of splashes.entries()) {
      const angle = index * (Math.PI * 2 / splashes.length) + 0.18;
      const travel = radius * (0.12 + age * (0.52 + (index % 3) * 0.13));
      const jump = Math.sin(age * Math.PI) * (0.98 + (index % 5) * 0.24);
      const size = (1 - age * 0.85) * (0.87 + (index % 3) * 0.12);
      drop.visible = true;
      drop.position.set(Math.cos(angle) * travel, 0.10 + jump, Math.sin(angle) * travel);
      drop.rotation.set(age * 3.85, angle, Math.cos(angle) * (0.48 + age));
      drop.scale.set(0.12 * size, 0.26 * size, 0.105 * size);
    }
    return true;
  }

  return {
    sync(view: PopperView, seconds: number) {
      root.position.set(view.position.x, view.position.y, view.position.z);
      setRadius(view.radius);
      if (view.phase === 'burst') {
        burstAt ??= seconds - Math.max(0, POPPER.burstSeconds - view.remaining);
        burst(seconds);
        return;
      }
      burstAt = undefined;
      const left = T.MathUtils.clamp(view.remaining / POPPER.fuseSeconds, 0, 1);
      const spring = Math.sin((1 - left) * 32);
      bucket.visible = true;
      lid.position.y = 0.53 + spring * 0.055 * (1 - left);
      lid.rotation.z = spring * 0.17 * (1 - left);
      perimeter.visible = true;
      perimeter.material.opacity = 0.64 + (1 - left) * 0.33;
      shade.material.color.setHex(0xf4a45f);
      shade.material.opacity = 0.12 + (1 - left) * 0.16;
      dial.visible = true;
      dial.geometry.setDrawRange(0, Math.ceil(dialSteps * left) * 6);
      wave.visible = false;
      for (const drop of splashes) drop.visible = false;
    },
    burst,
    dispose() {
      root.removeFromParent();
      for (const face of [perimeter, shade, dial, wave]) {
        face.geometry.dispose();
        face.material.dispose();
      }
    },
  };
}

export function makePopperArt(parent: T.Scene, kit: GeometryKit) {
  const effects = new Map<string, ReturnType<typeof makePopper>>();
  return {
    animate(views: readonly PopperView[], seconds: number) {
      const active = new Set<string>();
      for (const view of views) {
        active.add(view.id);
        let model = effects.get(view.id);
        if (!model) {
          model = makePopper(parent, kit);
          effects.set(view.id, model);
        }
        model.sync(view, seconds);
      }
      for (const [id, model] of effects) {
        if (active.has(id) || model.burst(seconds)) continue;
        model.dispose();
        effects.delete(id);
      }
    },
    dispose() {
      for (const model of effects.values()) model.dispose();
      effects.clear();
    },
  };
}

export function makeAirCatchMark(parent: T.Scene, kit: GeometryKit) {
  const root = kit.group(parent);
  const mark = kit.orb(root, 0x5ce5a1, 0, 0, 0, 0.14, 0.21, 0.14, true);
  mark.castShadow = false;
  const highlight = kit.orb(root, 0xfff3a6, 0, 0.06, 0, 0.081, 0.107, 0.081, true);
  highlight.castShadow = false;
  return {
    animate(active: boolean, point: Vec3, seconds: number) {
      root.visible = active;
      if (!active) return;
      root.position.set(point.x, point.y + 0.56 + Math.sin(seconds * 18) * 0.07, point.z);
      root.rotation.y = seconds * 4.8;
      root.scale.setScalar(1 + Math.sin(seconds * 14) * 0.12);
    },
    dispose() { root.removeFromParent(); },
  };
}
