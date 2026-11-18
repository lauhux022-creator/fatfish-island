import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const screenshots = process.env.SCREENSHOT_DIR;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const wait = (page, predicate, arg, timeout = 25_000) => page.waitForFunction(predicate, arg, { timeout });
const read = ({ page }) => page.evaluate(() => window.fatfishDebug.snapshot());
const network = ({ page }) => page.evaluate(() => window.fatfishDebug.network());
const box = (state) => state.crates.find(({ salvage }) => salvage);
const scale = { x: 5.5, z: 0.7 };
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const direction = (distance) => Math.abs(distance) < 0.2 ? 0 : Math.sign(distance);
const walk = (from, to) => ({ moveX: direction(to.x - from.x), moveZ: direction(to.z - from.z) });

async function boot(virtual = true, sharedContext) {
  const context = sharedContext ?? await browser.newContext({ viewport: { width: 1120, height: 700 } });
  const page = await context.newPage();
  const client = { page, context, virtual };
  page.on('pageerror', (error) => errors.push(error.message));
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm2-review', day: 1, debug: '1', shiftSeconds: 90, nightSeconds: 12 });
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
  const version = await page.locator('[data-version]').textContent();
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version, process.env.EXPECTED_VERSION);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  const state = await read(client);
  assert(state.tick > 2);
  assert.equal(state.players.filter(({ bot }) => bot).length, 3);
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
    if (frame.length < 300_000) {
      await writeFile(join(screenshots, `m11-${name}.jpg`), frame);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${name}`);
}

async function play(client, done, plan, seconds, step = 85) {
  const { page, virtual } = client;
  const controls = createBrowserControls(page);
  let state = await read(client);
  const end = state.time + seconds;
  try {
    for (let tries = 0; !done(state) && state.time < end && tries < 1200 * seconds / step; tries++) {
      await controls.apply(state, plan(state));
      if (virtual) await page.clock.runFor(step);
      else await wait(page, (tick) => window.fatfishDebug.snapshot().tick >= tick,
        state.tick + Math.round(60 * step / 1000), 6000);
      state = await read(client);
    }
  } finally {
    await controls.stop();
  }
  assert(done(state), JSON.stringify({
    time: state.time, position: state.player.position, crate: box(state), hook: state.hook,
    notice: state.notice, carrying: state.player.carrying, equip: state.player.equipment,
    network: done(state) ? undefined : await network(client),
  }));
  return state;
}

async function stage(client) {
  const dock = { x: -7.45, z: -2.8 };
  const westLane = { x: -7.4, z: 3.35 };
  await play(client, ({ player }) => gap(player.position, dock) < 0.4, ({ player }) => {
    const { x, z } = player.position;
    if (player.ragdoll) return {};
    if (x > -5.15 && z < 3.28) return { moveZ: 1 };
    if (x > -6.9) return walk(player.position, westLane);
    return walk(player.position, dock);
  }, 10);
  const floating = await play(client, (s) => box(s)?.state === 'floating', () => ({}), 14, 250);
  assert(floating.crates.some(({ id }) => id === 'supply-crate'));
  assert(floating.crates.some(({ id }) => id === 'training-crate'));
  return floating;
}

async function haul(client, capture) {
  const arrival = await stage(client);
  if (capture) await photo(client, '01-floating-reward');
  const id = box(arrival).id;
  const { page, virtual } = client;
  const { width, height } = page.viewportSize();
  async function pointAt(target) {
    const point = await page.evaluate((position) => window.fatfishDebug.project({ ...position, y: -0.5 }), target);
    assert(point.x >= 0 && point.x < width && point.y >= 0 && point.y < height, JSON.stringify(point));
    await page.mouse.move(point.x, point.y);
  }
  await pointAt(box(arrival).position);
  await page.mouse.down();
  try {
    const charged = await play(client, (s) => s.hook.phase === 'charging' && s.hook.charge >= 0.82, () => ({}), 4);
    await pointAt(box(charged).position);
  } finally {
    await page.mouse.up();
  }
  const hooked = await play(client, (s) => s.hook.targetId === id, () => ({}), 3, 85);
  assert.equal(hooked.hook.target, 'crate');
  if (capture) await photo(client, '02-hooked-supply');

  let landed = hooked;
  for (let tap = 0; tap < 5; tap++) {
    await page.mouse.click(width * 0.52, height * 0.45);
    if (virtual) await page.clock.runFor(150);
    else await wait(page, (progress) => {
      const { hook } = window.fatfishDebug.snapshot();
      return hook.phase === 'idle' || hook.progress > progress;
    }, landed.hook.progress, 3500);
    landed = await read(client);
  }
  assert.equal(box(landed)?.state, 'loose');
  assert(box(landed).position.z >= -4);
  return id;
}

async function carry(client, id) {
  await play(client, (s) => !s.player.ragdoll && s.hook.phase === 'idle'
    && gap(s.player.position, box(s).position) < 1.65, (s) => {
    const target = box(s).position;
    if (s.player.ragdoll) return {};
    if (gap(s.player.position, target) < 1.55) return {};
    return walk(s.player.position, { x: target.x, z: Math.max(-3.15, target.z) });
  }, 14, 80);
  await client.page.keyboard.press('KeyE');
  return play(client, (s) => s.player.carrying === id, () => ({}), 2, 65);
}

async function redeem(client, id, capture) {
  const delivery = { x: 5.05, z: 2.7 };
  const stationed = await play(client, ({ player }) => gap(player.position, delivery) < 0.45, ({ player }) => {
    const { x, z } = player.position;
    if (player.ragdoll) return {};
    if (x < 1.5 && z < 3.35) return { moveZ: 1 };
    if (x < 4.25) return { moveX: 1 };
    return walk(player.position, delivery);
  }, 15);
  assert.equal(stationed.player.carrying, id);
  if (capture) await photo(client, '03-haul-to-scale');
  const redeemed = await play(client, (s) => !box(s) && s.player.equipment.popper, (s) => ({
    aim: scale, interact: s.player.carrying === id,
  }), 2, 55);
  assert.equal(redeemed.cash, stationed.cash);
  assert.equal(redeemed.sold, stationed.sold);
  assert.equal(redeemed.player.shiftCash, stationed.player.shiftCash);
  assert.deepEqual(redeemed.campaign.order, stationed.campaign.order);
  assert.match(redeemed.notice?.text ?? '', /弹鱼桶/);
  if (capture) await photo(client, '04-supply-redeemed');
  return redeemed;
}

async function local() {
  const client = await boot();
  const id = await haul(client, true);
  await carry(client, id);
  const paid = await redeem(client, id, true);
  assert(!paid.player.equipment.bait);
  console.log(`本地三名机器人同班，钩漂流箱、收线上岸、搬进秤，t${paid.time.toFixed(2)}s 领一只弹鱼桶，个人鱼账不变。`);
  await client.context.close();
}

async function enter(client, code) {
  const { page } = client;
  await page.locator('[data-room-toggle]').click();
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
  await wait(page, () => {
    const net = window.fatfishDebug.network();
    return net.mode === 'playing' || Boolean(net.error);
  });
  const room = await network(client);
  assert.equal(room.mode, 'playing', room.error ?? 'Failed to join');
  return room;
}

async function room() {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
  if (process.env.ROOM_30_FPS === '1') {
    await context.addInitScript(() => {
      window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 32);
      window.cancelAnimationFrame = window.clearTimeout.bind(window);
    });
  }
  const host = await boot(false, context);
  const guest = await boot(false, context);
  await host.page.bringToFront();
  const { code } = await enter(host);
  const id = await haul(host, false);
  await guest.page.bringToFront();
  const { playerId } = await enter(guest, code);
  await wait(guest.page, (id) => window.fatfishDebug.snapshot().crates
    .some((item) => item.id === id && item.state === 'loose'), id);
  await carry(guest, id);
  const paid = await redeem(guest, id, false);
  await wait(host.page, ({ id, playerId }) => {
    const state = window.fatfishDebug.snapshot();
    return !state.crates.some((item) => item.id === id)
      && state.players.find((player) => player.id === playerId)?.equipment.popper;
  }, { id, playerId });
  assert.equal((await read(host)).player.equipment.popper, false);
  for (const client of [host, guest]) assert.equal((await network(client)).mode, 'playing');
  await photo(guest, '05-shared-salvage');
  console.log(`真实房间房主抛竿收线，访客搬走进秤领取。两端共同确认箱子消失，奖励到访客（t${paid.time.toFixed(2)}s）。`);
  await context.close();
}

try {
  if (process.env.ROOM_ONLY === '1') await room();
  else {
    await local();
    if (process.env.PAGES_ONLY !== '1' && process.env.LOCAL_ONLY !== '1') await room();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
