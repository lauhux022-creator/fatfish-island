import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { FISHING, ISLAND, TICKS_PER_SECOND } from '../shared/sim/config';
import { SALVAGE } from '../shared/sim/salvage';
import { emptyInput, type CrateView, type SimInput, type SimSnapshot } from '../shared/sim/types';
import { cargoStep, cargoUntil, nearCargoWorker, type CargoSimulation } from './cargo-fixture';

const seed = 'm11-salvage';
const nightSeconds = 8;
const west = { x: -7.35, z: -1.6 };
const pathZ = -2.5;
const delivery = { x: 3.2, z: 1.75 };

function step(sim: CargoSimulation, input: Partial<SimInput> = {}) {
  return cargoStep(sim, { player: { ...emptyInput, ...input } });
}

function crate(view: SimSnapshot, id: string): CrateView {
  const found = view.crates.find((object) => object.id === id);
  assert(found, `Missing crate ${id} at tick ${view.tick}`);
  return found;
}

function waitForSpawn(sim: CargoSimulation, expectedTick: number) {
  const early = cargoUntil(sim, ({ tick }) => tick === expectedTick - 1, 15 * TICKS_PER_SECOND);
  assert(!early.crates.some(({ salvage }) => salvage));
  const appeared = step(sim);
  const floating = appeared.crates.filter(({ salvage }) => salvage);
  assert.equal(floating.length, 1);
  assert.equal(floating[0].id, `salvage-${appeared.day}`);
  assert.equal(floating[0].state, 'floating');
  assert(Math.abs(floating[0].position.x - SALVAGE.origin.x) < 0.01);
  assert(Math.abs(floating[0].position.z - SALVAGE.origin.z) < 0.01);
  return floating[0].id;
}

function walkWest(sim: CargoSimulation) {
  nearCargoWorker(sim, 'player', { x: 0, z: pathZ });
  nearCargoWorker(sim, 'player', { x: west.x, z: pathZ });
  nearCargoWorker(sim, 'player', west);
}

function hookCrate(sim: CargoSimulation, id: string, charge: number) {
  const aim = crate(sim.snapshot(), id).position;
  let view = step(sim, { aim, castPressed: true, castHeld: true });
  for (let tick = 0; tick < FISHING.chargeSeconds * TICKS_PER_SECOND && view.hook.charge < charge; tick++) {
    view = step(sim, { aim, castHeld: true });
  }
  assert(view.hook.charge >= charge);
  const released = step(sim, { aim, castReleased: true });
  const hooked = cargoUntil(sim, ({ hook }) => hook.phase === 'bite', 2 * TICKS_PER_SECOND);
  assert.equal(hooked.hook.target, 'crate');
  assert.equal(hooked.hook.targetId, id);
  assert.equal(crate(hooked, id).state, 'hooked');
  return { released, hooked };
}

function reelAndGrab(sim: CargoSimulation, id: string) {
  for (let tap = 0; tap < FISHING.crateTaps; tap++) step(sim, { castPressed: true });
  const landed = sim.snapshot();
  const loose = crate(landed, id);
  assert.equal(landed.hook.phase, 'idle');
  assert.equal(loose.state, 'loose');
  assert(loose.position.z > ISLAND.shoreZ);
  assert.equal(landed.player.carrying, null);
  const grabbed = step(sim, { aim: loose.position, interactPressed: true });
  assert.equal(grabbed.player.carrying, id);
  assert.equal(crate(grabbed, id).state, 'carried');
  return grabbed;
}

function bringToScale(sim: CargoSimulation, id: string) {
  nearCargoWorker(sim, 'player', { x: 0, z: pathZ });
  nearCargoWorker(sim, 'player', delivery);
  const ready = sim.snapshot();
  assert.equal(ready.player.carrying, id);
  assert.equal(crate(ready, id).state, 'carried');
  return ready;
}

