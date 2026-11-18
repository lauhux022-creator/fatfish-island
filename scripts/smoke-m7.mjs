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
const water = { x: 1.6, y: -0.5, z: -8.1 };
const scale = { x: 5.5, y: 0, z: 0.7 };

const snapshot = ({ page }) => page.evaluate(() => window.fatfishDebug.snapshot());
const network = ({ page }) => page.evaluate(() => window.fatfishDebug.network());
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (point, target, radius) => gap(point, target) <= radius;
const pace = (delta) => Math.abs(delta) > 0.25 ? Math.sign(delta) : 0;
const walk = (from, to) => ({ moveX: pace(to.x - from.x), moveZ: pace(to.z - from.z) });

async function boot(virtual, small = false) {
  const context = await browser.newContext({ viewport: small ? { width: 800, height: 500 } : { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const client = { context, page, virtual, controls: createBrowserControls(page) };
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ debug: '1', seed: 'm7-heavy', day: '1' }).toString();
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  if (virtual) {
    await page.waitForLoadState('networkidle', { timeout: 45000 });
    for (let attempts = 0; attempts < 60; attempts++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
    }
  } else {
    await page.waitForFunction(() => window.fatfishDebug?.snapshot().tick > 2);
  }
  assert((await snapshot(client)).tick > 2);
  const version = await page.locator('[data-version]').textContent();
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version, process.env.EXPECTED_VERSION);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  return client;
}

async function photo({ page }, suffix) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  for (const quality of [80, 70, 60, 50]) {
    const frame = await page.screenshot({
      type: 'jpeg', quality, style: '[data-debug]{visibility:hidden!important}',
    });
    if (frame.length < 300_000) {
      await writeFile(join(screenshots, `m7-${suffix}.jpg`), frame);
      return;
    }
  }
  throw new Error('Screenshot exceeds 300 KB');
}

async function tick(client, ms = 100) {
  const { page, virtual } = client;
  if (virtual) {
    await page.clock.runFor(ms);
    return;
  }
  const { tick } = await snapshot(client);
  await page.waitForFunction((step) => window.fatfishDebug.snapshot().tick >= step, tick + Math.max(1, Math.floor(ms / 17)),
    { timeout: 7500 });
}

async function until(client, predicate, seconds, step = 100) {
  let view = await snapshot(client);
  for (let elapsed = 0; elapsed < seconds * 1000 && !predicate(view); elapsed += step) {
    await tick(client, step);
    view = await snapshot(client);
  }
  assert(predicate(view), JSON.stringify({
    time: view.time, position: view.player.position, hook: view.hook,
    fish: view.fish.map(({ id, heavy, state, liftClaimId, carrierId, helperId }) => ({
      id, heavy, state, liftClaimId, carrierId, helperId,
    })),
  }));
  return view;
}

async function aim(client, to) {
  const { page } = client;
  const pixels = await page.evaluate((point) => window.fatfishDebug.project(point), to);
  const size = page.viewportSize();
  assert(pixels.x >= 0 && pixels.x < size.width && pixels.y >= 0 && pixels.y < size.height);
  await page.mouse.move(pixels.x, pixels.y);
  return pixels;
}

async function catchHeavy(client) {
  const { page } = client;
  const before = await snapshot(client);
  const bait = before.players.find(({ id }) => id === 'bot-2');
  assert(bait);
  await aim(client, { ...bait.position, y: 0.45 });
  await page.mouse.down();
  await until(client, ({ hook }) => hook.charge >= 0.45, 2, 45);
  await page.mouse.up();
  const hooked = await until(client, ({ hook }) => hook.phase === 'bait', 4);
  assert.equal(hooked.hook.targetId, bait.id);
  const splash = await aim(client, water);
  await page.mouse.click(splash.x, splash.y);
  const bite = await until(client, ({ hook }) => hook.phase === 'bite', 5);
  const heavy = bite.fish.find(({ id }) => id === bite.hook.targetId);
  assert(heavy?.heavy && heavy.baitPlayerId === bait.id);
  for (let i = 0; i < 10 && (await snapshot(client)).hook.phase !== 'idle'; i++) {
    await page.mouse.click(splash.x, splash.y);
    await tick(client, 95);
  }
  assert.equal((await snapshot(client)).hook.phase, 'idle');
  return heavy;
}

async function untilFirstGrip(client, heavyId) {
  const plan = createReviewPolicy();
  const { controls } = client;
  try {
    let view = await snapshot(client);
    for (let start = view.time; view.time < start + 9.5;) {
      if (view.player.lifting === heavyId || view.player.carrying === heavyId) return view;
      const cargo = view.fish.find(({ id }) => id === heavyId);
      assert(cargo, `The heavy fish escaped at t=${view.time}`);
      const inReach = near(view.player.position, cargo.position, 2.4)
        && Math.abs(view.player.position.y - cargo.position.y) < 1.25;
      const swing = cargo.state === 'flopping' && inReach && !view.player.ragdoll && view.player.swing <= 0;
      await controls.apply(view, swing ? { aim: cargo.position, swing: true } : plan(view));
      await tick(client, 75);
      view = await snapshot(client);
    }
    throw new Error(`Could not get a grip on ${heavyId}`);
  } finally {
    await controls.stop();
  }
}

