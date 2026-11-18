import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRoomMessage } from '../server/room-wire';
import { createSimulation } from '../shared/sim';
import { FISH, FISHING, ISLAND, PLAY, TICKS_PER_SECOND } from '../shared/sim/config';
import { POPPER } from '../shared/sim/popper';
import { SHOP } from '../shared/sim/shop';
import { emptyInput, type SimInput, type Vec3 } from '../shared/sim/types';
import { cargoFish, cargoStep, cargoUntil, cargoWorker, nearCargoWorker, type CargoSimulation } from './cargo-fixture';
import { createReviewPolicy } from './review-policy.mjs';

const seed = { seed: 'm2-review', day: 3 };
type Point = Pick<Vec3, 'x' | 'z'>;

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function approach(from: Vec3, to: Point, stop: number) {
  const gap = distance(from, to);
  return gap > stop ? { moveX: (to.x - from.x) / gap, moveZ: (to.z - from.z) / gap } : { moveX: 0, moveZ: 0 };
}

function playerStep(sim: CargoSimulation, input: Partial<SimInput> = {}) {
  return cargoStep(sim, { player: { ...emptyInput, ...input } });
}

function sellForCash(sim: CargoSimulation, cost: number) {
  const plan = createReviewPolicy();
  let view = sim.snapshot();
  let input: SimInput = emptyInput;
  let held = false;
  for (let tick = 0; tick < PLAY.daySeconds * TICKS_PER_SECOND; tick++) {
    if (tick % 6 === 0) {
      const next = plan(view);
      const release = held && (view.hook.phase !== 'charging' || next.cast === 'release');
      const charge = !held && next.cast === 'hold';
      held = charge || (held && !release);
      input = { ...emptyInput, moveX: next.moveX ?? 0, moveZ: next.moveZ ?? 0, aim: next.aim ?? null,
        castHeld: held, castPressed: charge || next.cast === 'tap', castReleased: release,
        swingPressed: !!next.swing, interactPressed: !!next.interact };
    } else input = { ...emptyInput, moveX: input.moveX, moveZ: input.moveZ, aim: input.aim, castHeld: held };
    view = playerStep(sim, input);
    if (view.cash >= cost && view.hook.phase === 'idle' && !view.player.carrying) return view;
  }
  assert.fail(`could not earn ¥${cost} through normal fishing`);
}

function approachShop(sim: CargoSimulation) {
  nearCargoWorker(sim, 'player', { x: -4.4, z: 3.7 });
  nearCargoWorker(sim, 'player', SHOP.position);
  assert(sim.snapshot().player.shopOpen);
}

function landFish(sim: CargoSimulation) {
  nearCargoWorker(sim, 'player', { x: -4.4, z: 3.7 });
  nearCargoWorker(sim, 'player', { x: 0.1, z: -0.55 });
  const aim = { x: -0.1, z: -8.8 };
  for (let tick = 0; tick <= FISHING.chargeSeconds * TICKS_PER_SECOND; tick++) {
    playerStep(sim, { aim, castPressed: tick === 0, castHeld: true });
  }
  playerStep(sim, { aim, castReleased: true });
  const bite = cargoUntil(sim, ({ hook }) => hook.phase === 'bite', 14 * TICKS_PER_SECOND);
  assert(bite.hook.targetId);
  const fish = cargoFish(bite, bite.hook.targetId);
  assert(!fish.heavy);
  for (let tap = 0; tap < FISH[fish.kind].taps; tap++) playerStep(sim, { aim, castPressed: true });

  for (let tick = 0; tick < 5 * TICKS_PER_SECOND; tick++) {
    const view = sim.snapshot();
    const groundedFish = cargoFish(view, fish.id);
    if (groundedFish.state === 'stunned') return fish.id;
    assert.equal(groundedFish.state, 'flopping');
    const { position, swing } = view.player;
    const target = { ...groundedFish.position, z: Math.max(ISLAND.shoreZ + 0.85, groundedFish.position.z + 0.3) };
    const swingPressed = !swing && distance(position, groundedFish.position) < 2.2
      && Math.abs(position.y - groundedFish.position.y) < 1.35;
    playerStep(sim, { ...approach(position, target, 0.65), aim: groundedFish.position, swingPressed });
  }
  assert.fail('could not stun the landed fish with the paddle');
}

