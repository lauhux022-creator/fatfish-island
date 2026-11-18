import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const screenshotDirectory = process.env.SCREENSHOT_DIR;
const expectedCommit = process.env.EXPECTED_COMMIT;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const remoteRequests = new Set();
let aimPixels;

page.on('pageerror', (error) => errors.push(error.message));
page.on('requestfailed', (request) => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
    errors.push(`${request.failure()?.errorText}: ${request.url()}`);
  }
});
page.on('request', (request) => {
  const url = new URL(request.url());
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== base.origin) remoteRequests.add(url.origin);
});

const probe = (predicate, arg, timeout = 16000) => page.waitForFunction(predicate, arg, { timeout });
const read = () => page.evaluate(() => window.fatfishDebug.snapshot());
const sea = { x: 0, y: -0.5, z: -8 };
const scale = { x: 5.5, y: 0, z: 0.7 };

async function photo(slug) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  for (let quality = 80; quality >= 40; quality -= 10) {
    const frame = await page.screenshot({
      type: 'jpeg',
      quality,
      style: '[data-debug] { visibility: hidden !important; }',
    });
    if (frame.length < 300_000) {
      await writeFile(join(screenshotDirectory, `m2.5-${slug}.jpg`), frame);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${slug}`);
}

async function visit(url) {
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  await probe(() => document.querySelector('#app')?.dataset.ready === 'true');
  if (expectedCommit) assert.equal(await page.locator('[data-commit]').textContent(), expectedCommit);
  assert.match(await page.title(), /大肥鱼的黑心渔场/);
}

async function openShift(shiftSeconds) {
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm2-review', day: '3', debug: '1' }).toString();
  if (shiftSeconds) url.searchParams.set('shiftSeconds', String(shiftSeconds));
  await visit(url);
  await probe(() => window.fatfishDebug?.snapshot().tick > 5);
  const state = await read();
  assert.equal(state.seed, 'm2-review');
  assert.equal(state.day, 3);
  assert.equal(state.sold, 0);
  assert.equal(await page.locator('[data-debug]').isVisible(), true);
  assert.deepEqual(state.players.filter((worker) => worker.bot).map(({ name }) => name).sort(), ['阿铲', '桶桶', '溜溜'].sort());
}

async function aimAt(position) {
  const projected = await page.evaluate((point) => window.fatfishDebug.project(point), position);
  const { width, height } = page.viewportSize();
  assert(projected.x > 0 && projected.x < width && projected.y > 0 && projected.y < height,
    `Aim falls outside viewport: ${JSON.stringify({ position, projected })}`);
  await page.mouse.move(projected.x, projected.y);
  aimPixels = projected;
}

async function tapCast() {
  await page.mouse.click(aimPixels.x, aimPixels.y);
}

async function castAt(position, charge = 0.96) {
  await aimAt(position);
  await page.mouse.down();
  await probe((meter) => window.fatfishDebug.snapshot().hook.charge >= meter, charge);
  await page.mouse.up();
}

async function reel() {
  for (let tap = 0; tap < 8; tap++) {
    const before = await read();
    if (before.hook.phase === 'idle') return;
    await tapCast();
    await probe((progress) => {
      const hook = window.fatfishDebug.snapshot().hook;
      return hook.phase === 'idle' || hook.progress > progress;
    }, before.hook.progress, 3500);
  }
  assert.equal((await read()).hook.phase, 'idle');
}

async function moveUntil(key, predicate, arg, timeout = 6500) {
  await page.keyboard.down(key);
  try {
    await probe(predicate, arg, timeout);
  } finally {
    await page.keyboard.up(key);
  }
}

async function walkTo(x, z) {
  const { position } = (await read()).player;
  if (Math.abs(position.x - x) > 0.3) {
    const side = Math.sign(x - position.x);
    await moveUntil(side > 0 ? 'KeyD' : 'KeyA', ({ target, sign }) =>
      (window.fatfishDebug.snapshot().player.position.x - target) * sign > -0.18, { target: x, sign: side });
  }
  if (Math.abs(position.z - z) > 0.3) {
    const side = Math.sign(z - position.z);
    await moveUntil(side > 0 ? 'KeyS' : 'KeyW', ({ target, sign }) =>
      (window.fatfishDebug.snapshot().player.position.z - target) * sign > -0.18, { target: z, sign: side });
  }
  await probe(() => window.fatfishDebug.snapshot().player.speed < 0.6);
}

async function driveUntil(done, timeout = 50, expectedFish) {
  const controls = createBrowserControls(page);
  const plan = createReviewPolicy();
  let state = await read();
  const deadline = state.time + timeout;
  try {
    while (!done(state)) {
      if (state.time >= deadline) throw new Error('player loop did not finish');
      if (expectedFish && !state.fish.some(({ id }) => id === expectedFish)) {
        throw new Error(`Expected live-bait fish was lost: ${expectedFish}`);
      }
      await controls.apply(state, plan(state));
      await probe((tick) => window.fatfishDebug.snapshot().tick >= tick + 5, state.tick);
      state = await read();
    }
    return state;
  } finally {
    await controls.stop();
  }
}

async function playerCatchAndSell() {
  await openShift();
  const state = await read();
  assert.equal(state.teamTarget, 1500);
  assert.equal(await page.locator('[data-kpi] [data-team-target]').textContent(), '¥1500');
  await photo('01-kpi');
  const sold = await driveUntil((next) => next.sold > 0);
  assert(sold.cash > 0);
  console.log(`玩家钓 → 揍 → 搬 → 卖 · ¥${sold.cash}`);
}

async function fishEscapesAtShore() {
  await openShift();
  await walkTo(0, -0.45);
  await walkTo(-7.2, -1.3);
  await castAt({ x: -7.3, y: -0.5, z: -8.8 });
  await probe(() => {
    const hook = window.fatfishDebug.snapshot().hook;
    return hook.phase === 'bite' && hook.target === 'fish';
  }, null, 22000);
  const id = (await read()).hook.targetId;
  await reel();
  const handle = await probe((id) => {
    const next = window.fatfishDebug.snapshot();
    if (next.fish.some((fish) => fish.id === id && fish.state === 'escaping')) return next.time;
  }, id, 20000);
  const crossed = await handle.jsonValue();
  await handle.dispose();
  await probe((id) => !window.fatfishDebug.snapshot().fish.some((fish) => fish.id === id), id, 5000);
  const after = await read();
  assert(after.time - crossed <= 1, 'fish lingered over one second after crossing the shoreline');
  assert.equal(after.player.metrics.fishEscaped, 1);
  assert.equal(after.notice.cue, 'fish_escape');
  assert.match(await page.locator('[data-notice]').textContent(), /鱼溜回海里/);
  await photo('02-escape');
  console.log(`放任鱼溜回海里，越界后 ${(after.time - crossed).toFixed(2)} 秒移除`);
}

async function sellHeld() {
  const previous = (await read()).sold;
  await walkTo(3.8, 1.45);
  await aimAt(scale);
  await page.keyboard.press('KeyE');
  await probe((sold) => window.fatfishDebug.snapshot().sold > sold, previous);
  assert.match(await page.locator('.ledger [data-cash]').textContent(), /¥[1-9]/);
}

async function hookSupplyCrate() {
  await openShift();
  await castAt({ x: -3.3, y: -0.5, z: -6.1 });
  await probe(() => window.fatfishDebug.snapshot().hook.target === 'crate');
  await reel();
  const crate = (await read()).crates.find(({ id }) => id === 'supply-crate');
  assert.equal(crate?.state, 'loose');
  assert(crate.position.z > -4);
  console.log('海上木箱上钩，连点拖上岸');
}

async function teammateBait() {
  await openShift();
  const mate = (await read()).players.find(({ id }) => id === 'bot-2');
  await castAt({ ...mate.position, y: 0.45 }, 0.45);
  await probe(() => window.fatfishDebug.snapshot().hook.phase === 'bait');
  const baitId = (await read()).hook.targetId;
  assert.equal(baitId, mate.id);
  assert.equal((await read()).players.find(({ id }) => id === baitId).baitedBy, 'player');
  await aimAt(sea);
  await tapCast();
  await probe((id) => {
    const bait = window.fatfishDebug.snapshot().players.find((member) => member.id === id);
    return bait.ragdoll > 0 && bait.position.z < -4.12;
  }, baitId);

  await probe(() => window.fatfishDebug.snapshot().hook.phase === 'bite');
  const landed = await read();
  const fish = landed.fish.find(({ id }) => id === landed.hook.targetId);
  assert.equal(fish?.baitPlayerId, baitId);
  assert.notEqual(fish.kind, 'sardine');
  assert.equal(fish.baitMultiplier, 1.8);
  await reel();
  const landedId = fish.id;
  const scored = await driveUntil((next) => next.sold > 0, 32, landedId);
  assert(scored.cash > 34);
  assert.match(scored.notice.text, /活饵/);
  await photo('03-bait-premium');
  console.log(`钩队友 → 甩进海里 → 活饵 ×${fish.baitMultiplier} → 入账 ¥${scored.cash}`);
}

async function friendlyFire() {
  await openShift();
  await walkTo(2, 0.85);
  const { position } = (await read()).players.find(({ id }) => id === 'bot-2');
  await aimAt({ ...position, y: 0.32 });
  await page.keyboard.press('KeyF');
  await probe(() => window.fatfishDebug.snapshot().players.find(({ id }) => id === 'bot-2').ragdoll > 1.5);
  const down = (await read()).players.find(({ id }) => id === 'bot-2');
  assert.equal(down.parts.length, 6);
  assert(down.ragdoll > 1.45 && down.ragdoll <= 2);
  if (screenshotDirectory) {
    await probe(() => window.fatfishDebug.snapshot().players.find(({ id }) => id === 'bot-2').ragdoll < 1.45);
    await photo('04-friendly-fire');
  }
  await probe(() => window.fatfishDebug.snapshot().players.find(({ id }) => id === 'bot-2').ragdoll === 0);
  assert.equal((await read()).players.find(({ id }) => id === 'bot-2').parts.length, 0);
  console.log('挥桨拍倒队友，六段布娃娃两秒恢复');
}

async function takeCrewFish(state) {
  for (let attempt = 0; attempt < 13; attempt++) {
    const handle = await probe((state) => {
      const { fish, player } = window.fatfishDebug.snapshot();
      return fish.find((item) => item.state === state && item.carrierId !== player.id &&
        item.position.y > 0.85 && Math.hypot(item.position.x - player.position.x, item.position.z - player.position.z) <
        (state === 'thrown' ? 2.22 : 1.8));
    }, state, 48000);
    const target = await handle.jsonValue();
    await handle.dispose();
    await aimAt({ ...target.position, y: 0 });
    const { tick, notice } = await read();
    await page.keyboard.press('KeyE');
    // Keep trying through the short pickup grace window, with separate input edges.
    await probe(({ tick, id }) => {
      const next = window.fatfishDebug.snapshot();
      return next.player.carrying === id || next.tick > tick + 6;
    }, { tick, id: target.id });
    const next = await read();
    if (state === 'carried' && next.player.carrying === target.id) return target;
    if (state === 'thrown' && next.notice?.id !== notice?.id && next.notice?.text.includes('半空截胡')) return target;
    if (next.player.carrying) {
      await aimAt({ x: next.player.position.x - 2, y: 0, z: next.player.position.z + 2 });
      await page.keyboard.press('KeyE');
    }
  }
  throw new Error(`Could not take a teammate's ${state} fish`);
}

async function stealFromBot() {
  await openShift();
  await walkTo(3.75, -0.25);
  const victim = await takeCrewFish('carried');
  assert(victim.carrierId);
  const stolen = await read();
  assert.notEqual(stolen.players.find(({ id }) => id === victim.carrierId).carrying, victim.id);
  await sellHeld();
  assert.equal((await read()).sold, 1);
  console.log('从机器人手上抢到鱼，入秤后计给最后碰鱼的玩家');
}

async function interceptThrow() {
  await openShift();
  await walkTo(4.7, 1.02);
  await takeCrewFish('thrown');
  console.log('从半空中截住一条机器人抛向秤盘的鱼');
}

async function botsAndStandings() {
  await openShift(48);
  const standingsButton = page.getByRole('button', { name: '绩效榜' });
  await standingsButton.click();
  assert.equal(await page.locator('[data-standings] tbody tr').count(), 4);
  await standingsButton.click();
  assert.equal(await page.locator('[data-standings]').isVisible(), false);
  await probe(() => window.fatfishDebug.snapshot().shiftPaused, null, 87000);
  const snapshot = await read();
  const champion = snapshot.result.ranking[0];
  const lowest = snapshot.result.ranking.at(-1);
  assert.equal(snapshot.day, 3);
  assert.equal(snapshot.result.ranking.length, 4);
  assert(champion.bot && champion.revenue > 0 && champion.bonus === Math.round(champion.revenue * 0.25));
  assert.equal(lowest.optimization, true);
  assert.equal(lowest.fine, Math.round(lowest.revenue * 0.2));
  assert.equal(await page.locator('[data-standings]:modal').isVisible(), true);
  assert.equal(await page.locator('[data-standings] tbody tr').count(), 4);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await read()).tick, snapshot.tick);
  await photo('05-standings');
  await page.keyboard.press('Enter');
  await probe(() => !window.fatfishDebug.snapshot().shiftPaused && window.fatfishDebug.snapshot().day === 4);
  const resumed = await read();
  assert.equal(resumed.teamRevenue, 0);
  assert.equal(resumed.players.find(({ id }) => id === lowest.id).optimization, true);
  assert.equal(await page.locator('[data-standings]:modal').count(), 0);
  console.log(`日末暂停且按 Enter 才开次日 · ${champion.name} 奖金 ¥${champion.bonus} · ${lowest.name} 待优化`);
}

try {
  await visit(base);
  assert.equal(await page.locator('[data-debug]').isVisible(), false);
  assert.equal(await page.evaluate(() => typeof window.fatfishDebug), 'undefined');
  await playerCatchAndSell();
  await hookSupplyCrate();
  await fishEscapesAtShore();
  await teammateBait();
  await friendlyFire();
  await stealFromBot();
  await botsAndStandings();
  await interceptThrow();
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual([...remoteRequests], [], 'local mode requested an external service');
} catch (error) {
  console.error('Last game state:', JSON.stringify(await read().catch(() => null)));
  throw error;
} finally {
  await browser.close();
}
