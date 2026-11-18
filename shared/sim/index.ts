import RAPIER, { type ColliderDesc, type RigidBody } from '@dimforge/rapier3d-compat';
import { createBotController } from './bots';
import { seededRandom } from './random';
import { CREW, FISH, FISHING, ISLAND, PLAY, SHIFT, STEP_SECONDS, TICKS_PER_SECOND } from './config';
import type {
  CrateView, FishKind, FishState, HookPhase, HookView, PlayerView, Pose, RagdollLimb, Rotation,
  ShiftResult, SimInput, SimNotice, SimSnapshot, Vec3,
} from './types';

interface SimulationOptions {
  seed?: string;
  day?: number;
  shiftSeconds?: number;
}

interface Fish {
  id: string;
  kind: FishKind;
  body: RigidBody;
  state: FishState;
  hits: number;
  lastHit: number;
  lastTouch: string | null;
  caughtBy: string;
  carrierId: string | null;
  baitPlayerId: string | null;
  grabAgainAt: number;
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
  bait: Actor | null;
  baitPlayerId: string | null;
  baitLanding: Vec3 | null;
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

interface Actor {
  id: string;
  name: string;
  bot: boolean;
  spawn: Vec3;
  body: RigidBody;
  random: () => number;
  yaw: number;
  aim: Direction;
  groundContact: boolean;
  moveSpeed: number;
  swingUntil: number;
  ragdoll: RagdollBody[];
  recoverTick: number;
  nextTripAt: number;
  carrying: Fish | Crate | null;
  hook: Hook;
  baitedBy: Actor | null;
  cash: number;
  sold: number;
  shiftCash: number;
  shiftSold: number;
  optimization: boolean;
}

const PLAYER_RADIUS = 0.31;
const PLAYER_HALF_HEIGHT = 0.45;
const PLAYER_HEIGHT = PLAYER_RADIUS + PLAYER_HALF_HEIGHT;
const FISH_KINDS = Object.keys(FISH) as FishKind[];
const FISHING_SHORE_Z = ISLAND.shoreZ - 0.12;

let rapierReady: Promise<void> | undefined;

export async function createSimulation(options: SimulationOptions = {}) {
  rapierReady ??= RAPIER.init();
  await rapierReady;
  return new IslandSimulation(options);
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
  return position.z < FISHING_SHORE_Z && position.z >= FISHING.minFishingZ
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
    target: null, swimmer: null, bait: null, baitPlayerId: null, baitLanding: null, start: null, deadline: 0,
  };
}

class IslandSimulation {
  private readonly world = new RAPIER.World({ x: 0, y: -PLAY.gravity, z: 0 });
  private readonly actors: Actor[];
  private readonly crates: Crate[];
  private readonly fish: Fish[] = [];
  private readonly seed: string;
  private readonly random: () => number;
  private readonly bots: ReturnType<typeof createBotController>;
  private readonly shiftLength: number;
  private day: number;
  private shiftEnd: number;
  private result: ShiftResult | null = null;
  private tick = 0;
  private nextEntityId = 0;
  private notice: SimNotice | null = null;
  private noticeId = 0;

