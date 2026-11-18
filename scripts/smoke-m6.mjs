import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const photos = process.env.SCREENSHOT_DIR;
const pagesOnly = process.env.PAGES_ONLY === '1';
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

const state = (page) => page.evaluate(() => window.fatfishDebug.snapshot());
const network = (page) => page.evaluate(() => window.fatfishDebug.network());
const wait = (page, predicate, arg, timeout = 30_000) => page.waitForFunction(predicate, arg, { timeout });

async function boot(seed, { day = 1, virtual = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  const slowBoot = performance.now();
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ seed, day, debug: '1' });
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  if (virtual) {
    await page.waitForLoadState('networkidle', { timeout: 45_000 });
    for (let tries = 0; tries < 80; tries++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
    }
  } else {
    await wait(page, () => window.fatfishDebug?.snapshot().tick > 2, null, 45_000);
  }
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  assert.equal(await page.locator('[data-version]').textContent(), '0.6.0');
  assert((await state(page)).tick > 2);
  return { page, context, readySeconds: Number(((performance.now() - slowBoot) / 1000).toFixed(2)) };
}

async function photo(page, name) {
  if (!photos) return;
  await mkdir(photos, { recursive: true });
  for (const quality of [80, 70, 60, 50]) {
    const result = await page.screenshot({
      type: 'jpeg', quality, style: '[data-debug] { visibility: hidden !important; }',
    });
    if (result.length < 300_000) {
      await writeFile(join(photos, `m6-${name}.jpg`), result);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${name}`);
}

async function advance(page, virtual, tick, duration = 100) {
  if (virtual) await page.clock.runFor(duration);
  else await wait(page, ([tick, count]) => window.fatfishDebug.snapshot().tick >= tick + count,
    [tick, Math.round(60 * duration / 1000)], 5000);
}

async function runForGoal(page, virtual, controls, plan, enough, deadline) {
  let snapshot = await state(page);
  while (!enough(snapshot) && snapshot.time < deadline) {
    assert(!snapshot.shiftPaused, 'unexpected settlement during purchase smoke');
    await controls.apply(snapshot, plan(snapshot));
    await advance(page, virtual, snapshot.tick);
    snapshot = await state(page);
  }
  await controls.stop();
  assert(enough(snapshot), JSON.stringify({ time: snapshot.time, wallet: snapshot.cash, position: snapshot.player.position, status: snapshot.player.animation }));
  return snapshot;
}

async function chargeBar() {
  const { page, context } = await boot('ux-first-shift');
  const controls = createBrowserControls(page);
  const aim = { x: 1.6, z: -8.1 };
  await controls.apply(await state(page), { aim, cast: 'hold' });
  await page.clock.runFor(330);
  const charge = (await state(page)).hook.charge;
  const progress = page.locator('[data-task-meter]');
  assert(charge > 0.1 && charge < 0.7);
  assert.equal(await progress.isVisible(), true);
  assert(Math.abs(await progress.evaluate((element) => element.value) - charge) < 0.04);
  await photo(page, '01-charge');
  await controls.stop();
  await page.clock.runFor(1500);
  assert.match((await state(page)).notice?.text ?? '', /蓄|拉满/);
  await context.close();
  console.log('实际抛竿蓄力出现在操作提示栏，短抛落岸显示蓄力指引。');
}

async function buyAtDock(page, virtual, { capture = false } = {}) {
  const controls = createBrowserControls(page);
  const shop = { x: -7.3, z: 1.2 };
  const payday = await runForGoal(page, virtual, controls, createReviewPolicy(),
    ({ cash }) => cash >= 114, (await state(page)).time + 175);
  const nearby = await runForGoal(page, virtual, controls, ({ player }) => {
    const { x, z } = player.position;
    if (player.ragdoll) return {};
    // Keep the training crate at x = -3.2, z = 1.3 between this path and the shore.
    if (x > -5.2 && z < 3.35) return { moveZ: 1 };
    if (x > -5.2) return { moveX: -1 };
    return {
      moveX: Math.abs(shop.x - x) < 0.4 ? 0 : Math.sign(shop.x - x),
      moveZ: Math.abs(shop.z - z) < 0.4 ? 0 : Math.sign(shop.z - z),
    };
  }, ({ player }) => player.shopOpen, payday.time + 15);
  await page.keyboard.press('KeyQ');
  const rod = page.locator('[data-shop-buy="rod"]');
  const bait = page.locator('[data-shop-buy="bait"]');
  assert(await rod.isVisible());
  assert(await bait.isEnabled());
  if (capture) await photo(page, '02-dock-shop');
  const wallet = (await state(page)).cash;
  await rod.click();
  if (virtual) await advance(page, true, nearby.tick, 150);
  else await wait(page, () => window.fatfishDebug.snapshot().player.equipment.rod);
  const bought = await state(page);
  assert.equal(bought.player.equipment.rod, true);
  assert.equal(bought.cash, wallet - 90);
  assert.equal(await rod.isDisabled(), true);
  await bait.click();
  if (virtual) await advance(page, true, bought.tick, 150);
  else await wait(page, () => window.fatfishDebug.snapshot().player.equipment.bait);
  const stocked = await state(page);
  assert.equal(stocked.player.equipment.bait, true);
  assert.equal(stocked.cash, wallet - 114);
  assert.equal(await bait.isDisabled(), true);
  assert.equal(stocked.player.shiftCash, bought.player.shiftCash);
  if (capture) await photo(page, '03-equipped');
  await page.keyboard.press('Escape');
  assert.equal(await rod.isVisible(), false);
  return { payday: payday.time, wallet, stocked };
}

async function local() {
  const { page, context } = await boot('m2-review', { day: 3 });
  const { payday, wallet, stocked } = await buyAtDock(page, true, { capture: true });
  const controls = createBrowserControls(page);
  await runForGoal(page, true, controls, createReviewPolicy(),
    ({ player, hook }) => !player.equipment.bait && (hook.phase === 'bite' || hook.phase === 'reeling'),
    stocked.time + 45);
  console.log(`本地在 ${payday.toFixed(2)} 秒攒够货款，花 ¥114 买竿与鱼饵（¥${wallet} → ¥${stocked.cash}），新饵钩到鱼后耗掉一次。`);
  await context.close();
}

async function room() {
  const [host, guest] = await Promise.all([
    boot('m2-review', { day: 3, virtual: false }),
    boot('m2-review', { day: 3, virtual: false }),
  ]);
  await host.page.locator('[data-room-toggle]').click();
  await host.page.locator('[data-room-create]').click();
  await wait(host.page, () => window.fatfishDebug.network().mode === 'playing');
  const { code } = await network(host.page);
  await guest.page.locator('[data-room-toggle]').click();
  await guest.page.locator('[data-room-code-input]').fill(code);
  await guest.page.locator('[data-room-join]').click();
  await wait(guest.page, () => window.fatfishDebug.network().mode === 'playing');
  await host.page.bringToFront();
  const { wallet, stocked } = await buyAtDock(host.page, false);
  await guest.page.bringToFront();
  await wait(guest.page, ({ buyer, balance }) => {
    const player = window.fatfishDebug.snapshot().players.find(({ id }) => id === buyer);
    return player?.equipment.rod && player.equipment.bait && player.cash === balance;
  }, { buyer: stocked.player.id, balance: stocked.cash });
  assert.equal((await state(guest.page)).player.equipment.rod, false);
  console.log(`联机两端看到同一份已购竿、鱼饵和余额（¥${wallet} → ¥${stocked.cash}），访客装备保持基本款。`);
  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  if (pagesOnly) {
    const { page, context, readySeconds } = await boot('m6-pages', { virtual: false });
    assert.equal((await network(page)).mode, 'local');
    assert.equal((await state(page)).players.filter(({ bot }) => bot).length, 3);
    await page.keyboard.down('KeyA');
    try {
      await wait(page, () => window.fatfishDebug.snapshot().player.shopOpen, null, 7000);
    } finally {
      await page.keyboard.up('KeyA');
    }
    await page.keyboard.press('KeyQ');
    assert(await page.locator('[data-shop-buy="rod"]').isVisible());
    console.log(`Pages 活动帧 ${readySeconds.toFixed(2)} 秒，带三名机器人进入码头摊位。`);
    await context.close();
  } else if (process.env.ROOM_ONLY === '1') {
    await room();
  } else {
    await chargeBar();
    await local();
    if (process.env.LOCAL_ONLY !== '1') await room();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
