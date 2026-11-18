import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { createBotController } from '../shared/sim/bots';
import { TICKS_PER_SECOND } from '../shared/sim/config';
import { CAMPAIGN_PACES, isCampaignPace } from '../shared/sim/pace';
import { emptyInput, type SimInput, type SimSnapshot } from '../shared/sim/types';

type Simulation = Awaited<ReturnType<typeof createSimulation>>;
const idleCrew = { 'bot-1': emptyInput, 'bot-2': emptyInput, 'bot-3': emptyInput };
const seed = 'm8-quick';

function idle(sim: Simulation, ticks: number) {
  for (let tick = 0; tick < ticks; tick++) sim.step(emptyInput, idleCrew);
}

function crewDriver() {
  const bot = createBotController(seed);
  return (snapshot: SimSnapshot): SimInput => {
    const player = { ...snapshot.player, bot: true };
    // Give the controlled player the lead guard's pursuit range during the raid.
    const context = snapshot.campaign.phase === 'night' ? {
      ...snapshot, players: [player, ...snapshot.players.slice(1).map((worker) => ({ ...worker, bot: false }))],
    } : snapshot;
    return bot.input(context, player);
  };
}

function runQuickSeason(sim: Simulation, driver: ((snapshot: SimSnapshot) => SimInput) | null) {
  const { daySeconds, nightSeconds } = CAMPAIGN_PACES.quick;
  const totalSeconds = daySeconds + nightSeconds;
  let previousGoals = 0;
  let end = sim.snapshot();

  for (let day = 1; day <= 3; day++) {
    const open = sim.snapshot();
    assert.equal(open.campaign.pace, 'quick');
    assert.equal(open.campaign.remaining, daySeconds);
    assert.equal(open.day, day);
    assert.equal(open.time, (day - 1) * totalSeconds);
    for (let tick = 0; tick < totalSeconds * TICKS_PER_SECOND; tick++) {
      sim.step(driver ? driver(sim.snapshot()) : emptyInput);
      if (tick === daySeconds * TICKS_PER_SECOND - 1) {
        const dusk = sim.snapshot();
        assert.equal(dusk.campaign.phase, 'night');
        assert.equal(dusk.campaign.remaining, nightSeconds);
        assert.equal(dusk.time, (day - 1) * totalSeconds + daySeconds);
      }
    }
    end = sim.snapshot();
    previousGoals += end.teamTarget;
    assert.equal(end.time, day * totalSeconds);
    assert.equal(end.shiftPaused, true);
    assert.equal(end.campaign.cycle.target, previousGoals);
    assert.equal(end.campaign.lastCycle?.day ?? null, day === 3 ? 3 : null);
    if (day < 3) sim.step({ ...emptyInput, continuePressed: true });
  }
  return end;
}

test('pace defaults, clamps and independent debug overrides remain deterministic', async (t) => {
  assert.equal(isCampaignPace('classic'), true);
  assert.equal(isCampaignPace('quick'), true);
  assert.equal(isCampaignPace('constructor'), false);
  assert.equal(isCampaignPace(undefined), false);
  const fixtures = [
    { options: {}, pace: 'classic', day: 240, night: 120 },
    { options: { pace: 'quick' }, pace: 'quick', day: 90, night: 30 },
    { options: { pace: 'quick', shiftSeconds: 12 }, pace: 'quick', day: 12, night: 30 },
    { options: { pace: 'quick', nightSeconds: 8 }, pace: 'quick', day: 90, night: 8 },
    { options: { pace: 'quick', shiftSeconds: 1000, nightSeconds: 1 }, pace: 'quick', day: 240, night: 8 },
    { options: { pace: 'quick', shiftSeconds: Infinity, nightSeconds: NaN }, pace: 'quick', day: 90, night: 30 },
  ] as const;
  for (const fixture of fixtures) {
    const sim = await createSimulation(fixture.options);
    t.after(() => sim.dispose());
    assert.equal(sim.snapshot().campaign.pace, fixture.pace);
    assert.equal(sim.snapshot().campaign.remaining, fixture.day);
    idle(sim, fixture.day * TICKS_PER_SECOND - 1);
    assert.equal(sim.snapshot().campaign.phase, 'day');
    idle(sim, 1);
    const dusk = sim.snapshot();
    assert.equal(dusk.campaign.phase, 'night');
    assert.equal(dusk.campaign.remaining, fixture.night);
    assert.equal(dusk.teamTarget, Math.round(Math.round(1350 * fixture.day / 240) * 1.04));
    idle(sim, fixture.night * TICKS_PER_SECOND - 1);
    assert.equal(sim.snapshot().shiftPaused, false);
    idle(sim, 1);
    const settled = sim.snapshot();
    assert.equal(settled.time, fixture.day + fixture.night);
    assert.equal(settled.shiftPaused, true);
  }
});

test('active fishing and guarding clear a six-minute quick season and open the crab fight', async (t) => {
  const sim = await createSimulation({ seed, pace: 'quick' });
  t.after(() => sim.dispose());
  const drive = crewDriver();
  const board = runQuickSeason(sim, drive);
  assert.equal(board.time, 360);
  assert.equal(board.campaign.lastCycle?.passed, true);
  assert.equal(board.campaign.lastCycle?.secured, 1880);
  assert.equal(board.campaign.lastCycle?.target, 1671);
  assert.equal(board.campaign.warehouse.lostFish, 0);

  sim.step({ ...emptyInput, continuePressed: true });
  assert.equal(sim.snapshot().campaign.phase, 'boss');
  for (let tick = 0; tick < 45 * TICKS_PER_SECOND; tick++) {
    const snapshot = sim.snapshot();
    if (snapshot.campaign.phase === 'cleared') break;
    sim.step(drive(snapshot));
  }
  const result = sim.snapshot();
  assert.equal(result.campaign.pace, 'quick');
  assert.equal(result.campaign.phase, 'cleared');
  assert.equal(result.day, 3);
  t.diagnostic(`Secured ¥1880 against ¥1671 and defeated the crab in ${(result.time - board.time).toFixed(2)}s`);
});

test('an unattended quick season loses stock, settles at six minutes and starts the ghost shift', async (t) => {
  const sim = await createSimulation({ seed, pace: 'quick' });
  t.after(() => sim.dispose());
  const board = runQuickSeason(sim, null);
  assert.equal(board.time, 360);
  assert.equal(board.campaign.lastCycle?.passed, false);
  assert.equal(board.campaign.lastCycle?.target, 1671);
  assert.equal(board.campaign.lastCycle?.secured, 1244);
  assert.equal(board.campaign.lastCycle?.eaten?.id, board.player.id);
  assert.equal(board.campaign.warehouse.lostFish, 8);
  assert.equal(board.player.ghost, false);
  sim.step({ ...emptyInput, continuePressed: true });
  const dawn = sim.snapshot();
  assert.equal(dawn.campaign.pace, 'quick');
  assert.equal(dawn.campaign.phase, 'day');
  assert.equal(dawn.campaign.remaining, 90);
  assert.equal(dawn.day, 4);
  assert.equal(dawn.player.ghost, true);
  t.diagnostic('Secured ¥1244 against ¥1671 and lost 8 fish before the day-four ghost shift');
});
