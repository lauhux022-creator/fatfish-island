import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { CAMPAIGN, FISH, ISLAND, STEP_SECONDS, TICKS_PER_SECOND } from '../shared/sim/config';
import { DAILY_ORDERS, type DailyOrderId } from '../shared/sim/orders';
import { POPPER } from '../shared/sim/popper';
import { SHOP } from '../shared/sim/shop';
import { emptyInput, type SimInput, type SimSnapshot, type Vec3 } from '../shared/sim/types';
import { cargoFish, cargoStep, cargoUntil, cargoWorker, nearCargoWorker, prepareCargo, type CargoSimulation } from './cargo-fixture';
import { createReviewPolicy } from './review-policy.mjs';

const nightSeconds = 8;
const launchPoint = { x: 2.9, z: 1.55 };
type Point = Pick<Vec3, 'x' | 'z'>;

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function steer(from: Vec3, to: Point) {
  const gap = distance(from, to);
  return gap > 0.5 ? { moveX: (to.x - from.x) / gap, moveZ: (to.z - from.z) / gap } : { moveX: 0, moveZ: 0 };
}

function playerStep(sim: CargoSimulation, input: Partial<SimInput> = {}) {
  return cargoStep(sim, { player: { ...emptyInput, ...input } });
}

function* fishingTicks(sim: CargoSimulation) {
  const plan = createReviewPolicy();
  let view = sim.snapshot();
  let input: SimInput = emptyInput;
  let held = false;
  for (let tick = 0; view.campaign.phase === 'day'; tick++) {
    if (tick % 6 === 0) {
      const next = plan(view);
      const release = held && (view.hook.phase !== 'charging' || next.cast === 'release');
      const charge = !held && next.cast === 'hold';
      held = charge || (held && !release);
      input = {
        ...emptyInput, moveX: next.moveX ?? 0, moveZ: next.moveZ ?? 0, aim: next.aim ?? null,
        castHeld: held, castPressed: charge || next.cast === 'tap', castReleased: release,
        swingPressed: Boolean(next.swing), interactPressed: Boolean(next.interact),
      };
    } else input = { ...emptyInput, moveX: input.moveX, moveZ: input.moveZ, aim: input.aim, castHeld: held };
    const previous = view;
    view = playerStep(sim, input);
    yield { previous, view };
  }
}

function sellOrdinaryFish(sim: CargoSimulation, count: number) {
  const sales = [];
  for (const { previous, view } of fishingTicks(sim)) {
    if (view.sold <= previous.sold) continue;
    const fish = previous.fish.find(({ id, state, lastTouch }) => (state === 'carried' || state === 'thrown')
      && lastTouch === view.player.id && !view.fish.some((current) => current.id === id));
    assert(fish && !fish.baitPlayerId && fish.airCatchMultiplier === 1);
    const value = Math.round(FISH[fish.kind].price * fish.multiplier * view.boss.priceMultiplier);
    assert.equal(view.cash - previous.cash, value);
    assert.equal(view.player.shiftCash - previous.player.shiftCash, value);
    assert.equal(view.campaign.warehouse.value - previous.campaign.warehouse.value, value);
    sales.push({ kind: fish.kind, view });
    if (sales.length === count) return sales;
  }
  assert.fail(`only ${sales.length} ordinary deliveries before the end of the daylight shift`);
}

function getFishReadyAtScale(sim: CargoSimulation, afterSales: number) {
  for (const { view } of fishingTicks(sim)) {
    if (view.sold !== afterSales || !view.player.carrying) continue;
    const id = view.player.carrying;
    nearCargoWorker(sim, 'player', launchPoint);
    assert.equal(sim.snapshot().player.carrying, id);
    return id;
  }
  assert.fail('did not carry a normal fish to the scale');
}

function assertOrder(view: SimSnapshot, id: DailyOrderId, progress: number, status: 'open' | 'complete' | 'expired') {
  const { target, woodReward } = DAILY_ORDERS[id];
  assert.deepEqual(view.campaign.order, { id, day: view.day, progress, target, woodReward, status });
}

