import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { CAMPAIGN, PLAY, TICKS_PER_SECOND } from '../shared/sim/config';
import { emptyInput, type SimInput } from '../shared/sim/types';

type Simulation = Awaited<ReturnType<typeof createSimulation>>;
const idleCrew = { 'bot-1': emptyInput, 'bot-2': emptyInput, 'bot-3': emptyInput };

function advance(sim: Simulation, ticks: number, controls: Readonly<Record<string, SimInput>> = idleCrew) {
  for (let tick = 0; tick < ticks; tick++) sim.step(emptyInput, controls);
}

function moveGhostNear(sim: Simulation, id: string, reach: number) {
  for (let tick = 0; tick < 3 * TICKS_PER_SECOND; tick++) {
    const { player, players } = sim.snapshot();
    const worker = players.find((actor) => actor.id === id);
    assert(worker);
    const { x, z } = worker.position;
    const dx = x - player.position.x;
    const dz = z - player.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < reach - 0.35) return;
    sim.step({ ...emptyInput, moveX: dx / distance, moveZ: dz / distance }, idleCrew);
  }
  assert.fail(`Ghost could not approach ${id}`);
}

test('default time advances from four-minute day to two-minute raid, then waits at the board', async (t) => {
  const sim = await createSimulation();
  t.after(() => sim.dispose());
  const dayTicks = 240 * TICKS_PER_SECOND;
  const nightTicks = 120 * TICKS_PER_SECOND;

  assert.equal(sim.snapshot().campaign.remaining, 240);
  advance(sim, dayTicks - 1);
  assert.equal(sim.snapshot().campaign.phase, 'day');
  advance(sim, 1);
  const dusk = sim.snapshot();
  assert.equal(dusk.campaign.phase, 'night');
  assert.equal(dusk.campaign.remaining, 120);
  assert.equal(dusk.result, null);

  advance(sim, nightTicks - 1);
  assert.equal(sim.snapshot().shiftPaused, false);
  advance(sim, 1);
  const board = sim.snapshot();
  assert.equal(board.time, 360);
  assert.equal(board.shiftPaused, true);
  assert.equal(board.result?.ranking.length, 4);
  advance(sim, TICKS_PER_SECOND);
  assert.equal(sim.snapshot().tick, board.tick);
});

test('the third day settles the sum of the actual daily goals and leaves later cycles fresh', async (t) => {
  const sim = await createSimulation({ seed: 'm5-cycle', shiftSeconds: 10, nightSeconds: 8 });
  t.after(() => sim.dispose());
  let total = 0;

  for (let day = 1; day <= 3; day++) {
    advance(sim, 18 * TICKS_PER_SECOND);
    const board = sim.snapshot();
    total += board.teamTarget;
    assert.equal(board.day, day);
    assert.equal(board.shiftPaused, true);
    assert.deepEqual(board.campaign.cycle, { firstDay: 1, lastDay: 3, secured: 0, target: total });
    assert.equal(board.campaign.lastCycle?.target ?? null, day === 3 ? total : null);
    if (day === 3) {
      assert.equal(board.campaign.lastCycle?.passed, false);
      assert.equal(board.campaign.lastCycle?.eaten?.id, 'bot-3');
      assert(board.players.every(({ ghost }) => !ghost));
    }
    sim.step({ ...emptyInput, continuePressed: true }, idleCrew);
  }

  const dawn = sim.snapshot();
  assert.equal(dawn.day, 4);
  assert.deepEqual(dawn.campaign.cycle, { firstDay: 4, lastDay: 6, secured: 0, target: dawn.teamTarget });
  assert(dawn.players.find(({ id }) => id === 'bot-3')?.ghost);
  t.diagnostic(`Day 3 total KPI ¥${total}`);
});

