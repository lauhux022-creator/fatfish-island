import RAPIER, { type ColliderDesc, type RigidBody } from '@dimforge/rapier3d-compat';
import { classifyFishChat, normalizePlayerChat } from '../fish-brain/chat';
import { MockBrain } from '../fish-brain/mock';
import { FishBrainRuntime, type FishRequest } from '../fish-brain/runtime';
import type { FishBrain, FishBrainOutput, FishEvent, FishObservedEvent } from '../fish-brain/types';
import { createBotController } from './bots';
import type { BuildKind, CampaignCycleResult, CampaignPhase, CampaignView } from './campaign-types';
import { assignWorkerRoles, DEFAULT_WORKER_ROLE, WORKER_ROLES, type WorkerAnimation, type WorkerRoleId } from './cast';
import { BOSS, CAMPAIGN, CREW, FISH, FISHING, ISLAND, PLAY, SHIFT, STEP_SECONDS, TEAM_DAILY_KPI, TICKS_PER_SECOND, WORKER_MOTION } from './config';
import { buildAhead } from './construction';
import { Defense } from './defense';
import { resolveMovement, yawRotation } from './prediction';
import { seededRandom } from './random';
import { castChargeSeconds, isShopItemId, SHOP, weaponStats, type ShopEquipment, type ShopItemId } from './shop';
import { emptyInput } from './types';
import type {
  BossLine, CrateView, FishKind, FishState, HookPhase, HookView, PlayerMetrics, PlayerView, Pose, RagdollLimb,
  ShiftResult, SimInput, SimNotice, SimSnapshot, Vec3,
} from './types';

interface SimulationOptions {
  seed?: string;
  day?: number;
  shiftSeconds?: number;
  nightSeconds?: number;
  roleId?: WorkerRoleId;
  brain?: FishBrain;
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
  thrownBy: string | null;
  baitPlayerId: string | null;
  grabAgainAt: number;
  multiplier: number;
  wakeAt: number;
  hopAt: number;
  escapeAt: number;
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
  paidBait: boolean;
  aimedAtSea: boolean;
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

type ActorMetrics = Omit<PlayerMetrics, 'interference' | 'fishIncidents'> & { fishIncidents: Set<string> };

function newActorMetrics(): ActorMetrics {
  return { paddleHits: 0, fishStolen: 0, knockdowns: 0, fishEscaped: 0, fishIncidents: new Set() };
}

interface Actor {
  id: (typeof CREW)[number]['id'];
  roleId: WorkerRoleId;
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
  castUntil: number;
  ragdoll: RagdollBody[];
  recoverTick: number;
  nextTripAt: number;
  carrying: Fish | Crate | null;
  hook: Hook;
  baitedBy: Actor | null;
  cash: number;
  equipment: ShopEquipment;
  sold: number;
  shiftCash: number;
  shiftSold: number;
  shiftBossBonus: number;
  shiftBossFine: number;
  favor: number;
  memory: string[];
  giftedBait: boolean;
  swallowed: boolean;
  lastSwallowedDay: number;
  metrics: ActorMetrics;
  optimization: boolean;
  cycleCash: number;
  cycleSold: number;
  ghostPosition: Vec3 | null;
  ghostVelocity: Vec3;
  nextPrankAt: number;
  revivePaid: number;
}

const PLAYER_RADIUS = 0.31;
const PLAYER_HALF_HEIGHT = 0.45;
const PLAYER_HEIGHT = PLAYER_RADIUS + PLAYER_HALF_HEIGHT;
const FISH_KINDS = Object.keys(FISH) as FishKind[];
const FISHING_SHORE_Z = ISLAND.shoreZ - 0.12;

let rapierReady: Promise<void> | undefined;

export async function createSimulation(options: SimulationOptions = {}) {
  // The browser build imports WebAssembly as a module; Node initializes the compat package.
  rapierReady ??= RAPIER.init?.() ?? Promise.resolve();
  await rapierReady;
  return new IslandSimulation(options);
}

function clamp(value: number, lo: number, hi: number) {
  return Math.min(Math.max(value, lo), hi);
}

function distance(a: Direction, b: Direction) {
  return Math.hypot(a.x - b.x, a.z - b.z);
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
    target: null, swimmer: null, bait: null, baitPlayerId: null, baitLanding: null, paidBait: false, aimedAtSea: false,
    start: null, deadline: 0,
  };
}

class IslandSimulation {
  private readonly world = new RAPIER.World({ x: 0, y: -PLAY.gravity, z: 0 });
  private readonly actors: Actor[];
  private readonly crates: Crate[];
  private readonly fish: Fish[] = [];
  private readonly transferredFish = new Set<string>();
  private readonly affectedFish = new Set<string>();
  private escapedFish = 0;
  private readonly seed: string;
  private readonly random: () => number;
  private readonly bots: ReturnType<typeof createBotController>;
  private readonly shiftLength: number;
  private readonly nightLength: number;
  private readonly defense: Defense;
  private readonly boss: FishBrainRuntime;
  private day: number;
  private shiftEnd: number;
  private shiftPaused = false;
  private phase: CampaignPhase = 'day';
  private result: ShiftResult | null = null;
  private cycleFirstDay: number;
  private cycleTarget = 0;
  private lastCycle: CampaignCycleResult | null = null;
  private readonly warehouseLots: number[] = [];
  private warehouseValue = 0;
  private warehouseLostFish = 0;
  private warehouseLostValue = 0;
  private tick = 0;
  private nextEntityId = 0;
  private readonly notices = new Map<string, SimNotice>();
  private noticeId = 0;
  private bossLine: BossLine | null = null;
  private bossInterview: BossLine | null = null;
  private salePricePercent = 100;
  private bossKpi: number | null = null;
  private rewardCrates = 0;

  constructor({
    seed = 'dock-shift', day = 1, shiftSeconds = PLAY.daySeconds, nightSeconds = CAMPAIGN.nightSeconds,
    roleId = DEFAULT_WORKER_ROLE, brain = new MockBrain(),
  }: SimulationOptions) {
    this.seed = seed;
    this.day = Number.isFinite(day) ? Math.max(1, Math.trunc(day)) : 1;
    this.cycleFirstDay = this.day;
    this.random = seededRandom(`${seed}:world`);
    this.bots = createBotController(seed);
    this.defense = new Defense(seed);
    this.boss = new FishBrainRuntime(brain);
    const seconds = Number.isFinite(shiftSeconds) ? clamp(shiftSeconds, SHIFT.shortestSeconds, PLAY.daySeconds) : PLAY.daySeconds;
    this.shiftLength = Math.round(seconds * TICKS_PER_SECOND);
    const night = Number.isFinite(nightSeconds)
      ? clamp(nightSeconds, CAMPAIGN.nightMinimumSeconds, CAMPAIGN.nightSeconds) : CAMPAIGN.nightSeconds;
    this.nightLength = Math.round(night * TICKS_PER_SECOND);
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

    const roles = assignWorkerRoles(roleId);
    this.actors = CREW.map((worker, index) => this.makeActor(worker, roles[index]));
    this.crates = [
      this.makeCrate('supply-crate', ISLAND.supplyCrate, 'floating', 0.43),
      this.makeCrate('training-crate', ISLAND.trainingCrate, 'loose', 0.52),
    ];
    this.requestBoss('shift_start', null, '新一班开工');
  }

