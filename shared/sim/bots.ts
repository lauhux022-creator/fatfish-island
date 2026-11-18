import { BOTS, ISLAND, PLAY } from './config';
import { seededRandom } from './random';
import { emptyInput, type PlayerView, type SimInput, type SimSnapshot, type Vec3 } from './types';

type Point = Pick<Vec3, 'x' | 'z'>;
type BotId = keyof typeof BOTS.profiles;
type Profile = (typeof BOTS.profiles)[BotId];
type Range = readonly [number, number];

interface Brain {
  random: () => number;
  nextCastAt: number;
  releaseAt: number;
  reelAt: number;
  mischiefAt: number;
  throwAt: number;
}

function sample(random: () => number, [low, high]: Range) {
  return low + (high - low) * random();
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function steer(origin: Point, target: Point, stop: number): Pick<SimInput, 'moveX' | 'moveZ'> {
  const inset = BOTS.shoreInset;
  const x = clamp(target.x, ISLAND.minX + inset, ISLAND.maxX - inset) - origin.x;
  const z = clamp(target.z, ISLAND.shoreZ + inset, ISLAND.backZ - inset) - origin.z;
  const length = Math.hypot(x, z);
  if (length <= stop) return { moveX: 0, moveZ: 0 };
  const speed = Math.min(1, (length - stop) / 0.7 + 0.15);
  return { moveX: x * speed / length, moveZ: z * speed / length };
}

function nearest<T extends { position: Vec3 }>(
  choices: readonly T[], origin: Point, eligible: (item: T) => boolean, reach: number,
) {
  let selected: T | undefined;
  for (const item of choices) {
    if (!eligible(item)) continue;
    const range = distance(origin, item.position);
    if (range < reach) {
      reach = range;
      selected = item;
    }
  }
  return selected;
}

function fishingInput(snapshot: SimSnapshot, player: PlayerView, brain: Brain, castAim: Point): SimInput | undefined {
  const { phase } = player.hook;
  if (phase === 'idle') return undefined;
  if (phase === 'charging') {
    const release = snapshot.time >= brain.releaseAt;
    return { ...emptyInput, aim: castAim, castHeld: !release, castReleased: release };
  }
  if ((phase === 'bite' || phase === 'reeling' || phase === 'bait') && snapshot.time >= brain.reelAt) {
    brain.reelAt = snapshot.time + sample(brain.random, BOTS.reelCadence);
    return { ...emptyInput, aim: castAim, castPressed: true };
  }
  return { ...emptyInput, aim: castAim };
}

function mischiefInput(snapshot: SimSnapshot, player: PlayerView, brain: Brain, profile: Profile) {
  if (snapshot.time < brain.mischiefAt) return undefined;
  const theft = nearest(snapshot.fish, player.position, (fish) =>
    fish.caughtBy !== player.id && fish.baitPlayerId !== player.id
    && Math.abs(fish.position.y - player.position.y) < 1.25
    && (fish.state === 'carried' || fish.state === 'thrown'), BOTS.mischiefReach);
  if (theft) {
    brain.mischiefAt = snapshot.time + sample(brain.random, BOTS.mischiefCooldown);
    if (brain.random() < profile.stealChance) {
      return { ...emptyInput, aim: theft.position, interactPressed: true };
    }
    return undefined;
  }
  if (player.swing > 0) return undefined;
  const rival = nearest(snapshot.players, player.position, (other) =>
    other.id !== player.id && other.ragdoll === 0 && !other.baitedBy && Boolean(other.carrying), BOTS.mischiefReach);
  if (rival) {
    brain.mischiefAt = snapshot.time + sample(brain.random, BOTS.mischiefCooldown);
    if (brain.random() < BOTS.roughhouseChance) {
      return { ...emptyInput, aim: rival.position, swingPressed: true };
    }
  }
  return undefined;
}

function workInput(snapshot: SimSnapshot, player: PlayerView, brain: Brain, profile: Profile): SimInput {
  const origin = player.position;
  const lane = { x: profile.laneX, z: BOTS.laneZ };
  const castAim = { x: profile.laneX, z: BOTS.castZ };

  if (player.ragdoll > 0 || player.baitedBy) return emptyInput;
  if (player.carrying) {
    const drop = { x: profile.dropX, z: BOTS.dropZ };
    if (distance(origin, drop) > 0.65) {
      brain.throwAt = 0;
      return { ...emptyInput, ...steer(origin, drop, 0.46), aim: ISLAND.scale };
    }
    if (!brain.throwAt) brain.throwAt = snapshot.time + sample(brain.random, BOTS.throwWindup);
    if (snapshot.time < brain.throwAt) return { ...emptyInput, aim: ISLAND.scale };
    brain.nextCastAt = snapshot.time + sample(brain.random, BOTS.shiftBreak);
    return { ...emptyInput, aim: ISLAND.scale, interactPressed: true };
  }
  brain.throwAt = 0;

  const line = fishingInput(snapshot, player, brain, castAim);
  if (line) return line;

  const catchOfTheDay = nearest(snapshot.fish, origin, (fish) => fish.caughtBy === player.id
    && (fish.state === 'stunned' || fish.state === 'flopping'), 9);
  if (catchOfTheDay) {
    const aim = catchOfTheDay.position;
    const range = distance(origin, aim);
    if (catchOfTheDay.state === 'stunned') {
      return {
        ...emptyInput, ...steer(origin, aim, 1.02), aim,
        interactPressed: range < PLAY.reach * 0.81 && Math.abs(aim.y - origin.y) < 1.25,
      };
    }
    const canHit = player.swing <= 0 && range < PLAY.swingReach * 0.88 && Math.abs(aim.y - origin.y) < 1.22;
    return {
      ...emptyInput, ...steer(origin, aim, 1.22), aim, swingPressed: canHit,
      jumpPressed: canHit && player.grounded && brain.random() < profile.jumpChance,
    };
  }

  const mischief = mischiefInput(snapshot, player, brain, profile);
  if (mischief) return mischief;
  if (distance(origin, lane) > 0.36) return { ...emptyInput, ...steer(origin, lane, 0.25), aim: castAim };
  if (snapshot.time < brain.nextCastAt) return { ...emptyInput, aim: castAim };
  brain.releaseAt = snapshot.time + sample(brain.random, BOTS.castHold);
  return { ...emptyInput, aim: castAim, castPressed: true, castHeld: true };
}

export function createBotController(seed: string) {
  const brains = new Map<BotId, Brain>();
  return {
    input(snapshot: SimSnapshot, player: PlayerView): SimInput {
      const id = player.id as BotId;
      const profile = BOTS.profiles[id];
      if (!player.bot || !profile) return emptyInput;
      let brain = brains.get(id);
      if (!brain) {
        const random = seededRandom(`${seed}/${id}`);
        brain = {
          random,
          nextCastAt: profile.start + random() * 0.32,
          releaseAt: 0,
          reelAt: 0,
          mischiefAt: sample(random, BOTS.firstMischief),
          throwAt: 0,
        };
        brains.set(id, brain);
      }
      return workInput(snapshot, player, brain, profile);
    },
  };
}
