import { CAMPAIGN, ISLAND, STEP_SECONDS } from './config';
import type { BuildKind, EnemyView, StructureView } from './campaign-types';
import { buildSiteAvailable, snapBuildSite } from './construction';
import { seededRandom } from './random';
import type { Vec3 } from './types';

type Point = Pick<Vec3, 'x' | 'z'>;

interface RaidWorker {
  id: string;
  position: Vec3;
}

export type DefenseEvent =
  | { kind: 'raid'; count: number }
  | { kind: 'knockdown'; actorId: string; source: Vec3; force: Vec3 };

interface Attack {
  position: Vec3;
  radius: number;
  structureId?: string;
}

interface Enemy extends EnemyView {
  stateUntil: number;
  readyAt: number;
  attack?: Attack;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function point(x: number, z: number): Vec3 {
  return { x, y: z < ISLAND.shoreZ ? ISLAND.seaY : ISLAND.groundY, z };
}

function nearest<T extends { position: Vec3 }>(items: Iterable<T>, origin: Point, range: number): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    const gap = distance(item.position, origin);
    if (gap < range) {
      best = item;
      range = gap;
    }
  }
  return best;
}

function face(enemy: Enemy, target: Point) {
  const dx = target.x - enemy.position.x;
  const dz = target.z - enemy.position.z;
  if (Math.hypot(dx, dz) > 0.01) enemy.yaw = Math.atan2(-dx, -dz);
}

function walk(enemy: Enemy, target: Point, speed: number) {
  const origin = enemy.position;
  const length = distance(origin, target);
  if (length <= 0.01) return;
  face(enemy, target);
  const amount = Math.min(1, speed * STEP_SECONDS / length);
  enemy.position = point(origin.x + (target.x - origin.x) * amount, origin.z + (target.z - origin.z) * amount);
}

export class Defense {
  private readonly random: () => number;
  private readonly structures = new Map<string, StructureView>();
  private readonly enemies = new Map<string, Enemy>();
  private wood: number = CAMPAIGN.startingWood;
  private mode: 'idle' | 'night' | 'boss' = 'idle';
  private waveAt = 0;
  private wave = 0;
  private raidSize = 2;
  private time = 0;
  private id = 0;
  private defeated = false;

  constructor(seed: string) {
    this.random = seededRandom(`${seed}:night-defense`);
  }

  get bossDefeated() {
    return this.defeated;
  }

  snapshot(): { wood: number; structures: StructureView[]; enemies: EnemyView[] } {
    return {
      wood: this.wood,
      structures: Array.from(this.structures.values(), (item) => ({ ...item, position: { ...item.position } })),
      enemies: Array.from(this.enemies.values(), (item) => ({
        id: item.id, kind: item.kind, position: { ...item.position }, yaw: item.yaw, hp: item.hp,
        maxHp: item.maxHp, state: item.state,
        attack: item.attack && { position: { ...item.attack.position }, radius: item.attack.radius },
      })),
    };
  }

  startNight(day: number, time: number) {
    this.mode = 'night';
    this.time = time;
    this.enemies.clear();
    this.waveAt = time + CAMPAIGN.raid.firstWaveSeconds;
    this.wave = 0;
    this.raidSize = Math.min(3, 2 + Math.floor((day - 1) / CAMPAIGN.cycleDays));
    this.wood = Math.min(CAMPAIGN.maxWood, this.wood + CAMPAIGN.tideWood);
  }

  endNight() {
    this.enemies.clear();
    this.mode = 'idle';
  }

  startBoss(time: number) {
    this.mode = 'boss';
    this.time = time;
    this.enemies.clear();
    this.wood = Math.min(CAMPAIGN.maxWood, this.wood + CAMPAIGN.bossWood);
    this.spawn('crab', { ...CAMPAIGN.crab.spawn }, CAMPAIGN.crab.hp, time + CAMPAIGN.crab.firstAttackSeconds);
  }

  build(kind: BuildKind, position: Vec3) {
    const plan = CAMPAIGN.build[kind];
    const at = snapBuildSite(position);
    if (!plan || this.wood < plan.cost
      || !buildSiteAvailable(at, [...this.structures.values()], [...this.enemies.values()])) return false;
    const id = `defense-${++this.id}`;
    this.structures.set(id, { id, kind, position: at, yaw: 0, hp: plan.hp, maxHp: plan.hp });
    this.wood -= plan.cost;
    return true;
  }

