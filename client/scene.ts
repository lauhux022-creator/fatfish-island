import * as T from 'three';
import { ISLAND, PLAY } from '../shared/sim/config';
import type { FishState, Pose, SimSnapshot, Vec3 } from '../shared/sim/types';
import { makeGeometryKit, palette as p } from './assets/geometry';
import { createModels } from './assets/models';
import { makeIsland } from './assets/world';

function isWater(x: number, z: number) {
  return z < ISLAND.shoreZ || z > ISLAND.backZ || x < ISLAND.minX || x > ISLAND.maxX;
}

function pose(object: T.Object3D, value: Pose) {
  const { position, rotation } = value;
  object.position.set(position.x, position.y, position.z);
  object.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
}

export function createScene(canvas: HTMLCanvasElement) {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.43;

  const world = new T.Scene();
  world.background = new T.Color(0xa5c5ac);
  world.fog = new T.Fog(0xa8c6ad, 24, 77);
  const dome = new T.HemisphereLight(0xffe7b4, 0x6b8668, 2.24);
  world.add(dome);
  const key = new T.DirectionalLight(0xffdfaa, 2.45);
  key.position.set(-8, 17, -5);
  key.target.position.set(0.5, 0, 0.8);
  key.castShadow = true;
  key.shadow.mapSize.set(1536, 1536);
  key.shadow.camera.left = -14;
  key.shadow.camera.right = 14;
  key.shadow.camera.top = 14;
  key.shadow.camera.bottom = -14;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 38;
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.025;
  world.add(key, key.target);
  const fill = new T.DirectionalLight(0xcaf0d9, 0.48);
  fill.position.set(6, 9, 12);
  world.add(fill);

  const camera = new T.PerspectiveCamera(50, 1, 0.15, 120);
  const focal = new T.Vector3();
  const tracking = new T.Vector3();
  const projection = new T.Vector3();
  const ray = new T.Raycaster();
  const ground = new T.Plane(new T.Vector3(0, 1, 0), -ISLAND.groundY);
  const water = new T.Plane(new T.Vector3(0, 1, 0), -ISLAND.seaY - 0.04);
  const aimHit = new T.Vector3();
  const cursor = new T.Vector2();
  const rodTip = new T.Vector3();
  let width = 0;
  let height = 0;
  let previous = -1;
  let walk = 0;
  let aimPoint: { x: number; z: number } | null = null;

  const kit = makeGeometryKit();
  const models = createModels(kit);
  const animateIsland = makeIsland(world, kit);
  const player = models.worker(world);
  const fish = new Map<string, ReturnType<typeof models.fish> & { state: FishState }>();
  const crates = new Map<string, ReturnType<typeof models.crate>>();
  const scalePosition = new T.Vector3(ISLAND.scale.x, ISLAND.groundY + 0.56, ISLAND.scale.z);
  const track = new T.RingGeometry(0.94, 1, 44);
  const saleRing = new T.Mesh(track, new T.MeshBasicMaterial({ color: 0xffec9c, transparent: true, opacity: 0, depthWrite: false }));
  saleRing.rotation.x = -Math.PI / 2;
  saleRing.position.copy(scalePosition);
  saleRing.visible = false;
  world.add(saleRing);
  let soldPrevious = 0;
  let soldAt = -10;

  const lineGeometry = new T.BufferGeometry();
  const lineArray = new Float32Array(15);
  const linePoints = new T.BufferAttribute(lineArray, 3).setUsage(T.DynamicDrawUsage);
  lineGeometry.setAttribute('position', linePoints);
  const line = new T.Line(lineGeometry, new T.LineBasicMaterial({ color: 0xffeea8, transparent: true, opacity: 0.88 }));
  line.frustumCulled = false;
  world.add(line);
  const bobber = kit.group(world);
  kit.orb(bobber, 0xffe5a1, 0, -0.006, 0, 0.13, 0.12, 0.13);
  kit.orb(bobber, 0xe66844, 0, 0.042, 0, 0.115, 0.085, 0.115);
  kit.box(bobber, 0x693d32, 0, 0.135, 0, 0.028, 0.089, 0.028);
  const bite = new T.Mesh(track, new T.MeshBasicMaterial({ color: 0xffd968, transparent: true, opacity: 0, depthWrite: false }));
  bite.rotation.x = -Math.PI / 2;
  world.add(bite);
  const crosshair = new T.Mesh(new T.RingGeometry(0.73, 1, 28, 1), new T.MeshBasicMaterial({ color: 0xffedd0, opacity: 0.72, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
  crosshair.rotation.x = -Math.PI / 2;
  world.add(crosshair);

  const shockwave = kit.group(world);
  const shockArcs = [0.09, 0.14, 0.2].map((arcWidth, index) => {
    const start = -0.66 + index * 0.05;
    const geometry = new T.RingGeometry(0.82 - arcWidth, 0.82 + index * 0.14, 30, 1, start, Math.PI * 0.88);
    const mat = new T.MeshBasicMaterial({ color: index ? 0xffe8a8 : 0xfff1c9, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
    const streak = new T.Mesh(geometry, mat);
    streak.rotation.x = -Math.PI / 2;
    streak.rotation.z = Math.PI;
    streak.position.y = index * 0.065;
    shockwave.add(streak);
    return streak;
  });

  const confetti = Array.from({ length: 22 }, (_, i) => {
    const object = kit.orb(world, [0xffe9b0, 0xfeb547, 0x60b5a3, 0xf0995f][i % 4], 0, 0, 0, 0.062, 0.099, 0.064, true);
    object.castShadow = false;
    object.visible = false;
    return object;
  });
  const effects: { x: number; y: number; z: number; born: number; scale: number }[] = [];
  const impactOrigin = new T.Vector3();
  let ragdollPrevious = false;

  function aim(clientX: number, clientY: number) {
    aimPoint = null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    cursor.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    ray.setFromCamera(cursor, camera);
    if (!ray.ray.intersectPlane(ground, aimHit)) return null;
    if (isWater(aimHit.x, aimHit.z)) {
      if (!ray.ray.intersectPlane(water, aimHit)) return null;
    }
    aimPoint = { x: aimHit.x, z: aimHit.z };
    return aimPoint;
  }

  function project(position: Vec3) {
    const rect = canvas.getBoundingClientRect();
    projection.set(position.x, position.y, position.z).project(camera);
    return { x: rect.left + (projection.x + 1) * 0.5 * rect.width, y: rect.top + (1 - projection.y) * 0.5 * rect.height };
  }

  function frameCamera(snapshot: SimSnapshot, delta: number) {
    const newWidth = Math.max(1, canvas.clientWidth);
    const newHeight = Math.max(1, canvas.clientHeight);
    if (newWidth !== width || newHeight !== height) {
      width = newWidth;
      height = newHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    const focus = snapshot.player.position;
    const narrow = Math.max(0, 1.17 - camera.aspect);
    const carryFocus = snapshot.player.carrying ? Math.min(0.48, narrow * 0.72) : 0;
    const focusX = T.MathUtils.lerp(focus.x * 0.72, scalePosition.x, carryFocus);
    focal.set(focusX, 0.25, focus.z * 0.79 - 3.22);
    tracking.lerp(focal, delta ? 1 - Math.exp(-5.3 * delta) : 1);
    camera.position.set(tracking.x, tracking.y + 6.52 + narrow * 2.4, tracking.z + 12.72 + narrow * 8.1);
    camera.lookAt(tracking);
    camera.updateMatrixWorld();
  }

  function animatePlayer(snapshot: SimSnapshot, delta: number, seconds: number) {
    const view = snapshot.player;
    const ragdolled = view.parts.length > 0;
    const moved = Math.min(1, view.speed / PLAY.moveSpeed);
    const swing = view.swing;
    player.yaw.visible = !ragdolled;
    for (const member of player.ragdoll.values()) member.visible = false;
    for (const member of view.parts) {
      const model = player.ragdoll.get(member.limb);
      if (!model) continue;
      model.visible = true;
      pose(model, member);
    }
    if (ragdolled && !ragdollPrevious) {
      effects.unshift({ x: view.position.x, y: view.position.y, z: view.position.z, born: seconds, scale: 0.85 });
    }
    ragdollPrevious = ragdolled;
    player.yaw.position.set(view.position.x, view.position.y, view.position.z);
    player.yaw.rotation.y = view.yaw;
    walk += delta * 10.5 * moved;
    const stride = Math.sin(walk);
    const lean = stride * moved * 0.115;
    player.body.position.y = view.grounded ? Math.abs(Math.cos(walk)) * moved * 0.088 : 0;
    player.body.rotation.set(-moved * 0.075, 0, lean);
    const leftLeg = player.standing.get('leftLeg')!;
    const rightLeg = player.standing.get('rightLeg')!;
    const leftArm = player.standing.get('leftArm')!;
    const rightArm = player.standing.get('rightArm')!;
    const head = player.standing.get('head')!;
    leftLeg.rotation.x = view.grounded ? stride * moved * 0.54 : -0.36;
    rightLeg.rotation.x = view.grounded ? -leftLeg.rotation.x : 0.29;
    head.rotation.z = -lean * 0.68;
    leftArm.rotation.x = view.carrying ? 1.24 : -stride * moved * 0.48;
    rightArm.rotation.x = view.carrying ? 1.24 : stride * moved * 0.31 + 0.53 - (snapshot.hook.charge * 0.62);
    player.rod.visible = !view.carrying && swing < 0.07;
    player.rod.rotation.x = -snapshot.hook.charge * 0.86;
    player.rod.rotation.y = snapshot.hook.charge * 0.22;
    player.paddle.visible = swing >= 0.07;
    const chase = Math.PI * (1.5 * swing - 0.72);
    player.paddle.rotation.set(-0.72, chase, -0.31 - 0.61 * Math.sin(swing * Math.PI));
    if (player.paddle.visible) {
      rightArm.rotation.set(0.88, 0, -0.20);
    } else {
      rightArm.rotation.z = 0;
    }

    shockwave.visible = swing > 0.12 && swing < 0.79 && !ragdolled;
    shockwave.position.set(view.position.x, view.position.y - 0.17, view.position.z);
    shockwave.rotation.y = view.yaw + Math.PI * (swing - 0.39);
    shockwave.scale.setScalar(1.2 + (1 - swing) * 0.48);
    for (const [index, streak] of shockArcs.entries()) streak.material.opacity = Math.sin(swing * Math.PI) * (0.5 - index * 0.11);
  }

  function animateFish(snapshot: SimSnapshot, seconds: number) {
    const updated = new Set<string>();
    for (const [index, item] of snapshot.fish.entries()) {
      updated.add(item.id);
      let model = fish.get(item.id);
      if (!model) {
        model = { ...models.fish(world, item.kind), state: item.state };
        fish.set(item.id, model);
      }
      pose(model.animal, item);
      const swimming = item.state === 'swimming';
      const energetic = item.state === 'flopping' || item.state === 'hooked';
      const speed = energetic ? 27 : 12;
      model.tail.rotation.y = Math.sin(seconds * speed + index) * (swimming || energetic ? 0.51 : 0.09);
      if (swimming) model.animal.position.y += 0.035 * Math.sin(seconds * 3 + index);
      if (item.state === 'stunned' && model.state === 'flopping') {
        effects.unshift({ ...item.position, born: seconds, scale: 0.76 });
      }
      model.state = item.state;
    }
    for (const [id, value] of fish) {
      if (updated.has(id)) continue;
      value.animal.removeFromParent();
      fish.delete(id);
    }

    const active = new Set<string>();
    for (const item of snapshot.crates) {
      active.add(item.id);
      let model = crates.get(item.id);
      if (!model) {
        model = models.crate(world, item.id === 'training-crate');
        crates.set(item.id, model);
      }
      pose(model, item);
    }
    for (const [id, model] of crates) {
      if (active.has(id)) continue;
      model.removeFromParent();
      crates.delete(id);
    }
  }

  function animateHook(snapshot: SimSnapshot, seconds: number) {
    const hook = snapshot.hook.position;
    const phase = snapshot.hook.phase;
    crosshair.visible = Boolean(aimPoint && (phase === 'idle' || phase === 'charging'));
    if (aimPoint) {
      const { x, z } = aimPoint;
      crosshair.position.set(x, isWater(x, z) ? ISLAND.seaY + 0.10 : ISLAND.groundY + 0.078, z);
      const radius = 0.20 + snapshot.hook.charge * 0.23;
      crosshair.scale.setScalar(radius);
      crosshair.material.opacity = 0.53 + snapshot.hook.charge * 0.44;
    }
    line.visible = Boolean(hook);
    bobber.visible = Boolean(hook);
    bite.visible = Boolean(hook && (phase === 'waiting' || phase === 'bite' || phase === 'reeling'));
    if (!hook) return;
    player.tip.getWorldPosition(rodTip);
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const sag = Math.sin(t * Math.PI) * (phase === 'reeling' ? 0.11 : 0.40);
      linePoints.setXYZ(i, T.MathUtils.lerp(rodTip.x, hook.x, t), T.MathUtils.lerp(rodTip.y, hook.y + 0.045, t) - sag, T.MathUtils.lerp(rodTip.z, hook.z, t));
    }
    linePoints.needsUpdate = true;
    bobber.position.set(hook.x, hook.y + (phase === 'bite' ? 0.08 + Math.sin(seconds * 50) * 0.067 : 0.04), hook.z);
    bobber.rotation.z = Math.sin(seconds * 8) * (phase === 'bite' ? 0.4 : 0.15);
    const pulse = (seconds * (phase === 'bite' ? 2.3 : 1.16)) % 1;
    bite.scale.setScalar(0.18 + pulse * 0.9);
    bite.position.set(hook.x, Math.max(ISLAND.seaY + 0.093, hook.y + 0.04), hook.z);
    bite.material.opacity = (1 - pulse) * (phase === 'bite' ? 0.92 : 0.52);
  }

  function animateEffects(snapshot: SimSnapshot, seconds: number) {
    if (snapshot.sold > soldPrevious) {
      soldAt = seconds;
      effects.unshift({ x: scalePosition.x, y: scalePosition.y, z: scalePosition.z, born: seconds, scale: 1.43 });
    }
    soldPrevious = snapshot.sold;
    const age = seconds - soldAt;
    saleRing.visible = age < 0.65;
    saleRing.scale.setScalar(1.02 + age * 2.4);
    saleRing.material.opacity = Math.max(0, 1 - age / 0.65) * 0.85;

    for (let i = effects.length - 1; i >= 0; i--) {
      if (seconds - effects[i].born > 0.8 || i > 1) effects.splice(i, 1);
    }
    for (const [index, confetto] of confetti.entries()) {
      const event = effects[Math.floor(index / 11)];
      confetto.visible = !!event;
      if (!event) continue;
      const lifetime = (seconds - event.born) / 0.8;
      const angle = index * 2.399;
      const drift = lifetime * (0.62 + (index % 5) * 0.13) * event.scale;
      impactOrigin.set(event.x + Math.cos(angle) * drift, event.y + Math.sin(lifetime * Math.PI) * (0.92 + (index % 4) * 0.25), event.z + Math.sin(angle) * drift);
      confetto.position.copy(impactOrigin);
      confetto.rotation.set(lifetime * 5, lifetime * 6 + angle, angle + lifetime * 8);
      const size = 1 - 0.85 * lifetime;
      confetto.scale.set(0.085 * size, 0.102 * size, 0.073 * size);
    }
  }

  function render(snapshot: SimSnapshot, elapsed: number) {
    const delta = previous < 0 ? 0 : Math.min(0.1, Math.max(0, elapsed - previous));
    previous = elapsed;
    frameCamera(snapshot, delta);
    animateIsland(elapsed);
    animatePlayer(snapshot, delta, elapsed);
    animateFish(snapshot, elapsed);
    animateHook(snapshot, elapsed);
    animateEffects(snapshot, elapsed);
    renderer.render(world, camera);
  }

  function dispose() {
    const geometries = new Set<T.BufferGeometry>();
    const materials = new Set<T.Material>();
    world.traverse(object => {
      if (!(object instanceof T.Mesh || object instanceof T.Line)) return;
      geometries.add(object.geometry);
      const item = object.material;
      for (const mat of Array.isArray(item) ? item : [item]) materials.add(mat);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) {
      if ('map' in material && material.map instanceof T.Texture) material.map.dispose();
      material.dispose();
    }
    renderer.dispose();
  }

  return { render, aim, project, dispose };
}
