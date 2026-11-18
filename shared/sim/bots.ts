import { BOTS, FISHING, ISLAND, PLAY } from './config';
import { seededRandom } from './random';
import { emptyInput, type PlayerView, type SimInput, type SimSnapshot, type Vec3 } from './types';

type Point = Pick<Vec3, 'x' | 'z'>;
type BotId = keyof typeof BOTS.profiles;
type Profile = (typeof BOTS.profiles)[BotId];
type Range = readonly [number, number];

interface Pursuit {
  victim: string;
  until: number;
  steal: boolean;
}

interface Claim {
  hunter: string;
  until: number;
}

interface Brain {
  random: () => number;
  station: number;
  nextCastAt: number;
  releaseAt: number;
  reelAt: number;
  mischiefAt: number;
  reconsiderAt: number;
  pursuit: Pursuit | null;
  crossed: boolean;
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

function isInTraffic(worker: PlayerView) {
  return Boolean(worker.carrying) || (worker.hook.phase === 'idle' && worker.speed > 0.8 &&
    distance(worker.position, BOTS.crossing) < BOTS.crossingReach);
}

function chooseRival(snapshot: SimSnapshot, player: PlayerView, claims: Map<string, Claim>) {
  const leader = snapshot.players.reduce((current, candidate) =>
    candidate.shiftCash > current.shiftCash ||
      (candidate.shiftCash === current.shiftCash && candidate.shiftSold > current.shiftSold) ? candidate : current);
  let choice: PlayerView | undefined;
  let best = Infinity;
  for (const rival of snapshot.players) {
    if (rival.id === player.id || rival.ragdoll > 0 || rival.baitedBy || !isInTraffic(rival)) continue;
    const claim = claims.get(rival.id);
    if (claim && claim.until > snapshot.time) continue;
    const range = distance(player.position, rival.position);
    if (range > BOTS.mischiefReach) continue;
    const score = range + rival.metrics.interference * BOTS.interferenceWeight
      - (rival === leader && leader.shiftCash > 0 ? BOTS.leaderWeight : 0)
      - (rival.carrying ? 0.95 : 0);
    if (score < best) {
      best = score;
      choice = rival;
    }
  }
  return choice && { rival: choice, leads: choice === leader && leader.shiftCash > 0 };
}

function endPursuit(brain: Brain, player: PlayerView, claims: Map<string, Claim>, time: number, acted: boolean) {
  const pursuit = brain.pursuit;
  if (!pursuit) return;
  if (acted) {
    claims.set(pursuit.victim, { hunter: player.id, until: time + BOTS.victimRest });
    brain.mischiefAt = time + sample(brain.random, BOTS.mischiefCooldown);
  } else if (claims.get(pursuit.victim)?.hunter === player.id) {
    claims.delete(pursuit.victim);
  }
  brain.pursuit = null;
  brain.reconsiderAt = time + sample(brain.random, BOTS.rethinkSeconds);
}

function mischiefInput(snapshot: SimSnapshot, player: PlayerView, brain: Brain, profile: Profile, claims: Map<string, Claim>): SimInput | undefined {
  const { time } = snapshot;
  if (time < brain.mischiefAt) return undefined;
  if (!brain.pursuit) {
    if (time < brain.reconsiderAt) return undefined;
    brain.reconsiderAt = time + sample(brain.random, BOTS.rethinkSeconds);
    const pick = chooseRival(snapshot, player, claims);
    if (!pick || brain.random() >= (pick.leads ? BOTS.leaderChance : BOTS.crewChance)) return undefined;
    const until = time + BOTS.chaseSeconds;
    const steal = player.hook.phase === 'idle' && brain.random() < profile.stealChance;
    brain.pursuit = { victim: pick.rival.id, steal, until };
    claims.set(pick.rival.id, { hunter: player.id, until });
  }

  const { victim, until, steal } = brain.pursuit;
  const rival = snapshot.players.find((worker) => worker.id === victim);
  if (!rival || rival.ragdoll > 0 || rival.baitedBy || !isInTraffic(rival) || time >= until) {
    endPursuit(brain, player, claims, time, false);
    return undefined;
  }

  const origin = player.position;
  if (steal) {
    const fish = nearest(snapshot.fish, origin, (item) =>
      item.baitPlayerId !== player.id && Math.abs(item.position.y - origin.y) < 1.42 &&
      ((item.state === 'carried' && item.carrierId === victim && item.stealReady)
        || (item.state === 'thrown' && item.lastTouch === victim)),
    PLAY.reach - 0.14);
    if (fish) {
      endPursuit(brain, player, claims, time, true);
      return { ...emptyInput, aim: fish.position, interactPressed: true };
    }
  }

  const range = distance(origin, rival.position);
  if ((!steal || !rival.carrying || until - time < 0.34) && player.swing <= 0 &&
      range < PLAY.swingReach - 0.22 && Math.abs(rival.position.y - origin.y) < 1.3) {
    endPursuit(brain, player, claims, time, true);
    return { ...emptyInput, aim: rival.position, swingPressed: true };
  }
  return { ...emptyInput, ...steer(origin, rival.position, 1.1), aim: rival.position };
}

function deliveryInput(snapshot: SimSnapshot, player: PlayerView, brain: Brain, profile: Profile): SimInput {
  const origin = player.position;
  if (!brain.crossed && (distance(origin, BOTS.crossing) < 0.74 || origin.x > BOTS.crossing.x)) {
    brain.crossed = true;
  }
  if (!brain.crossed) {
    return { ...emptyInput, ...steer(origin, BOTS.crossing, 0.49), aim: ISLAND.scale };
  }
  if (distance(origin, profile.drop) > 0.65) {
    brain.throwAt = 0;
    return { ...emptyInput, ...steer(origin, profile.drop, 0.41), aim: ISLAND.scale };
  }
  if (!brain.throwAt) brain.throwAt = snapshot.time + sample(brain.random, BOTS.throwWindup);
  if (snapshot.time < brain.throwAt) return { ...emptyInput, aim: ISLAND.scale };
  brain.nextCastAt = snapshot.time + sample(brain.random, BOTS.shiftBreak);
  brain.station = (brain.station + 1) % FISHING.goodSpots.length;
  return { ...emptyInput, aim: ISLAND.scale, interactPressed: true };
}

function workInput(snapshot: SimSnapshot, player: PlayerView, brain: Brain, profile: Profile, claims: Map<string, Claim>): SimInput {
  const origin = player.position;
  const castAim = FISHING.goodSpots[brain.station];
  const lane = { x: castAim.x, z: BOTS.laneZ + profile.depthOffset };

  if (player.ragdoll > 0 || player.baitedBy) {
    endPursuit(brain, player, claims, snapshot.time, false);
    return emptyInput;
  }
  if (player.carrying) {
    endPursuit(brain, player, claims, snapshot.time, false);
    return deliveryInput(snapshot, player, brain, profile);
  }
  brain.crossed = false;
  brain.throwAt = 0;

  const line = fishingInput(snapshot, player, brain, castAim);
  if (line) {
    endPursuit(brain, player, claims, snapshot.time, false);
    return line;
  }

  const catchOfTheDay = nearest(snapshot.fish, origin, (fish) => fish.caughtBy === player.id
    && (fish.state === 'stunned' || fish.state === 'flopping'), 9);
  if (catchOfTheDay) {
    endPursuit(brain, player, claims, snapshot.time, false);
    const aim = catchOfTheDay.position;
    const range = distance(origin, aim);
    if (catchOfTheDay.state === 'stunned') {
      return {
        ...emptyInput, ...steer(origin, aim, 0.94), aim,
        interactPressed: range < PLAY.reach * 0.80 && Math.abs(aim.y - origin.y) < 1.25,
      };
    }
    const sight = { x: aim.x - origin.x, z: aim.z - origin.z };
    const blocking = snapshot.players.some((other) => {
      if (other.id === player.id || other.ragdoll > 0) return false;
      const gap = distance(origin, other.position);
      const dot = sight.x * (other.position.x - origin.x) + sight.z * (other.position.z - origin.z);
      return gap < range && dot > PLAY.friendlyArc * range * gap;
    });
    const angle = Math.max(0.5, range);
    const approach = blocking ? { x: aim.x - sight.z / angle * 1.4, z: aim.z + sight.x / angle * 1.4 } : aim;
    const canHit = !blocking && player.swing <= 0 && range < PLAY.swingReach * 0.89 && Math.abs(aim.y - origin.y) < 1.31;
    return {
      ...emptyInput, ...steer(origin, approach, 0.97), aim, swingPressed: canHit,
      jumpPressed: canHit && player.grounded && brain.random() < profile.jumpChance,
    };
  }

  const mischief = mischiefInput(snapshot, player, brain, profile, claims);
  if (mischief) return mischief;
  if (snapshot.time < brain.nextCastAt - 1.5) return { ...emptyInput, aim: castAim };
  if (distance(origin, lane) > 0.36) return { ...emptyInput, ...steer(origin, lane, 0.25), aim: castAim };
  if (snapshot.time < brain.nextCastAt) return { ...emptyInput, aim: castAim };
  brain.releaseAt = snapshot.time + sample(brain.random, BOTS.castHold);
  return { ...emptyInput, aim: castAim, castPressed: true, castHeld: true };
}

export function createBotController(seed: string) {
  const brains = new Map<BotId, Brain>();
  const claims = new Map<string, Claim>();
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
          station: profile.station,
          nextCastAt: profile.start + random() * 0.32,
          releaseAt: 0,
          reelAt: 0,
          mischiefAt: sample(random, BOTS.firstMischief),
          reconsiderAt: 0,
          pursuit: null,
          crossed: false,
          throwAt: 0,
        };
        brains.set(id, brain);
      }
      return workInput(snapshot, player, brain, profile, claims);
    },
  };
}
