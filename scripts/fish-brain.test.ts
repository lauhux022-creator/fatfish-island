import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekBrain } from '../server/fish-brain';
import { MockBrain } from '../shared/fish-brain/mock';
import {
  FISH_ACTIONS,
  FISH_EMOTIONS,
  type FishBrainInput,
  type FishBrainOutput,
  type FishTrigger,
} from '../shared/fish-brain/types';
import { validateFishOutput } from '../shared/fish-brain/validation';
import { createSimulation } from '../shared/sim';
import { BOSS, TICKS_PER_SECOND } from '../shared/sim/config';
import { emptyInput } from '../shared/sim/types';

const input: FishBrainInput = {
  event: { trigger: 'chat', day: 3, time: 29, actorId: 'player', summary: '你与大肥鱼谈鱼价' },
  recentEvents: [],
  players: [
    { id: 'player', name: '你', cash: 200, shiftCash: 120, shiftSold: 3, favor: 0, memory: '' },
    { id: 'bot-2', name: '桶桶', cash: 180, shiftCash: 100, shiftSold: 2, favor: 4, memory: '' },
  ],
  message: { authorId: 'player', text: '收鱼能涨价吗' },
  teamTarget: 1500,
  teamRevenue: 220,
  priceMultiplier: 1,
};

const valid: FishBrainOutput = {
  say: '给你涨价，鱼得自己追。',
  emotion: 'smug',
  action: 'price_change',
  target: null,
  amount: 15,
};

test('validates the exact JSON shape and falls back to none for malformed decisions', () => {
  assert.deepEqual(validateFishOutput(valid), valid);
  for (const unsafe of [
    null,
    { ...valid, action: 'edit_world' },
    { ...valid, price: 500 },
    { ...valid, amount: Infinity },
    { ...valid, emotion: 'unknown' },
    { ...valid, target: ['player'] },
    { ...valid, say: '鱼'.repeat(31) },
  ]) {
    const fallback = validateFishOutput(unsafe);
    assert.equal(fallback.action, 'none');
    assert.equal(fallback.amount, 0);
  }
});

test('MockBrain generates repeatable short lines for all five triggers', () => {
  const brain = new MockBrain();
  const triggers: FishTrigger[] = ['shift_start', 'sale', 'chat', 'death', 'shift_end'];
  for (const trigger of triggers) {
    const context = { ...input, message: trigger === 'chat' ? input.message : null, event: { ...input.event, trigger } };
    const decision = brain.respond(context);
    assert.deepEqual(decision, brain.respond(context));
    assert.deepEqual(validateFishOutput(decision), decision);
    assert(decision.say.length > 0 && [...decision.say].length <= 30);
    assert(FISH_ACTIONS.includes(decision.action));
    assert(FISH_EMOTIONS.includes(decision.emotion));
  }
});

test('server adapter uses chat completions JSON mode and drops unknown model actions', async () => {
  const calls: { model: string; response_format: { type: string }; messages: { role: string; content: string }[] }[] = [];
  const brain = new DeepSeekBrain('fixture-key', 'fixture-model', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-key');
    calls.push(JSON.parse(String(options.body)));
    const contents = calls.length === 1 ? valid : { ...valid, action: 'edit_world' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(contents) } }] });
  });
  assert.deepEqual(await brain.respond(input), valid);
  assert.equal(calls[0].model, 'fixture-model');
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.equal(JSON.parse(calls[0].messages[1].content).message.text, '收鱼能涨价吗');
  assert.equal((await brain.respond(input)).action, 'none');
});

test('server adapter falls back to Mock on a failed HTTP request', async () => {
  const brain = new DeepSeekBrain('fixture-key', 'fixture-model', async () => new Response(null, { status: 503 }));
  assert.deepEqual(await brain.respond(input), new MockBrain().respond(input));
});

test('server adapter aborts after four seconds and falls back to Mock', async () => {
  let receivedAbort = false;
  const brain = new DeepSeekBrain('fixture-key', 'fixture-model', async (_, options) =>
    new Promise<Response>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Adapter failed to abort')), 6000);
      options?.signal?.addEventListener('abort', () => {
        receivedAbort = true;
        clearTimeout(timer);
        reject(options.signal!.reason);
      }, { once: true });
    }));
  const start = performance.now();
  assert.deepEqual(await brain.respond(input), new MockBrain().respond(input));
  assert(receivedAbort);
  assert(performance.now() - start >= 3800 && performance.now() - start < 6000);
});


test('the simulation clamps validated actions and discards invalid targets', async () => {
  const replies: FishBrainOutput[] = [
    { ...valid, action: 'set_kpi', amount: 99999 },
    { ...valid, action: 'eat_player', target: 'unknown-worker', amount: 1 },
    { ...valid, action: 'price_change', amount: 5000 },
    { ...valid, action: 'spawn_event', target: 'crate', amount: 5000 },
    { ...valid, action: 'bonus', target: 'player', amount: 5000 },
  ];
  const sim = await createSimulation({ day: 3, brain: { respond: () => replies.shift()! } });
  const observers = { 'bot-1': emptyInput, 'bot-2': emptyInput, 'bot-3': emptyInput };

  function chainChat() {
    const calls = sim.snapshot().boss.calls;
    sim.step({ ...emptyInput, chat: '测试请求' }, observers);
    for (let index = 1; index < BOSS.cooldownSeconds * TICKS_PER_SECOND; index++) {
      assert.equal(sim.snapshot().boss.calls, calls);
      sim.step(emptyInput, observers);
    }
    assert.equal(sim.snapshot().boss.calls, calls + 1);
    return sim.snapshot();
  }

  try {
    const initial = sim.snapshot();
    sim.step(emptyInput, observers);
    const raised = sim.snapshot();
    assert.equal(raised.boss.calls, 1);
    assert.equal(raised.teamTarget, Math.floor(initial.teamTarget * BOSS.kpiRange[1]));
    assert.equal(chainChat().boss.line?.action, 'none');
    assert(sim.snapshot().players.every(({ ragdoll }) => ragdoll === 0));
    assert.equal(chainChat().boss.priceMultiplier, 1 + BOSS.priceStep[1] / 100);
    assert.equal(chainChat().crates.length, initial.crates.length + BOSS.rewardCrates.length);
    const noUnearnedBonus = chainChat();
    assert.equal(noUnearnedBonus.boss.line?.action, 'none');
    assert.equal(noUnearnedBonus.player.cash, initial.player.cash);
  } finally {
    sim.dispose();
  }
});