  setSeat(id: string, humanName: string | null) {
    const actor = this.actors.find((worker) => worker.id === id);
    if (!actor) throw new RangeError('Unknown crew seat');

    const name = humanName || WORKER_ROLES[actor.roleId].name;
    const bot = humanName === null;
    if (actor.bot === bot && actor.name === name) return;
    if (actor.hook.phase === 'charging') this.clearHook(actor);
    this.bots.release(id);
    this.notices.delete(id);
    actor.name = name;
    actor.bot = bot;
  }

  seatForRole(roleId: WorkerRoleId) {
    return this.actors.find((actor) => actor.roleId === roleId)?.id;
  }

  step(input: SimInput, overrides: Readonly<Record<string, SimInput>> = {}) {
    if (this.phase === 'cleared') return;
    const controls = this.actors.map((actor, index) =>
      overrides[actor.id] ?? (index === 0 && !actor.bot ? input : undefined));
    for (const [index, actor] of this.actors.entries()) {
      if (!actor.bot && controls[index]?.chat) this.receiveBossChat(actor, controls[index].chat);
    }
    if (this.shiftPaused) {
      if (this.actors.some((actor, index) => !actor.bot && controls[index]?.continuePressed)) this.startNextShift();
      this.advanceBoss();
      return;
    }
    this.advanceBoss();
    const previous = this.actors.some((actor, index) => actor.bot && !controls[index]) ? this.snapshot() : null;
    const inputs = this.actors.map((actor, index) =>
      controls[index] ?? (actor.bot ? this.bots.input(previous!, previous!.players[index]) : emptyInput));

    this.tick += 1;
    for (const [index, actor] of this.actors.entries()) {
      if (actor.recoverTick !== 0 && this.tick >= actor.recoverTick) this.recover(actor);
      const actorInput = inputs[index];
      if (actor.ghostPosition) {
        this.moveGhost(actor, actor.ghostPosition, actorInput);
        if (actorInput.swingPressed) this.prank(actor, actor.ghostPosition);
        if (actorInput.revivePressed) this.payRevive(actor);
        continue;
      }
      if (actor.ragdoll.length) continue;
      this.updatePlayer(actor, actorInput);
      if (actor.baitedBy) continue;
      if (this.phase === 'day') this.updateCastInput(actor, actorInput);
      if (actorInput.swingPressed) this.swing(actor);
      if (actorInput.interactPressed) this.interact(actor);
      if (actorInput.build) this.build(actor, actorInput.build);
      if (actorInput.buy) this.buy(actor, actorInput.buy);
      if (actorInput.revivePressed) this.payRevive(actor);
    }

    for (const actor of this.actors) {
      this.updateWaitingHook(actor);
      this.updateCarried(actor);
    }
    this.updateFloppingFish();
    this.world.step();
    for (const actor of this.actors) this.updateFlyingHook(actor);
    this.updateOutcomes();
    if (this.phase === 'night' || this.phase === 'boss') this.updateDefense();
    if (this.phase === 'day' && this.tick >= this.shiftEnd) this.startNight();
    else if (this.phase === 'night' && this.tick >= this.shiftEnd) this.settleShift();
    else if (this.phase === 'boss' && this.defense.bossDefeated) this.phase = 'cleared';
  }

  snapshot(): SimSnapshot {
    const players = this.actors.map((actor) => this.viewActor(actor));
    const player = players[0];
    const notices = Object.fromEntries([...this.notices].map(([id, notice]) => [id, { ...notice }]));
    return {
      tick: this.tick,
      time: this.time,
      day: this.day,
      seed: this.seed,
      player,
      players,
      hook: player.hook,
      shiftRemaining: this.phaseRemaining,
      shiftPaused: this.shiftPaused,
      teamRevenue: players.reduce((sum, worker) => sum + worker.shiftCash, 0),
      teamTarget: this.teamTarget,
      metrics: {
        fishEscaped: this.escapedFish,
        fishTransferred: this.transferredFish.size,
        fishIncidents: this.affectedFish.size,
      },
      result: this.result && { ...this.result, ranking: this.result.ranking.map((entry) => ({ ...entry })) },
      campaign: this.viewCampaign(),
      boss: {
        line: this.bossLine && this.bossLine.day === this.day ? { ...this.bossLine } : null,
        interview: this.bossInterview && this.bossInterview.day === this.day ? { ...this.bossInterview } : null,
        pending: this.boss.pending,
        cooldownSeconds: this.boss.cooldownSeconds,
        calls: this.boss.calls,
        favor: player.favor,
        memory: player.memory,
        priceMultiplier: this.salePricePercent / 100,
      },
      fish: this.fish.map(({ id, body, kind, state, multiplier, caughtBy, carrierId, baitPlayerId, lastTouch, grabAgainAt }) =>
        ({
          id, kind, state, multiplier, caughtBy, carrierId, baitPlayerId, lastTouch, ...pose(body),
          baitMultiplier: baitPlayerId ? FISHING.baitPriceMultiplier : 1,
          stealReady: state === 'thrown' || (state === 'carried' && this.time >= grabAgainAt),
        })),
      crates: this.crates.map(({ id, body, state }) => ({ id, state, ...pose(body) })),
      cash: player.cash,
      sold: player.sold,
      notice: notices[player.id] ?? null,
      notices,
    };
  }

  dispose() {
    this.boss.dispose();
    this.world.free();
  }

  private get time() {
    return this.tick * STEP_SECONDS;
  }

  private get phaseRemaining() {
    return this.phase === 'day' || this.phase === 'night' ? Math.max(0, this.shiftEnd - this.tick) * STEP_SECONDS : 0;
  }

  private get cycleLastDay() {
    return Math.ceil(this.day / CAMPAIGN.cycleDays) * CAMPAIGN.cycleDays;
  }