test('raiders debit warehouse lots, and the eaten worker can prank and receive revival payments', async (t) => {
  const sim = await createSimulation({ seed: 'm5-night', day: 3, shiftSeconds: 48, nightSeconds: 30 });
  t.after(() => sim.dispose());
  advance(sim, 48 * TICKS_PER_SECOND, {});
  const dusk = sim.snapshot();
  const before = dusk.campaign.warehouse;
  assert(before.stock > 0);
  assert.equal(dusk.campaign.cycle.firstDay, 3);
  assert.equal(dusk.campaign.cycle.target, dusk.teamTarget);

  advance(sim, 30 * TICKS_PER_SECOND);
  const board = sim.snapshot();
  const after = board.campaign.warehouse;
  assert(after.lostFish > 0);
  assert.equal(after.stock + after.lostFish, before.stock);
  assert.equal(after.value + after.lostValue, before.value);
  assert.equal(board.teamRevenue, dusk.teamRevenue);
  for (const worker of dusk.players) {
    const entry = board.result?.ranking.find(({ id }) => id === worker.id);
    assert(entry);
    assert.equal(board.players.find(({ id }) => id === worker.id)?.cash, worker.cash + entry.bonus - entry.fine);
  }
  assert.equal(board.campaign.lastCycle?.secured, after.value);
  assert.equal(board.campaign.lastCycle?.eaten?.id, board.player.id);
  assert.equal(board.player.ghost, false);

  sim.step({ ...emptyInput, continuePressed: true }, idleCrew);
  const dawn = sim.snapshot();
  assert.equal(dawn.player.ghost, true);
  assert.equal(dawn.campaign.warehouse.value, 0);
  assert.equal(dawn.campaign.warehouse.lostValue, 0);
  const donor = dawn.players.find(({ ghost, cash }) => !ghost && cash >= CAMPAIGN.reviveCost);
  assert(donor);
  sim.setSeat(donor.id, '来帮忙的工友');
  moveGhostNear(sim, donor.id, CAMPAIGN.ghostPrankReach);
  sim.step({ ...emptyInput, swingPressed: true }, idleCrew);
  const prank = sim.snapshot();
  assert.match(prank.notice?.text ?? '', /闹鬼/);
  assert(prank.players.some(({ ragdoll }) => ragdoll > 0));

  advance(sim, (PLAY.ragdollSeconds + 0.2) * TICKS_PER_SECOND);
  moveGhostNear(sim, donor.id, CAMPAIGN.reviveReach);
  let paid = 0;
  while (paid < CAMPAIGN.reviveCost) {
    sim.step(emptyInput, { ...idleCrew, [donor.id]: { ...emptyInput, revivePressed: true } });
    paid = Math.min(CAMPAIGN.reviveCost, paid + CAMPAIGN.reviveContribution);
    const snapshot = sim.snapshot();
    const fullyPaid = paid === CAMPAIGN.reviveCost;
    assert.equal(snapshot.players.find(({ id }) => id === donor.id)?.cash, donor.cash - paid);
    assert.equal(snapshot.player.ghost, !fullyPaid);
    assert.equal(snapshot.player.revivePaid, fullyPaid ? 0 : paid);
  }
  t.diagnostic(`Raid took ${after.lostFish} fish worth ¥${after.lostValue}, and revival cost ¥${paid}`);
});

test('a passed cycle opens one crab encounter and its defeat ends the island', async (t) => {
  const sim = await createSimulation({ seed: 'm5-night', day: 3, shiftSeconds: 48, nightSeconds: 8 });
  t.after(() => sim.dispose());
  advance(sim, 56 * TICKS_PER_SECOND, {});
  const result = sim.snapshot();
  assert.equal(result.shiftPaused, true);
  assert.equal(result.campaign.lastCycle?.passed, true);
  assert(result.campaign.cycle.secured >= result.campaign.cycle.target);

  sim.step({ ...emptyInput, continuePressed: true });
  const encounter = sim.snapshot();
  assert.equal(encounter.day, result.day);
  assert.equal(encounter.campaign.phase, 'boss');
  assert.deepEqual(encounter.campaign.enemies.map(({ kind }) => kind), ['crab']);

  let current = encounter;
  for (let checks = 0; checks < 240 && current.campaign.phase === 'boss'; checks++) {
    advance(sim, TICKS_PER_SECOND / 4, {});
    current = sim.snapshot();
  }
  assert.equal(current.campaign.phase, 'cleared');
  assert.equal(current.campaign.enemies.length, 0);
  sim.step({ ...emptyInput, continuePressed: true });
  assert.equal(sim.snapshot().tick, current.tick);
  t.diagnostic(`Secured ¥${result.campaign.cycle.secured} against a ¥${result.campaign.cycle.target} KPI and defeated the crab in ${(current.time - encounter.time).toFixed(2)}s`);
});