function finishDay(sim: CargoSimulation, extraWood: number) {
  const before = cargoUntil(sim, ({ campaign }) => campaign.phase === 'day' && campaign.remaining <= STEP_SECONDS,
    Math.ceil(sim.snapshot().campaign.remaining * TICKS_PER_SECOND) + 1);
  const dusk = playerStep(sim);
  assert.equal(dusk.campaign.phase, 'night');
  assert.equal(dusk.campaign.wood, Math.min(CAMPAIGN.maxWood, before.campaign.wood + CAMPAIGN.tideWood) + extraWood);
  for (const [index, worker] of before.players.entries()) {
    const after = dusk.players[index];
    assert.equal(after.cash, worker.cash);
    assert.equal(after.sold, worker.sold);
    assert.equal(after.shiftCash, worker.shiftCash);
    assert.equal(after.shiftSold, worker.shiftSold);
  }
  assert.equal(dusk.teamRevenue, before.teamRevenue);
  assert.equal(dusk.teamTarget, before.teamTarget);
  assert.deepEqual(dusk.campaign.warehouse, before.campaign.warehouse);
  assert.deepEqual(dusk.campaign.cycle, before.campaign.cycle);
  return dusk;
}

test('delivery and variety pay once at dusk, with variety ignoring repeat species', async (t) => {
  const sim = await createSimulation({ seed: 'm5-review', shiftSeconds: 90, nightSeconds });
  t.after(() => sim.dispose());
  const start = sim.snapshot();
  assertOrder(start, 'delivery', 0, 'open');
  const deliveries = sellOrdinaryFish(sim, 3);
  for (const [i, { view }] of deliveries.entries()) {
    assertOrder(view, 'delivery', Math.min(i + 1, 2), i === 0 ? 'open' : 'complete');
    assert.equal(view.campaign.wood, start.campaign.wood);
  }
  const firstDusk = finishDay(sim, 2);
  assertOrder(firstDusk, 'delivery', 2, 'complete');
  const board = cargoUntil(sim, ({ shiftPaused }) => shiftPaused, nightSeconds * TICKS_PER_SECOND);
  assertOrder(board, 'delivery', 2, 'complete');
  assert.equal(board.campaign.wood, firstDusk.campaign.wood);

  const dawn = playerStep(sim, { continuePressed: true });
  assert.equal(dawn.day, 2);
  assertOrder(dawn, 'variety', 0, 'open');
  const variety = sellOrdinaryFish(sim, 4);
  assert.deepEqual(variety.map(({ kind }) => kind), ['sardine', 'sardine', 'sardine', 'puffer']);
  for (const [i, { view }] of variety.entries()) {
    assertOrder(view, 'variety', i < 3 ? 1 : 2, i < 3 ? 'open' : 'complete');
    assert.equal(view.campaign.wood, dawn.campaign.wood);
  }
  const secondDusk = finishDay(sim, 2);
  assertOrder(secondDusk, 'variety', 2, 'complete');
  assert.equal(secondDusk.campaign.wood, CAMPAIGN.maxWood + 2);
  const secondBoard = cargoUntil(sim, ({ shiftPaused }) => shiftPaused, nightSeconds * TICKS_PER_SECOND);
  assert.equal(secondBoard.campaign.wood, secondDusk.campaign.wood);
  assertOrder(playerStep(sim, { continuePressed: true }), 'trick', 0, 'open');
  t.diagnostic(`First dusk gave ${firstDusk.campaign.wood} wood; second brought it to ${secondDusk.campaign.wood}.`);
});

test('incomplete orders expire even when a real fish is delivered after dusk', async (t) => {
  const sim = await createSimulation({ seed: 'm2-review', shiftSeconds: 48, nightSeconds });
  t.after(() => sim.dispose());
  const id = getFishReadyAtScale(sim, 1);
  assertOrder(sim.snapshot(), 'delivery', 1, 'open');
  const dusk = finishDay(sim, 0);
  assertOrder(dusk, 'delivery', 1, 'expired');
  assert.equal(dusk.player.carrying, id);
  playerStep(sim, { aim: ISLAND.scale, interactPressed: true });
  const lateSale = cargoUntil(sim, ({ sold }) => sold === 2, 2 * TICKS_PER_SECOND);
  assertOrder(lateSale, 'delivery', 1, 'expired');
  assert.equal(lateSale.campaign.wood, dusk.campaign.wood);
  assert.equal(lateSale.campaign.warehouse.stock, dusk.campaign.warehouse.stock + 1);
  assert(lateSale.cash > dusk.cash);
});