  hit(origin: Vec3, aim: Point, weaponReach: number) {
    let victim: Enemy | undefined;
    let score = Infinity;
    for (const enemy of this.enemies.values()) {
      const gap = distance(enemy.position, origin);
      const reach = weaponReach + (enemy.kind === 'crab' ? CAMPAIGN.crab.sizeReach : 0);
      const dx = enemy.position.x - origin.x;
      const dz = enemy.position.z - origin.z;
      const facing = (aim.x * dx + aim.z * dz) / Math.max(0.01, gap);
      if (gap > reach || (gap > 1.05 && facing < 0.34) || Math.abs(origin.y - enemy.position.y) > 2.2) continue;
      const candidate = gap * (1.35 - facing * 0.35);
      if (candidate < score) {
        victim = enemy;
        score = candidate;
      }
    }
    if (!victim) return false;
    if (victim.kind === 'crab' && victim.state !== 'recover') {
      const towardCrew = (origin.x - victim.position.x) * -Math.sin(victim.yaw)
        + (origin.z - victim.position.z) * -Math.cos(victim.yaw);
      if (victim.state === 'windup' || towardCrew > distance(origin, victim.position) * CAMPAIGN.crab.lateralGuard) return true;
    }
    this.damage(victim, 1);
    if (victim.kind === 'raider' && victim.hp > 0) this.recover(victim, CAMPAIGN.raid.staggerSeconds);
    return true;
  }

  step(time: number, workers: readonly RaidWorker[], stockedLots: number): DefenseEvent[] {
    this.time = time;
    const events: DefenseEvent[] = [];
    if (this.mode === 'night' && time >= this.waveAt) this.spawnWave();
    for (const enemy of this.enemies.values()) {
      if (this.checkTrap(enemy)) continue;
      if (enemy.state === 'windup') {
        if (time >= enemy.stateUntil) this.resolveStrike(enemy, workers, events);
        continue;
      }
      if (enemy.state === 'recover') {
        if (time < enemy.stateUntil) continue;
        enemy.state = 'advance';
      }
      if (enemy.kind === 'crab') {
        this.advanceCrab(enemy, workers);
        continue;
      }
      if (this.advanceRaider(enemy, workers) && stockedLots > 0) {
        const count = Math.min(stockedLots, CAMPAIGN.raid.steal);
        stockedLots -= count;
        events.push({ kind: 'raid', count });
      }
    }
    return events;
  }

  private spawn(kind: Enemy['kind'], position: Vec3, hp: number, readyAt: number) {
    const id = kind === 'crab' ? 'island-crab' : `raider-${++this.id}`;
    this.enemies.set(id, { id, kind, position, yaw: Math.PI, hp, maxHp: hp, state: 'advance', stateUntil: 0, readyAt });
  }

  private spawnWave() {
    const { raid } = CAMPAIGN;
    for (let index = 0; index < this.raidSize && this.enemies.size < raid.maxActive; index++) {
      const lane = raid.lanes[(this.wave + index) % raid.lanes.length];
      const drift = (this.random() - 0.5) * 0.9;
      this.spawn('raider', point(lane + drift, raid.spawnZ), raid.hp, this.time + 0.75);
    }
    this.wave += 1;
    this.waveAt = this.time + raid.waveSeconds + this.random() * 1.9;
  }

  private structuresOf(kind: BuildKind) {
    return [...this.structures.values()].filter((item) => item.kind === kind);
  }

  private blockingFence(origin: Vec3, goal: Vec3, padding: number) {
    const { halfWidth, halfDepth } = CAMPAIGN.build.fence;
    const gap = distance(origin, goal);
    return this.structuresOf('fence').find(({ position }) =>
      Math.abs(origin.x - position.x) < halfWidth + padding
      && Math.abs(origin.z - position.z) < halfDepth + padding + 0.16
      && distance(position, goal) < gap + 0.24);
  }

  private checkTrap(enemy: Enemy) {
    const trap = nearest(this.structuresOf('trap'), enemy.position, CAMPAIGN.build.trap.radius);
    if (!trap) return false;
    this.structures.delete(trap.id);
    this.damage(enemy, CAMPAIGN.build.trap.damage);
    if (enemy.hp > 0) this.recover(enemy, CAMPAIGN.build.trap.stunSeconds);
    return true;
  }