  constructor({ seed = 'dock-shift', day = 1, shiftSeconds = PLAY.daySeconds }: SimulationOptions) {
    this.seed = seed;
    this.day = Number.isFinite(day) ? Math.max(1, Math.trunc(day)) : 1;
    this.random = seededRandom(`${seed}:world`);
    this.bots = createBotController(seed);
    const seconds = Number.isFinite(shiftSeconds) ? clamp(shiftSeconds, SHIFT.shortestSeconds, PLAY.daySeconds) : PLAY.daySeconds;
    this.shiftLength = Math.round(seconds * TICKS_PER_SECOND);
    this.shiftEnd = this.shiftLength;
    this.world.timestep = STEP_SECONDS;

    const halfX = (ISLAND.maxX - ISLAND.minX) / 2;
    const halfZ = (ISLAND.backZ - ISLAND.shoreZ) / 2;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(halfX, 0.5, halfZ)
      .setTranslation(ISLAND.minX + halfX, ISLAND.groundY - 0.5, ISLAND.shoreZ + halfZ)
      .setFriction(0.85));
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.22, 0.7)
      .setTranslation(ISLAND.scale.x, 0.22, ISLAND.scale.z)
      .setFriction(0.75));

    this.actors = CREW.map((worker) => this.makeActor(worker));
    this.crates = [
      this.makeCrate('supply-crate', ISLAND.supplyCrate, 'floating', 0.43),
      this.makeCrate('training-crate', ISLAND.trainingCrate, 'loose', 0.52),
    ];
  }

  step(input: SimInput, overrides: Readonly<Record<string, SimInput>> = {}) {
    const previous = this.actors.some((actor) => actor.bot && !overrides[actor.id]) ? this.snapshot() : null;
    const inputs = this.actors.map((actor, index) => {
      if (!actor.bot) return input;
      return overrides[actor.id] ?? this.bots.input(previous!, previous!.players[index]);
    });

    this.tick += 1;
    for (const [index, actor] of this.actors.entries()) {
      if (actor.recoverTick !== 0 && this.tick >= actor.recoverTick) this.recover(actor);
      if (actor.ragdoll.length) continue;
      const actorInput = inputs[index];
      this.updatePlayer(actor, actorInput);
      if (actor.baitedBy) continue;
      this.updateCastInput(actor, actorInput);
      if (actorInput.swingPressed) this.swing(actor);
      if (actorInput.interactPressed) this.interact(actor);
    }

    for (const actor of this.actors) {
      this.updateWaitingHook(actor);
      this.updateCarried(actor);
    }
    this.updateFloppingFish();
    this.world.step();
    for (const actor of this.actors) this.updateFlyingHook(actor);
    this.updateOutcomes();
    if (this.tick >= this.shiftEnd) this.settleShift();
  }

  snapshot(): SimSnapshot {
    const players = this.actors.map((actor) => this.viewActor(actor));
    const player = players[0];
    return {
      tick: this.tick,
      time: this.time,
      day: this.day,
      seed: this.seed,
      player,
      players,
      hook: player.hook,
      shiftRemaining: (this.shiftEnd - this.tick) * STEP_SECONDS,
      result: this.result && { ...this.result, ranking: this.result.ranking.map((entry) => ({ ...entry })) },
      fish: this.fish.map(({ id, body, kind, state, multiplier, caughtBy, carrierId, baitPlayerId }) =>
        ({ id, kind, state, multiplier, caughtBy, carrierId, baitPlayerId, ...pose(body) })),
      crates: this.crates.map(({ id, body, state }) => ({ id, state, ...pose(body) })),
      cash: player.cash,
      sold: player.sold,
      notice: this.notice && { ...this.notice },
    };
  }

  dispose() {
    this.world.free();
  }

  private get time() {
    return this.tick * STEP_SECONDS;
  }

  private announce(actor: Actor, text: string, tone: SimNotice['tone'] = 'info', other?: Actor) {
    if (actor.bot && other?.bot !== false) return;
    this.notice = { id: ++this.noticeId, text, tone };
  }

  private makeActor({ id, name, bot, spawn }: (typeof CREW)[number]): Actor {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z).setCcdEnabled(true).lockRotations());
    this.world.createCollider(RAPIER.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS)
      .setFriction(0.02).setDensity(2), body);
    return {
      id, name, bot, spawn, body,
      random: seededRandom(bot ? `${this.seed}:${id}` : this.seed),
      yaw: 0, aim: { x: 0, z: -1 }, groundContact: true, moveSpeed: 0, swingUntil: 0,
      ragdoll: [], recoverTick: 0, nextTripAt: 0, carrying: null, hook: newHook(),
      baitedBy: null, cash: 0, sold: 0, shiftCash: 0, shiftSold: 0, optimization: false,
    };
  }

  private viewActor(actor: Actor): PlayerView {
    const { id, name, bot, cash, sold, shiftCash, shiftSold, optimization, yaw, ragdoll } = actor;
    const body = ragdoll[0]?.body ?? actor.body;
    const hook = actor.hook;
    const target: HookView['target'] = hook.bait ? 'player' : hook.target ? (isFish(hook.target) ? 'fish' : 'crate') : null;
    return {
      ...pose(body),
      id, name, bot, cash, sold, shiftCash, shiftSold, optimization, yaw,
      baitedBy: actor.baitedBy?.id ?? null,
      rotation: ragdoll.length ? body.rotation() : yawRotation(yaw),
      speed: ragdoll.length ? 0 : Math.hypot(body.linvel().x, body.linvel().z),
      grounded: actor.groundContact && !ragdoll.length,
      swing: clamp((actor.swingUntil - this.time) / PLAY.swingSeconds, 0, 1),
      ragdoll: actor.recoverTick ? (actor.recoverTick - this.tick) * STEP_SECONDS : 0,
      parts: ragdoll.map(({ limb, body }) => ({ limb, ...pose(body) })),
      carrying: actor.carrying?.id ?? null,
      hook: {
        phase: hook.phase,
        position: hook.body?.translation() ?? null,
        charge: hook.charge,
        progress: hook.taps / hook.required,
        target,
        targetId: hook.bait?.id ?? hook.target?.id ?? null,
      },
    };
  }

  private settleShift() {
    // Array sort is stable, so ties on both values use the crew’s joining order.
    const ordered = [...this.actors].sort((a, b) => b.shiftCash - a.shiftCash || b.shiftSold - a.shiftSold);
    this.result = {
      day: this.day,
      showUntil: this.time + SHIFT.resultSeconds,
      ranking: ordered.map((actor, index) => ({
        id: actor.id, name: actor.name, bot: actor.bot, rank: index + 1,
        revenue: actor.shiftCash, sold: actor.shiftSold,
        bonus: index === 0 ? SHIFT.bonus : 0,
        optimization: index === ordered.length - 1,
      })),
    };
    for (const [index, actor] of ordered.entries()) {
      if (index === 0) actor.cash += SHIFT.bonus;
      actor.optimization = index === ordered.length - 1;
      actor.shiftCash = 0;
      actor.shiftSold = 0;
    }
    this.day += 1;
    this.shiftEnd += this.shiftLength;
  }

  private makeCrate(id: string, origin: Vec3, state: CrateView['state'], halfSize: number): Crate {
    const desc = state === 'floating' ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    const body = this.world.createRigidBody(desc.setTranslation(origin.x, origin.y, origin.z)
      .setCcdEnabled(true).setLinearDamping(0.1).setAngularDamping(0.8));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize)
      .setFriction(0.8).setRestitution(0.24).setDensity(id === 'training-crate' ? 3 : 0.68), body);
    return { id, body, state, looseAt: 0 };
  }

  private updatePlayer(actor: Actor, input: SimInput) {
    const position = actor.body.translation();
    const velocity = actor.body.linvel();
    const moveLength = Math.max(1, Math.hypot(input.moveX, input.moveZ));
    const move = { x: input.moveX / moveLength, z: input.moveZ / moveLength };
    const focus = input.aim ? { x: input.aim.x - position.x, z: input.aim.z - position.z } : move;
    const focusLength = Math.hypot(focus.x, focus.z);
    if (focusLength > 0.05) {
      actor.aim = { x: focus.x / focusLength, z: focus.z / focusLength };
      actor.yaw = Math.atan2(-actor.aim.x, -actor.aim.z);
    }

    actor.groundContact = position.y <= PLAYER_HEIGHT + 0.08 && Math.abs(velocity.y) < 0.7 && onLand(position);
    const easing = actor.groundContact ? 0.36 : 0.12;
    const penalty = actor.optimization ? SHIFT.optimizationSpeed : 1;
    const speed = actor.baitedBy ? 0 : PLAY.moveSpeed * penalty * (actor.carrying ? 0.87 : 1);
    actor.moveSpeed = Math.hypot(move.x, move.z) * speed;
    const jumping = input.jumpPressed && actor.groundContact && !actor.baitedBy;
    actor.body.setLinvel({
      x: velocity.x + (move.x * speed - velocity.x) * easing,
      y: jumping ? PLAY.jumpSpeed : velocity.y,
      z: velocity.z + (move.z * speed - velocity.z) * easing,
    }, true);
    if (jumping) actor.groundContact = false;
  }

  private updateCastInput(actor: Actor, input: SimInput) {
    if (actor.hook.phase === 'bait' && input.castPressed) {
      this.launchBait(actor, input.aim);
      return;
    }
    if (input.castPressed && (actor.hook.phase === 'bite' || actor.hook.phase === 'reeling')) {
      this.reel(actor);
    } else if (input.castPressed && actor.hook.phase === 'idle' && !actor.carrying) {
      actor.hook.phase = 'charging';
    }
    if (actor.hook.phase === 'charging') {
      if (input.castHeld) actor.hook.charge = Math.min(1, actor.hook.charge + STEP_SECONDS / FISHING.chargeSeconds);
      if (input.castReleased) this.cast(actor, input.aim);
    }
  }

  private cast(actor: Actor, aim: SimInput['aim']) {
    const position = actor.body.translation();
    const origin = { x: position.x + actor.aim.x * 0.45, y: position.y + 0.55, z: position.z + actor.aim.z * 0.45 };
    const range = FISHING.minRange + (FISHING.maxRange - FISHING.minRange) * actor.hook.charge;
    const travel = aim ? clamp(distance(position, aim), 0.8, range) : range;
    const destination = {
      x: position.x + actor.aim.x * travel,
      y: ISLAND.seaY + 0.1,
      z: position.z + actor.aim.z * travel,
    };
    const seconds = 0.38 + travel * 0.042;
    const velocity = launchVector(origin, destination, seconds);
    actor.hook.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setCcdEnabled(true));
    this.world.createCollider(RAPIER.ColliderDesc.ball(0.1).setSensor(true), actor.hook.body);
    actor.hook.phase = 'flying';
    actor.hook.deadline = this.time + seconds + 0.2;
  }

  private crateByHook(actor: Actor) {
    const position = actor.hook.body?.translation();
    if (!position) return null;
    return this.crates.find(({ body, state }) => {
      if (state === 'carried' || state === 'hooked') return false;
      const crate = body.translation();
      return distance(position, crate) < 0.74 && Math.abs(position.y - crate.y) < 0.68;
    }) ?? null;
  }

  private latchBait(owner: Actor, target: Actor) {
    const hook = owner.hook;
    if (!hook.body) return;
    hook.bait = target;
    hook.phase = 'bait';
    hook.deadline = this.time + FISHING.teammateSlackSeconds;
    target.baitedBy = owner;
    this.clearHook(target);
    hook.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    hook.body.setTranslation(this.baitPosition(target), true);
    this.announce(owner, owner.bot ? `${owner.name}把你钩住了！` : `钩住了${target.name}！朝海点一下当鱼饵`,
      owner.bot ? 'bad' : 'good', target);
  }

  private baitPosition(actor: Actor) {
    const torso = actor.ragdoll[0]?.body ?? actor.body;
    const position = torso.translation();
    return { ...position, y: position.y + 0.35 };
  }

  private launchBait(owner: Actor, aim: SimInput['aim']) {
    const hook = owner.hook;
    const target = hook.bait;
    if (!target || !hook.body) return;
    if (!aim || aim.z >= FISHING_SHORE_Z) {
      this.announce(owner, '先朝海面瞄准，再点左键抛队友', 'info');
      return;
    }

    const origin = target.body.translation();
    const landing = {
      x: clamp(aim.x, -FISHING.maxFishingX, FISHING.maxFishingX),
      y: ISLAND.seaY + 0.11,
      z: Math.max(aim.z, FISHING.minFishingZ),
    };
    const seconds = clamp(0.67 + distance(origin, landing) * 0.018, 0.72, 1.02);
    hook.baitPlayerId = target.id;
    hook.baitLanding = landing;
    hook.phase = 'flying';
    hook.deadline = this.time + seconds;
    this.startRagdoll(target, null, launchVector(origin, landing, seconds));
    this.announce(owner, owner.bot ? `${owner.name}把你抛进海里当鱼饵！` : `${target.name}牌活饵，专钓大鱼！`,
      owner.bot ? 'bad' : 'good', target);
  }

  private updateFlyingHook(actor: Actor) {
    const hook = actor.hook;
    if (hook.phase !== 'flying' || !hook.body) return;

    if (hook.bait && hook.baitLanding) {
      if (this.time < hook.deadline) {
        hook.body.setNextKinematicTranslation(this.baitPosition(hook.bait));
        return;
      }
      hook.bait.baitedBy = null;
      hook.bait = null;
      const landing = hook.baitLanding;
      hook.baitLanding = null;
      hook.body.setTranslation(landing, true);
      hook.phase = 'waiting';
      hook.deadline = this.time + FISHING.baitBiteSeconds;
      return;
    }

    const position = hook.body.translation();
    const falling = hook.body.linvel().y <= 0;
    const teammate = falling && this.actors.find((other) => {
      if (other === actor || other.baitedBy || other.ragdoll.length) return false;
      const point = other.body.translation();
      return distance(position, point) < FISHING.teammateHookRadius && Math.abs(position.y - point.y) < 0.7;
    });
    if (teammate) {
      this.latchBait(actor, teammate);
      return;
    }
    const crate = this.crateByHook(actor);
    if (crate) {
      this.latch(actor, crate);
      return;
    }

    const landedOnBeach = falling && onLand(position) && position.y <= 0.11;
    if (falling && canFish(position) && position.y <= ISLAND.seaY + 0.14) {
      hook.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      hook.body.setTranslation({ ...position, y: ISLAND.seaY + 0.11 }, true);
      hook.phase = 'waiting';
      hook.deadline = this.time + FISHING.biteMin + actor.random() * (FISHING.biteMax - FISHING.biteMin);
    } else if (landedOnBeach || this.time > hook.deadline) {
      this.clearHook(actor);
      this.announce(actor, '空钩！瞄准岸外的海面', 'bad');
    }
  }

  private updateWaitingHook(actor: Actor) {
    const hook = actor.hook;
    if (hook.phase === 'bait' && hook.bait && hook.body) {
      if (this.time > hook.deadline || hook.bait.ragdoll.length) {
        this.clearHook(actor);
        this.announce(actor, '队友挣开鱼线了');
      } else {
        hook.body.setNextKinematicTranslation(this.baitPosition(hook.bait));
      }
    }
    if (hook.phase === 'waiting' && hook.body) {
      const crate = !hook.baitPlayerId && this.crateByHook(actor);
      if (crate) this.latch(actor, crate);
      else this.updateSwimmer(actor, hook.body.translation());
    }
    if ((hook.phase === 'bite' || hook.phase === 'reeling') && this.time > hook.deadline) {
      const wasCrate = hook.target && !isFish(hook.target);
      this.clearHook(actor);
      this.announce(actor, wasCrate ? '箱子从钩上滑掉了' : '手慢了，鱼扭头就走', 'bad');
    }
  }

  private updateSwimmer(actor: Actor, bait: Vec3) {
    const seconds = actor.hook.deadline - this.time;
    if (seconds > FISHING.approachSeconds) return;
    if (!actor.hook.swimmer) {
      const direction = bait.x >= 0 ? 1 : -1;
      actor.hook.swimmer = this.makeFish(actor, { x: bait.x + direction * 1.55, y: bait.y - 0.1, z: bait.z - 0.52 });
    }
    const fish = actor.hook.swimmer;
    const position = fish.body.translation();
    if (seconds <= 0 && distance(position, bait) < 0.35) {
      this.latch(actor, fish);
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

  private makeFish(actor: Actor, position: Vec3): Fish {
    const baitPlayerId = actor.hook.baitPlayerId;
    const weight = (kind: FishKind) => baitPlayerId ? FISHING.baitWeights[kind] : FISH[kind].weight;
    let choice = actor.random() * FISH_KINDS.reduce((total, kind) => total + weight(kind), 0);
    const kind = FISH_KINDS.find((kind) => (choice -= weight(kind)) < 0) ?? FISH_KINDS[0];
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
      caughtBy: actor.id, carrierId: null, baitPlayerId, grabAgainAt: 0,
    };
    this.fish.push(fish);
    return fish;
  }

  private latch(actor: Actor, target: Fish | Crate) {
    if (!actor.hook.body) return;
    const isCatch = isFish(target);
    if (actor.hook.swimmer && actor.hook.swimmer !== target) this.removeFish(actor.hook.swimmer);
    actor.hook.swimmer = null;
    actor.hook.target = target;
    actor.hook.phase = 'bite';
    actor.hook.required = isCatch ? FISH[target.kind].taps : FISHING.crateTaps;
    actor.hook.deadline = this.time + FISHING.lineSlackSeconds;
    actor.hook.start = target.body.translation();
    target.state = 'hooked';
    target.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    actor.hook.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    actor.hook.body.setTranslation(actor.hook.start, true);
    this.announce(actor, isCatch ? `${FISH[target.kind].name}咬钩！连点收线` : '箱子上钩！连点拖上岸', 'good');
  }

  private reel(actor: Actor) {
    const hook = actor.hook;
    if (!hook.body || !hook.target || !hook.start) return;
    const target = hook.target;
    const position = actor.body.translation();
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
      target.body.setRotation(yawRotation(actor.yaw + 0.45), true);
      target.body.collider(0).setEnabled(true);
      if (isFish(target)) {
        target.state = 'flopping';
        this.touchFish(target, actor);
        target.hopAt = this.time + 0.46;
        target.body.setLinvel({ x: -direction.x / length, y: 2.5, z: 0.95 }, true);
        target.body.setAngvel({ x: 3.2, y: 2.4, z: 2.6 }, true);
        this.announce(actor, '鱼上岸了！趁它溜走前拍晕', 'good');
      } else {
        target.state = 'loose';
        target.body.setLinvel({ x: -direction.x / length, y: 1.7, z: 0.35 }, true);
        target.body.setAngvel({ x: 2.4, y: 0.8, z: 1.1 }, true);
        this.announce(actor, '今日福利：一只空箱');
      }
      this.clearHook(actor, false);
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

  private clearHook(actor: Actor, release = true) {
    const { body, target, swimmer, bait } = actor.hook;
    if (bait?.baitedBy === actor) bait.baitedBy = null;
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
    actor.hook = newHook();
  }

  private swing(actor: Actor) {
    if (this.time < actor.swingUntil || actor.carrying) return;
    actor.swingUntil = this.time + PLAY.swingSeconds;
    const position = actor.body.translation();
    let hit: Fish | undefined;
    let reach: number = PLAY.swingReach;
    for (const fish of this.fish) {
      if (fish.state !== 'flopping') continue;
      const point = fish.body.translation();
      const radius = distance(position, point);
      const dot = (point.x - position.x) * actor.aim.x + (point.z - position.z) * actor.aim.z;
      if (radius < reach && Math.abs(point.y - position.y) < 1.45 && (dot > 0.06 * radius || radius < 1.12)) {
        hit = fish;
        reach = radius;
      }
    }
    let teammate: Actor | null = null;
    for (const other of this.actors) {
      if (other === actor || other.ragdoll.length || this.time < other.nextTripAt) continue;
      const point = other.body.translation();
      const radius = distance(position, point);
      const dot = (point.x - position.x) * actor.aim.x + (point.z - position.z) * actor.aim.z;
      if (radius < reach && Math.abs(point.y - position.y) < 1.45 && dot > PLAY.friendlyArc * radius) {
        teammate = other;
        reach = radius;
      }
    }
    if (teammate) {
      const point = teammate.body.translation();
      const length = Math.max(0.2, distance(position, point));
      this.startRagdoll(teammate, null, {
        x: (point.x - position.x) / length * PLAY.friendlyKnockback,
        y: 3.8,
        z: (point.z - position.z) / length * PLAY.friendlyKnockback,
      });
      this.announce(actor, actor.bot ? `${actor.name}把你一桨拍飞！` : `一桨拍飞了${teammate.name}！`, 'bad', teammate);
      return;
    }
    if (!hit) return;
    const point = hit.body.translation();
    const airborne = !actor.groundContact || (point.y > 0.68 && hit.body.linvel().y > 0.6);
    const combo = this.time - hit.lastHit <= PLAY.comboWindow;
    hit.multiplier = Math.min(PLAY.maxMultiplier, hit.multiplier
      + (airborne ? PLAY.airBonus : 0) + (combo ? PLAY.comboBonus : 0));
    this.touchFish(hit, actor);
    hit.lastHit = this.time;
    hit.hits += 1;

    const stunned = hit.hits >= FISH[hit.kind].hits;
    hit.body.setLinvel({
      x: actor.aim.x * (stunned ? 0.6 : 1.3),
      y: stunned ? 1.65 : 2.75,
      z: actor.aim.z * (stunned ? 0.6 : 1.3),
    }, true);
    hit.body.setAngvel({ x: 5.7, y: 3.5, z: 2.2 }, true);
    if (stunned) {
      hit.state = 'stunned';
      hit.wakeAt = this.time + PLAY.stunSeconds;
      this.announce(actor, `拍晕啦！近身按 E 搬鱼 · ×${hit.multiplier.toFixed(2)}`, 'good');
    } else {
      this.announce(actor, `${airborne ? '空中拍鱼' : combo ? '连拍' : '拍中'}！${hit.hits}/${FISH[hit.kind].hits}`, 'good');
    }
  }

  private interact(actor: Actor) {
    if (actor.carrying) {
      this.throwCarried(actor);
      return;
    }
    if (actor.hook.phase !== 'idle') return;

    const position = actor.body.translation();
    const fishToGrab = this.fish.filter((fish) => fish.state === 'stunned' || fish.state === 'thrown'
      || (fish.state === 'carried' && this.time >= fish.grabAgainAt));
    const eligible: (Fish | Crate)[] = [...fishToGrab, ...this.crates.filter((crate) => crate.state === 'loose')];
    const candidates = eligible.flatMap((item) => {
      const point = item.body.translation();
      const radius = distance(position, point);
      if (radius >= PLAY.reach || Math.abs(position.y - point.y) >= 1.65) return [];
      const dot = (point.x - position.x) * actor.aim.x + (point.z - position.z) * actor.aim.z;
      if (isFish(item) && item.state !== 'stunned' && radius > 0.68 && dot < 0.18 * radius) return [];
      return [{ item, score: radius - 0.45 * dot }];
    }).sort((a, b) => Number(isFish(b.item)) - Number(isFish(a.item)) || a.score - b.score);
    const item = candidates[0]?.item;
    if (!item) return;

    const previousTouch = isFish(item) ? item.lastTouch : null;
    const victim = isFish(item) && item.carrierId ? this.actors.find(({ id }) => id === item.carrierId) : null;
    const intercepted = isFish(item) && item.state === 'thrown' && previousTouch !== actor.id;
    if (victim?.carrying === item) victim.carrying = null;
    actor.carrying = item;
    item.state = 'carried';
    item.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    item.body.collider(0).setEnabled(false);
    item.body.setTranslation(this.carryPoint(actor), true);

    if (!isFish(item)) {
      this.announce(actor, '箱子搬起来了 · E 扔出');
      return;
    }
    item.carrierId = actor.id;
    item.grabAgainAt = this.time + PLAY.stealGrace;
    this.touchFish(item, actor);
    if (item.baitPlayerId === actor.id) {
      this.announce(actor, '这条鱼用你当饵，你的绩效不计', 'info');
    } else if (victim) {
      this.announce(actor, actor.bot ? `${actor.name}从你手里抢走了鱼！` : `从${victim.name}手里抢到鱼！`,
        actor.bot ? 'bad' : 'good', victim);
    } else if (intercepted) {
      this.announce(actor, actor.bot ? `${actor.name}半空截走了你的鱼！` : '半空截胡！鱼到你手里了',
        actor.bot ? 'bad' : 'good', this.actors.find(({ id }) => id === previousTouch));
    } else {
      this.announce(actor, '带到秤旁，准星对准秤按 E');
    }
  }

  private touchFish(fish: Fish, actor: Actor) {
    if (fish.baitPlayerId !== actor.id) fish.lastTouch = actor.id;
  }

  private carryPoint(actor: Actor) {
    const position = actor.body.translation();
    return { x: position.x + actor.aim.x * 0.98, y: position.y + 0.46, z: position.z + actor.aim.z * 0.98 };
  }

  private updateCarried(actor: Actor) {
    if (!actor.carrying) return;
    actor.carrying.body.setNextKinematicTranslation(this.carryPoint(actor));
    actor.carrying.body.setNextKinematicRotation(yawRotation(actor.yaw + Math.PI / 2));
  }

  private throwCarried(actor: Actor) {
    const item = actor.carrying;
    if (!item) return;
    actor.carrying = null;
    const position = actor.body.translation();
    const origin = this.carryPoint(actor);
    const scaleDistance = distance(position, ISLAND.scale);
    const towardScale = (ISLAND.scale.x - position.x) * actor.aim.x + (ISLAND.scale.z - position.z) * actor.aim.z;
    const assist = isFish(item) && scaleDistance <= ISLAND.scale.aimAssistDistance
      && (scaleDistance < 0.6 || towardScale > scaleDistance * 0.58);
    const velocity = assist ? launchVector(origin, ISLAND.scale, 0.5)
      : { x: actor.aim.x * 6.35, y: 4.85, z: actor.aim.z * 6.35 };
    item.state = 'thrown';
    item.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    item.body.setTranslation(origin, true);
    item.body.setLinvel(velocity, true);
    item.body.setAngvel({ x: 4.6, y: 2.1, z: 1.7 }, true);
    item.body.collider(0).setEnabled(true);
    if (isFish(item)) {
      item.carrierId = null;
      item.wakeAt = this.time + PLAY.stunSeconds;
      this.touchFish(item, actor);
    } else item.looseAt = this.time + 0.75;
  }

  private updateFloppingFish() {
    for (const fish of this.fish) {
      if ((fish.state === 'stunned' || fish.state === 'thrown') && this.time >= fish.wakeAt) {
        fish.state = 'flopping';
        fish.hits = 0;
        fish.multiplier = 1;
        const lastTouch = this.actors.find(({ id }) => id === fish.lastTouch);
        if (lastTouch) this.announce(lastTouch, '鱼醒了，正在逃班', 'bad');
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
        const worker = this.actors.find(({ id }) => id === fish.lastTouch);
        if (worker) {
          worker.cash += amount;
          worker.sold += 1;
          worker.shiftCash += amount;
          worker.shiftSold += 1;
          this.announce(worker, `入账 ¥${amount} · ${FISH[fish.kind].name} ×${fish.multiplier.toFixed(2)}`, 'good');
        }
        this.removeFish(fish);
      } else if (fish.state !== 'hooked' && fish.state !== 'carried' && fish.state !== 'swimming'
        && point.y < ISLAND.seaY - 0.15) {
        this.removeFish(fish);
        const worker = this.actors.find(({ id }) => id === fish.lastTouch);
        if (worker) this.announce(worker, '扑通！鱼溜回海里了', 'bad');
      } else if (fish.state === 'thrown' && fish.body.linvel().y <= 0.25 && point.y < 0.56 && onLand(point)) {
        fish.state = 'stunned';
      }
    }

    for (const crate of this.crates) {
      this.updateCrate(crate);
    }

    for (const actor of this.actors) {
      if (!actor.ragdoll.length && actor.body.translation().y < ISLAND.seaY - 0.27) {
        this.startRagdoll(actor, null);
        this.announce(actor, '落水工伤，海浪马上送你回来', 'bad');
      }
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
    const thrownInto = crate.state === 'thrown' && Math.hypot(velocity.x, velocity.y, velocity.z) > 2.8;
    for (const actor of this.actors) {
      if (actor.ragdoll.length || this.time < actor.nextTripAt) continue;
      const player = actor.body.translation();
      const playerVelocity = actor.body.linvel();
      const runningInto = actor.moveSpeed >= PLAY.crateTripSpeed
        && ((point.x - player.x) * playerVelocity.x + (point.z - player.z) * playerVelocity.z > 0.09);
      if ((runningInto || thrownInto) && distance(point, player) < 0.94 && Math.abs(point.y - player.y) < 0.85) {
        this.startRagdoll(actor, point);
        this.announce(actor, '箱子反击：工伤休息 2 秒', 'bad');
      }
    }
  }

  private removeFish(fish: Fish) {
    const index = this.fish.indexOf(fish);
    if (index === -1) return;
    this.world.removeRigidBody(fish.body);
    this.fish.splice(index, 1);
  }

  private startRagdoll(actor: Actor, source: Vec3 | null, force?: Vec3) {
    if (actor.carrying) this.throwCarried(actor);
    this.clearHook(actor);
    actor.groundContact = false;
    const rawPosition = actor.body.translation();
    const wet = !onLand(rawPosition, 0.35);
    const position = wet ? {
      x: clamp(rawPosition.x, ISLAND.minX + 0.65, ISLAND.maxX - 0.65),
      y: 0.96,
      z: clamp(rawPosition.z, ISLAND.shoreZ + 0.65, ISLAND.backZ - 0.65),
    } : rawPosition;
    const velocity = actor.body.linvel();
    const away = source ?? rawPosition;
    const direction = { x: position.x - away.x, z: position.z - away.z };
    const length = Math.max(0.35, Math.hypot(direction.x, direction.z));
    const launch = force ?? {
      x: (wet ? 0 : velocity.x * 0.28) + direction.x / length * 2.9,
      y: 3.8,
      z: (wet ? 0 : velocity.z * 0.28) + direction.z / length * 2.9,
    };
    actor.body.setEnabled(false);
    actor.recoverTick = this.tick + PLAY.ragdollSeconds * TICKS_PER_SECOND;
    const rotation = yawRotation(actor.yaw);

    const addPart = (limb: RagdollLimb, offset: Vec3, collider: ColliderDesc) => {
      const cosine = Math.cos(actor.yaw);
      const sine = Math.sin(actor.yaw);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x + offset.x * cosine + offset.z * sine, position.y + offset.y,
          position.z - offset.x * sine + offset.z * cosine)
        .setRotation(rotation).setLinvel(launch.x, launch.y, launch.z)
        .setAngularDamping(1).setCcdEnabled(limb === 'torso'));
      this.world.createCollider(collider.setFriction(0.78).setRestitution(0.12), body);
      actor.ragdoll.push({ limb, body });
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

  private recover(actor: Actor) {
    const torso = actor.ragdoll[0].body.translation();
    for (const { body } of actor.ragdoll) this.world.removeRigidBody(body);
    actor.ragdoll = [];
    actor.recoverTick = 0;
    actor.nextTripAt = this.time + 0.9;
    actor.body.setEnabled(true);
    actor.body.setTranslation(onLand(torso, 0.45)
      ? { x: torso.x, y: ISLAND.spawn.y, z: torso.z }
      : actor.spawn, true);
    actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.announce(actor, '工伤结束，继续打工');
  }
}