test('active bots and a seat taken over mid-throw keep normal sale credit without filling the order', async (t) => {
  const autonomous = await createSimulation({ seed: 'm5-night', shiftSeconds: 48, nightSeconds });
  t.after(() => autonomous.dispose());
  let crew = autonomous.snapshot();
  for (let tick = 0; tick < 45 * TICKS_PER_SECOND && crew.campaign.warehouse.stock < 2; tick++) {
    autonomous.step(emptyInput);
    crew = autonomous.snapshot();
  }
  assert.equal(crew.sold, 0);
  assert.equal(crew.campaign.warehouse.stock, 2);
  assert(crew.players.some(({ bot, cash }) => bot && cash > 0));
  assertOrder(crew, 'delivery', 0, 'open');

  const takeover = await createSimulation({ seed: 'm2-review', shiftSeconds: 48, nightSeconds });
  t.after(() => takeover.dispose());
  const id = getFishReadyAtScale(takeover, 1);
  const thrown = playerStep(takeover, { aim: ISLAND.scale, interactPressed: true });
  assert.equal(cargoFish(thrown, id).state, 'thrown');
  assert.equal(cargoFish(thrown, id).lastTouch, thrown.player.id);
  takeover.setSeat('player', null);
  const credited = cargoUntil(takeover, ({ sold }) => sold === 2, 2 * TICKS_PER_SECOND);
  assert.equal(credited.player.bot, true);
  assert.equal(credited.campaign.warehouse.stock, 2);
  assert(credited.cash > thrown.cash);
  assertOrder(credited, 'delivery', 1, 'open');
});

test('a live-bait cargo sale from the credited player earns the trick order', async (t) => {
  const sim = await createSimulation({ seed: 'm7-bot-cargo', day: 3, shiftSeconds: 64, nightSeconds });
  t.after(() => sim.dispose());
  assertOrder(sim.snapshot(), 'trick', 0, 'open');
  const id = prepareCargo(sim);
  const landed = cargoFish(sim.snapshot(), id);
  playerStep(sim, { aim: landed.position, interactPressed: true });
  let view = sim.snapshot();
  for (let tick = 0; tick < 2 * TICKS_PER_SECOND && view.player.carrying !== id; tick++) {
    sim.step(emptyInput);
    view = sim.snapshot();
  }
  const paired = cargoFish(view, id);
  assert(paired.helperId && cargoWorker(view, paired.helperId).bot);
  const spot = { x: 4.45, z: 1.55 };
  for (let tick = 0; tick < 6 * TICKS_PER_SECOND && distance(view.player.position, spot) >= 0.55; tick++) {
    assert.equal(view.player.carrying, id);
    sim.step({ ...emptyInput, ...steer(view.player.position, spot), aim: ISLAND.scale });
    view = sim.snapshot();
  }
  const expected = Math.round(FISH[paired.kind].price * paired.multiplier * paired.baitMultiplier * view.boss.priceMultiplier);
  playerStep(sim, { aim: ISLAND.scale, interactPressed: true });
  const sold = cargoUntil(sim, ({ sold }) => sold === 1, 2 * TICKS_PER_SECOND);
  assertOrder(sold, 'trick', 1, 'complete');
  assert.equal(sold.campaign.wood, CAMPAIGN.startingWood);
  assert.equal(sold.cash, expected);
  assert.equal(sold.campaign.warehouse.stock, 1);
  assert.equal(sold.campaign.warehouse.value, expected);
  assert.equal(cargoWorker(sold, paired.helperId).cash, 0);
  assertOrder(finishDay(sim, 3), 'trick', 1, 'complete');
});