  private advanceRaider(enemy: Enemy, workers: readonly RaidWorker[]) {
    const { raid, build } = CAMPAIGN;
    const origin = enemy.position;
    const lure = nearest(this.structuresOf('lure'), origin, build.lure.attractionReach);
    const goal = lure?.position ?? CAMPAIGN.warehouse;
    const fence = this.blockingFence(origin, goal, 0.28);
    const target = fence ?? (lure && distance(origin, goal) < raid.reach ? lure : undefined);
    if (target) {
      face(enemy, target.position);
      this.windup(enemy, target.position, raid.strikeRadius, raid.windupSeconds, target.id);
      return false;
    }
    if (!lure && distance(origin, CAMPAIGN.warehouse) <= CAMPAIGN.warehouseRadius) {
      this.enemies.delete(enemy.id);
      return true;
    }
    const worker = origin.y >= ISLAND.groundY && this.time >= enemy.readyAt
      ? nearest(workers, origin, raid.reach) : undefined;
    if (worker) {
      face(enemy, worker.position);
      this.windup(enemy, worker.position, raid.strikeRadius, raid.windupSeconds);
      return false;
    }
    walk(enemy, goal, raid.speed);
    return false;
  }

  private advanceCrab(enemy: Enemy, workers: readonly RaidWorker[]) {
    const { crab, build } = CAMPAIGN;
    const lure = nearest(this.structuresOf('lure'), enemy.position, build.lure.attractionReach);
    const target = lure ?? nearest(workers, enemy.position, Infinity);
    if (!target) return;
    const origin = enemy.position;
    if (distance(origin, target.position) > crab.strikeReach) {
      const fence = this.blockingFence(origin, target.position, 0.62);
      if (!fence) walk(enemy, target.position, crab.speed);
      else if (this.time >= enemy.readyAt) {
        face(enemy, fence.position);
        this.windup(enemy, fence.position, crab.strikeRadius, crab.windupSeconds);
      }
      return;
    }
    face(enemy, target.position);
    if (this.time < enemy.readyAt) return;
    const reach = Math.min(2.1, distance(origin, target.position));
    const center = point(origin.x - Math.sin(enemy.yaw) * reach, origin.z - Math.cos(enemy.yaw) * reach);
    this.windup(enemy, center, crab.strikeRadius, crab.windupSeconds);
  }

  private windup(enemy: Enemy, target: Vec3, radius: number, seconds: number, structureId?: string) {
    enemy.state = 'windup';
    enemy.stateUntil = this.time + seconds;
    enemy.attack = { position: point(target.x, target.z), radius, structureId };
  }

  private resolveStrike(enemy: Enemy, workers: readonly RaidWorker[], events: DefenseEvent[]) {
    const attack = enemy.attack!;
    const crab = enemy.kind === 'crab';
    // The marked area is fixed at windup; moving out or jumping avoids the strike.
    if (attack.structureId) {
      const structure = this.structures.get(attack.structureId);
      if (structure) this.damageStructure(structure, 1);
    } else {
      for (const worker of workers) {
        const position = worker.position;
        if (position.y > 1.65 || distance(position, attack.position) > attack.radius) continue;
        const dx = position.x - enemy.position.x;
        const dz = position.z - enemy.position.z;
        const length = Math.max(0.35, Math.hypot(dx, dz));
        events.push({
          kind: 'knockdown', actorId: worker.id, source: { ...enemy.position },
          force: { x: dx / length * (crab ? 5.25 : 3.5), y: crab ? 4.15 : 3, z: dz / length * (crab ? 5.25 : 3.5) },
        });
      }
      if (crab) {
        for (const structure of this.structures.values()) {
          if (distance(structure.position, attack.position) <= attack.radius) this.damageStructure(structure, 2);
        }
      }
    }
    this.recover(enemy, crab ? CAMPAIGN.crab.recoverSeconds : CAMPAIGN.raid.recoverSeconds);
    enemy.readyAt = this.time + (crab ? CAMPAIGN.crab.attackInterval : CAMPAIGN.raid.recoverSeconds + 0.45);
  }

  private recover(enemy: Enemy, seconds: number) {
    enemy.state = 'recover';
    enemy.stateUntil = this.time + seconds;
    enemy.attack = undefined;
  }

  private damage(enemy: Enemy, amount: number) {
    enemy.hp -= amount;
    if (enemy.hp > 0) return;
    this.enemies.delete(enemy.id);
    if (enemy.kind === 'crab') this.defeated = true;
  }

  private damageStructure(structure: StructureView, amount: number) {
    structure.hp -= amount;
    if (structure.hp <= 0) this.structures.delete(structure.id);
  }
}
