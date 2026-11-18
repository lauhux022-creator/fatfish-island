import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { FISH, FISHING, PLAY, TICKS_PER_SECOND } from '../shared/sim/config';
import { SHOP, SHOP_ITEM_IDS, type ShopItemId } from '../shared/sim/shop';
import { emptyInput, type SimInput, type SimSnapshot, type Vec3 } from '../shared/sim/types';
import { createReviewPolicy } from './review-policy.mjs';

type Simulation = Awaited<ReturnType<typeof createSimulation>>;
const seed = { seed: 'm2-review', day: 3 };
const idleCrew = { 'bot-1': emptyInput, 'bot-2': emptyInput, 'bot-3': emptyInput };
const groundLane = { x: 0.15, z: -0.85 };
const water = { x: -0.4, z: -8.9 };

function step(sim: Simulation, input: SimInput = emptyInput) {
  sim.step(input, idleCrew);
  return sim.snapshot();
}

function playShift(sim: Simulation, goal?: number) {
  const policy = createReviewPolicy();
  let input: SimInput = emptyInput;
  let castHeld = false;
  let state = sim.snapshot();
  for (let tick = 0; tick < PLAY.daySeconds * TICKS_PER_SECOND; tick++) {
    if (tick % 6 === 0) {
      const plan = policy(state);
      input = { ...emptyInput, moveX: plan.moveX ?? 0, moveZ: plan.moveZ ?? 0, aim: plan.aim ?? null, castHeld,
        swingPressed: Boolean(plan.swing), interactPressed: Boolean(plan.interact) };
      if (castHeld && (state.hook.phase !== 'charging' || plan.cast === 'release')) {
        castHeld = false;
        input.castReleased = true;
      } else if (!castHeld && plan.cast === 'hold') {
        castHeld = true;
        input.castPressed = true;
      } else if (plan.cast === 'tap') input.castPressed = true;
    } else input = { ...emptyInput, moveX: input.moveX, moveZ: input.moveZ, aim: input.aim, castHeld };
    sim.step(input);
    state = sim.snapshot();
    if (goal && state.cash >= goal && state.hook.phase === 'idle' && !state.player.ragdoll && !state.player.carrying) return state;
  }
  if (goal) assert.fail(`Did not earn ¥${goal}`);
  return state;
}

function walk(sim: Simulation, to: Pick<Vec3, 'x' | 'z'>) {
  for (let tick = 0; tick < 4 * TICKS_PER_SECOND; tick++) {
    const { x, z } = sim.snapshot().player.position;
    const dx = to.x - x;
    const dz = to.z - z;
    const gap = Math.hypot(dx, dz);
    if (gap < 0.26) return;
    sim.step({ ...emptyInput, moveX: dx / gap, moveZ: dz / gap }, idleCrew);
  }
  assert.fail(`Could not reach (${to.x}, ${to.z})`);
}

function approachShop(sim: Simulation) {
  walk(sim, { x: -4.4, z: 3.7 });
  walk(sim, SHOP.position);
  assert.equal(sim.snapshot().player.shopOpen, true);
}

function until(sim: Simulation, condition: (state: SimSnapshot) => boolean, ticks: number) {
  for (let tick = 0; tick <= ticks; tick++) {
    const state = tick === 0 ? sim.snapshot() : step(sim);
    if (condition(state)) return state;
  }
  assert.fail('Simulation did not reach the expected state');
}

function cast(sim: Simulation, aim: SimInput['aim']) {
  for (let tick = 0; tick < 48; tick++) {
    sim.step({ ...emptyInput, aim, castPressed: tick === 0, castHeld: true }, idleCrew);
  }
  assert.equal(sim.snapshot().hook.charge, 1, 'the rod reaches full charge in 0.8s');
  step(sim, { ...emptyInput, aim, castReleased: true });
}

test('ignoring the stall preserves the reviewed basic equipment and shift numbers', async (t) => {
  const sim = await createSimulation(seed);
  t.after(() => sim.dispose());
  const state = playShift(sim);
  assert.equal(state.time, 240);
  assert.equal(state.player.shiftSold, 10);
  assert.equal(state.player.metrics.interference, 6);
  assert.equal(state.metrics.fishIncidents, 17);
  assert.equal(state.teamRevenue, 2106);
  assert.deepEqual(state.player.equipment, { rod: false, pan: false, bait: false, popper: false });
});

test('a short cast aimed at water tells players to charge, and a land aim gets a direction hint', async (t) => {
  const attempts = [
    { aim: { x: 1.6, z: -8.1 }, feedback: /蓄满/ },
    { aim: { x: 0, z: 1 }, feedback: /瞄准岸外/ },
  ];
  for (const { aim, feedback } of attempts) {
    const sim = await createSimulation({ seed: 'ux-first-shift' });
    t.after(() => sim.dispose());
    for (let tick = 0; tick < 20; tick++) {
      sim.step({ ...emptyInput, aim, castPressed: tick === 0, castHeld: true }, idleCrew);
    }
    step(sim, { ...emptyInput, aim, castReleased: true });
    const miss = until(sim, ({ hook }) => hook.phase === 'idle', 2 * TICKS_PER_SECOND);
    assert.match(miss.notice?.text ?? '', feedback);
  }
});

