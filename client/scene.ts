import * as T from 'three';
import { BUILD_KINDS, type CampaignView } from '../shared/sim/campaign-types';
import { CAMPAIGN, FISHING, ISLAND, PLAY } from '../shared/sim/config';
import { POPPER, popperTarget } from '../shared/sim/popper';
import { buildAhead, buildSiteAvailable, snapBuildSite } from '../shared/sim/construction';
import { weaponStats } from '../shared/sim/shop';
import type { FishState, PlayerView, Pose, SimSnapshot, Vec3 } from '../shared/sim/types';
import { createActorAssets, makeActor } from './assets/actors';
import { makeCampaignArt, makeGhost } from './assets/campaign';
import { crewBadge } from './assets/crew-badge';
import { makeGeometryKit } from './assets/geometry';
import { makeLiftMarkers } from './assets/lift-markers';
import { createModels } from './assets/models';
import { makeAirCatchMark, makePopperArt } from './assets/poppers';
import { makeSalvageCrate, makeSalvageCue } from './assets/salvage';
import { makeIsland } from './assets/world';
import { crewColor } from './crew-colors';

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
  const sky = new T.Color(0xa5c5ac);
  const fog = new T.Fog(0xa8c6ad, 24, 77);
  world.background = sky;
  world.fog = fog;
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

  const lighting = [
    { color: sky, from: sky.clone(), to: new T.Color(0x343c63) },
    { color: fog.color, from: fog.color.clone(), to: new T.Color(0x394769) },
    { color: dome.color, from: dome.color.clone(), to: new T.Color(0x9abce6) },
    { color: dome.groundColor, from: dome.groundColor.clone(), to: new T.Color(0x777695) },
    { color: key.color, from: key.color.clone(), to: new T.Color(0xa4c7f4) },
    { color: fill.color, from: fill.color.clone(), to: new T.Color(0xc2c8eb) },
  ];

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
  const handPoint = new T.Vector3();
  let width = 0;
  let height = 0;
  let previous = -1;
  let previousAnimationTime = -1;
  let aimPoint: { x: number; z: number } | null = null;
  let aimingAtCrew = false;
  let localPlayerId = '';
  let crewViews: PlayerView[] = [];
  let night = 0;
  let defenseCamera = 0;

  const kit = makeGeometryKit();
  const appearances = createActorAssets();
  let priorityModels: Promise<unknown> | undefined;
  const models = createModels(kit);
  const island = makeIsland(world, kit, appearances);
  const campaignArt = makeCampaignArt(world, kit, appearances);
  const popperArt = makePopperArt(world, kit);
  const salvageCue = makeSalvageCue(world);
  const speechPoint = new T.Vector3();
  const workers = new Map<string, ReturnType<typeof createWorker>>();
  const fish = new Map<string, ReturnType<typeof models.fish> & {
    state: FishState;
    carrierId: string | null;
    lift: ReturnType<typeof makeLiftMarkers> | null;
    airCatch?: ReturnType<typeof makeAirCatchMark>;
  }>();
  const crates = new Map<string, { body: T.Group; flag?: T.Group; dispose?: () => void }>();
  const scalePosition = new T.Vector3(ISLAND.scale.x, ISLAND.groundY + 0.56, ISLAND.scale.z);
  const track = new T.RingGeometry(0.94, 1, 44);
  const saleRing = new T.Mesh(track, new T.MeshBasicMaterial({ color: 0xffec9c, transparent: true, opacity: 0, depthWrite: false }));
  saleRing.rotation.x = -Math.PI / 2;
  saleRing.position.copy(scalePosition);
  saleRing.visible = false;
  world.add(saleRing);
  let soldPrevious = 0;
  let soldAt = -10;

  const crosshair = new T.Mesh(new T.RingGeometry(0.73, 1, 28, 1), new T.MeshBasicMaterial({ color: 0xffedd0, opacity: 0.72, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
  crosshair.rotation.x = -Math.PI / 2;
  world.add(crosshair);
  const castLanding = new T.Mesh(
    new T.RingGeometry(0.72, 1, 28),
    new T.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
  );
  castLanding.rotation.x = -Math.PI / 2;
  castLanding.scale.setScalar(0.29);
  world.add(castLanding);
  const catchMarker = new T.Mesh(
    new T.RingGeometry(0.82, 1, 32),
    new T.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
  );
  catchMarker.rotation.x = -Math.PI / 2;
  world.add(catchMarker);
  const buildMarker = new T.Mesh(
    new T.RingGeometry(0.27, 0.38, 4, 1, Math.PI / 4),
    new T.MeshBasicMaterial({ transparent: true, opacity: 0.86, depthWrite: false, toneMapped: false }),
  );
  buildMarker.rotation.x = -Math.PI / 2;
  world.add(buildMarker);
  const popperMarker = new T.Mesh(
    new T.RingGeometry(0.24, 0.32, 6),
    new T.MeshBasicMaterial({ color: 0x74dbaa, transparent: true, opacity: 0.83, depthWrite: false, toneMapped: false }),
  );
  popperMarker.rotation.x = -Math.PI / 2;
  world.add(popperMarker);

  const shockArcGeometries = [0.09, 0.14, 0.2].map((arcWidth, index) => {
    const start = -0.66 + index * 0.05;
    return new T.RingGeometry(0.82 - arcWidth, 0.82 + index * 0.14, 30, 1, start, Math.PI * 0.88);
  });

  function createWorker(view: PlayerView, index: number) {
    const accent = crewColor(view.id);
    const model = models.worker(world, view.id);
    const actor = makeActor(model.yaw, appearances, 1.68, Math.PI);
    actor.pivot.position.y = -0.76;
    const rodOrigin = model.rod.position.clone();
    const paddleOrigin = model.paddle.position.clone();
    const badge = crewBadge(world, view.id === localPlayerId ? '你' : view.name, accent);
    const lineColor = view.bot ? new T.Color(accent).lerp(new T.Color(0xfffaf0), 0.6) : new T.Color(0xffeea8);
    const lineGeometry = new T.BufferGeometry();
    const linePoints = new T.BufferAttribute(new Float32Array(15), 3).setUsage(T.DynamicDrawUsage);
    lineGeometry.setAttribute('position', linePoints);
    const line = new T.Line(lineGeometry, new T.LineBasicMaterial({
      color: lineColor, transparent: true, opacity: view.bot ? 0.74 : 0.88,
    }));
    line.frustumCulled = false;
    world.add(line);
    const bobber = kit.group(world);
    kit.orb(bobber, 0xffe5a1, 0, -0.006, 0, 0.13, 0.12, 0.13);
    kit.orb(bobber, view.bot ? accent : 0xe66844, 0, 0.042, 0, 0.115, 0.085, 0.115);
    kit.box(bobber, 0x693d32, 0, 0.135, 0, 0.028, 0.089, 0.028);
    const bite = new T.Mesh(track, new T.MeshBasicMaterial({ color: 0xffd968, transparent: true, opacity: 0, depthWrite: false }));
    bite.rotation.x = -Math.PI / 2;
    const splash = new T.Mesh(track, new T.MeshBasicMaterial({ color: 0xdafff2, transparent: true, opacity: 0, depthWrite: false }));
    splash.rotation.x = -Math.PI / 2;
    world.add(bite, splash);
    const shockwave = kit.group(world);
    const shockArcs = shockArcGeometries.map((geometry, index) => {
      const mat = new T.MeshBasicMaterial({ color: index ? 0xffe8a8 : 0xfff1c9, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
      const streak = new T.Mesh(geometry, mat);
      streak.rotation.x = -Math.PI / 2;
      streak.rotation.z = Math.PI;
      streak.position.y = index * 0.065;
      shockwave.add(streak);
      return streak;
    });

    return {
      model, actor, rodOrigin, paddleOrigin, badge, lineColor, line, linePoints, bobber, bite, splash, shockwave, shockArcs,
      ghost: makeGhost(world, kit, accent),
      walk: (index * 2.3) % (Math.PI * 2), ragdoll: false, wet: false, splashAt: -10,
    };
  }

  const confetti = Array.from({ length: 22 }, (_, i) => {
    const object = kit.orb(world, [0xffe9b0, 0xfeb547, 0x60b5a3, 0xf0995f][i % 4], 0, 0, 0, 0.062, 0.099, 0.064, true);
    object.castShadow = false;
    object.visible = false;
    return object;
  });
  const effects: { x: number; y: number; z: number; born: number; scale: number }[] = [];
  const impactOrigin = new T.Vector3();

  function crewAim(x: number, y: number) {
    let closest: PlayerView | undefined;
    let nearest = Infinity;
    for (const mate of crewViews) {
      if (mate.id === localPlayerId || mate.ragdoll || mate.baitedBy || mate.ghost) continue;
      const point = mate.position;
      projection.set(point.x, point.y, point.z).project(camera);
      if (projection.z < -1 || projection.z > 1) continue;
      const dx = Math.abs(x - projection.x);
      const dy = Math.abs(y - projection.y);
      const centerX = projection.x;
      projection.set(point.x + 0.34, point.y, point.z).project(camera);
      if (dx > Math.abs(projection.x - centerX)) continue;
      projection.set(point.x, point.y - 0.49, point.z).project(camera);
      if (y < projection.y) continue;
      projection.set(point.x, point.y + (mate.optimization ? 1.24 : 0.8), point.z).project(camera);
      if (y > projection.y) continue;
      const distance = dx * dx + dy * dy;
      if (distance < nearest) {
        closest = mate;
        nearest = distance;
      }
    }
    return closest;
  }

  function aim(clientX: number, clientY: number) {
    aimPoint = null;
    aimingAtCrew = false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    cursor.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    const mate = crewAim(cursor.x, cursor.y);
    if (mate) {
      aimingAtCrew = true;
      aimPoint = { x: mate.position.x, z: mate.position.z };
      return aimPoint;
    }
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

  function frameCamera(snapshot: SimSnapshot, delta: number, campaign: CampaignView) {
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
    const transition = delta ? 1 - Math.exp(-2.8 * delta) : 1;
    defenseCamera = T.MathUtils.lerp(defenseCamera, campaign.phase === 'night' || campaign.phase === 'boss' ? 1 : 0, transition);
    let daytimeX = T.MathUtils.lerp(focus.x * 0.72, scalePosition.x, carryFocus);
    if (carryFocus && snapshot.crates.some(item => item.salvage && item.id === snapshot.player.carrying)) {
      daytimeX = Math.min(daytimeX, focus.x + 2.35);
    }
    if (narrow > 0 && !snapshot.player.carrying) {
      const looseCargo = snapshot.fish.find(item => item.heavy && item.state === 'stunned'
        && Math.hypot(item.position.x - focus.x, item.position.z - focus.z) < 4.5);
      if (looseCargo) daytimeX = T.MathUtils.lerp(daytimeX, looseCargo.position.x, Math.min(0.52, narrow * 0.74));
    }
    const crab = campaign.enemies.find(enemy => enemy.kind === 'crab')?.position;
    const defenseX = crab ? T.MathUtils.lerp(focus.x * 0.72, crab.x, 0.29) : focus.x * 0.49;
    const dockFraming = Math.max(0, 1 - camera.aspect) * (height < 720 ? 6.4 : 2.35);
    const defenseZ = crab ? T.MathUtils.lerp(focus.z, crab.z, 0.44) - 1.6 : focus.z * 0.38 - 0.22 + dockFraming;
    focal.set(
      T.MathUtils.lerp(daytimeX, defenseX, defenseCamera),
      0.25,
      T.MathUtils.lerp(focus.z * 0.79 - 3.22, defenseZ, defenseCamera),
    );
    tracking.lerp(focal, delta ? 1 - Math.exp(-5.3 * delta) : 1);
    camera.position.set(
      tracking.x,
      tracking.y + 6.52 + defenseCamera * 2.8 + narrow * 2.4,
      tracking.z + 12.72 + defenseCamera * 2.85 + narrow * 8.1,
    );
    camera.lookAt(tracking);
    camera.updateMatrixWorld();
  }

  function animatePlayer(view: PlayerView, worker: ReturnType<typeof createWorker>, delta: number, seconds: number) {
    const { model: player, actor, shockwave, shockArcs } = worker;
    const floating = view.ghost;
    worker.ghost.animate(floating, view.position, seconds);
    for (const member of player.ragdoll.values()) member.visible = false;
    if (floating) {
      player.yaw.visible = false;
      worker.shockwave.visible = false;
      worker.splash.visible = false;
      worker.ragdoll = false;
      worker.wet = false;
      return;
    }
    const ragdolled = view.parts.length > 0;
    const entangled = Boolean(view.baitedBy);
    const holding = Boolean(view.carrying || view.lifting);
    const moved = Math.min(1, view.speed / PLAY.moveSpeed);
    const swing = view.swing;
    player.yaw.visible = !ragdolled;
    for (const hat of player.hats) hat.visible = view.optimization;
    player.loadedHat.visible = actor.ready && view.optimization;
    for (const piece of player.standing.values()) piece.visible = !actor.ready;
    for (const member of view.parts) {
      const model = player.ragdoll.get(member.limb);
      if (!model) continue;
      model.visible = true;
      pose(model, member);
    }
    if (ragdolled && !worker.ragdoll && !entangled) {
      effects.unshift({ x: view.position.x, y: view.position.y, z: view.position.z, born: seconds, scale: 0.85 });
    }
    worker.ragdoll = ragdolled;
    const wet = entangled && view.position.y < 0.45 && isWater(view.position.x, view.position.z);
    if (wet && !worker.wet) {
      worker.splashAt = seconds;
      worker.splash.position.set(view.position.x, ISLAND.seaY + 0.093, view.position.z);
      effects.unshift({ x: view.position.x, y: ISLAND.seaY, z: view.position.z, born: seconds, scale: 1.38 });
    }
    worker.wet = wet;
    const splashAge = seconds - worker.splashAt;
    worker.splash.visible = splashAge < 0.62;
    worker.splash.scale.setScalar(0.3 + splashAge * 2.8);
    worker.splash.material.opacity = Math.max(0, 1 - splashAge / 0.62) * 0.92;

    player.yaw.position.set(view.position.x, view.position.y, view.position.z);
    player.yaw.rotation.y = view.yaw;
    const hasPan = Boolean(view.equipment?.pan);
    actor.play(view.animation, delta, weaponStats({ pan: hasPan }).swingSeconds);
    player.rodUpgrade.visible = Boolean(view.equipment?.rod);
    player.paddleBlade.visible = !hasPan;
    player.paddlePan.visible = hasPan;
    worker.walk += delta * 10.5 * moved;
    const walk = worker.walk;
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
    const struggle = entangled ? Math.sin(seconds * 16) * 0.26 : 0;
    leftArm.rotation.x = entangled ? -0.9 + struggle : holding ? 1.24 : -stride * moved * 0.48;
    leftArm.rotation.z = entangled ? -0.38 : 0;
    rightArm.rotation.x = entangled ? -0.9 - struggle : holding ? 1.24 : stride * moved * 0.31 + 0.53 - (view.hook.charge * 0.62);
    player.rod.visible = !entangled && !holding && swing < 0.07;
    player.rod.rotation.x = -view.hook.charge * 0.86;
    player.rod.rotation.y = view.hook.charge * 0.22;
    player.paddle.visible = !entangled && swing >= 0.07;
    const chase = Math.PI * (1.5 * swing - 0.72);
    player.paddle.rotation.set(-0.72, chase, -0.31 - 0.61 * Math.sin(swing * Math.PI));
    if (player.paddle.visible) {
      rightArm.rotation.set(0.88, 0, -0.20);
    } else {
      rightArm.rotation.z = entangled ? 0.38 : 0;
    }
    if (actor.hand) {
      actor.hand.getWorldPosition(handPoint);
      player.body.worldToLocal(handPoint);
      player.rod.position.set(handPoint.x, handPoint.y + 0.13, handPoint.z - 0.20);
      player.paddle.position.copy(handPoint);
    } else {
      player.rod.position.copy(worker.rodOrigin);
      player.paddle.position.copy(worker.paddleOrigin);
    }

    shockwave.visible = swing > 0.12 && swing < 0.79 && !ragdolled;
    shockwave.position.set(view.position.x, view.position.y - 0.17, view.position.z);
    shockwave.rotation.y = view.yaw + Math.PI * (swing - 0.39);
    shockwave.scale.setScalar(1.2 + (1 - swing) * 0.48);
    for (const [index, streak] of shockArcs.entries()) streak.material.opacity = Math.sin(swing * Math.PI) * (0.5 - index * 0.11);
  }

  function animateCrew(snapshot: SimSnapshot, delta: number, seconds: number, selfId: string | null) {
    localPlayerId = selfId ?? '';
    crewViews = snapshot.players;
    if (!priorityModels) {
      priorityModels = Promise.all([appearances.load('feiyu'), appearances.load(snapshot.player.roleId)]);
      void priorityModels.then(() => appearances.load('crab'));
    }
    const loadedRoles: string[] = [];
    const badgeLayout: { x: number; y: number; width: number; height: number }[] = [];
    const unitsPerPixel = 2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)) / height;
    for (const view of crewViews) {
      let worker = workers.get(view.id);
      if (!worker) {
        worker = createWorker(view, workers.size);
        workers.set(view.id, worker);
      }
      worker.actor.use(view.roleId, view.id === localPlayerId ? undefined : priorityModels);
      if (worker.actor.id) loadedRoles.push(worker.actor.id);
      animatePlayer(view, worker, delta, seconds);
      animateHook(view, worker, seconds);

      const badge = worker.badge;
      badge.setName(view.id === localPlayerId ? '你' : view.name);
      const cargo = view.carrying ? snapshot.fish.find(item => item.id === view.carrying && item.heavy) : undefined;
      const liftStatus = view.lifting ? '等搭手' : cargo?.helperId === view.id ? '帮抬中' : cargo ? '抬鱼中' : '';
      badge.setStatus(view.ghost ? '幽灵' : view.baitedBy ? '当饵中' : liftStatus || (view.optimization ? '待优化' : ''));
      badge.resize(unitsPerPixel);
      const head = view.parts.find(part => part.limb === 'head')?.position;
      const anchor = head ?? view.position;
      const headroom = (head ? 0.41 : 1.0) + (view.optimization ? 0.32 : 0);
      badge.sprite.position.set(anchor.x, Math.max(anchor.y + headroom, 0.37), anchor.z);
      projection.copy(badge.sprite.position).project(camera);
      const x = (projection.x + 1) * 0.5 * width;
      const foot = (1 - projection.y) * 0.5 * height;
      let y = foot - badge.pixelHeight;
      while (badgeLayout.some(box => Math.abs(box.x - x) < (box.width + badge.pixelWidth) / 2 + 4
        && box.y + box.height > y && box.y < y + badge.pixelHeight)) {
        y -= badge.pixelHeight;
      }
      badge.sprite.center.y = (y + badge.pixelHeight - foot) / badge.pixelHeight;
      badgeLayout.push({ x, y, width: badge.pixelWidth, height: badge.pixelHeight });
    }
    const ready = loadedRoles.join(',');
    if (canvas.dataset.loadedRoles !== ready) canvas.dataset.loadedRoles = ready;
  }

  function animateFish(snapshot: SimSnapshot, seconds: number) {
    const findHand = (id: string, target: T.Vector3) => {
      const worker = workers.get(id);
      return worker?.actor.hand?.getWorldPosition(target);
    };
    const updated = new Set<string>();
    for (const [index, item] of snapshot.fish.entries()) {
      updated.add(item.id);
      let model = fish.get(item.id);
      if (!model) {
        model = {
          ...models.fish(world, item.kind, item.heavy),
          state: item.state,
          carrierId: item.carrierId,
          lift: item.heavy ? makeLiftMarkers(world, kit) : null,
        };
        fish.set(item.id, model);
      }
      pose(model.animal, item);
      if (item.heavy && item.state === 'carried') {
        model.animal.position.y += 0.31;
        model.animal.rotateY(Math.PI / 2);
      }
      model.lift?.animate(item, snapshot.players, model.animal.position, seconds, findHand);
      const airCatch = item.popCatchUntil != null && item.popCatchUntil > snapshot.time
        && item.position.y >= POPPER.catchHeight;
      if (airCatch) model.airCatch ??= makeAirCatchMark(world, kit);
      model.airCatch?.animate(airCatch, item.position, seconds);
      const swimming = item.state === 'swimming';
      const energetic = item.state === 'flopping' || item.state === 'hooked';
      const speed = energetic ? 27 : 12;
      model.tail.rotation.y = Math.sin(seconds * speed + index) * (swimming || energetic ? 0.51 : 0.09);
      if (swimming) model.animal.position.y += 0.035 * Math.sin(seconds * 3 + index);
      if (item.state === 'stunned' && model.state === 'flopping') {
        effects.unshift({ ...item.position, born: seconds, scale: 0.76 });
      }
      if (item.carrierId && item.carrierId !== model.carrierId && (model.carrierId || model.state === 'thrown')) {
        effects.unshift({ ...item.position, born: seconds, scale: 0.64 });
      }
      model.state = item.state;
      model.carrierId = item.carrierId;
    }
    for (const [id, value] of fish) {
      if (updated.has(id)) continue;
      value.lift?.dispose();
      value.airCatch?.dispose();
      value.animal.removeFromParent();
      fish.delete(id);
    }

    const active = new Set<string>();
    let driftingCrate: Vec3 | undefined;
    for (const item of snapshot.crates) {
      active.add(item.id);
      let model = crates.get(item.id);
      if (!model) {
        model = item.salvage ? makeSalvageCrate(world, kit) : { body: models.crate(world, item.id === 'training-crate') };
        crates.set(item.id, model);
      }
      pose(model.body, item);
      if (model.flag) model.flag.rotation.y = Math.sin(seconds * 4.1) * 0.24;
      if (item.salvage && item.state === 'floating') driftingCrate = item.position;
    }
    for (const [id, model] of crates) {
      if (active.has(id)) continue;
      model.body.removeFromParent();
      model.dispose?.();
      crates.delete(id);
    }
    const cue = salvageCue.update(driftingCrate, camera, width, height);
    if (canvas.dataset.salvageCue !== cue) canvas.dataset.salvageCue = cue;
  }

  function animateCrosshair(snapshot: SimSnapshot) {
    const { phase, charge } = snapshot.hook;
    crosshair.visible = Boolean(aimPoint && (phase === 'idle' || phase === 'charging' || phase === 'bait'));
    if (aimPoint) {
      const { x, z } = aimPoint;
      crosshair.position.set(x, isWater(x, z) ? ISLAND.seaY + 0.10 : ISLAND.groundY + 0.078, z);
      const hot = aimingAtCrew || phase === 'bait';
      const radius = (hot ? 0.31 : 0.2) + charge * 0.23;
      crosshair.scale.setScalar(radius);
      crosshair.material.color.setHex(hot ? 0xff8346 : 0xffedd0);
      crosshair.material.opacity = (hot ? 0.68 : 0.53) + charge * 0.3;
    }
    castLanding.visible = Boolean(aimPoint && phase === 'charging' && !aimingAtCrew);
    if (castLanding.visible && aimPoint) {
      const { position, yaw } = snapshot.player;
      const range = T.MathUtils.lerp(FISHING.minRange, FISHING.maxRange, charge);
      const distance = Math.hypot(aimPoint.x - position.x, aimPoint.z - position.z);
      const travel = T.MathUtils.clamp(distance, 0.8, range);
      const x = position.x - Math.sin(yaw) * travel;
      const z = position.z - Math.cos(yaw) * travel;
      const water = isWater(x, z);
      const y = (water ? ISLAND.seaY : ISLAND.groundY) + 0.10;
      castLanding.position.set(x, y, z);
      castLanding.material.color.setHex(water ? 0xffd876 : 0xfd7958);
    }
  }

  function animateCatchHelp(snapshot: SimSnapshot, seconds: number, selfId: string | null) {
    const fish = selfId && !snapshot.sold && snapshot.campaign.phase === 'day'
      ? snapshot.fish.find(item => item.caughtBy === selfId && (item.state === 'flopping' || (item.state === 'stunned' && !item.heavy)))
      : undefined;
    catchMarker.visible = Boolean(fish);
    if (!fish) return;
    catchMarker.position.set(fish.position.x, ISLAND.groundY + 0.075, fish.position.z);
    catchMarker.material.color.setHex(fish.state === 'stunned' ? 0x348675 : 0xd4782e);
    catchMarker.material.opacity = 0.60 + Math.sin(seconds * 9) * 0.20;
    catchMarker.scale.setScalar(0.55 + Math.sin(seconds * 9) * 0.06);
  }

  function animateBuildMarker(snapshot: SimSnapshot, selfId: string | null) {
    const { player, campaign, shiftPaused } = snapshot;
    buildMarker.visible = Boolean(selfId) && (campaign.phase === 'night' || campaign.phase === 'boss')
      && !shiftPaused && !player.ghost && !player.baitedBy && !player.ragdoll;
    if (!buildMarker.visible) return;
    const site = snapBuildSite(buildAhead(player.position, player.yaw));
    const woodAvailable = BUILD_KINDS.some(kind => campaign.wood >= CAMPAIGN.build[kind].cost);
    const spaceAvailable = buildSiteAvailable(site, campaign.structures, campaign.enemies);
    buildMarker.position.set(site.x, (isWater(site.x, site.z) ? ISLAND.seaY : site.y) + 0.08, site.z);
    buildMarker.material.color.setHex(woodAvailable && spaceAvailable ? 0xf7c66e : 0xff715e);
  }

  function animatePopperMarker(snapshot: SimSnapshot, selfId: string | null) {
    const { player, campaign, shiftPaused } = snapshot;
    const canPlace = selfId && aimPoint && player.equipment?.popper && !player.popperCooldown && !shiftPaused
      && campaign.phase === 'day' && campaign.remaining > POPPER.fuseSeconds
      && !player.ghost && !player.ragdoll && !player.baitedBy;
    const point = canPlace ? popperTarget(player.position, aimPoint) : null;
    popperMarker.visible = point !== null;
    if (point) popperMarker.position.set(point.x, point.y + 0.092, point.z);
  }

  function animateHook(view: PlayerView, worker: ReturnType<typeof createWorker>, seconds: number) {
    const { model, lineColor, line, linePoints, bobber, bite } = worker;
    const { position: hook, phase, target } = view.hook;
    const active = Boolean(hook && !view.ragdoll && !view.baitedBy && !view.ghost);
    const tether = target === 'player';
    line.visible = active;
    bobber.visible = active;
    bite.visible = active && (phase === 'waiting' || phase === 'bite' || phase === 'reeling');
    if (!hook || !active) return;
    if (tether) line.material.color.setHex(0xff973b);
    else line.material.color.copy(lineColor);
    line.material.opacity = tether ? 0.99 : view.bot ? 0.74 : 0.88;
    model.tip.getWorldPosition(rodTip);
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const sag = Math.sin(t * Math.PI) * (phase === 'reeling' || tether ? 0.11 : 0.40);
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
    const crewSold = snapshot.players.reduce((sum, view) => sum + view.sold, 0);
    if (crewSold > soldPrevious) {
      soldAt = seconds;
      effects.unshift({ x: scalePosition.x, y: scalePosition.y, z: scalePosition.z, born: seconds, scale: 1.43 });
    }
    soldPrevious = crewSold;
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

  function projectBossSpeech() {
    return project(island.bossSpeechAnchor.getWorldPosition(speechPoint));
  }

  function render(snapshot: SimSnapshot, elapsed: number, bossSpeaking: boolean, selfId: string | null = snapshot.player.id) {
    const delta = previous < 0 ? 0 : Math.min(0.1, Math.max(0, elapsed - previous));
    previous = elapsed;
    const animationTime = performance.now() / 1000;
    const animationDelta = previousAnimationTime < 0 ? 0 : Math.min(0.1, Math.max(0, animationTime - previousAnimationTime));
    previousAnimationTime = animationTime;
    const { campaign } = snapshot;
    const targetNight = campaign.phase === 'night' ? 1 : campaign.phase === 'boss' ? 0.12 : 0;
    night = T.MathUtils.lerp(night, targetNight, delta ? 1 - Math.exp(-2.15 * delta) : 1);
    for (const { color, from, to } of lighting) color.copy(from).lerp(to, night);
    dome.intensity = T.MathUtils.lerp(2.24, 1.75, night);
    key.intensity = T.MathUtils.lerp(2.45, 0.95, night);
    fill.intensity = T.MathUtils.lerp(0.48, 0.42, night);
    frameCamera(snapshot, delta, campaign);
    island.animate(elapsed, animationDelta, snapshot.boss.line?.emotion ?? 'calm', bossSpeaking, night);
    campaignArt.animate(campaign, elapsed, night, camera);
    popperArt.animate(snapshot.poppers ?? [], elapsed);
    const { bossModel } = island;
    const { crabModel } = campaignArt;
    if (canvas.dataset.bossModel !== bossModel) canvas.dataset.bossModel = bossModel;
    if (canvas.dataset.crabModel !== crabModel) canvas.dataset.crabModel = crabModel;
    animateCrew(snapshot, animationDelta, elapsed, selfId);
    animateFish(snapshot, elapsed);
    animateCrosshair(snapshot);
    animateCatchHelp(snapshot, elapsed, selfId);
    animateBuildMarker(snapshot, selfId);
    animatePopperMarker(snapshot, selfId);
    animateEffects(snapshot, elapsed);
    renderer.render(world, camera);
  }

  function dispose() {
    for (const { actor } of workers.values()) actor.dispose();
    island.dispose();
    campaignArt.dispose();
    popperArt.dispose();
    salvageCue.dispose();
    appearances.dispose();
    const geometries = new Set<T.BufferGeometry>();
    const materials = new Set<T.Material>();
    world.traverse(object => {
      if (object instanceof T.Sprite) materials.add(object.material);
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
    key.shadow.dispose();
    renderer.dispose();
  }

  return { render, aim, project, projectBossSpeech, dispose };
}