async function local() {
  const client = await boot(true);
  const heavy = await catchHeavy(client);
  await photo(client, '01-giant-on-shore');
  await untilFirstGrip(client, heavy.id);
  const paired = await until(client, ({ fish, player }) =>
    player.carrying === heavy.id && fish.some(({ id, helperId }) => id === heavy.id && helperId), 10);
  const fish = paired.fish.find(({ id }) => id === heavy.id);
  assert(paired.players.find(({ id }) => id === fish.helperId)?.bot);
  await photo(client, '02-bot-grip');
  const plan = createReviewPolicy();
  let view = paired;
  for (let start = view.time; view.time < start + 12 && view.sold === paired.sold;) {
    await client.controls.apply(view, plan(view));
    await tick(client, 100);
    view = await snapshot(client);
  }
  await client.controls.stop();
  assert.equal(view.sold, paired.sold + 1, JSON.stringify({
    pairedAt: paired.time, finalTime: view.time, notice: view.notice,
    player: view.player.position, cargo: view.fish.find(({ id }) => id === heavy.id),
  }));
  assert.equal(view.players.find(({ id }) => id === heavy.baitPlayerId).cash, 0);
  assert(view.cash > 90);
  await photo(client, '03-jumbo-sale');
  assert.equal((await network(client)).mode, 'local');
  console.log(`本地钩到巨型欠薪斑，${paired.players.find(({ id }) => id === fish.helperId).name} 搭手，卖鱼到账 ¥${view.cash}。`);
  await client.context.close();
}

async function connect(client, name, code) {
  const { page } = client;
  await page.locator('[data-room-toggle]').click();
  await page.locator('[data-room-name]').fill(name);
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
  await page.waitForFunction(() => window.fatfishDebug.network().mode === 'playing', null, { timeout: 12000 });
  return network(client);
}

async function room() {
  const [host, guest, bait, fourth] = await Promise.all([boot(false), boot(false), boot(false, true), boot(false, true)]);
  const { code } = await connect(host, '钩手');
  const { playerId: guestId } = await connect(guest, '搬手', code);
  const baitSeat = await connect(bait, '鱼饵', code);
  await connect(fourth, '工友', code);
  await until(host, ({ players }) => players.every(({ bot }) => !bot), 3);
  await host.page.bringToFront();
  const heavy = await catchHeavy(host);
  assert.equal(heavy.baitPlayerId, baitSeat.playerId);
  const grip = await untilFirstGrip(host, heavy.id);
  const point = grip.fish.find(({ id }) => id === heavy.id).position;
  for (let attempts = 0; attempts < 40; attempts++) {
    const current = await snapshot(guest);
    if (near(current.player.position, point, 1.7) && near(current.player.position, grip.player.position, 2.85)) break;
    const side = {
      x: (point.x + grip.player.position.x) / 2 - 0.7,
      z: (point.z + grip.player.position.z) / 2,
    };
    await guest.controls.apply(current, walk(current.player.position, side));
    await tick(guest, 80);
  }
  await guest.controls.stop();
  await aim(guest, point);
  await guest.page.keyboard.press('KeyE');
  const pair = await until(host, ({ fish }) => fish.some(({ id, helperId }) => id === heavy.id && helperId === guestId), 3);
  const cargo = pair.fish.find(({ id }) => id === heavy.id);
  const readGuest = await until(guest, ({ fish }) => fish.some(({ id, helperId }) => id === heavy.id && helperId === guestId), 3);
  assert.equal(readGuest.player.carrying, heavy.id);
  assert.equal(cargo.carrierId, pair.player.id);
  await photo(host, '04-room-pair');
  const finish = { x: 4.4, z: 1.8 };
  const companion = { x: 4.4, z: 0.4 };
  let view = pair;
  while (!near(view.player.position, finish, 0.7) && view.time < pair.time + 8) {
    assert.equal(view.player.carrying, heavy.id);
    const other = await snapshot(guest);
    await host.controls.apply(view, walk(view.player.position, finish));
    await guest.controls.apply(other, walk(other.player.position, companion));
    await tick(host, 95);
    view = await snapshot(host);
  }
  await host.controls.stop();
  await guest.controls.stop();
  assert(near(view.player.position, finish, 0.7));
  await aim(host, scale);
  await host.page.keyboard.press('KeyE');
  const sale = await until(host, ({ sold }) => sold === pair.sold + 1, 3);
  await until(guest, ({ players, fish }) => players.find(({ id }) => id === sale.player.id)?.cash === sale.player.cash
    && !fish.some(({ id }) => id === heavy.id), 3);
  assert.equal((await snapshot(guest)).player.cash, 0);
  console.log(`联机两个真人等到同一条鱼双人合抬并交货，两个视角确认抛鱼者入账 ¥${sale.player.cash}。`);
  await Promise.all([host, guest, bait, fourth].map(({ context }) => context.close()));
}

try {
  if (!process.env.ROOM_ONLY) await local();
  if (!pagesOnly && !process.env.LOCAL_ONLY) await room();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