test('the trick order ignores ordinary sales but accepts a popper catch without live bait', async (t) => {
  const sim = await createSimulation({ seed: 'm2-review', day: 3, shiftSeconds: 90, nightSeconds });
  t.after(() => sim.dispose());
  const normal = sellOrdinaryFish(sim, 2).at(-1)!.view;
  assertOrder(normal, 'trick', 0, 'open');
  nearCargoWorker(sim, 'player', { x: -4.4, z: 3.7 });
  nearCargoWorker(sim, 'player', SHOP.position);
  const bought = playerStep(sim, { buy: 'popper' });
  assert(bought.player.equipment.popper);
  assert.equal(bought.cash, normal.cash - SHOP.items.popper.price);

  nearCargoWorker(sim, 'player', { x: -4.4, z: 3.7 });
  let id: string | undefined;
  for (const { view } of fishingTicks(sim)) {
    id = view.fish.find(({ id, heavy, baitPlayerId }) => id === view.player.carrying && !heavy && !baitPlayerId)?.id;
    if (id) break;
  }
  assert(id);
  // Set the fish down on a clear part of the yard before trying the trick.
  nearCargoWorker(sim, 'player', { x: 1, z: 0.35 });
  const putDown = playerStep(sim, { aim: { x: 1, z: 8 }, interactPressed: true });
  assert.equal(cargoFish(putDown, id).state, 'thrown');
  const grounded = cargoUntil(sim, (view) => cargoFish(view, id).state === 'stunned', 2 * TICKS_PER_SECOND);
  const readyAt = grounded.time + 0.5;
  const resting = cargoFish(cargoUntil(sim, ({ time }) => time >= readyAt, TICKS_PER_SECOND), id).position;
  const inward = resting.x < 0 ? 1 : -1;
  const popAt = { x: resting.x - inward * 0.65, z: Math.max(ISLAND.shoreZ + 0.65, resting.z) };
  const origin = sim.snapshot().player.position;
  nearCargoWorker(sim, 'player', { x: origin.x, z: popAt.z - 2.2 });
  nearCargoWorker(sim, 'player', { x: popAt.x + inward * 3.6, z: popAt.z + 0.2 });
  const ready = cargoFish(sim.snapshot(), id);
  assert(ready.position.z > ISLAND.shoreZ && distance(ready.position, popAt) < POPPER.radius);
  assert.equal(playerStep(sim, { aim: popAt, popperPressed: true }).poppers[0]?.phase, 'fuse');

  let view = cargoUntil(sim, ({ poppers }) => poppers[0]?.phase === 'burst', TICKS_PER_SECOND);
  assert.notEqual(cargoFish(view, id).popCatchUntil, null);
  assertOrder(view, 'trick', 0, 'open');
  for (let tick = 0; tick < TICKS_PER_SECOND && view.player.carrying !== id; tick++) {
    const fish = cargoFish(view, id);
    const { position } = view.player;
    const canCatch = fish.popCatchUntil !== null && fish.position.y > POPPER.catchHeight
      && distance(position, fish.position) < 2.2 && Math.abs(position.y - fish.position.y) < 1.5;
    view = playerStep(sim, { ...steer(position, fish.position), aim: fish.position, interactPressed: canCatch });
  }
  assert.equal(view.player.carrying, id);
  const boosted = cargoFish(view, id);
  assert.equal(boosted.airCatchMultiplier, POPPER.airCatchMultiplier);
  assert.equal(boosted.baitPlayerId, null);
  assertOrder(view, 'trick', 0, 'open');

  nearCargoWorker(sim, 'player', launchPoint);
  playerStep(sim, { aim: ISLAND.scale, interactPressed: true });
  const sold = cargoUntil(sim, ({ sold }) => sold === normal.sold + 1, 2 * TICKS_PER_SECOND);
  assertOrder(sold, 'trick', 1, 'complete');
  assert.equal(sold.campaign.warehouse.stock, normal.campaign.warehouse.stock + 1);
  assertOrder(finishDay(sim, 3), 'trick', 1, 'complete');
});