test('the shop validates cash, range, eligibility and duplicate buys independently of the sale ledger', async (t) => {
  const broke = await createSimulation(seed);
  t.after(() => broke.dispose());
  approachShop(broke);
  const rejected = step(broke, { ...emptyInput, buy: 'bait' });
  assert.equal(rejected.cash, 0);
  assert(!rejected.player.equipment.bait);

  const sim = await createSimulation(seed);
  t.after(() => sim.dispose());
  const paid = playShift(sim, 260);
  assert.equal(step(sim, { ...emptyInput, buy: 'rod' }).cash, paid.cash);
  approachShop(sim);

  const airborne = step(sim, { ...emptyInput, jumpPressed: true, buy: 'rod' });
  assert(!airborne.player.shopOpen);
  assert.equal(airborne.cash, paid.cash);
  until(sim, ({ player }) => player.shopOpen, 2 * TICKS_PER_SECOND);
  assert.equal(step(sim, { ...emptyInput, buy: 'missing' as ShopItemId }).cash, paid.cash);

  const ledger = sim.snapshot();
  let spent = 0;
  for (const id of SHOP_ITEM_IDS) {
    spent += SHOP.items[id].price;
    const bought = step(sim, { ...emptyInput, buy: id });
    assert(bought.player.equipment[id]);
    assert.equal(bought.cash, paid.cash - spent);
    assert.equal(step(sim, { ...emptyInput, buy: id }).cash, bought.cash);
  }
  const bought = sim.snapshot();
  assert.equal(bought.player.shiftCash, ledger.player.shiftCash);
  assert.equal(bought.teamRevenue, ledger.teamRevenue);
  assert.equal(bought.campaign.warehouse.value, ledger.campaign.warehouse.value);

  const night = until(sim, ({ campaign }) => campaign.phase === 'night', PLAY.daySeconds * TICKS_PER_SECOND);
  assert.equal(night.player.shopOpen, false);
});

test('bait waits for a fish, the rod cuts reel taps and the pan stuns in one swing', async (t) => {
  async function prepare(useBait: boolean) {
    const sim = await createSimulation(seed);
    t.after(() => sim.dispose());
    playShift(sim, 260);
    approachShop(sim);
    step(sim, { ...emptyInput, buy: 'rod' });
    step(sim, { ...emptyInput, buy: 'pan' });
    step(sim, { ...emptyInput, buy: useBait ? 'bait' : undefined });

    cast(sim, { x: -8.5, z: 2.4 });
    const miss = until(sim, ({ hook }) => hook.phase === 'idle', 2 * TICKS_PER_SECOND);
    assert.equal(miss.player.equipment.bait, useBait);

    const crate = miss.crates.find(({ id }) => id === 'training-crate');
    assert(crate);
    cast(sim, crate.position);
    const snag = until(sim, ({ hook }) => hook.phase === 'bite', 2 * TICKS_PER_SECOND);
    assert.equal(snag.hook.targetId, crate.id);
    assert.equal(snag.player.equipment.bait, useBait);
    for (let tap = 0; tap < FISHING.crateTaps - 1; tap++) step(sim, { ...emptyInput, castPressed: true });
    assert.equal(sim.snapshot().hook.phase, 'reeling');
    assert.equal(step(sim, { ...emptyInput, castPressed: true }).hook.phase, 'idle');

    walk(sim, groundLane);
    cast(sim, water);
    const waiting = until(sim, ({ hook }) => hook.phase === 'waiting', 2 * TICKS_PER_SECOND);
    assert.equal(waiting.player.equipment.bait, useBait);
    const caught = until(sim, ({ hook }) => hook.phase === 'bite', 12 * TICKS_PER_SECOND);
    assert.equal(caught.player.equipment.bait, false);
    return { sim, caught, biteTime: caught.time - waiting.time };
  }

  const paid = await prepare(true);
  const ordinary = await prepare(false);
  assert(Math.abs(ordinary.biteTime - paid.biteTime - SHOP.items.bait.biteReduction) < 1e-9);
  const fish = paid.caught.fish.find(({ id }) => id === paid.caught.hook.targetId);
  assert.equal(fish?.kind, 'puffer');
  assert(fish);
  const taps = FISH[fish.kind].taps - SHOP.items.rod.fewerTaps;
  for (let tap = 0; tap < taps - 1; tap++) step(paid.sim, { ...emptyInput, aim: water, castPressed: true });
  assert.equal(paid.sim.snapshot().hook.phase, 'reeling');
  assert.equal(step(paid.sim, { ...emptyInput, aim: water, castPressed: true }).hook.phase, 'idle');

  let swings = 0;
  for (let tick = 0; tick < 3 * TICKS_PER_SECOND; tick++) {
    const { player, fish: activeFish } = paid.sim.snapshot();
    const live = activeFish.find(({ id }) => id === fish.id);
    assert(live);
    if (live.state === 'stunned') break;
    assert.equal(live.state, 'flopping');
    const dx = live.position.x - player.position.x;
    const dz = live.position.z + 0.25 - player.position.z;
    const gap = Math.hypot(dx, dz);
    const swing = Math.hypot(dx, dz - 0.25) < 1.9 && Math.abs(live.position.y - player.position.y) < 1.35 && player.swing === 0;
    if (swing) swings++;
    step(paid.sim, { ...emptyInput, aim: live.position, swingPressed: swing,
      moveX: gap > 0.35 ? dx / gap : 0, moveZ: gap > 0.35 ? dz / gap : 0 });
  }
  assert.equal(paid.sim.snapshot().fish.find(({ id }) => id === fish.id)?.state, 'stunned');
  assert.equal(swings, 1);
  t.diagnostic(`Fished a puffer after ${paid.biteTime.toFixed(2)}s with bait, took ${taps} reel taps and ${swings} pan swing`);

  approachShop(paid.sim);
  const night = until(paid.sim, ({ campaign }) => campaign.phase === 'night', PLAY.daySeconds * TICKS_PER_SECOND);
  assert(night.cash >= SHOP.items.bait.price);
  const unavailable = step(paid.sim, { ...emptyInput, buy: 'bait' });
  assert.equal(unavailable.cash, night.cash);
  assert(!unavailable.player.equipment.bait);
});
