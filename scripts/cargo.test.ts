import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { CARGO } from '../shared/sim/cargo';
import { FISH, ISLAND, TICKS_PER_SECOND } from '../shared/sim/config';
import { emptyInput, type Vec3 } from '../shared/sim/types';
import { cargoFish, cargoStep, cargoUntil, cargoWorker, nearCargoWorker, prepareCargo, type CargoSimulation } from './cargo-fixture';

const human = 'player';
const baitMate = 'bot-2';

function grip(sim: CargoSimulation, worker: string, fishId: string) {
  const point = cargoFish(sim.snapshot(), fishId).position;
  return cargoStep(sim, { [worker]: { ...emptyInput, aim: point, interactPressed: true } });
}

function pairCargo(sim: CargoSimulation, fishId: string, approach: Vec3) {
  nearCargoWorker(sim, baitMate, { x: approach.x + 1.05, z: approach.z - 0.75 });
  const paired = grip(sim, baitMate, fishId);
  const fish = cargoFish(paired, fishId);
  assert.equal(fish.carrierId, human);
  assert.equal(fish.helperId, baitMate);
  assert.equal(fish.liftClaimId, null);
  assert.equal(fish.liftClaimAt, null);
  assert.equal(paired.player.carrying, fishId);
  assert.equal(cargoWorker(paired, baitMate).carrying, fishId);
  return paired;
}

test('two players must lift a live-bait grouper and its baited thrower cannot keep the sale', async (t) => {
  const sim = await createSimulation({ seed: 'm7-team' });
  t.after(() => sim.dispose());
  sim.setSeat(baitMate, '搭把手的工友');
  const fishId = prepareCargo(sim);
  const landed = cargoFish(sim.snapshot(), fishId);

  const requested = grip(sim, human, fishId);
  const waiting = cargoFish(requested, fishId);
  assert.equal(waiting.state, 'stunned');
  assert.equal(waiting.liftClaimId, human);
  assert.equal(waiting.liftClaimAt, requested.time);
  assert.equal(requested.player.lifting, fishId);
  assert.equal(waiting.carrierId, null);
  assert.equal(requested.player.carrying, null);
  assert.equal(cargoFish(grip(sim, 'bot-3', fishId), fishId).helperId, null);

  const paired = pairCargo(sim, fishId, landed.position);
  const carryPoint = cargoFish(paired, fishId).position;
  const early = cargoStep(sim, { player: { ...emptyInput, aim: ISLAND.scale, interactPressed: true } });
  assert.equal(early.player.carrying, fishId);
  assert.equal(early.cash, 0);

  const move = { ...emptyInput, moveX: 1, aim: ISLAND.scale };
  for (let tick = 0; tick < 2 * TICKS_PER_SECOND; tick++) {
    const state = sim.snapshot();
    if (cargoFish(state, fishId).position.x >= 3.5) break;
    cargoStep(sim, { player: move, [baitMate]: move });
  }
  for (let tick = 0; tick < 10; tick++) cargoStep(sim);
  const brought = sim.snapshot();
  const loaded = cargoFish(brought, fishId);
  assert(loaded.position.x > carryPoint.x + 1.5);
  const helper = cargoWorker(brought, baitMate);
  assert(Math.abs(loaded.position.x - (brought.player.position.x + helper.position.x) / 2) < 0.12);
  assert(Math.abs(loaded.position.y - (brought.player.position.y + helper.position.y) / 2 - CARGO.carryOffset) < 0.12);
  const wrongAim = cargoStep(sim, { [baitMate]: { ...emptyInput, aim: { x: -10, z: helper.position.z }, interactPressed: true } });
  assert.equal(cargoWorker(wrongAim, baitMate).carrying, fishId);

  const launched = cargoStep(sim, { [baitMate]: { ...emptyInput, aim: ISLAND.scale, interactPressed: true } });
  const flying = cargoFish(launched, fishId);
  assert.equal(flying.state, 'thrown');
  assert.equal(flying.lastTouch, human);
  assert.equal(launched.player.carrying, null);
  assert.equal(cargoWorker(launched, baitMate).carrying, null);
  assert.equal(launched.cash, 0);

  const sold = cargoUntil(sim, (state) => state.player.sold === 1, 2 * TICKS_PER_SECOND);
  const price = Math.round(FISH.grouper.price * loaded.multiplier * loaded.baitMultiplier * brought.boss.priceMultiplier);
  assert.equal(sold.player.cash, price);
  assert.equal(sold.player.shiftCash, price);
  assert.equal(cargoWorker(sold, baitMate).cash, 0);
  assert.equal(sold.campaign.warehouse.stock, 1);
  assert.equal(sold.campaign.warehouse.value, price);
  assert(!sold.fish.some(({ id }) => id === fishId));
  t.diagnostic(`A grounded pair earned ¥${price}. The baited teammate threw the fish and received ¥0.`);
});