function buyPopper(sim: CargoSimulation) {
  const cost = SHOP.items.popper.price;
  const paid = sellForCash(sim, cost * 2);
  assert(paid.sold > 0);
  assert.equal(paid.campaign.warehouse.stock, paid.sold);
  const outOfRange = playerStep(sim, { buy: 'popper' });
  assert.equal(outOfRange.cash, paid.cash);
  assert.equal(outOfRange.player.equipment.popper, false);

  approachShop(sim);
  const stocked = playerStep(sim, { buy: 'popper' });
  assert.equal(stocked.cash, paid.cash - cost);
  assert.equal(stocked.player.equipment.popper, true);
  assert.equal(stocked.teamRevenue, paid.teamRevenue);
  assert.equal(stocked.campaign.warehouse.value, paid.campaign.warehouse.value);
  const duplicate = playerStep(sim, { buy: 'popper' });
  assert.equal(duplicate.cash, stocked.cash);
  return stocked;
}

function prepareBlast(sim: CargoSimulation) {
  const id = landFish(sim);
  const simTime = sim.snapshot().time;
  const rested = cargoUntil(sim, ({ time }) => time >= simTime + 0.7, TICKS_PER_SECOND);
  const { position } = cargoFish(rested, id);
  const side = position.x < 0 ? 1 : -1;
  const target = { x: position.x - side * 0.65, z: Math.max(ISLAND.shoreZ + 0.65, position.z) };
  const watcher = { x: target.x + side * 3.6, z: target.z + 0.2 };
  nearCargoWorker(sim, 'bot-2', { x: target.x, z: target.z + 1.55 });
  const facing = sim.snapshot().player.position;
  nearCargoWorker(sim, 'player', { x: facing.x, z: target.z + 2.8 });
  nearCargoWorker(sim, 'player', watcher);
  const before = sim.snapshot();
  const finalPosition = cargoFish(before, id).position;
  assert(distance(target, finalPosition) < POPPER.radius);
  assert(distance(target, cargoWorker(before, 'bot-2').position) < POPPER.radius);
  assert(distance(target, before.player.position) > POPPER.radius);
  assert(distance(target, before.player.position) < POPPER.throwReach);
  return { before, id, target };
}

test('room inputs accept a boolean popper edge and reject other values', () => {
  for (const edge of [true, false, undefined]) {
    const packet = readRoomMessage(JSON.stringify({ type: 'input', seq: 1, input: { ...emptyInput, popperPressed: edge } }));
    assert.equal(packet?.type, 'input');
    assert.equal(packet.input.popperPressed, edge === true);
  }
  for (const popperPressed of [null, 1, 'true', []]) {
    assert.equal(readRoomMessage(JSON.stringify({ type: 'input', seq: 1, input: { ...emptyInput, popperPressed } })), null);
  }
});

