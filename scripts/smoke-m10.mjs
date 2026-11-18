import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const screenshots = process.env.SCREENSHOT_DIR;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const wait = (page, predicate, arg, timeout = 25_000) => page.waitForFunction(predicate, arg, { timeout });
const state = (page) => page.evaluate(() => window.fatfishDebug.snapshot());
const network = (page) => page.evaluate(() => window.fatfishDebug.network());
const order = (page) => page.locator('[data-daily-order]');

async function boot({ day = 1, shiftSeconds = 90, virtual = true, mobile = false } = {}) {
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1120, height: 700 } });
  const page = await context.newPage();
  const sockets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.endsWith('/rooms')) sockets.push(socket);
  });
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm2-review', day, debug: '1', shiftSeconds, nightSeconds: 12 });
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  if (virtual) {
    await page.waitForLoadState('networkidle', { timeout: 45_000 });
    for (let tries = 0; tries < 70; tries++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
    }
  } else {
    await wait(page, () => window.fatfishDebug?.snapshot().tick > 2, null, 45_000);
  }
  const initial = await state(page);
  assert(initial.tick > 2);
  assert.equal(initial.day, day);
  assert.equal(initial.players.filter(({ bot }) => bot).length, 3);
  assert.equal((await network(page)).mode, 'local');
  assert.equal(sockets.length, 0);
  const version = await page.locator('[data-version]').textContent();
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version, process.env.EXPECTED_VERSION);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  return { context, page, initial, virtual, sockets };
}

