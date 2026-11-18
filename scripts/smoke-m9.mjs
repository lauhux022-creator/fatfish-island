import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const screenshots = process.env.SCREENSHOT_DIR;
const pagesOnly = process.env.PAGES_ONLY === '1';
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const axis = (difference) => Math.abs(difference) < 0.2 ? 0 : Math.sign(difference);
const walk = (origin, target) => ({ moveX: axis(target.x - origin.x), moveZ: axis(target.z - origin.z) });
const read = ({ page }) => page.evaluate(() => window.fatfishDebug.snapshot());
const network = ({ page }) => page.evaluate(() => window.fatfishDebug.network());
const wait = (page, predicate, value, timeout = 30_000) => page.waitForFunction(predicate, value, { timeout });

async function boot(virtual) {
  const context = await browser.newContext({ viewport: { width: 1120, height: 700 } });
  const page = await context.newPage();
  const controls = createBrowserControls(page);
  const client = { context, page, controls, virtual };
  page.on('pageerror', (error) => errors.push(error.message));
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm2-review', day: '3', debug: '1' }).toString();
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  if (virtual) {
    await page.waitForLoadState('networkidle', { timeout: 45_000 });
    for (let attempt = 0; attempt < 70; attempt++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
    }
  } else {
    await wait(page, () => window.fatfishDebug?.snapshot().tick > 2, null, 45_000);
  }
  const version = await page.locator('[data-version]').textContent();
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version, process.env.EXPECTED_VERSION);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  assert.equal((await read(client)).players.filter(({ bot }) => bot).length, 3);
  assert.equal((await network(client)).mode, 'local');
  return client;
}

