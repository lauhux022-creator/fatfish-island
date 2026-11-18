import RAPIER, { type ColliderDesc, type RigidBody } from '@dimforge/rapier3d-compat';
import { FISH, FISHING, ISLAND, PLAY, STEP_SECONDS, TICKS_PER_SECOND } from './config';
import type {
  CrateView, FishKind, FishState, HookPhase, Pose, RagdollLimb, Rotation, SimInput,
  SimNotice, SimSnapshot, Vec3,
} from './types';

interface SimulationOptions {
  seed?: string;
  day?: number;
}

interface Fish {
  id: string;
  kind: FishKind;
  body: RigidBody;
  state: FishState;
  hits: number;
  lastHit: number;
  lastTouch: string | null;
  multiplier: number;
  wakeAt: number;
  hopAt: number;
}

interface Crate {
  id: string;
  body: RigidBody;
  state: CrateView['state'];
  looseAt: number;
}

interface Hook {
  phase: HookPhase;
  body: RigidBody | null;
  charge: number;
  taps: number;
  required: number;
  target: Fish | Crate | null;
  swimmer: Fish | null;
  start: Vec3 | null;
  deadline: number;
}

interface RagdollBody {
  limb: RagdollLimb;
  body: RigidBody;
}

interface Direction {
  x: number;
  z: number;
}

const PLAYER = 'player';
const PLAYER_RADIUS = 0.31;
const PLAYER_HALF_HEIGHT = 0.45;
const PLAYER_HEIGHT = PLAYER_RADIUS + PLAYER_HALF_HEIGHT;
const FISH_KINDS = Object.keys(FISH) as FishKind[];

let rapierReady: Promise<void> | undefined;