function assertSameFishLedger(before: SimSnapshot, after: SimSnapshot) {
  assert.equal(after.player.sold, before.player.sold);
  assert.equal(after.player.shiftSold, before.player.shiftSold);
  assert.equal(after.player.shiftCash, before.player.shiftCash);
  assert.equal(after.teamRevenue, before.teamRevenue);
  assert.equal(after.teamTarget, before.teamTarget);
  assert.equal(after.campaign.wood, before.campaign.wood);
  assert.deepEqual(after.campaign.order, before.campaign.order);
  assert.deepEqual(after.campaign.warehouse, before.campaign.warehouse);
  assert.deepEqual(after.campaign.cycle, before.campaign.cycle);
}

test('one drifting crate per day grants a popper, then bait, then wallet cash only', async (t) => {
  const sim = await createSimulation({ seed, shiftSeconds: 36, nightSeconds });
  t.after(() => sim.dispose());
  for (const day of [1, 2, 3]) {
    const start = sim.snapshot();
    assert.equal(start.day, day);
    walkWest(sim);
    const id = waitForSpawn(sim, start.tick + SALVAGE.spawnSeconds * TICKS_PER_SECOND);
    const times = hookCrate(sim, id, 0.72);
    const lifted = reelAndGrab(sim, id);
    assert.equal(lifted.cash, start.cash);
    assert.deepEqual(lifted.player.equipment, start.player.equipment);
    bringToScale(sim, id);
    for (let tick = 0; tick < 12; tick++) step(sim, { aim: ISLAND.scale });
    const before = sim.snapshot();
    assert.equal(before.player.carrying, id, 'walking to the scale must not redeem the crate');
    assert.deepEqual(before.player.equipment, start.player.equipment);
    const launched = step(sim, { aim: ISLAND.scale, interactPressed: true });
    assert.equal(crate(launched, id).state, 'thrown');
    const after = cargoUntil(sim, ({ crates }) => !crates.some((item) => item.id === id), 2 * TICKS_PER_SECOND);
    assert.equal(after.player.carrying, null);
    assertSameFishLedger(before, after);
    assert.equal(after.player.equipment.popper, true);
    assert.equal(after.player.equipment.bait, day >= 2);
    assert.equal(after.cash - before.cash, day === 3 ? SALVAGE.cashReward : 0);
    assert.equal(after.campaign.order.progress, 0);
    t.diagnostic(`Day ${day} release ${times.released.time.toFixed(2)}s, hooked ${times.hooked.time.toFixed(2)}s, claimed ${after.time.toFixed(2)}s.`);

    for (let tick = 0; tick < TICKS_PER_SECOND; tick++) step(sim, { aim: ISLAND.scale, interactPressed: tick % 15 === 0 });
    assert.equal(sim.snapshot().cash, after.cash);
    assert.deepEqual(sim.snapshot().player.equipment, after.player.equipment);
    cargoUntil(sim, (view) => {
      assert(!view.crates.some(({ salvage }) => salvage), 'redeemed crate should not reappear in the same day');
      return view.shiftPaused;
    }, (36 + nightSeconds) * TICKS_PER_SECOND);
    if (day < 3) step(sim, { continuePressed: true });
  }
});

test('a marine supply crate remains ordinary when hooked and thrown at the scale', async (t) => {
  const sim = await createSimulation({ seed });
  t.after(() => sim.dispose());
  const id = 'supply-crate';
  assert.equal(crate(sim.snapshot(), id).salvage, false);
  hookCrate(sim, id, 0.9);
  reelAndGrab(sim, id);
  const before = bringToScale(sim, id);
  step(sim, { aim: ISLAND.scale, interactPressed: true });
  for (let tick = 0; tick < 2 * TICKS_PER_SECOND; tick++) step(sim);
  const after = sim.snapshot();
  assert.equal(crate(after, id).salvage, false);
  assert.equal(after.cash, before.cash);
  assert.deepEqual(after.player.equipment, before.player.equipment);
  assertSameFishLedger(before, after);
});