async function photo({ page }, name) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  for (const quality of [80, 70, 60, 50]) {
    const frame = await page.screenshot({
      type: 'jpeg', quality, style: '[data-debug]{visibility:hidden!important}',
    });
    if (frame.length < 300000) {
      await writeFile(join(screenshots, `m9-${name}.jpg`), frame);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${name}`);
}

async function advance(client, tick, ms) {
  if (client.virtual) await client.page.clock.runFor(ms);
  else await wait(client.page, (next) => window.fatfishDebug.snapshot().tick >= next,
    tick + Math.max(1, Math.floor(ms / 17)), 6000);
}

async function drive(client, done, plan, seconds, step = 100) {
  const { controls } = client;
  let state = await read(client);
  const end = state.time + seconds;
  try {
    for (let steps = 0; !done(state) && state.time < end && steps < Math.ceil(seconds * 1500 / step); steps++) {
      await controls.apply(state, plan(state));
      await advance(client, state.tick, step);
      state = await read(client);
    }
    assert(done(state), JSON.stringify({
      time: state.time, cash: state.cash, position: state.player.position, carrying: state.player.carrying,
      notice: state.notice, poppers: state.poppers,
      fish: state.fish.map(({ id, state, position, caughtBy, popCatchUntil, airCatchMultiplier }) => (
        { id, state, position, caughtBy, popCatchUntil, airCatchMultiplier }
      )),
    }));
    return state;
  } finally {
    await controls.stop();
  }
}

async function aim({ page }, at) {
  const point = await page.evaluate((at) => window.fatfishDebug.project(at), { y: 0, ...at });
  const size = page.viewportSize();
  assert(point.x >= 0 && point.x < size.width && point.y >= 0 && point.y < size.height,
    `World point is off-screen: ${JSON.stringify({ at, point })}`);
  await page.mouse.move(point.x, point.y);
}

async function reachShop(client) {
  const shop = { x: -7.3, z: 1.2 };
  await drive(client, ({ player }) => player.shopOpen, ({ player }) => {
    const { x, z } = player.position;
    if (player.ragdoll) return {};
    if (x > -5.2 && z < 3.35) return { moveZ: 1 };
    if (x > -5.2) return { moveX: -1 };
    return walk(player.position, shop);
  }, 15);
}

async function buy(client, capture = false) {
  const { page, virtual } = client;
  const funded = await drive(client, (s) => s.cash >= 40 && s.sold > 0, createReviewPolicy(), 215);
  await reachShop(client);
  await page.keyboard.press('KeyQ');
  const item = page.locator('[data-shop-buy="popper"]');
  assert(await item.isVisible());
  assert(await item.isEnabled());
  const before = await read(client);
  await item.click();
  if (!virtual) {
    await wait(page, () => window.fatfishDebug.snapshot().player.equipment.popper);
  }
  await advance(client, before.tick, 120);
  const stocked = await read(client);
  assert(stocked.player.equipment.popper);
  assert.equal(stocked.cash, before.cash - 40);
  assert.equal(stocked.player.shiftCash, before.player.shiftCash);
  if (capture) await photo(client, '01-popper-shop');
  await page.keyboard.press('Escape');
  assert.equal(await item.isVisible(), false);
  return { funded, stocked };
}

async function local() {
  const client = await boot(true);
  const { page } = client;
  const { funded } = await buy(client, true);
  const catchForPop = ({ player, fish }) => fish.find((item) => item.id === player.carrying
    && item.caughtBy === player.id && !item.heavy);
  const fished = await drive(client, (s) => Boolean(catchForPop(s)), createReviewPolicy(), 90);
  const fishId = catchForPop(fished).id;
  const findFish = (state) => state.fish.find(({ id }) => id === fishId);
  const staging = { x: 0.3, z: -1.25 };
  await drive(client, ({ player }) => distance(player.position, staging) < 0.35,
    ({ player }) => walk(player.position, staging), 6);
  assert.equal((await read(client)).player.carrying, fishId);
  const { player } = await read(client);
  await aim(client, { x: player.position.x, z: player.position.z + 1.25 });
  await page.keyboard.press('KeyE');
  const landed = await drive(client, (state) => findFish(state)?.state === 'stunned'
    && findFish(state).position.z > 1.5, () => ({}), 3);
  const direction = findFish(landed).position.x <= 0 ? 1 : -1;
  const standAt = ({ position }) => ({
    x: position.x + direction * 2.05, z: Math.max(-3.25, Math.min(8.05, position.z)),
  });
  const ready = await drive(client, ({ player, fish }) => {
    const target = fish.find(({ id }) => id === fishId);
    return target?.state === 'stunned' && distance(player.position, standAt(target)) < 0.37;
  }, (state) => findFish(state) && !state.player.ragdoll ? walk(state.player.position, standAt(findFish(state))) : {}, 5);
  const target = findFish(ready).position;
  const marker = {
    x: target.x - 1.35 * direction, z: Math.max(-3.3, Math.min(8.1, target.z)),
  };
  await aim(client, marker);
  await page.keyboard.press('KeyG');
  const armed = await drive(client, ({ poppers }) => poppers.some(({ phase }) => phase === 'fuse'), () => ({}), 0.4, 55);
  assert.equal(armed.player.equipment.popper, false);
  const barrel = armed.poppers.find(({ phase }) => phase === 'fuse');
  assert(distance(barrel.position, ready.player.position) > 2.7);
  await photo(client, '02-fuse');
  const burst = await drive(client, (state) => (findFish(state)?.popCatchUntil ?? 0) > state.time
    && findFish(state).position.y >= 0.78,
    () => ({}), 1, 35);
  assert(!burst.player.ragdoll);
  await photo(client, '03-airborne');
  const caught = await drive(client, ({ player }) => player.carrying === fishId, (state) => {
    const fish = findFish(state);
    if (!fish) return {};
    const inReach = distance(state.player.position, fish.position) < 2.1;
    const inAir = fish.popCatchUntil && fish.position.y >= 0.75;
    return { ...walk(state.player.position, fish.position), aim: fish.position, interact: inReach && inAir };
  }, 2, 55);
  assert.equal(findFish(caught).airCatchMultiplier, 1.45);
  assert.equal(findFish(caught).lastTouch, caught.player.id);
  assert.match(caught.notice?.text ?? '', /空中|接住|接鱼/);
  await photo(client, '04-boosted-catch');
  console.log(`本地实际交货赚 ¥${funded.cash}、购桶、从圈外使普通鱼弹起，按 E 空接拿到 ×1.45。`);
  await client.context.close();
}

async function enterRoom(client, name, code) {
  const { page } = client;
  await page.locator('[data-room-toggle]').click();
  await page.locator('[data-room-name]').fill(name);
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
  await wait(page, () => {
    const net = window.fatfishDebug.network();
    return net.mode === 'playing' || Boolean(net.error);
  });
  const room = await network(client);
  assert.equal(room.mode, 'playing', room.error ?? 'The room did not start');
  return room;
}

async function room() {
  const [host, guest] = await Promise.all([boot(false), boot(false)]);
  const { code } = await enterRoom(host, '点桶');
  const { playerId } = await enterRoom(guest, '旁观一秒', code);
  await host.page.bringToFront();
  await buy(host);
  const victim = (await read(host)).players.find(({ id }) => id === playerId);
  assert(victim && !victim.ragdoll);
  await aim(host, { x: victim.position.x, z: victim.position.z });
  await host.page.keyboard.press('KeyG');
  const planted = await drive(host, ({ poppers }) => poppers.some(({ phase }) => phase === 'fuse'), () => ({}), 0.6, 45);
  const { id } = planted.poppers.find(({ phase }) => phase === 'fuse');
  await wait(guest.page, (id) => window.fatfishDebug.snapshot().poppers.some((barrel) => barrel.id === id), id);
  const blast = await drive(host, ({ players }) => players.some(({ id, ragdoll }) => id === playerId && ragdoll > 1.25),
    () => ({}), 1.25, 50);
  await wait(guest.page, () => window.fatfishDebug.snapshot().player.ragdoll > 1);
  assert.equal(blast.player.equipment.popper, false);
  assert.equal(blast.players.find(({ id }) => id === playerId).cash, victim.cash);
  await photo(host, '05-room-gag');
  console.log('双客户端看到同一个桶和同一次友伤布娃娃，桶只扣一次，被掀翻的访客不扣钱。');
  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  if (pagesOnly) {
    const client = await boot(true);
    await reachShop(client);
    await client.page.keyboard.press('KeyQ');
    assert(await client.page.locator('[data-shop-buy="popper"]').isVisible());
    console.log('Pages 走到摊位打开弹鱼桶目录，和三名机器人本地开班。');
    await client.context.close();
  } else if (process.env.ROOM_ONLY === '1') {
    await room();
  } else {
    await local();
    if (process.env.LOCAL_ONLY !== '1') await room();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