  private viewCampaign(): CampaignView {
    return {
      phase: this.phase,
      remaining: this.phaseRemaining,
      ...this.defense.snapshot(),
      warehouse: {
        position: { ...CAMPAIGN.warehouse },
        stock: this.warehouseLots.length,
        value: this.warehouseValue,
        lostFish: this.warehouseLostFish,
        lostValue: this.warehouseLostValue,
      },
      cycle: {
        firstDay: this.cycleFirstDay,
        lastDay: this.cycleLastDay,
        secured: this.warehouseValue,
        target: this.cycleTarget + (this.shiftPaused || this.phase === 'boss' || this.phase === 'cleared' ? 0 : this.teamTarget),
      },
      lastCycle: this.lastCycle && { ...this.lastCycle, eaten: this.lastCycle.eaten && { ...this.lastCycle.eaten } },
      reviveCost: CAMPAIGN.reviveCost,
    };
  }

  private get teamTarget() {
    return this.bossKpi ?? this.baseTeamTarget;
  }

  private get baseTeamTarget() {
    const target = TEAM_DAILY_KPI[Math.min(this.day - 1, TEAM_DAILY_KPI.length - 1)];
    // Short shifts exist for reproducing the same rules via the debug override.
    return Math.round(target * this.shiftLength / (PLAY.daySeconds * TICKS_PER_SECOND));
  }

  private requestBoss(trigger: FishEvent['trigger'], actor: Actor | null, summary: string, amount?: number) {
    this.boss.request({ trigger, day: this.day, time: this.time, actorId: actor?.id ?? null, summary, amount });
  }

  private observeCrew(trigger: 'theft' | 'friendly_hit', actor: Actor, other: Actor, summary: string) {
    const event: FishObservedEvent = {
      trigger, day: this.day, time: this.time, actorId: actor.id, relatedId: other.id, summary,
    };
    this.boss.observe(event);
  }

  private receiveBossChat(actor: Actor, value: unknown) {
    const text = normalizePlayerChat(value);
    if (!text) return;
    this.boss.request({
      trigger: 'chat', day: this.day, time: this.time, actorId: actor.id, summary: `${actor.name}找老板谈话`,
    }, { authorId: actor.id, text });
  }

  private advanceBoss() {
    this.boss.advance(this.day, () => ({
      players: this.actors.map(({ id, roleId, name, cash, shiftCash, shiftSold, favor, memory }) =>
        ({ id, roleId, name, cash, shiftCash, shiftSold, favor, memory: memory.join('，') })),
      teamTarget: this.teamTarget,
      teamRevenue: this.actors.reduce((sum, worker) => sum + worker.shiftCash, 0),
      priceMultiplier: this.salePricePercent / 100,
    }), (request, response) => this.finishBossRequest(request, response));
  }

  private finishBossRequest(request: FishRequest, response: FishBrainOutput) {
    const decision = this.applyBossAction(request, response);
    const { event, message } = request;
    const speaker = message && this.actors.find(({ id }) => id === message.authorId);
    if (speaker && message) this.rememberConversation(speaker, message.text, decision);
    const line = { ...decision, id: this.boss.calls, trigger: event.trigger, day: event.day };
    this.bossLine = line;
    if (event.trigger === 'shift_end') this.bossInterview = line;
  }

  private remember(actor: Actor, entry: string, change = 0) {
    actor.favor = clamp(actor.favor + change, BOSS.minFavor, BOSS.maxFavor);
    const previous = actor.memory.indexOf(entry);
    if (previous >= 0) actor.memory.splice(previous, 1);
    actor.memory.push(entry);
    if (actor.memory.length > BOSS.maxMemoryEntries) actor.memory.shift();
  }

  private rememberConversation(speaker: Actor, text: string, response: FishBrainOutput) {
    switch (classifyFishChat(text)) {
      case 'praise':
        this.remember(speaker, '夸过老板', BOSS.praiseFavor);
        break;
      case 'bribe':
        if (response.action === 'fine' && response.target === speaker.id && response.amount > 0) {
          this.remember(speaker, '请过老板喝茶', BOSS.bribeFavor);
        } else this.remember(speaker, '提过请喝茶');
        break;
      case 'complaint': {
        const fined = response.action === 'fine' && this.actors.find(({ id }) => id === response.target);
        if (fined === speaker) this.remember(speaker, '告状反被记账', BOSS.backfireFavor);
        else if (fined) {
          this.remember(speaker, `告过${fined.name}的状`, BOSS.complaintFavor);
          this.remember(fined, '被同事告过状', BOSS.blamedFavor);
        } else this.remember(speaker, '提过告状');
        break;
      }
      case 'bargain':
        this.remember(speaker, '和老板谈过鱼价');
        break;
      default:
        this.remember(speaker, '来找过老板');
    }
  }