test('salvage can be hooked again after falling in, and missed and knocked-loose throws do not redeem it', async (t) => {
  const sim = await createSimulation({ seed, shiftSeconds: 48, nightSeconds });
  t.after(() => sim.dispose());
  walkWest(sim);
  const id = waitForSpawn(sim, SALVAGE.spawnSeconds * TICKS_PER_SECOND);
  hookCrate(sim, id, 0.72);
  reelAndGrab(sim, id);
  const overboard = step(sim, { aim: { x: west.x, z: -8.3 }, interactPressed: true });
  assert.equal(crate(overboard, id).state, 'thrown');
  const afloat = cargoUntil(sim, (view) => crate(view, id).state === 'floating', 2 * TICKS_PER_SECOND);
  assert.equal(afloat.player.equipment.popper, false);
  assert.equal(afloat.cash, 0);
  hookCrate(sim, id, 0.72);
  const grabbed = reelAndGrab(sim, id);
  const shot = step(sim, { aim: { x: -4.8, z: -0.9 }, interactPressed: true });
  assert.equal(crate(shot, id).state, 'thrown');
  const missed = cargoUntil(sim, (view) => crate(view, id).state === 'loose', 2 * TICKS_PER_SECOND);
  assert.equal(missed.cash, grabbed.cash);
  assert.deepEqual(missed.player.equipment, grabbed.player.equipment);
  assertSameFishLedger(grabbed, missed);

  const loose = crate(missed, id);
  nearCargoWorker(sim, 'player', loose.position, 0.95);
  assert.equal(step(sim, { aim: loose.position, interactPressed: true }).player.carrying, id);
  bringToScale(sim, id);
  nearCargoWorker(sim, 'player', { x: 4.37, z: 1.3 });
  nearCargoWorker(sim, 'bot-2', { x: 2.9, z: 1.3 });
  for (let tick = 0; tick < 12; tick++) step(sim, { aim: ISLAND.scale });
  const before = sim.snapshot();
  assert.equal(before.player.carrying, id);
  const atScale = crate(before, id).position;
  assert(Math.hypot(atScale.x - ISLAND.scale.x, atScale.z - ISLAND.scale.z) <= ISLAND.scale.radius);
  const knock = cargoStep(sim, { 'bot-2': { ...emptyInput, aim: before.player.position, swingPressed: true } });
  assert(knock.player.ragdoll > 1.5);
  assert.equal(knock.player.carrying, null);
  assert.equal(crate(knock, id).state, 'thrown');
  for (let tick = 0; tick < 2 * TICKS_PER_SECOND; tick++) step(sim);
  const after = sim.snapshot();
  assert.equal(crate(after, id).salvage, true);
  assert.equal(after.cash, before.cash);
  assert.deepEqual(after.player.equipment, before.player.equipment);
  assertSameFishLedger(before, after);
});

test('a short daylight shift spawns salvage halfway and clears its hook or carrier at dusk', async (t) => {
  for (const keepHooked of [false, true]) {
    const sim = await createSimulation({ seed, shiftSeconds: 20, nightSeconds });
    t.after(() => sim.dispose());
    walkWest(sim);
    const id = waitForSpawn(sim, 10 * TICKS_PER_SECOND);
    if (keepHooked) {
      cargoUntil(sim, ({ time }) => time >= 16, 7 * TICKS_PER_SECOND);
      assert.equal(hookCrate(sim, id, 0.72).hooked.hook.targetId, id);
    } else {
      hookCrate(sim, id, 0.72);
      assert.equal(reelAndGrab(sim, id).player.carrying, id);
    }
    const dusk = cargoUntil(sim, ({ campaign }) => campaign.phase === 'night', 20 * TICKS_PER_SECOND);
    assert.equal(dusk.time, 20);
    assert(!dusk.crates.some((item) => item.id === id));
    assert.equal(dusk.player.carrying, null);
    assert.equal(dusk.hook.phase, 'idle');
    assert.equal(dusk.cash, 0);
    assert.equal(dusk.player.equipment.popper, false);
    assert.equal(dusk.player.equipment.bait, false);
    assert.equal(crate(dusk, 'supply-crate').salvage, false);
  }
});