async function photo(page, name) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  for (const quality of [80, 70, 60, 50]) {
    const image = await page.screenshot({
      type: 'jpeg', quality, style: '[data-debug] { visibility: hidden !important; }',
    });
    if (image.length < 300_000) {
      await writeFile(join(screenshots, `m10-${name}.jpg`), image);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${name}`);
}

async function play(client, plan, enough, seconds, step = 100) {
  const { page, virtual } = client;
  const controls = createBrowserControls(page);
  let current = await state(page);
  const deadline = current.time + seconds;
  try {
    for (let attempts = 0; !enough(current) && current.time < deadline && attempts < 1200 * seconds / step; attempts++) {
      await controls.apply(current, plan(current));
      if (virtual) await page.clock.runFor(step);
      else await wait(page, (tick) => window.fatfishDebug.snapshot().tick >= tick,
        current.tick + Math.round(60 * step / 1000), 6000);
      current = await state(page);
    }
  } finally {
    await controls.stop();
  }
  assert(enough(current), JSON.stringify({
    time: current.time, sold: current.sold, order: current.campaign.order,
    wood: current.campaign.wood, phase: current.campaign.phase, notice: current.notice,
  }));
  return current;
}

function assertOrder(snapshot, id, progress, status) {
  const current = snapshot.campaign.order;
  assert.equal(current.id, id);
  assert.equal(current.progress, progress);
  assert.equal(current.status, status);
  assert.equal(current.day, snapshot.day);
  return current;
}

async function local() {
  const client = await boot();
  const { page, initial, sockets } = client;
  assertOrder(initial, 'delivery', 0, 'open');
  assert(await order(page).isVisible());
  assert.equal(await order(page).getAttribute('data-status'), 'open');
  if (screenshots) {
    for (let tries = 0; tries < 20; tries++) {
      const roles = await page.locator('canvas').getAttribute('data-loaded-roles');
      if (roles?.split(',').length === 4) break;
      await page.clock.runFor(75);
    }
  }
  await photo(page, '01-day-open');

  const plan = createReviewPolicy();
  const first = await play(client, plan, (s) => s.campaign.order.progress === 1, 87);
  assertOrder(first, 'delivery', 1, 'open');
  assert.equal(first.sold, 1);
  const done = await play(client, plan, (s) => s.campaign.order.status === 'complete', 90 - first.time);
  assert.equal(assertOrder(done, 'delivery', 2, 'complete').woodReward, 2);
  assert.equal(done.sold, 2);
  assert.equal(done.campaign.wood, 6);
  assert.equal(await order(page).getAttribute('data-status'), 'complete');
  await photo(page, '02-order-complete');
  const dusk = await play(client, () => ({}), (s) => s.campaign.phase === 'night', 92 - done.time, 600);
  assertOrder(dusk, 'delivery', 2, 'complete');
  assert.equal(dusk.campaign.wood, 14);

  const at = await page.evaluate(({ x, z }) =>
    window.fatfishDebug.project({ x: x - 2, y: 0, z }), dusk.player.position);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.press('Digit1');
  const built = await play(client, () => ({}),
    (s) => s.campaign.structures.some(({ kind }) => kind === 'fence'), 2, 50);
  assert.equal(built.campaign.wood, 12);
  await page.clock.runFor(800);
  await photo(page, '03-wood-at-night');
  assert.equal(sockets.length, 0);
  console.log(`本地两笔实际交货得 ¥${done.cash}，t${done.time.toFixed(2)}s 完成订单。夜间木料 14，造围栏后 12。`);
  await client.context.close();
}

async function mobile() {
  const client = await boot({ day: 2, shiftSeconds: 24, mobile: true });
  const { page } = client;
  assertOrder(client.initial, 'variety', 0, 'open');
  const bounds = await order(page).boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  const dusk = await play(client, () => ({}), (s) => s.campaign.phase === 'night', 25, 800);
  assertOrder(dusk, 'variety', 0, 'expired');
  assert.equal(dusk.campaign.wood, 12);
  await play(client, () => ({}), (s) => s.shiftPaused, 13, 600);
  assert.match(await page.locator('[data-settlement-order]').textContent(), /已过期/);
  await photo(page, '04-mobile-expired');
  await page.locator('[data-control="continue"]').tap();
  const next = await play(client, () => ({}), (s) => s.day === 3, 1, 75);
  assert.equal(assertOrder(next, 'trick', 0, 'open').woodReward, 3);
  console.log('390×844 触屏，未完成的鱼种单到夜间过期，不多发木料，点下一班切换到活饵／空接单。');
  await client.context.close();
}

async function connect(page, code) {
  await page.locator('[data-room-toggle]').click();
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
  await wait(page, () => {
    const net = window.fatfishDebug.network();
    return net.mode === 'playing' || Boolean(net.error);
  });
  const room = await network(page);
  assert.equal(room.mode, 'playing', room.error ?? 'Failed to join');
  return room;
}

async function room() {
  const [host, guest] = await Promise.all([boot({ virtual: false, shiftSeconds: 105 }), boot({ virtual: false })]);
  const { code } = await connect(host.page);
  await connect(guest.page, code);
  await host.page.bringToFront();
  const first = await play(host, createReviewPolicy(), (s) => s.campaign.order.progress > 0, 96);
  await wait(guest.page, () => window.fatfishDebug.snapshot().campaign.order.progress > 0);
  assert.equal((await state(guest.page)).player.sold, 0);
  assert.equal(first.campaign.phase, 'day');
  await photo(host.page, '05-room-order');
  const dusk = (page) => wait(page, () => window.fatfishDebug.snapshot().campaign.phase === 'night', null, 110_000);
  await Promise.all([dusk(host.page), dusk(guest.page)]);
  const [a, b] = await Promise.all([state(host.page), state(guest.page)]);
  assert.deepEqual(a.campaign.order, b.campaign.order);
  assert.equal(a.campaign.wood, b.campaign.wood);
  console.log(`双客户端同步订单 ${a.campaign.order.progress}/2，入夜状态 ${a.campaign.order.status}，木料 ${a.campaign.wood}。`);
  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  if (process.env.ROOM_ONLY === '1') await room();
  else {
    await local();
    if (process.env.PAGES_ONLY !== '1') await mobile();
    if (process.env.PAGES_ONLY !== '1' && process.env.LOCAL_ONLY !== '1') await room();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
