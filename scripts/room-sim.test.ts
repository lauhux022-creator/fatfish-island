import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from '../shared/sim';
import { CREW, TICKS_PER_SECOND } from '../shared/sim/config';
import { predictPlayerMovement } from '../shared/sim/prediction';
import { emptyInput } from '../shared/sim/types';

const stillBots = { 'bot-1': emptyInput, 'bot-2': emptyInput, 'bot-3': emptyInput };

test('each occupied seat receives only its own movement, and prediction reuses the same steering', async () => {
  const sim = await createSimulation({ roleId: 'claude' });
  try {
    for (const seat of CREW) sim.setSeat(seat.id, `工友 ${seat.id}`);
    for (let tick = 0; tick < 10; tick++) sim.step(emptyInput);
    const before = sim.snapshot();
    assert.equal(before.player.roleId, 'claude');
    assert.equal(before.player.animation, 'idle');
    assert.deepEqual(new Set(before.players.map(({ roleId }) => roleId)), new Set(['claude', 'gpt', 'grok', 'kimi']));
    const movePrimary = { ...emptyInput, moveX: 1 };
    const moveGuest = { ...emptyInput, moveX: -1 };
    const predicted = predictPlayerMovement(before.player, movePrimary);
    sim.step(emptyInput, { player: movePrimary, 'bot-1': moveGuest });
    const after = sim.snapshot();

    assert(after.players.every((worker) => !worker.bot));
    assert(after.players[0].position.x > before.players[0].position.x);
    assert(after.players[1].position.x < before.players[1].position.x);
    assert.equal(after.players[2].position.x, before.players[2].position.x);
    assert.equal(after.players[3].position.x, before.players[3].position.x);
    assert(Math.abs(after.player.position.x - predicted.position.x) < 0.005);
    assert.equal(predicted.position.y, before.player.position.y);
    assert.equal(predicted.yaw, after.player.yaw);
  } finally {
    sim.dispose();
  }
});

test('a guest can talk to the boss and resume settlement without borrowing the host identity', async () => {
  const sim = await createSimulation({ shiftSeconds: 10, nightSeconds: 8 });
  try {
    sim.setSeat('bot-1', '阿宁');
    for (let tick = 0; tick < 10 * TICKS_PER_SECOND; tick++) sim.step(emptyInput, stillBots);
    const dusk = sim.snapshot();
    assert.equal(dusk.campaign.phase, 'night');
    assert(!dusk.shiftPaused);
    for (let tick = 0; tick < 8 * TICKS_PER_SECOND; tick++) sim.step(emptyInput, stillBots);
    const paused = sim.snapshot();
    assert(paused.shiftPaused);
    sim.step(emptyInput, { ...stillBots, 'bot-1': { ...emptyInput, chat: '老板发个鱼饵' } });
    for (let tick = 0; tick < 20 * TICKS_PER_SECOND; tick++) sim.step(emptyInput, stillBots);
    const answered = sim.snapshot();

    assert.equal(answered.tick, paused.tick);
    assert.equal(answered.boss.line?.target, 'bot-1');
    assert.equal(answered.boss.line?.action, 'gift_item');
    assert(!answered.player.giftedBait);
    assert(answered.players[1].giftedBait);
    assert.match(answered.players[1].memory, /老板/);

    sim.step(emptyInput, { ...stillBots, 'bot-1': { ...emptyInput, continuePressed: true } });
    assert(!sim.snapshot().shiftPaused);
    assert.equal(sim.snapshot().day, paused.day + 1);
    assert.equal(sim.snapshot().campaign.phase, 'day');
  } finally {
    sim.dispose();
  }
});

test('a departing host becomes a working bot without resetting the seat ledger or holding a charge', async () => {
  const sim = await createSimulation();
  try {
    sim.setSeat('player', '船长');
    sim.step(emptyInput, stillBots);
    sim.step({ ...emptyInput, chat: '老板真英明' }, stillBots);
    for (let tick = 0; tick < 8 * TICKS_PER_SECOND; tick++) sim.step(emptyInput, stillBots);
    sim.step({ ...emptyInput, castPressed: true, castHeld: true }, stillBots);
    const before = sim.snapshot().player;
    assert.equal(before.hook.phase, 'charging');
    assert.equal(before.animation, 'box_01');
    assert(before.favor > 0);

    sim.setSeat('player', null);
    const substitute = sim.snapshot().player;
    assert(substitute.bot);
    assert.equal(substitute.name, 'GPT');
    assert.equal(substitute.roleId, before.roleId);
    assert.equal(substitute.hook.phase, 'idle');
    assert.deepEqual(substitute.position, before.position);
    assert.equal(substitute.cash, before.cash);
    assert.equal(substitute.favor, before.favor);
    assert.equal(substitute.memory, before.memory);

    for (let tick = 0; tick < 4 * TICKS_PER_SECOND; tick++) {
      const view = sim.snapshot().player;
      if (view.hook.phase !== 'idle') break;
      sim.step(emptyInput, stillBots);
    }
    assert.notEqual(sim.snapshot().player.hook.phase, 'idle');
  } finally {
    sim.dispose();
  }
});

test('friendly fire sends different notices to the attacker and victim', async () => {
  const sim = await createSimulation();
  try {
    sim.setSeat('player', '船长');
    sim.setSeat('bot-2', '木桶');
    for (let tick = 0; tick < TICKS_PER_SECOND; tick++) {
      const { player, players } = sim.snapshot();
      const attacker = players[2];
      const dx = player.position.x - attacker.position.x;
      const dz = player.position.z - attacker.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 2.15) break;
      sim.step(emptyInput, { ...stillBots, 'bot-2': { ...emptyInput, moveX: dx / distance, moveZ: dz / distance } });
    }
    sim.step(emptyInput, {
      ...stillBots,
      'bot-2': { ...emptyInput, swingPressed: true, aim: sim.snapshot().player.position },
    });
    const hit = sim.snapshot();
    assert(hit.player.ragdoll > 0);
    assert.equal(hit.player.animation, 'fall');
    assert.equal(hit.players[2].animation, 'chop');
    assert.deepEqual(hit.notice, hit.notices.player);
    assert.equal(hit.notices.player?.text, '木桶把你一桨拍飞！');
    assert.equal(hit.notices['bot-2']?.text, '一桨拍飞了船长！');
  } finally {
    sim.dispose();
  }
});