test('a purchased popper respects its fuse, ragdolls friends and pays a single aerial-catch sale', async (t) => {
  const sim = await createSimulation(seed);
  t.after(() => sim.dispose());
  const noStock = playerStep(sim, { aim: { x: 0.9, z: 2.3 }, popperPressed: true });
  assert.equal(noStock.poppers.length, 0);
  assert.equal(noStock.cash, 0);
  buyPopper(sim);
  const invalid = playerStep(sim, { aim: { x: -8, z: -12 }, popperPressed: true });
  assert.equal(invalid.poppers.length, 0);
  assert.equal(invalid.player.equipment.popper, true);

  const { before, id, target } = prepareBlast(sim);
  const waterTarget = { x: before.player.position.x, z: ISLAND.shoreZ - 0.1 };
  assert(distance(before.player.position, waterTarget) < POPPER.throwReach);
  const water = playerStep(sim, { aim: waterTarget, popperPressed: true });
  assert.equal(water.poppers.length, 0);
  assert.equal(water.player.equipment.popper, true);
  const armed = playerStep(sim, { aim: target, popperPressed: true });
  const barrel = armed.poppers[0];
  assert.equal(armed.poppers.length, 1);
  assert.equal(barrel.phase, 'fuse');
  assert.equal(barrel.ownerId, before.player.id);
  assert.equal(armed.player.equipment.popper, false);
  assert(armed.player.popperCooldown > 0);
  const repeated = playerStep(sim, { aim: target, popperPressed: true });
  assert.deepEqual(repeated.poppers.map(({ id }) => id), [barrel.id]);
  assert.equal(cargoWorker(repeated, 'bot-2').ragdoll, 0);

  const nearBurst = cargoUntil(sim, ({ time }) => time >= armed.time + POPPER.fuseSeconds - 2 / TICKS_PER_SECOND,
    TICKS_PER_SECOND);
  assert.equal(nearBurst.poppers[0].phase, 'fuse');
  assert.equal(cargoFish(nearBurst, id).popCatchUntil, null);
  assert.equal(cargoWorker(nearBurst, 'bot-2').ragdoll, 0);
  const burst = cargoUntil(sim, ({ poppers }) => poppers[0]?.phase === 'burst', 4);
  assert(Math.abs(burst.time - armed.time - POPPER.fuseSeconds) <= 1 / TICKS_PER_SECOND);
  assert(cargoWorker(burst, 'bot-2').ragdoll > 1.5);
  assert.equal(burst.player.ragdoll, 0);
  assert.equal(burst.sold, before.sold);
  assert.equal(burst.cash, before.cash);

  let captured = burst;
  let caughtInAir = false;
  for (let tick = 0; tick < 2 * TICKS_PER_SECOND && !captured.player.carrying; tick++) {
    const fish = cargoFish(captured, id);
    const { position } = captured.player;
    const catchable = fish.popCatchUntil !== null && fish.position.y > POPPER.catchHeight
      && distance(position, fish.position) < PLAY.reach - 0.15 && Math.abs(position.y - fish.position.y) < 1.5;
    captured = playerStep(sim, { ...approach(position, fish.position, 0.45), aim: fish.position, interactPressed: catchable });
    caughtInAir ||= catchable && captured.player.carrying === id;
  }
  assert(caughtInAir, `the fish did not reach a playable E catch after ${burst.time.toFixed(2)}s blast`);
  const fish = cargoFish(captured, id);
  assert.equal(fish.airCatchMultiplier, 1.45);
  assert.equal(fish.popCatchUntil, null);
  assert.equal(fish.lastTouch, captured.player.id);
  assert.equal(captured.sold, before.sold);

  nearCargoWorker(sim, 'player', { x: 3.95, z: 1.25 });
  const ready = sim.snapshot();
  const expected = Math.round(FISH[fish.kind].price * fish.multiplier * fish.airCatchMultiplier * ready.boss.priceMultiplier);
  playerStep(sim, { aim: ISLAND.scale, interactPressed: true });
  const sale = cargoUntil(sim, ({ sold }) => sold > before.sold, 2 * TICKS_PER_SECOND);
  assert.equal(sale.sold, before.sold + 1);
  assert.equal(sale.cash - before.cash, expected);
  assert.equal(sale.campaign.warehouse.stock, before.campaign.warehouse.stock + 1);
  assert.equal(sale.campaign.warehouse.value, before.campaign.warehouse.value + expected);
  for (let tick = 0; tick < TICKS_PER_SECOND; tick++) playerStep(sim, { aim: ISLAND.scale, interactPressed: tick % 12 === 0 });
  const after = sim.snapshot();
  assert.equal(after.sold, sale.sold);
  assert.equal(after.cash, sale.cash);
  assert.equal(after.poppers.length, 0);
  assert(after.players.every(({ id, sold }) => id === after.player.id || sold === 0));
  t.diagnostic(`Friend ragdolled at the ${POPPER.fuseSeconds}s fuse, E awarded ×${fish.airCatchMultiplier}, a single sale paid ¥${expected}.`);
});

test('a fish picked up after landing misses the aerial bonus', async (t) => {
  const sim = await createSimulation(seed);
  t.after(() => sim.dispose());
  buyPopper(sim);
  const { id, target } = prepareBlast(sim);
  playerStep(sim, { aim: target, popperPressed: true });
  cargoUntil(sim, (view) => cargoFish(view, id).popCatchUntil !== null, 2 * TICKS_PER_SECOND);
  const grounded = cargoUntil(sim, (view) => {
    const fish = cargoFish(view, id);
    return fish.state === 'stunned' && fish.popCatchUntil === null;
  }, 2 * TICKS_PER_SECOND);
  const loose = cargoFish(grounded, id);
  nearCargoWorker(sim, 'player', loose.position, 0.9);
  const state = playerStep(sim, { aim: loose.position, interactPressed: true });
  assert.equal(state.player.carrying, id);
  assert.equal(cargoFish(state, id).airCatchMultiplier, 1);
});

test('a popper cannot be armed too close to dusk or at night', async (t) => {
  const sim = await createSimulation({ ...seed, shiftSeconds: 40 });
  t.after(() => sim.dispose());
  buyPopper(sim);
  cargoUntil(sim, ({ campaign }) => campaign.remaining < POPPER.fuseSeconds, 40 * TICKS_PER_SECOND);
  const { x, z } = sim.snapshot().player.position;
  const aim = { x: x + 0.9, z };
  const late = playerStep(sim, { aim, popperPressed: true });
  assert.equal(late.campaign.phase, 'day');
  assert.equal(late.poppers.length, 0);
  assert.equal(late.player.equipment.popper, true);
  cargoUntil(sim, ({ campaign }) => campaign.phase === 'night', TICKS_PER_SECOND);
  const night = playerStep(sim, { aim, popperPressed: true });
  assert.equal(night.poppers.length, 0);
  assert.equal(night.player.equipment.popper, true);
});