  private applyBossAction(request: FishRequest, response: FishBrainOutput): FishBrainOutput & { effect?: string } {
    const { action, target, amount } = response;
    const actor = target && this.actors.find(({ id }) => id === target);
    const rejected = (): FishBrainOutput => ({ say: '这笔账我先记着。', emotion: 'calm', action: 'none', target: null, amount: 0 });
    switch (action) {
      case 'none':
        return response;
      case 'bonus':
      case 'fine': {
        if (!actor || amount < 0) return rejected();
        const fine = action === 'fine';
        const cap = fine
          ? Math.min(actor.cash, Math.max(0, Math.round(actor.shiftCash * BOSS.maxFineRate) - actor.shiftBossFine))
          : Math.max(0, Math.round(actor.shiftCash * BOSS.maxBonusRate) - actor.shiftBossBonus);
        const applied = clamp(Math.round(amount), 0, cap);
        const complaint = request.message && classifyFishChat(request.message.text) === 'complaint';
        if (!applied && !(fine && complaint && amount === 0)) return rejected();
        actor.cash += fine ? -applied : applied;
        if (fine) actor.shiftBossFine += applied;
        else actor.shiftBossBonus += applied;
        const entry = this.shiftPaused && this.result?.ranking.find(({ id }) => id === actor.id);
        if (entry) {
          if (fine) entry.fine += applied;
          else entry.bonus += applied;
        }
        return {
          ...response,
          amount: applied,
          effect: applied ? `${actor.name} ${fine ? '扣款' : '奖金'} ¥${applied}` : `${actor.name}被老板记了一笔`,
        };
      }
      case 'set_kpi': {
        if (target !== null || this.phase !== 'day') return rejected();
        const min = Math.ceil(this.baseTeamTarget * BOSS.kpiRange[0]);
        const max = Math.floor(this.baseTeamTarget * BOSS.kpiRange[1]);
        this.bossKpi = clamp(Math.round(amount), min, max);
        return { ...response, amount: this.bossKpi, effect: `本班团队指标 ¥${this.bossKpi}` };
      }
      case 'price_change': {
        if (target !== null || this.shiftPaused) return rejected();
        const before = this.salePricePercent;
        const points = clamp(Math.round(amount), ...BOSS.priceStep);
        this.salePricePercent = clamp(before + points, ...BOSS.priceRange);
        return {
          ...response, amount: this.salePricePercent - before,
          effect: `后续收鱼价 ×${(this.salePricePercent / 100).toFixed(2)}`,
        };
      }
      case 'spawn_event': {
        if (target !== 'crate' || this.shiftPaused || amount < 0.5) return rejected();
        const spawned = this.spawnBossCrates(Math.round(amount));
        return spawned ? { ...response, amount: spawned, effect: `补给木箱 ×${spawned} 已送到岸后` } : rejected();
      }
      case 'gift_item':
        if (!actor || actor.giftedBait || amount < 0.5) return rejected();
        actor.giftedBait = true;
        return { ...response, amount: 1, effect: `${actor.name}获得一份加急鱼饵` };
      case 'eat_player':
        if (!actor || this.shiftPaused || actor.ghostPosition || actor.ragdoll.length
          || actor.lastSwallowedDay === this.day || amount < 0.5) {
          return rejected();
        }
        this.startRagdoll(actor, null, launchVector(actor.body.translation(), BOSS.swallowLanding, BOSS.swallowFlightSeconds));
        actor.swallowed = true;
        actor.lastSwallowedDay = this.day;
        this.remember(actor, '被老板吞过又吐回岸上');
        this.requestBoss('death', actor, `${actor.name}被大肥鱼吞下`);
        return { ...response, amount: 1, effect: `${actor.name}被大肥鱼吞走了` };
    }
  }

  private spawnBossCrates(wanted: number) {
    const available = BOSS.rewardCrates.filter((position) =>
      !this.actors.some((worker) => !worker.ghostPosition
        && distance(worker.ragdoll[0]?.body.translation() ?? worker.body.translation(), position) < 1.3)
      && !this.crates.some(({ body }) => distance(body.translation(), position) < 1),
    );
    const amount = Math.min(wanted, available.length, BOSS.rewardCrates.length - this.rewardCrates);
    for (const position of available.slice(0, amount)) {
      this.crates.push(this.makeCrate(`boss-supply-${++this.rewardCrates}`, position, 'loose', 0.43));
    }
    return amount;
  }

  private announce(actor: Actor, text: string, tone: SimNotice['tone'] = 'info', cue?: SimNotice['cue']) {
    if (actor.bot) return;
    this.notices.set(actor.id, { id: ++this.noticeId, text, tone, cue });
  }

  private canShop(actor: Actor, position: Vec3) {
    return this.phase === 'day' && !this.shiftPaused && !actor.ghostPosition && !actor.ragdoll.length
      && !actor.baitedBy && actor.groundContact && distance(position, SHOP.position) <= SHOP.radius;
  }

  private buy(actor: Actor, id: ShopItemId) {
    if (!isShopItemId(id) || !this.canShop(actor, actor.body.translation())) return;
    const item = SHOP.items[id];
    if (actor.equipment[id]) {
      this.announce(actor, id === 'bait' ? '鱼饵盒里还有一份' : `已经买过${item.name}`);
      return;
    }
    if (actor.cash < item.price) {
      this.announce(actor, `${item.name}要 ¥${item.price}，零钱还差一点`, 'bad');
      return;
    }
    actor.cash -= item.price;
    actor.equipment[id] = true;
    this.announce(actor, `买到${item.name} · 花了 ¥${item.price}`, 'good');
  }