test('separation and a teammate paddle knockdown both release cargo without selling it', async (t) => {
  const sim = await createSimulation({ seed: 'm7-team' });
  t.after(() => sim.dispose());
  sim.setSeat(baitMate, '第二把手');
  sim.setSeat('bot-3', '挥桨工友');
  const fishId = prepareCargo(sim);
  const initial = cargoFish(sim.snapshot(), fishId).position;
  grip(sim, human, fishId);
  pairCargo(sim, fishId, initial);

  for (let tick = 0; tick < TICKS_PER_SECOND && sim.snapshot().player.carrying; tick++) {
    cargoStep(sim, { player: { ...emptyInput, moveX: -1 }, [baitMate]: { ...emptyInput, moveX: 1 } });
  }
  const separated = sim.snapshot();
  const loose = cargoFish(separated, fishId);
  assert.equal(loose.state, 'stunned');
  assert.equal(loose.carrierId, null);
  assert.equal(loose.helperId, null);
  assert.equal(separated.player.carrying, null);
  assert.equal(cargoWorker(separated, baitMate).carrying, null);
  assert.equal(separated.campaign.warehouse.stock, 0);

  nearCargoWorker(sim, human, { x: loose.position.x - 0.9, z: loose.position.z + 0.65 });
  grip(sim, human, fishId);
  const resettled = cargoFish(sim.snapshot(), fishId).position;
  pairCargo(sim, fishId, resettled);
  const lead = sim.snapshot().player.position;
  nearCargoWorker(sim, 'bot-3', { x: lead.x - 1.45, z: lead.z + 1.2 });
  const knocked = cargoStep(sim, { 'bot-3': { ...emptyInput, aim: sim.snapshot().player.position, swingPressed: true } });
  assert(knocked.player.ragdoll > 0);
  assert.equal(cargoFish(knocked, fishId).state, 'stunned');
  assert.equal(knocked.player.carrying, null);
  assert.equal(cargoWorker(knocked, baitMate).carrying, null);
  assert.equal(knocked.campaign.warehouse.stock, 0);
});

test('a real day-four ghost cannot turn a pending request into a paired lift', async (t) => {
  const sim = await createSimulation({ seed: 'm7-team', day: 3, shiftSeconds: 10, nightSeconds: 8 });
  t.after(() => sim.dispose());
  const board = cargoUntil(sim, ({ shiftPaused }) => shiftPaused, 18 * TICKS_PER_SECOND);
  assert.equal(board.campaign.lastCycle?.eaten?.id, 'bot-3');
  const dawn = cargoStep(sim, { player: { ...emptyInput, continuePressed: true } });
  assert(cargoWorker(dawn, 'bot-3').ghost);
  const fishId = prepareCargo(sim);
  const initial = cargoFish(sim.snapshot(), fishId).position;

  nearCargoWorker(sim, 'bot-3', { x: initial.x + 1.1, z: initial.z - 0.65 });
  const rested = cargoFish(sim.snapshot(), fishId).position;
  nearCargoWorker(sim, 'bot-3', { x: rested.x + 0.65, z: rested.z + 0.65 });
  nearCargoWorker(sim, human, { x: rested.x - 0.5, z: rested.z + 0.95 });
  const claimed = grip(sim, human, fishId);
  const waiting = cargoFish(claimed, fishId);
  assert.equal(waiting.liftClaimId, human);
  const ghost = cargoWorker(claimed, 'bot-3').position;
  assert(Math.hypot(ghost.x - waiting.position.x, ghost.z - waiting.position.z) < CARGO.gripReach);
  assert(Math.abs(ghost.y - waiting.position.y) < CARGO.gripHeight);
  const attempted = grip(sim, 'bot-3', fishId);
  assert.equal(cargoFish(attempted, fishId).liftClaimId, human);
  assert.equal(cargoWorker(attempted, 'bot-3').carrying, null);
  assert.equal(attempted.player.carrying, null);
  assert.equal(cargoFish(attempted, fishId).helperId, null);
});