export async function createSimulation(options: SimulationOptions = {}) {
  rapierReady ??= RAPIER.init();
  await rapierReady;
  return new IslandSimulation(options);
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (const codePoint of seed) state = Math.imul(state ^ codePoint.codePointAt(0)!, 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let word = Math.imul(state ^ (state >>> 15), state | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    return ((word ^ (word >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, lo: number, hi: number) {
  return Math.min(Math.max(value, lo), hi);
}

function distance(a: Direction, b: Direction) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function yawRotation(yaw: number): Rotation {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function pose(body: RigidBody): Pose {
  return { position: body.translation(), rotation: body.rotation() };
}

function isFish(target: Fish | Crate): target is Fish {
  return 'kind' in target;
}

function onLand(position: Direction, inset = 0) {
  return position.x >= ISLAND.minX + inset && position.x <= ISLAND.maxX - inset
    && position.z >= ISLAND.shoreZ + inset && position.z <= ISLAND.backZ - inset;
}

function canFish(position: Direction) {
  return position.z < ISLAND.shoreZ - 0.12 && position.z >= FISHING.minFishingZ
    && Math.abs(position.x) <= FISHING.maxFishingX;
}

function launchVector(origin: Vec3, destination: Vec3, seconds: number): Vec3 {
  return {
    x: (destination.x - origin.x) / seconds,
    y: (destination.y - origin.y) / seconds + PLAY.gravity * (seconds + STEP_SECONDS) / 2,
    z: (destination.z - origin.z) / seconds,
  };
}

function newHook(): Hook {
  return {
    phase: 'idle', body: null, charge: 0, taps: 0, required: 1,
    target: null, swimmer: null, start: null, deadline: 0,
  };
}

class IslandSimulation {
  private readonly world = new RAPIER.World({ x: 0, y: -PLAY.gravity, z: 0 });
  private readonly player: RigidBody;
  private readonly crates: Crate[];
  private readonly fish: Fish[] = [];
  private readonly seed: string;
  private readonly day: number;
  private readonly random: () => number;
  private tick = 0;
  private yaw = 0;
  private aim: Direction = { x: 0, z: -1 };
  private groundContact = true;
  private moveSpeed = 0;
  private swingUntil = 0;
  private ragdoll: RagdollBody[] = [];
  private recoverTick = 0;
  private nextTripAt = 0;
  private carrying: Fish | Crate | null = null;
  private hook = newHook();
  private cash = 0;
  private sold = 0;
  private nextEntityId = 0;
  private notice: SimNotice | null = null;
  private noticeId = 0;

  constructor({ seed = 'dock-shift', day = 1 }: SimulationOptions) {
    this.seed = seed;
    this.day = Number.isFinite(day) ? Math.max(1, Math.trunc(day)) : 1;
    this.random = seededRandom(seed);
    this.world.timestep = STEP_SECONDS;

    const halfX = (ISLAND.maxX - ISLAND.minX) / 2;
    const halfZ = (ISLAND.backZ - ISLAND.shoreZ) / 2;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(halfX, 0.5, halfZ)
      .setTranslation(ISLAND.minX + halfX, ISLAND.groundY - 0.5, ISLAND.shoreZ + halfZ)
      .setFriction(0.85));
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.22, 0.7)
      .setTranslation(ISLAND.scale.x, 0.22, ISLAND.scale.z)
      .setFriction(0.75));

    this.player = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(ISLAND.spawn.x, ISLAND.spawn.y, ISLAND.spawn.z)
      .setCcdEnabled(true).lockRotations());
    this.world.createCollider(RAPIER.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS)
      .setFriction(0.02).setDensity(2), this.player);

    this.crates = [
      this.makeCrate('supply-crate', ISLAND.supplyCrate, 'floating', 0.43),
      this.makeCrate('training-crate', ISLAND.trainingCrate, 'loose', 0.52),
    ];
  }

  step(input: SimInput) {
    this.tick += 1;
    if (this.recoverTick !== 0 && this.tick >= this.recoverTick) this.recover();
    if (!this.ragdoll.length) {
      this.updatePlayer(input);
      this.updateCastInput(input);
      if (input.swingPressed) this.swing();
      if (input.interactPressed) this.interact();
    }

    this.updateWaitingHook();
    this.updateCarried();
    this.updateFloppingFish();
    this.world.step();
    this.updateFlyingHook();
    this.updateOutcomes();
  }

  snapshot(): SimSnapshot {
    const player = this.ragdoll[0]?.body ?? this.player;
    return {
      tick: this.tick,
      time: this.time,
      day: this.day,
      seed: this.seed,
      player: {
        ...pose(player),
        rotation: this.ragdoll.length ? player.rotation() : yawRotation(this.yaw),
        yaw: this.yaw,
        speed: this.ragdoll.length ? 0 : Math.hypot(player.linvel().x, player.linvel().z),
        grounded: this.groundContact && !this.ragdoll.length,
        swing: clamp((this.swingUntil - this.time) / PLAY.swingSeconds, 0, 1),
        ragdoll: this.recoverTick ? (this.recoverTick - this.tick) * STEP_SECONDS : 0,
        parts: this.ragdoll.map(({ limb, body }) => ({ limb, ...pose(body) })),
        carrying: this.carrying?.id ?? null,
      },
      hook: {
        phase: this.hook.phase,
        position: this.hook.body?.translation() ?? null,
        charge: this.hook.charge,
        progress: this.hook.taps / this.hook.required,
        target: this.hook.target ? (isFish(this.hook.target) ? 'fish' : 'crate') : null,
      },
      fish: this.fish.map(({ id, body, kind, state, multiplier }) => ({ id, kind, state, multiplier, ...pose(body) })),
      crates: this.crates.map(({ id, body, state }) => ({ id, state, ...pose(body) })),
      cash: this.cash,
      sold: this.sold,
      notice: this.notice ? { ...this.notice } : null,
    };
  }

  dispose() {
    this.world.free();
  }

  private get time() {
    return this.tick * STEP_SECONDS;
  }

  private announce(text: string, tone: SimNotice['tone'] = 'info') {
    this.notice = { id: ++this.noticeId, text, tone };
  }

  private makeCrate(id: string, origin: Vec3, state: CrateView['state'], halfSize: number): Crate {
    const desc = state === 'floating' ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    const body = this.world.createRigidBody(desc.setTranslation(origin.x, origin.y, origin.z)
      .setCcdEnabled(true).setLinearDamping(0.1).setAngularDamping(0.8));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize)
      .setFriction(0.8).setRestitution(0.24).setDensity(id === 'training-crate' ? 3 : 0.68), body);
    return { id, body, state, looseAt: 0 };
  }

  private updatePlayer(input: SimInput) {
    const position = this.player.translation();
    const velocity = this.player.linvel();
    const moveLength = Math.max(1, Math.hypot(input.moveX, input.moveZ));
    const move = { x: input.moveX / moveLength, z: input.moveZ / moveLength };
    const focus = input.aim ? { x: input.aim.x - position.x, z: input.aim.z - position.z } : move;
    const focusLength = Math.hypot(focus.x, focus.z);
    if (focusLength > 0.05) {
      this.aim = { x: focus.x / focusLength, z: focus.z / focusLength };
      this.yaw = Math.atan2(-this.aim.x, -this.aim.z);
    }

    this.groundContact = position.y <= PLAYER_HEIGHT + 0.08 && Math.abs(velocity.y) < 0.7 && onLand(position);
    const easing = this.groundContact ? 0.36 : 0.12;
    const speed = PLAY.moveSpeed * (this.carrying ? 0.87 : 1);
    this.moveSpeed = Math.hypot(move.x, move.z) * speed;
    const jumping = input.jumpPressed && this.groundContact;
    this.player.setLinvel({
      x: velocity.x + (move.x * speed - velocity.x) * easing,
      y: jumping ? PLAY.jumpSpeed : velocity.y,
      z: velocity.z + (move.z * speed - velocity.z) * easing,
    }, true);
    if (jumping) this.groundContact = false;
  }

  private updateCastInput(input: SimInput) {
    if (input.castPressed && (this.hook.phase === 'bite' || this.hook.phase === 'reeling')) {
      this.reel();
    } else if (input.castPressed && this.hook.phase === 'idle' && !this.carrying) {
      this.hook.phase = 'charging';
    }
    if (this.hook.phase === 'charging') {
      if (input.castHeld) this.hook.charge = Math.min(1, this.hook.charge + STEP_SECONDS / FISHING.chargeSeconds);
      if (input.castReleased) this.cast(input.aim);
    }
  }

  private cast(aim: SimInput['aim']) {
    const position = this.player.translation();
    const origin = { x: position.x + this.aim.x * 0.45, y: position.y + 0.55, z: position.z + this.aim.z * 0.45 };
    const range = FISHING.minRange + (FISHING.maxRange - FISHING.minRange) * this.hook.charge;
    const travel = aim ? clamp(distance(position, aim), 0.8, range) : range;
    const destination = {
      x: position.x + this.aim.x * travel,
      y: ISLAND.seaY + 0.1,
      z: position.z + this.aim.z * travel,
    };
    const seconds = 0.38 + travel * 0.042;
    const velocity = launchVector(origin, destination, seconds);
    this.hook.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setCcdEnabled(true));
    this.world.createCollider(RAPIER.ColliderDesc.ball(0.1).setSensor(true), this.hook.body);
    this.hook.phase = 'flying';
    this.hook.deadline = this.time + seconds + 0.2;
  }

  private crateByHook() {
    const position = this.hook.body?.translation();
    if (!position) return null;
    return this.crates.find(({ body, state }) => {
      if (state === 'carried' || state === 'hooked') return false;
      const crate = body.translation();
      return distance(position, crate) < 0.74 && Math.abs(position.y - crate.y) < 0.68;
    }) ?? null;
  }

  private updateFlyingHook() {
    if (this.hook.phase !== 'flying' || !this.hook.body) return;
    const crate = this.crateByHook();
    if (crate) {
      this.latch(crate);
      return;
    }

    const position = this.hook.body.translation();
    const falling = this.hook.body.linvel().y <= 0;
    const landedOnBeach = falling && onLand(position) && position.y <= 0.11;
    if (falling && canFish(position) && position.y <= ISLAND.seaY + 0.14) {
      this.hook.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.hook.body.setTranslation({ ...position, y: ISLAND.seaY + 0.11 }, true);
      this.hook.phase = 'waiting';
      this.hook.deadline = this.time + FISHING.biteMin + this.random() * (FISHING.biteMax - FISHING.biteMin);
    } else if (landedOnBeach || this.time > this.hook.deadline) {
      this.clearHook();
      this.announce('空钩！瞄准岸外的海面', 'bad');
    }
  }

  private updateWaitingHook() {
    if (this.hook.phase === 'waiting' && this.hook.body) {
      const crate = this.crateByHook();
      if (crate) this.latch(crate);
      else this.updateSwimmer(this.hook.body.translation());
    }
    if ((this.hook.phase === 'bite' || this.hook.phase === 'reeling') && this.time > this.hook.deadline) {
      const wasCrate = this.hook.target && !isFish(this.hook.target);
      this.clearHook();
      this.announce(wasCrate ? '箱子从钩上滑掉了' : '手慢了，鱼扭头就走', 'bad');
    }
  }

  private updateSwimmer(bait: Vec3) {
    const seconds = this.hook.deadline - this.time;
    if (seconds > FISHING.approachSeconds) return;
    if (!this.hook.swimmer) {
      const direction = bait.x >= 0 ? 1 : -1;
      this.hook.swimmer = this.makeFish({ x: bait.x + direction * 1.55, y: bait.y - 0.1, z: bait.z - 0.52 });
    }
    const fish = this.hook.swimmer;
    const position = fish.body.translation();
    if (seconds <= 0 && distance(position, bait) < 0.35) {
      this.latch(fish);
      return;
    }
    const fraction = Math.min(1, STEP_SECONDS / Math.max(STEP_SECONDS, seconds));
    fish.body.setNextKinematicTranslation({
      x: position.x + (bait.x - position.x) * fraction,
      y: position.y + (bait.y - position.y) * fraction,
      z: position.z + (bait.z - position.z) * fraction,
    });
    fish.body.setNextKinematicRotation(yawRotation(Math.atan2(position.x - bait.x, position.z - bait.z)));
  }

  private makeFish(position: Vec3): Fish {
    let choice = this.random() * FISH_KINDS.reduce((total, kind) => total + FISH[kind].weight, 0);
    const kind = FISH_KINDS.find((kind) => (choice -= FISH[kind].weight) < 0) ?? FISH_KINDS[0];
    const { size } = FISH[kind];
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position.x, position.y, position.z).setCcdEnabled(true)
      .setLinearDamping(0.15).setAngularDamping(1.35));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(size * 0.22, size * 0.26, size * 0.42)
      .setFriction(0.72).setRestitution(0.27).setDensity(0.75), body);
    body.collider(0).setEnabled(false);
    const fish: Fish = {
      id: `fish-${++this.nextEntityId}`, kind, body, state: 'swimming', hits: 0,
      multiplier: 1, lastHit: -Infinity, lastTouch: null, wakeAt: 0, hopAt: 0,
    };
    this.fish.push(fish);
    return fish;
  }

  private latch(target: Fish | Crate) {
    if (!this.hook.body) return;
    const isCatch = isFish(target);
    if (this.hook.swimmer && this.hook.swimmer !== target) this.removeFish(this.hook.swimmer);
    this.hook.swimmer = null;
    this.hook.target = target;
    this.hook.phase = 'bite';
    this.hook.required = isCatch ? FISH[target.kind].taps : FISHING.crateTaps;
    this.hook.deadline = this.time + FISHING.lineSlackSeconds;
    this.hook.start = target.body.translation();
    target.state = 'hooked';
    target.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.hook.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.hook.body.setTranslation(this.hook.start, true);
    this.announce(isCatch ? `${FISH[target.kind].name}咬钩！连点收线` : '箱子上钩！连点拖上岸', 'good');
  }

  private reel() {
    const hook = this.hook;
    if (!hook.body || !hook.target || !hook.start) return;
    const target = hook.target;
    const position = this.player.translation();
    const direction = {
      x: hook.start.x - position.x,
      z: hook.start.z - position.z,
    };
    const length = Math.max(0.01, Math.hypot(direction.x, direction.z));
    const landing = {
      x: clamp(position.x + direction.x / length * 1.65, ISLAND.minX + 0.7, ISLAND.maxX - 0.7),
      y: 0.86,
      z: clamp(position.z + direction.z / length * 1.65, ISLAND.shoreZ + 1.12, ISLAND.backZ - 0.7),
    };

    hook.taps += 1;
    hook.deadline = this.time + FISHING.lineSlackSeconds;
    if (hook.taps >= hook.required) {
      target.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      target.body.setTranslation(landing, true);
      target.body.setRotation(yawRotation(this.yaw + 0.45), true);
      target.body.collider(0).setEnabled(true);
      if (isFish(target)) {
        target.state = 'flopping';
        target.lastTouch = PLAYER;
        target.hopAt = this.time + 0.46;
        target.body.setLinvel({ x: -direction.x / length, y: 2.5, z: 0.95 }, true);
        target.body.setAngvel({ x: 3.2, y: 2.4, z: 2.6 }, true);
        this.announce('鱼上岸了！趁它溜走前拍晕', 'good');
      } else {
        target.state = 'loose';
        target.body.setLinvel({ x: -direction.x / length, y: 1.7, z: 0.35 }, true);
        target.body.setAngvel({ x: 2.4, y: 0.8, z: 1.1 }, true);
        this.announce('今日福利：一只空箱');
      }
      this.clearHook(false);
      return;
    }

    hook.phase = 'reeling';
    const fraction = hook.taps / hook.required;
    const moved = {
      x: hook.start.x + (landing.x - hook.start.x) * fraction,
      y: ISLAND.seaY + 0.19 + 0.68 * fraction,
      z: hook.start.z + (landing.z - hook.start.z) * fraction,
    };
    if (onLand(moved)) moved.y = Math.max(moved.y, 0.5);
    hook.body.setNextKinematicTranslation(moved);
    target.body.setNextKinematicTranslation(moved);
  }

  private clearHook(release = true) {
    const { body, target, swimmer } = this.hook;
    if (swimmer) this.removeFish(swimmer);
    if (release && target) {
      if (isFish(target)) this.removeFish(target);
      else {
        const position = target.body.translation();
        if (onLand(position)) {
          target.state = 'loose';
          target.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        } else {
          target.state = 'floating';
          target.body.setTranslation({ ...position, y: ISLAND.supplyCrate.y }, true);
        }
      }
    }
    if (body) this.world.removeRigidBody(body);
    this.hook = newHook();
  }

  private swing() {
    if (this.time < this.swingUntil || this.carrying) return;
    this.swingUntil = this.time + PLAY.swingSeconds;
    const position = this.player.translation();
    let hit: Fish | undefined;
    let reach: number = PLAY.swingReach;
    for (const fish of this.fish) {
      if (fish.state !== 'flopping') continue;
      const point = fish.body.translation();
      const radius = distance(position, point);
      const dot = (point.x - position.x) * this.aim.x + (point.z - position.z) * this.aim.z;
      if (radius < reach && Math.abs(point.y - position.y) < 1.45 && (dot > 0.06 * radius || radius < 1.12)) {
        hit = fish;
        reach = radius;
      }
    }
    if (!hit) return;
    const point = hit.body.translation();
    const airborne = !this.groundContact || (point.y > 0.68 && hit.body.linvel().y > 0.6);
    const combo = this.time - hit.lastHit <= PLAY.comboWindow;
    hit.multiplier = Math.min(PLAY.maxMultiplier, hit.multiplier
      + (airborne ? PLAY.airBonus : 0) + (combo ? PLAY.comboBonus : 0));
    hit.lastTouch = PLAYER;
    hit.lastHit = this.time;
    hit.hits += 1;

    const stunned = hit.hits >= FISH[hit.kind].hits;
    hit.body.setLinvel({
      x: this.aim.x * (stunned ? 0.6 : 1.3),
      y: stunned ? 1.65 : 2.75,
      z: this.aim.z * (stunned ? 0.6 : 1.3),
    }, true);
    hit.body.setAngvel({ x: 5.7, y: 3.5, z: 2.2 }, true);
    if (stunned) {
      hit.state = 'stunned';
      hit.wakeAt = this.time + PLAY.stunSeconds;
      this.announce(`拍晕啦！近身按 E 搬鱼 · ×${hit.multiplier.toFixed(2)}`, 'good');
    } else {
      this.announce(`${airborne ? '空中拍鱼' : combo ? '连拍' : '拍中'}！${hit.hits}/${FISH[hit.kind].hits}`, 'good');
    }
  }

  private interact() {
    if (this.carrying) {
      this.throwCarried();
      return;
    }
    if (this.hook.phase !== 'idle') return;
    const position = this.player.translation();
    const eligible: (Fish | Crate)[] = [
      ...this.fish.filter((fish) => fish.state === 'stunned'),
      ...this.crates.filter((crate) => crate.state === 'loose'),
    ];
    const candidates = eligible
      .map((item) => ({ item, point: item.body.translation() }))
      .filter(({ point }) => distance(position, point) < PLAY.reach && Math.abs(position.y - point.y) < 1.65)
      .sort((a, b) => Number(isFish(b.item)) - Number(isFish(a.item))
        || distance(position, a.point) - distance(position, b.point));
    const item = candidates[0]?.item;
    if (!item) return;
    this.carrying = item;
    item.state = 'carried';
    item.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    item.body.collider(0).setEnabled(false);
    item.body.setTranslation(this.carryPoint(), true);
    if (isFish(item)) item.lastTouch = PLAYER;
    this.announce(isFish(item) ? '带到秤旁，准星对准秤按 E' : '箱子搬起来了 · E 扔出');
  }

  private carryPoint() {
    const position = this.player.translation();
    return { x: position.x + this.aim.x * 0.98, y: position.y + 0.46, z: position.z + this.aim.z * 0.98 };
  }

  private updateCarried() {
    if (!this.carrying) return;
    this.carrying.body.setNextKinematicTranslation(this.carryPoint());
    this.carrying.body.setNextKinematicRotation(yawRotation(this.yaw + Math.PI / 2));
  }

  private throwCarried() {
    const item = this.carrying;
    if (!item) return;
    this.carrying = null;
    const position = this.player.translation();
    const origin = this.carryPoint();
    const scaleDistance = distance(position, ISLAND.scale);
    const towardScale = (ISLAND.scale.x - position.x) * this.aim.x + (ISLAND.scale.z - position.z) * this.aim.z;
    const assist = isFish(item) && scaleDistance <= ISLAND.scale.aimAssistDistance
      && (scaleDistance < 0.6 || towardScale > scaleDistance * 0.58);
    const velocity = assist ? launchVector(origin, ISLAND.scale, 0.5)
      : { x: this.aim.x * 6.35, y: 4.85, z: this.aim.z * 6.35 };
    item.state = 'thrown';
    item.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    item.body.setTranslation(origin, true);
    item.body.setLinvel(velocity, true);
    item.body.setAngvel({ x: 4.6, y: 2.1, z: 1.7 }, true);
    item.body.collider(0).setEnabled(true);
    if (isFish(item)) item.wakeAt = this.time + PLAY.stunSeconds;
    else item.looseAt = this.time + 0.75;
  }

  private updateFloppingFish() {
    for (const fish of this.fish) {
      if ((fish.state === 'stunned' || fish.state === 'thrown') && this.time >= fish.wakeAt) {
        fish.state = 'flopping';
        fish.hits = 0;
        fish.multiplier = 1;
        this.announce('鱼醒了，正在逃班', 'bad');
      }
      if (fish.state !== 'flopping' || this.time < fish.hopAt) continue;
      const point = fish.body.translation();
      const velocity = fish.body.linvel();
      if (point.y > 0.48 || velocity.y > 0.25) continue;
      const wander = (this.random() - 0.5) * 2.65;
      fish.body.setLinvel({ x: wander, y: 3.9 + this.random() * 0.6, z: -1.58 }, true);
      fish.body.setAngvel({ x: 4.8, y: wander * 4, z: 3.1 }, true);
      fish.hopAt = this.time + 0.43;
    }
  }

  private updateOutcomes() {
    for (const fish of [...this.fish]) {
      const point = fish.body.translation();
      if (fish.state === 'thrown' && fish.lastTouch && distance(point, ISLAND.scale) <= ISLAND.scale.radius
        && Math.abs(point.y - ISLAND.scale.y) < 0.37) {
        const amount = Math.round(FISH[fish.kind].price * fish.multiplier);
        if (fish.lastTouch === PLAYER) {
          this.cash += amount;
          this.sold += 1;
        }
        this.removeFish(fish);
        this.announce(`入账 ¥${amount} · ${FISH[fish.kind].name} ×${fish.multiplier.toFixed(2)}`, 'good');
      } else if (fish.state !== 'hooked' && fish.state !== 'carried' && fish.state !== 'swimming'
        && point.y < ISLAND.seaY - 0.15) {
        this.removeFish(fish);
        this.announce('扑通！鱼溜回海里了', 'bad');
      } else if (fish.state === 'thrown' && fish.body.linvel().y <= 0.25 && point.y < 0.56 && onLand(point)) {
        fish.state = 'stunned';
      }
    }

    for (const crate of this.crates) {
      this.updateCrate(crate);
    }

    if (this.ragdoll.length) return;
    const position = this.player.translation();
    if (position.y < ISLAND.seaY - 0.27) {
      this.startRagdoll(null);
      this.announce('落水工伤，海浪马上送你回来', 'bad');
    }
  }

  private updateCrate(crate: Crate) {
    if (crate.state !== 'loose' && crate.state !== 'thrown') return;
    const point = crate.body.translation();
    const velocity = crate.body.linvel();
    if (point.y < ISLAND.seaY - 0.22) {
      crate.state = 'floating';
      crate.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      crate.body.setTranslation({ ...point, y: ISLAND.supplyCrate.y }, true);
      crate.body.setRotation(yawRotation(0), true);
      return;
    }
    if (crate.state === 'thrown' && this.time > crate.looseAt && point.y < 0.72 && Math.abs(velocity.y) < 0.6) {
      crate.state = 'loose';
    }
    if (this.ragdoll.length || this.time < this.nextTripAt) return;
    const player = this.player.translation();
    const playerVelocity = this.player.linvel();
    const runningInto = this.moveSpeed >= PLAY.crateTripSpeed
      && ((point.x - player.x) * playerVelocity.x + (point.z - player.z) * playerVelocity.z > 0.09);
    const thrownInto = crate.state === 'thrown' && Math.hypot(velocity.x, velocity.y, velocity.z) > 2.8;
    if ((runningInto || thrownInto) && distance(point, player) < 0.94 && Math.abs(point.y - player.y) < 0.85) {
      this.startRagdoll(crate);
      this.announce('箱子反击：工伤休息 2 秒', 'bad');
    }
  }

  private removeFish(fish: Fish) {
    this.world.removeRigidBody(fish.body);
    this.fish.splice(this.fish.indexOf(fish), 1);
  }

  private startRagdoll(crate: Crate | null) {
    if (this.carrying) this.throwCarried();
    this.clearHook();
    this.groundContact = false;
    const rawPosition = this.player.translation();
    const wet = !onLand(rawPosition, 0.35);
    const position = wet ? {
      x: clamp(rawPosition.x, ISLAND.minX + 0.65, ISLAND.maxX - 0.65),
      y: 0.96,
      z: clamp(rawPosition.z, ISLAND.shoreZ + 0.65, ISLAND.backZ - 0.65),
    } : rawPosition;
    const velocity = this.player.linvel();
    const away = crate ? crate.body.translation() : rawPosition;
    const direction = { x: position.x - away.x, z: position.z - away.z };
    const length = Math.max(0.35, Math.hypot(direction.x, direction.z));
    const launch = {
      x: (wet ? 0 : velocity.x * 0.28) + direction.x / length * 2.9,
      y: 3.8,
      z: (wet ? 0 : velocity.z * 0.28) + direction.z / length * 2.9,
    };
    this.player.setEnabled(false);
    this.recoverTick = this.tick + PLAY.ragdollSeconds * TICKS_PER_SECOND;
    const rotation = yawRotation(this.yaw);

    const addPart = (limb: RagdollLimb, offset: Vec3, collider: ColliderDesc) => {
      const cosine = Math.cos(this.yaw);
      const sine = Math.sin(this.yaw);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x + offset.x * cosine + offset.z * sine, position.y + offset.y,
          position.z - offset.x * sine + offset.z * cosine)
        .setRotation(rotation).setLinvel(launch.x, launch.y, launch.z)
        .setAngularDamping(1).setCcdEnabled(limb === 'torso'));
      this.world.createCollider(collider.setFriction(0.78).setRestitution(0.12), body);
      this.ragdoll.push({ limb, body });
      return body;
    };

    const torso = addPart('torso', { x: 0, y: 0, z: 0 }, RAPIER.ColliderDesc.cuboid(0.23, 0.31, 0.17));
    torso.setAngvel({ x: -2.9, y: 4.7, z: -4.5 }, true);

    const hangPart = (limb: RagdollLimb, offset: Vec3, collider: ColliderDesc, mount: Vec3, spin: number) => {
      const part = addPart(limb, offset, collider);
      const anchor = { x: mount.x - offset.x, y: mount.y - offset.y, z: mount.z - offset.z };
      const joint = this.world.createImpulseJoint(RAPIER.JointData.spherical(mount, anchor), torso, part, true);
      joint.setContactsEnabled(false);
      part.setAngvel({ x: spin, y: 2.9, z: -spin * 0.6 }, true);
    };

    hangPart('head', { x: 0, y: 0.51, z: 0 }, RAPIER.ColliderDesc.ball(0.225),
      { x: 0, y: 0.31, z: 0 }, 2.9);
    hangPart('leftArm', { x: -0.38, y: 0.08, z: 0 }, RAPIER.ColliderDesc.capsule(0.17, 0.09),
      { x: -0.21, y: 0.24, z: 0 }, -5.5);
    hangPart('rightArm', { x: 0.38, y: 0.08, z: 0 }, RAPIER.ColliderDesc.capsule(0.17, 0.09),
      { x: 0.21, y: 0.24, z: 0 }, 5.5);
    hangPart('leftLeg', { x: -0.15, y: -0.46, z: 0 }, RAPIER.ColliderDesc.capsule(0.15, 0.098),
      { x: -0.14, y: -0.30, z: 0 }, 4.1);
    hangPart('rightLeg', { x: 0.15, y: -0.46, z: 0 }, RAPIER.ColliderDesc.capsule(0.15, 0.098),
      { x: 0.14, y: -0.30, z: 0 }, -4.1);
  }

  private recover() {
    const torso = this.ragdoll[0].body.translation();
    for (const { body } of this.ragdoll) this.world.removeRigidBody(body);
    this.ragdoll = [];
    this.recoverTick = 0;
    this.nextTripAt = this.time + 0.9;
    this.player.setEnabled(true);
    this.player.setTranslation(onLand(torso, 0.45)
      ? { x: torso.x, y: ISLAND.spawn.y, z: torso.z }
      : ISLAND.spawn, true);
    this.player.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.announce('工伤结束，继续打工');
  }
}
