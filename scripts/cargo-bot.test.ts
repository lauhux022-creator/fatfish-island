import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { CARGO } from '../shared/sim/cargo';
import { ISLAND, TICKS_PER_SECOND } from '../shared/sim/config';
import { emptyInput, type Vec3 } from '../shared/sim/types';
import { cargoFish, cargoStep, cargoWorker, nearCargoWorker, prepareCargo } from './cargo-fixture';

function approach(from: Vec3, target: Pick<Vec3, 'x' | 'z'>, stop: number) {
  const x = target.x - from.x;
  const z = target.z - from.z;
  const gap = Math.hypot(x, z);
  return gap > stop ? { moveX: x / gap, moveZ: z / gap } : { moveX: 0, moveZ: 0 };
}

test('the nearest ready bot joins a human lift, follows to the scale and leaves the sale with the leader', async (t) => {
  const sim = await createSimulation({ seed: 'm7-bot-cargo' });
  t.after(() => sim.dispose());
  const id = prepareCargo(sim);
  const heavy = cargoFish(sim.snapshot(), id);

  const solo = cargoStep(sim, { player: { ...emptyInput, aim: heavy.position, interactPressed: true } });
  assert.equal(solo.player.lifting, heavy.id);
  assert.equal(solo.player.carrying, null);
  assert.equal(solo.fish.find(({ id }) => id === heavy.id)?.state, 'stunned');
  assert.equal(solo.sold, 0);
  assert.equal(solo.campaign.warehouse.stock, 0);

  let paired = solo;
  for (let i = 0; i < 3 * TICKS_PER_SECOND && !paired.player.carrying; i++) {
    sim.step(emptyInput);
    paired = sim.snapshot();
  }
  const cargo = paired.fish.find(({ id }) => id === heavy.id);
  assert(cargo?.helperId);
  assert.equal(cargo.carrierId, solo.player.id);
  assert.equal(cargo.helperId, 'bot-1');
  assert.equal(paired.players.filter(({ carrying }) => carrying === heavy.id).length, 2);
  assert.equal(paired.players.find(({ id }) => id === cargo.helperId)?.carrying, heavy.id);

  const delivery = { x: 4.45, z: 1.55 };
  let current = paired;
  for (let i = 0; i < 8 * TICKS_PER_SECOND; i++) {
    const move = approach(current.player.position, delivery, 0.55);
    if (!move.moveX && !move.moveZ) break;
    sim.step({ ...emptyInput, ...move, aim: ISLAND.scale });
    current = sim.snapshot();
    assert.equal(current.player.carrying, heavy.id);
  }
  assert(Math.hypot(current.player.position.x - delivery.x, current.player.position.z - delivery.z) < 0.56);
  sim.step({ ...emptyInput, aim: ISLAND.scale, interactPressed: true });
  current = sim.snapshot();
  const thrown = current.fish.find(({ id }) => id === heavy.id);
  assert.equal(thrown?.state, 'thrown');
  assert.equal(thrown.lastTouch, solo.player.id);
  for (let i = 0; i < 2 * TICKS_PER_SECOND && current.sold === 0; i++) {
    sim.step(emptyInput);
    current = sim.snapshot();
  }
  assert.equal(current.sold, 1, JSON.stringify({
    launch: thrown.position,
    remaining: current.fish.find(({ id }) => id === heavy.id)?.position,
    workers: current.players.map(({ id, position }) => ({ id, position })),
  }));
  assert(current.cash > 90);
  assert.equal(current.campaign.warehouse.stock, 1);
  assert(current.players.every(({ bot, shiftSold, cash }) => !bot || (!shiftSold && !cash)));
  assert(current.players.every(({ carrying }) => carrying !== heavy.id));
  t.diagnostic(`Bot took ${(paired.time - solo.time).toFixed(2)}s to join. The leader received ¥${current.cash}.`);
});

test('a nearby human gets the first chance to help and an idle volunteer does not block the bot', async (t) => {
  for (const volunteers of [true, false]) {
    const sim = await createSimulation({ seed: 'm7-bot-cargo' });
    t.after(() => sim.dispose());
    const id = prepareCargo(sim);
    for (let tick = 0; tick < TICKS_PER_SECOND; tick++) cargoStep(sim);
    const { x, z } = cargoFish(sim.snapshot(), id).position;
    sim.setSeat('bot-2', '志愿搬手');
    nearCargoWorker(sim, 'player', { x: x + 1.25, z: z + 0.45 });
    nearCargoWorker(sim, 'bot-1', { x: x - 1, z: z + 0.7 });
    nearCargoWorker(sim, 'bot-2', { x: x + 0.1, z: z + 1.4 });
    const aim = cargoFish(sim.snapshot(), id).position;
    const claim = cargoStep(sim, { player: { ...emptyInput, aim, interactPressed: true } });
    assert.equal(claim.player.lifting, id);

    for (let tick = 0; tick < 35; tick++) sim.step(emptyInput, { 'bot-2': emptyInput });
    const waiting = sim.snapshot();
    const fish = cargoFish(waiting, id);
    assert.equal(fish.helperId, null);
    const bot = cargoWorker(waiting, 'bot-1');
    assert(bot.grounded);
    assert(Math.hypot(bot.position.x - fish.position.x, bot.position.z - fish.position.z) < CARGO.gripReach);

    if (volunteers) {
      sim.step(emptyInput, { 'bot-2': { ...emptyInput, aim: fish.position, interactPressed: true } });
      assert.equal(cargoFish(sim.snapshot(), id).helperId, 'bot-2');
    } else {
      for (let tick = 0; tick < 2 * TICKS_PER_SECOND && !sim.snapshot().player.carrying; tick++) {
        sim.step(emptyInput, { 'bot-2': emptyInput });
      }
      assert.equal(cargoFish(sim.snapshot(), id).helperId, 'bot-1');
    }
  }
});