  private makeActor({ id, bot, spawn }: (typeof CREW)[number], roleId: WorkerRoleId): Actor {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z).setCcdEnabled(true).lockRotations());
    this.world.createCollider(RAPIER.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS)
      .setFriction(0.02).setDensity(2), body);
    return {
      id, roleId, name: WORKER_ROLES[roleId].name, bot, spawn, body,
      random: seededRandom(bot ? `${this.seed}:${id}` : this.seed),
      yaw: 0, aim: { x: 0, z: -1 }, groundContact: true, moveSpeed: 0, swingUntil: 0, castUntil: 0,
      ragdoll: [], recoverTick: 0, nextTripAt: 0, carrying: null, hook: newHook(),
      baitedBy: null, cash: 0, sold: 0, shiftCash: 0, shiftSold: 0, metrics: newActorMetrics(), optimization: false,
      equipment: { rod: false, pan: false, bait: false },
      shiftBossBonus: 0, shiftBossFine: 0, favor: 0, memory: [], giftedBait: false, swallowed: false, lastSwallowedDay: 0,
      cycleCash: 0, cycleSold: 0, ghostPosition: null, ghostVelocity: { x: 0, y: 0, z: 0 }, nextPrankAt: 0, revivePaid: 0,
    };
  }

  private viewActor(actor: Actor): PlayerView {
    const { id, roleId, name, bot, cash, sold, shiftCash, shiftSold, optimization, yaw, ragdoll } = actor;
    const { fishIncidents, ...metrics } = actor.metrics;
    const body = ragdoll[0]?.body ?? actor.body;
    const hook = actor.hook;
    const ghost = actor.ghostPosition !== null;
    const position = actor.ghostPosition ? { ...actor.ghostPosition } : body.translation();
    const velocity = ghost ? { ...actor.ghostVelocity } : body.linvel();
    const speed = ragdoll.length ? 0 : Math.hypot(velocity.x, velocity.z);
    const target: HookView['target'] = hook.bait ? 'player' : hook.target ? (isFish(hook.target) ? 'fish' : 'crate') : null;
    return {
      id, roleId, name, bot, cash, sold, shiftCash, shiftSold, optimization, yaw,
      animation: this.animationFor(actor, speed),
      position,
      ghost,
      revivePaid: actor.revivePaid,
      equipment: { ...actor.equipment },
      shopOpen: this.canShop(actor, position),
      favor: actor.favor,
      memory: actor.memory.join('，'),
      giftedBait: actor.giftedBait,
      metrics: { ...metrics, fishIncidents: fishIncidents.size, interference: metrics.paddleHits + metrics.fishStolen },
      baitedBy: actor.baitedBy?.id ?? null,
      rotation: ragdoll.length ? body.rotation() : yawRotation(yaw),
      velocity,
      speed,
      grounded: !ghost && actor.groundContact && !ragdoll.length,
      swing: clamp((actor.swingUntil - this.time) / (ghost ? PLAY.swingSeconds : weaponStats(actor.equipment).swingSeconds), 0, 1),
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

  private animationFor(actor: Actor, speed: number): WorkerAnimation {
    if (actor.ragdoll.length) return actor.baitedBy?.hook.baitLanding ? 'dive' : 'fall';
    if (this.shiftPaused && this.result) {
      if (actor.id === this.result.ranking[0].id) return 'victory_celebration';
      if (actor.id === this.result.ranking.at(-1)?.id) return 'afraid';
      return 'idle';
    }
    if (actor.swingUntil > this.time) return 'chop';
    if (actor.hook.phase === 'charging' || actor.castUntil > this.time) return 'box_01';
    if (speed >= WORKER_MOTION.runSpeed) return 'run';
    return speed >= WORKER_MOTION.walkSpeed ? 'walk' : 'idle';
  }

  private startNight() {
    this.phase = 'night';
    this.shiftEnd = this.tick + this.nightLength;
    this.defense.startNight(this.day, this.time);
    for (const actor of this.actors) {
      if (actor.hook.phase !== 'idle') this.clearHook(actor);
      this.announce(actor, '天黑了！海怪盯上了仓库', 'bad');
    }
  }

  private updateDefense() {
    const workers = this.actors
      .filter((worker) => !worker.ghostPosition && !worker.ragdoll.length)
      .map(({ id, body }) => ({ id, position: body.translation() }));
    const events = this.defense.step(this.time, workers, this.warehouseLots.length);
    let stolen = 0;
    let lostValue = 0;
    for (const event of events) {
      if (event.kind === 'raid') {
        const lots = this.warehouseLots.splice(0, event.count);
        stolen += lots.length;
        lostValue += lots.reduce((sum, amount) => sum + amount, 0);
      } else {
        const actor = this.actors.find(({ id }) => id === event.actorId);
        if (!actor) continue;
        this.startRagdoll(actor, event.source, event.force);
        this.announce(actor, this.phase === 'boss' ? '螃蟹请你吃了一钳！' : '海怪把你撞翻了！', 'bad');
      }
    }
    if (!stolen) return;
    this.warehouseValue -= lostValue;
    this.warehouseLostFish += stolen;
    this.warehouseLostValue += lostValue;
    for (const actor of this.actors) this.announce(actor, `海怪抢走了 ${stolen} 条鱼 · 指标少了 ¥${lostValue}`, 'bad');
  }

  private build(actor: Actor, kind: BuildKind) {
    const point = buildAhead(actor.body.translation(), actor.yaw);
    if (!this.defense.build(kind, point)) this.announce(actor, '这里放不下，或漂流木不够', 'bad');
  }

  private settleShift() {
    this.defense.endNight();
    this.cycleTarget += this.teamTarget;
    // Array sort is stable, so ties on both values use the crew’s joining order.
    const ordered = [...this.actors].sort((a, b) => b.shiftCash - a.shiftCash || b.shiftSold - a.shiftSold);
    this.result = {
      day: this.day,
      ranking: ordered.map((actor, index) => ({
        id: actor.id, roleId: actor.roleId, name: actor.name, bot: actor.bot, rank: index + 1,
        revenue: actor.shiftCash, sold: actor.shiftSold,
        bonus: index === 0 ? Math.round(actor.shiftCash * SHIFT.bonusRate) : 0,
        fine: index === ordered.length - 1 ? Math.round(actor.shiftCash * SHIFT.fineRate) : 0,
        optimization: index === ordered.length - 1,
      })),
    };
    for (const [index, actor] of ordered.entries()) {
      const { bonus, fine } = this.result.ranking[index];
      actor.cash = Math.max(0, actor.cash + bonus - fine);
    }
    this.shiftPaused = true;
    if (this.day === this.cycleLastDay) {
      const passed = this.warehouseValue >= this.cycleTarget;
      const lowest = passed ? null : this.actors.filter((actor) => !actor.ghostPosition)
        .sort((a, b) => b.cycleCash - a.cycleCash || b.cycleSold - a.cycleSold).at(-1);
      this.lastCycle = {
        day: this.day, secured: this.warehouseValue, target: this.cycleTarget, passed,
        eaten: lowest ? { id: lowest.id, name: lowest.name } : null,
      };
    }
    this.requestBoss('shift_end', this.actors[0], '今天交班，排名已结算');
  }

  private startNextShift() {
    const ending = this.lastCycle?.day === this.day ? this.lastCycle : null;
    if (ending?.passed) {
      this.phase = 'boss';
      this.shiftPaused = false;
      this.notices.clear();
      this.defense.startBoss(this.time);
      return;
    }
    const lowest = this.result?.ranking.at(-1)?.id;
    for (const actor of this.actors) {
      actor.optimization = actor.id === lowest;
      actor.shiftCash = 0;
      actor.shiftSold = 0;
      actor.shiftBossBonus = 0;
      actor.shiftBossFine = 0;
      actor.castUntil = 0;
      actor.metrics = newActorMetrics();
      if (actor.hook.phase === 'charging') this.clearHook(actor);
    }
    this.escapedFish = 0;
    this.transferredFish.clear();
    this.affectedFish.clear();
    this.notices.clear();
    this.day += 1;
    this.phase = 'day';
    this.shiftEnd = this.tick + this.shiftLength;
    this.shiftPaused = false;
    this.bossKpi = null;
    this.salePricePercent = 100;
    this.boss.startDay(this.day);
    if (ending) {
      this.cycleFirstDay = this.day;
      this.cycleTarget = 0;
      this.warehouseLots.length = 0;
      this.warehouseValue = 0;
      this.warehouseLostFish = 0;
      this.warehouseLostValue = 0;
      for (const actor of this.actors) {
        actor.cycleCash = 0;
        actor.cycleSold = 0;
        if (actor.id === ending.eaten?.id) this.becomeGhost(actor);
      }
    }
    this.requestBoss('shift_start', null, '新一班开工');
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
    actor.groundContact = position.y <= PLAYER_HEIGHT + 0.08 && Math.abs(velocity.y) < 0.7 && onLand(position);
    const movement = resolveMovement({
      position,
      velocity,
      grounded: actor.groundContact,
      optimization: actor.optimization,
      carrying: actor.carrying?.id ?? null,
      baitedBy: actor.baitedBy?.id ?? null,
    }, input);
    if (movement.direction) {
      actor.aim = movement.direction;
      actor.yaw = Math.atan2(-actor.aim.x, -actor.aim.z);
    }
    actor.moveSpeed = movement.desiredSpeed;
    actor.body.setLinvel(movement.velocity, true);
    if (movement.jumped) actor.groundContact = false;
  }

  private becomeGhost(actor: Actor) {
    if (actor.baitedBy) this.clearHook(actor.baitedBy);
    this.clearHook(actor);
    if (actor.carrying) this.throwCarried(actor, { x: 0, y: 0.85, z: 0 });
    for (const { body } of actor.ragdoll) this.world.removeRigidBody(body);
    actor.ragdoll = [];
    actor.recoverTick = 0;
    actor.swallowed = false;
    actor.body.setEnabled(false);
    actor.ghostPosition = { ...actor.spawn, y: CAMPAIGN.ghostHover };
    actor.ghostVelocity = { x: 0, y: 0, z: 0 };
    actor.nextPrankAt = this.time;
    actor.revivePaid = 0;
    this.remember(actor, '三天欠账，被吞成幽灵');
    this.announce(actor, `变成幽灵了！F 捣乱 · R 凑够 ¥${CAMPAIGN.reviveCost} 复活`, 'bad');
    this.requestBoss('death', actor, `${actor.name}没交够三天指标，被吃成幽灵`);
  }

  private moveGhost(actor: Actor, position: Vec3, input: SimInput) {
    const inset = CAMPAIGN.ghostBoundsInset;
    const length = Math.max(1, Math.hypot(input.moveX, input.moveZ));
    const step = CAMPAIGN.ghostSpeed * STEP_SECONDS / length;
    const x = clamp(position.x + input.moveX * step, ISLAND.minX + inset, ISLAND.maxX - inset);
    const z = clamp(position.z + input.moveZ * step, ISLAND.shoreZ + inset, ISLAND.backZ - inset);
    const y = CAMPAIGN.ghostHover + Math.sin(this.time * CAMPAIGN.ghostBobRate) * CAMPAIGN.ghostBobAmplitude;
    actor.ghostVelocity = {
      x: (x - position.x) / STEP_SECONDS,
      y: (y - position.y) / STEP_SECONDS,
      z: (z - position.z) / STEP_SECONDS,
    };
    Object.assign(position, { x, y, z });
    const focus = input.aim ? { x: input.aim.x - x, z: input.aim.z - z } : { x: input.moveX, z: input.moveZ };
    if (Math.hypot(focus.x, focus.z) > 0.05) actor.yaw = Math.atan2(-focus.x, -focus.z);
  }

  private prank(actor: Actor, position: Vec3) {
    if (this.time < actor.nextPrankAt) return;
    const target = this.actors.filter((worker) => !worker.ghostPosition && !worker.ragdoll.length && this.time >= worker.nextTripAt)
      .map((worker) => ({ worker, separation: distance(position, worker.body.translation()) }))
      .sort((a, b) => a.separation - b.separation)[0];
    if (!target || target.separation > CAMPAIGN.ghostPrankReach) return;
    actor.nextPrankAt = this.time + CAMPAIGN.ghostPrankCooldown;
    actor.swingUntil = this.time + PLAY.swingSeconds;
    this.startRagdoll(target.worker, position);
    this.observeCrew('friendly_hit', actor, target.worker, `${actor.name}闹鬼拍飞了${target.worker.name}`);
    this.announce(actor, `闹鬼成功！${target.worker.name}摔了个屁股蹲`, 'good');
    this.announce(target.worker, `${actor.name}从幽灵工位伸来一脚！`, 'bad');
  }

  private payRevive(payer: Actor) {
    const position = payer.body.translation();
    const ghost = payer.ghostPosition ? payer : this.actors.flatMap((worker) => {
      if (!worker.ghostPosition) return [];
      const separation = distance(position, worker.ghostPosition);
      return separation <= CAMPAIGN.reviveReach ? [{ worker, separation }] : [];
    }).sort((a, b) => a.separation - b.separation)[0]?.worker;
    if (!ghost?.ghostPosition) return;

    const remaining = CAMPAIGN.reviveCost - ghost.revivePaid;
    // In an all-ghost crew, active humans need a way to earn income again.
    const emergency = !payer.bot && payer.cash < remaining && this.actors.every((worker) => worker.ghostPosition)
      && !this.actors.some((worker) => !worker.bot && worker.cash >= CAMPAIGN.reviveCost - worker.revivePaid);
    const advance = emergency ? remaining - payer.cash : 0;
    const installment = Math.min(remaining, CAMPAIGN.reviveContribution);
    const paid = emergency ? remaining : Math.min(payer.cash, installment);
    const donated = payer === ghost && paid < installment
      ? this.requestBotDonation(ghost.ghostPosition, installment - paid)
      : 0;
    const totalPaid = paid + donated;
    if (totalPaid <= 0) {
      this.announce(payer, payer === ghost ? '没凑够复活费，靠近有鱼款的机器人求助' : '手头没钱，复活费还没凑够', 'bad');
      return;
    }
    payer.cash += advance - paid;
    ghost.revivePaid += totalPaid;
    const paidText = `${ghost.name}的复活费 ¥${ghost.revivePaid}/${CAMPAIGN.reviveCost}`;
    if (ghost.revivePaid < CAMPAIGN.reviveCost) {
      this.announce(payer, donated ? `工友出了 ¥${donated} · ${paidText}` : paidText, 'good');
      if (payer !== ghost) this.announce(ghost, `${payer.name}捎来 ¥${paid} · ${paidText}`, 'good');
      return;
    }

    const { x, z } = ghost.ghostPosition;
    ghost.ghostPosition = null;
    ghost.revivePaid = 0;
    ghost.body.setTranslation({ x, y: ISLAND.spawn.y, z }, true);
    ghost.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ghost.body.setEnabled(true);
    ghost.nextTripAt = this.time + 0.9;
    this.announce(ghost, advance ? `老板垫了 ¥${advance}，肉身返岗！` : '欠款补齐，肉身返岗！', 'good');
    if (payer !== ghost) this.announce(payer, `你帮${ghost.name}凑齐了复活费！`, 'good');
  }

  private requestBotDonation(position: Vec3, limit: number) {
    const donor = this.actors.flatMap((worker) => {
      if (!worker.bot || worker.ghostPosition || worker.cash <= 0) return [];
      const separation = distance(position, worker.body.translation());
      return separation <= CAMPAIGN.reviveReach ? [{ worker, separation }] : [];
    }).sort((a, b) => a.separation - b.separation)[0]?.worker;
    if (!donor) return 0;
    const amount = Math.min(donor.cash, limit);
    donor.cash -= amount;
    return amount;
  }

  private updateCastInput(actor: Actor, input: SimInput) {
    if (actor.hook.phase === 'bait' && input.castPressed) {
      actor.castUntil = this.time + WORKER_MOTION.castSeconds;
      this.launchBait(actor, input.aim);
      return;
    }
    if (input.castPressed && (actor.hook.phase === 'bite' || actor.hook.phase === 'reeling')) {
      actor.castUntil = this.time + WORKER_MOTION.castSeconds;
      this.reel(actor);
    } else if (input.castPressed && actor.hook.phase === 'idle' && !actor.carrying) {
      actor.hook.phase = 'charging';
    }
    if (actor.hook.phase === 'charging') {
      if (input.castHeld) actor.hook.charge = Math.min(1, actor.hook.charge + STEP_SECONDS / castChargeSeconds(actor.equipment));
      if (input.castReleased) {
        actor.castUntil = this.time + WORKER_MOTION.castSeconds;
        this.cast(actor, input.aim);
      }
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
    actor.hook.aimedAtSea = canFish(aim ?? {
      x: position.x + actor.aim.x * FISHING.maxRange,
      z: position.z + actor.aim.z * FISHING.maxRange,
    });
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
    this.announce(owner, `钩住了${target.name}！朝海点一下当鱼饵`, 'good');
    this.announce(target, `${owner.name}把你钩住了！`, 'bad');
  }

  private baitPosition(actor: Actor) {
    const torso = actor.ragdoll[0]?.body ?? actor.body;
    const position = torso.translation();
    return { ...position, y: position.y + 0.35 };
  }

  private launchBait(owner: Actor, aim: SimInput['aim']) {
    const hook = owner.hook;
    const target = hook.bait;
    if (!target || !hook.body || target.ragdoll.length) return;
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
    this.announce(owner, `${target.name}牌活饵，专钓大鱼！`, 'good');
    this.announce(target, `${owner.name}把你抛进海里当鱼饵！`, 'bad');
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
      if (other === actor || other.ghostPosition || other.baitedBy || other.ragdoll.length) return false;
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
      const nearSpot = FISHING.goodSpots.some((spot) => distance(spot, position) <= FISHING.goodSpotRadius);
      hook.paidBait = actor.equipment.bait && !actor.giftedBait;
      const baitReduction = actor.giftedBait ? BOSS.giftBiteReduction : hook.paidBait ? SHOP.items.bait.biteReduction : 0;
      hook.deadline = this.time + FISHING.biteMin + actor.random() * (FISHING.biteMax - FISHING.biteMin)
        + (nearSpot ? 0 : FISHING.offSpotDelay) - baitReduction;
      actor.giftedBait = false;
    } else if (landedOnBeach || this.time > hook.deadline) {
      const threwShort = landedOnBeach && hook.aimedAtSea && hook.charge < 1;
      this.clearHook(actor);
      this.announce(actor, threwShort ? '抛短了！蓄满再松手' : '空钩！瞄准岸外的海面', 'bad');
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
      multiplier: 1, lastHit: -Infinity, lastTouch: null, wakeAt: 0, hopAt: 0, escapeAt: 0,
      caughtBy: actor.id, carrierId: null, thrownBy: null, baitPlayerId, grabAgainAt: 0,
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
    if (isCatch) {
      const taps = FISH[target.kind].taps;
      actor.hook.required = actor.equipment.rod ? Math.max(1, taps - SHOP.items.rod.fewerTaps) : taps;
      if (actor.hook.paidBait) actor.equipment.bait = false;
    } else actor.hook.required = FISHING.crateTaps;
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
    const weapon = weaponStats(actor.equipment);
    actor.swingUntil = this.time + weapon.swingSeconds;
    const position = actor.body.translation();
    if ((this.phase === 'night' || this.phase === 'boss') && this.defense.hit(position, actor.aim, weapon.reach)) return;
    let hit: Fish | undefined;
    let reach: number = weapon.reach;
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
      if (other === actor || other.ghostPosition || other.ragdoll.length || this.time < other.nextTripAt) continue;
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
      teammate.metrics.paddleHits += 1;
      this.startRagdoll(teammate, null, {
        x: (point.x - position.x) / length * PLAY.friendlyKnockback,
        y: 3.8,
        z: (point.z - position.z) / length * PLAY.friendlyKnockback,
      });
      this.observeCrew('friendly_hit', actor, teammate, `${actor.name}挥桨拍飞了${teammate.name}`);
      this.announce(actor, `一桨拍飞了${teammate.name}！`, 'bad');
      this.announce(teammate, `${actor.name}把你一桨拍飞！`, 'bad');
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
    hit.hits += weapon.fishDamage;

    const stunned = hit.hits >= FISH[hit.kind].hits;
    const impulse = stunned ? PLAY.fishStunHit : PLAY.fishHit;
    const side = this.random() < 0.5 ? -impulse.side : impulse.side;
    hit.body.setLinvel({
      x: actor.aim.x * impulse.forward + actor.aim.z * side,
      y: impulse.height,
      z: actor.aim.z * impulse.forward - actor.aim.x * side,
    }, true);
    hit.body.setAngvel({ x: 5.7, y: 3.5, z: 2.2 }, true);
    if (stunned) {
      hit.state = 'stunned';
      hit.wakeAt = this.time + PLAY.stunSeconds;
      this.announce(actor, `拍晕啦！近身按 E 搬鱼 · ×${hit.multiplier.toFixed(2)}`, 'good', 'fish_hit');
    } else {
      this.announce(actor, `${airborne ? '空中拍鱼' : combo ? '连拍' : '拍中'}！${hit.hits}/${FISH[hit.kind].hits}`, 'good', 'fish_hit');
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
    const victim = isFish(item) && item.carrierId ? this.actors.find(({ id }) => id === item.carrierId) : undefined;
    const interceptorVictim = isFish(item) && item.state === 'thrown'
      ? this.actors.find(({ id }) => id === item.thrownBy && id !== actor.id) : undefined;
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
    const formerOwner = victim ?? interceptorVictim ?? this.actors.find(({ id }) => id === previousTouch);
    if (formerOwner && formerOwner !== actor) {
      this.transferredFish.add(item.id);
      this.affectedFish.add(item.id);
      formerOwner.metrics.fishIncidents.add(item.id);
      if (victim || interceptorVictim) {
        formerOwner.metrics.fishStolen += 1;
        this.observeCrew('theft', actor, formerOwner, `${actor.name}从${formerOwner.name}那里${victim ? '抢鱼' : '截胡'}`);
      }
    }
    item.carrierId = actor.id;
    item.thrownBy = null;
    item.grabAgainAt = this.time + PLAY.stealGrace;
    this.touchFish(item, actor);
    if (item.baitPlayerId === actor.id) {
      this.announce(actor, '这条鱼用你当饵，你的绩效不计', 'info');
    } else if (victim) {
      this.announce(actor, `从${victim.name}手里抢到鱼！`, 'good');
    } else if (interceptorVictim) {
      this.announce(actor, '半空截胡！鱼到你手里了', 'good');
    } else {
      this.announce(actor, '带到秤旁，准星对准秤按 E');
    }
    if (victim) this.announce(victim, `${actor.name}从你手里抢走了鱼！`, 'bad');
    if (interceptorVictim) this.announce(interceptorVictim, `${actor.name}半空截走了你的鱼！`, 'bad');
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

  private throwCarried(actor: Actor, knockedLoose?: Vec3) {
    const item = actor.carrying;
    if (!item) return;
    actor.carrying = null;
    const position = actor.body.translation();
    const origin = this.carryPoint(actor);
    const scaleDistance = distance(position, ISLAND.scale);
    const towardScale = (ISLAND.scale.x - position.x) * actor.aim.x + (ISLAND.scale.z - position.z) * actor.aim.z;
    const assist = isFish(item) && scaleDistance <= ISLAND.scale.aimAssistDistance
      && (scaleDistance < 0.6 || towardScale > scaleDistance * 0.58);
    const velocity = knockedLoose ?? (assist ? launchVector(origin, ISLAND.scale, 0.5)
      : { x: actor.aim.x * 6.35, y: 4.85, z: actor.aim.z * 6.35 });
    item.state = 'thrown';
    item.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    item.body.setTranslation(origin, true);
    item.body.setLinvel(velocity, true);
    item.body.setAngvel({ x: 4.6, y: 2.1, z: 1.7 }, true);
    item.body.collider(0).setEnabled(true);
    if (isFish(item)) {
      item.carrierId = null;
      item.thrownBy = actor.id;
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
      if (!onLand(point) || point.y > 0.48 || velocity.y > 0.25) continue;
      const hop = PLAY.fishHop;
      const wander = (this.random() - 0.5) * hop.side;
      fish.body.setLinvel({
        x: wander,
        y: hop.height[0] + this.random() * (hop.height[1] - hop.height[0]),
        z: -(hop.seaward[0] + this.random() * (hop.seaward[1] - hop.seaward[0])),
      }, true);
      fish.body.setAngvel({ x: 4.8, y: wander * 3.5, z: 3.1 }, true);
      fish.hopAt = this.time + hop.interval[0] + this.random() * (hop.interval[1] - hop.interval[0]);
    }
  }

  private updateOutcomes() {
    for (const fish of [...this.fish]) {
      const point = fish.body.translation();
      if (fish.state === 'flopping' && !onLand(point)) {
        fish.state = 'escaping';
        fish.escapeAt = this.time + PLAY.fishEscapeSeconds;
      }
      if (fish.state === 'thrown' && fish.lastTouch && distance(point, ISLAND.scale) <= ISLAND.scale.radius
        && Math.abs(point.y - ISLAND.scale.y) < 0.37) {
        const baitMultiplier = fish.baitPlayerId ? FISHING.baitPriceMultiplier : 1;
        const amount = Math.round(FISH[fish.kind].price * fish.multiplier * baitMultiplier * this.salePricePercent / 100);
        const worker = this.actors.find(({ id }) => id === fish.lastTouch);
        if (worker) {
          worker.cash += amount;
          worker.sold += 1;
          worker.shiftCash += amount;
          worker.shiftSold += 1;
          if (this.phase !== 'boss') {
            worker.cycleCash += amount;
            worker.cycleSold += 1;
            this.warehouseLots.push(amount);
            this.warehouseValue += amount;
          }
          const bait = fish.baitPlayerId ? ` · 活饵 ×${baitMultiplier}` : '';
          this.announce(worker, `入账 ¥${amount} · ${FISH[fish.kind].name} ×${fish.multiplier.toFixed(2)}${bait}`, 'good');
          this.requestBoss('sale', worker, `${worker.name}卖出${FISH[fish.kind].name}`, amount);
        }
        this.removeFish(fish);
      } else if (fish.state !== 'hooked' && fish.state !== 'carried' && fish.state !== 'swimming'
        && (point.y < ISLAND.seaY - 0.15 || (fish.state === 'escaping' && this.time >= fish.escapeAt))) {
        this.escapedFish += 1;
        this.affectedFish.add(fish.id);
        const worker = this.actors.find(({ id }) => id === (fish.lastTouch ?? fish.caughtBy));
        if (worker) {
          worker.metrics.fishEscaped += 1;
          worker.metrics.fishIncidents.add(fish.id);
          this.announce(worker, '扑通！鱼溜回海里了', 'bad', 'fish_escape');
        }
        this.removeFish(fish);
      } else if (fish.state === 'thrown' && fish.body.linvel().y <= 0.25 && point.y < 0.56 && onLand(point)) {
        fish.state = 'stunned';
      }
    }

    for (const crate of this.crates) {
      this.updateCrate(crate);
    }

    for (const actor of this.actors) {
      if (!actor.ghostPosition && !actor.ragdoll.length && actor.body.translation().y < ISLAND.seaY - 0.27) {
        this.startRagdoll(actor, null);
        this.announce(actor, '落水工伤，海浪马上送你回来', 'bad', 'water_fall');
        this.remember(actor, '落水过一次');
        this.requestBoss('death', actor, `${actor.name}落水倒下，等待回岸`);
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
      if (actor.ghostPosition || actor.ragdoll.length || this.time < actor.nextTripAt) continue;
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
    if (actor.ghostPosition || actor.ragdoll.length) return;
    actor.metrics.knockdowns += 1;
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
    if (actor.carrying) {
      this.throwCarried(actor, { x: launch.x * 1.15, y: Math.max(3.8, launch.y), z: launch.z * 1.15 });
    }
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
    actor.body.setTranslation(!actor.swallowed && onLand(torso, 0.45)
      ? { x: torso.x, y: ISLAND.spawn.y, z: torso.z }
      : actor.spawn, true);
    actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.announce(actor, actor.swallowed ? '被老板吐回来了，继续打工' : '工伤结束，继续打工');
    actor.swallowed = false;
  }
}
