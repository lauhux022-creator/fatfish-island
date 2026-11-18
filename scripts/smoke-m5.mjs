import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const pagesOnly = process.env.PAGES_ONLY === '1';
const shots = process.env.SCREENSHOT_DIR;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

const state = (page) => page.evaluate(() => window.fatfishDebug.snapshot());
const network = (page) => page.evaluate(() => window.fatfishDebug.network());
const wait = (page, predicate, value, timeout = 45_000) => page.waitForFunction(predicate, value, { timeout });

async function boot(seed, { day = 3, shiftSeconds, nightSeconds, virtual = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const sockets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.endsWith('/rooms')) sockets.push(socket.url());
  });
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ seed, day, debug: '1', shiftSeconds, nightSeconds }).toString();
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  await page.waitForLoadState('networkidle', { timeout: 45_000 });
  if (virtual) {
    for (let tries = 0; tries < 50; tries++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
    }
  } else {
    await wait(page, () => window.fatfishDebug?.snapshot().tick > 2);
  }
  const booted = await state(page);
  assert.equal(booted.campaign.phase, 'day');
  assert.equal(booted.players.filter(({ bot }) => bot).length, 3);
  assert.deepEqual(new Set(booted.players.map(({ roleId }) => roleId)), new Set(['claude', 'gpt', 'grok', 'kimi']));
  assert.equal(sockets.length, 0);
  assert.equal(await page.locator('[data-version]').textContent(), '0.5.0');
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  return { page, context, sockets };
}

async function runUntil(page, predicate, seconds, step = 500) {
  let snapshot = await state(page);
  for (let elapsed = 0; !predicate(snapshot) && elapsed < seconds * 1000; elapsed += step) {
    await page.clock.runFor(step);
    snapshot = await state(page);
  }
  assert(predicate(snapshot), JSON.stringify({
    time: snapshot.time, day: snapshot.day, phase: snapshot.campaign.phase, paused: snapshot.shiftPaused,
    stock: snapshot.campaign.warehouse.stock, lastCycle: snapshot.campaign.lastCycle,
  }));
  return snapshot;
}

async function photo(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  for (let quality = 80; quality >= 40; quality -= 10) {
    const image = await page.screenshot({
      type: 'jpeg', quality, style: '[data-debug] { visibility: hidden !important; }',
    });
    if (image.length < 300_000) {
      await writeFile(join(shots, `m5-${name}.jpg`), image);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${name}`);
}

async function aim(page, x, z) {
  const at = await page.evaluate((at) => window.fatfishDebug.project(at), { x, y: z < -4 ? -0.5 : 0, z });
  const { width, height } = page.viewportSize();
  assert(at.x >= 0 && at.x < width && at.y >= 0 && at.y < height, JSON.stringify(at));
  await page.mouse.move(at.x, at.y);
}

async function place(page, key, dx, dz) {
  const { x, z } = (await state(page)).player.position;
  await aim(page, x + dx, z + dz);
  await page.keyboard.press(key);
}

function horizontalGap(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

async function steer(page, from, to, run) {
  const keys = [];
  if (Math.abs(to.x - from.x) > 0.45) keys.push(to.x < from.x ? 'KeyA' : 'KeyD');
  if (Math.abs(to.z - from.z) > 0.45) keys.push(to.z < from.z ? 'KeyW' : 'KeyS');
  for (const key of keys) await page.keyboard.down(key);
  try {
    await run();
  } finally {
    for (const key of keys) await page.keyboard.up(key);
  }
}

async function localSuccess() {
  const { page, context, sockets } = await boot('m5-night', { shiftSeconds: 48, nightSeconds: 8 });
  if (pagesOnly) {
    await page.clock.runFor(3000);
    await page.keyboard.down('KeyD');
    await page.clock.runFor(350);
    await page.keyboard.up('KeyD');
    assert((await state(page)).player.position.x > 0.8);
    const dusk = await runUntil(page, ({ campaign }) => campaign.phase === 'night', 49, 1000);
    assert.equal(dusk.day, 3);
    assert.equal(sockets.length, 0);
    assert.equal(await page.locator('[data-control="build:fence"]').isVisible(), true);
    console.log('Pages v0.5.0：固定种子、三名机器人、键盘移位与入夜建造入口，无房间连接。');
    return context.close();
  }
  await runUntil(page, (s) => s.time > 25 && s.campaign.warehouse.stock > 0, 44, 1000);
  await photo(page, '01-day');
  const dusk = await runUntil(page, (s) => s.campaign.phase === 'night', 28, 500);
  assert(dusk.time >= 48 && dusk.time < 48.6);
  assert.equal(await page.locator('[data-campaign-controls]').evaluate((panel) => getComputedStyle(panel).position), 'absolute');
  assert.notEqual(await page.locator('[data-campaign-ledger]').evaluate((panel) => getComputedStyle(panel).backgroundColor), 'rgba(0, 0, 0, 0)');
  const builds = [
    { key: 'Digit1', dx: -2, dz: 0, kind: 'fence', cost: 2 },
    { key: 'Digit2', dx: 0, dz: -2, kind: 'trap', cost: 2 },
    { key: 'Digit3', dx: 2, dz: 0, kind: 'lure', cost: 1 },
  ];
  let wood = dusk.campaign.wood;
  for (const { key, dx, dz, kind, cost } of builds) {
    await place(page, key, dx, dz);
    const built = await runUntil(page, (s) => s.campaign.structures.some((part) => part.kind === kind), 1, 100);
    wood -= cost;
    assert.equal(built.campaign.wood, wood);
  }
  await runUntil(page, (s) => s.campaign.enemies.length > 0 && s.time >= 50.4, 3);
  await photo(page, '02-fortify');
  const close = await runUntil(page, (s) => s.shiftPaused, 8);
  assert.equal(close.time, 56);
  assert.equal(close.campaign.lastCycle.passed, true);
  assert.match(await page.locator('[data-cycle-result]').textContent(), /达标/);
  await page.keyboard.press('Enter');
  await runUntil(page, (s) => s.campaign.phase === 'boss', 1, 100);
  let windup;
  for (let attempt = 0; attempt < 64; attempt++) {
    await page.clock.runFor(150);
    const reading = await state(page);
    const asset = await page.locator('canvas').getAttribute('data-crab-model');
    if (asset === 'crab' && reading.campaign.enemies.some(({ kind, attack }) => kind === 'crab' && attack)) {
      windup = reading;
      break;
    }
  }
  assert(windup, 'the supplied crab GLB must be visible during an authoritative telegraph');
  const crab = windup.campaign.enemies.find((enemy) => enemy.kind === 'crab');
  assert.equal(await page.locator('[data-crab-hud]').evaluate((bar) => getComputedStyle(bar).position), 'absolute');
  assert.equal(crab.maxHp, 22);
  assert.equal(crab.attack.radius, 2.05);
  await photo(page, '04-crab');
  const cleared = await runUntil(page, (s) => s.campaign.phase === 'cleared', 32);
  assert.equal(await page.locator('[data-campaign-victory]').isVisible(), true);
  assert.equal(sockets.length, 0);
  console.log(`本地 ${close.campaign.lastCycle.secured}/${close.campaign.lastCycle.target}，三种部件扣木 2/2/1，实机载入螃蟹 GLB，螃蟹战 ${(cleared.time - close.time).toFixed(2)} 秒通关。`);
  await context.close();
}

async function localGhost() {
  const { page, context } = await boot('m5-quick', { shiftSeconds: 38, nightSeconds: 10 });
  const failed = await runUntil(page, (s) => s.shiftPaused, 52, 1000);
  assert.equal(failed.time, 48);
  assert.equal(failed.campaign.lastCycle.passed, false);
  assert.equal(failed.campaign.lastCycle.eaten.id, failed.player.id);
  assert.match(await page.locator('[data-cycle-result]').textContent(), /吃|吞/);
  await page.keyboard.press('Enter');
  const ghost = await runUntil(page, (s) => s.day === 4 && s.player.ghost, 1, 100);
  const start = ghost.player.position;
  await page.keyboard.down('KeyD');
  await page.clock.runFor(420);
  await page.keyboard.up('KeyD');
  assert((await state(page)).player.position.x >= start.x + 1.3);
  assert.match(await page.locator('[data-revive-progress]').textContent(), /¥0 \/ ¥80/);
  await photo(page, '03-ghost');
  let paid = 0;
  for (let attempts = 0; attempts < 42 && paid < 80; attempts++) {
    const snapshot = await state(page);
    const before = snapshot.players.reduce((wallets, worker) => wallets + worker.cash, 0);
    const donor = snapshot.players.filter(({ bot, ghost, cash }) => bot && !ghost && cash > 0)
      .sort((a, b) => horizontalGap(snapshot.player.position, a.position) - horizontalGap(snapshot.player.position, b.position))[0];
    assert(donor, 'a bot must have savings to contribute');
    if (horizontalGap(snapshot.player.position, donor.position) > 2.85) {
      await steer(page, snapshot.player.position, donor.position, () => page.clock.runFor(210));
      continue;
    }
    await page.keyboard.press('KeyR');
    await page.clock.runFor(60);
    const updated = await state(page);
    const amount = (updated.player.ghost ? updated.player.revivePaid : 80) - paid;
    assert(amount > 0 && amount <= 20);
    assert.equal(updated.players.reduce((wallets, worker) => wallets + worker.cash, 0), before - amount);
    paid += amount;
  }
  assert.equal(paid, 80);
  assert.equal((await state(page)).player.ghost, false);
  console.log(`本地 ${failed.campaign.lastCycle.secured}/${failed.campaign.lastCycle.target}，绩效最低工位次日以幽灵返场，实付 ¥${paid} 复活。`);
  await context.close();
}

async function occupy(page, name, code) {
  await page.locator('[data-room-toggle]').click();
  await page.locator('[data-room-name]').fill(name);
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
  await wait(page, () => {
    const room = window.fatfishDebug.network();
    return room.mode === 'playing' || Boolean(room.error);
  });
  const joined = await network(page);
  assert.equal(joined.mode, 'playing', joined.error ?? 'Room did not become playable');
  return joined;
}

async function room() {
  const options = { shiftSeconds: 27, nightSeconds: 12, virtual: false };
  const [host, guest] = await Promise.all([boot('m5-room', options), boot('m5-room', options)]);
  const { code } = await occupy(host.page, '阿浪');
  assert.match(code, /^\d{4}$/);
  const { playerId } = await occupy(guest.page, '黑豆', code);
  assert(playerId);
  await wait(host.page, () => window.fatfishDebug.snapshot().players.filter(({ bot }) => !bot).length === 2);
  await Promise.all([host, guest].map(({ page }) =>
    wait(page, () => window.fatfishDebug.snapshot().campaign.phase === 'night')));
  const dusk = await state(host.page);
  assert(dusk.time >= 27 && dusk.time < 28);
  await place(guest.page, 'Digit1', 0, 2);
  await Promise.all([host, guest].map(({ page }) =>
    wait(page, () => window.fatfishDebug.snapshot().campaign.structures.some(({ kind }) => kind === 'fence'))));
  const fromHost = await state(host.page);
  const fromGuest = await state(guest.page);
  assert.deepEqual(fromHost.campaign.structures, fromGuest.campaign.structures);
  assert.equal(fromHost.campaign.wood, fromGuest.campaign.wood);
  assert.equal(fromHost.campaign.wood, dusk.campaign.wood - 2);
  await wait(host.page, () => {
    const { campaign, time } = window.fatfishDebug.snapshot();
    return campaign.enemies.length >= 1 && time >= 30;
  });
  await photo(host.page, '05-room-night');
  await Promise.all([host, guest].map(({ page }) => wait(page, () => window.fatfishDebug.snapshot().shiftPaused)));
  const settlement = await state(host.page);
  assert.equal(settlement.time, 39);
  assert.equal(settlement.campaign.lastCycle.passed, false);
  assert.deepEqual(settlement.campaign.lastCycle, (await state(guest.page)).campaign.lastCycle);
  const victim = settlement.campaign.lastCycle.eaten.id;
  await guest.page.keyboard.press('Enter');
  await Promise.all([host, guest].map(({ page }) => wait(page, (victim) => {
    const s = window.fatfishDebug.snapshot();
    return s.day === 4 && s.players.some(({ id, ghost }) => id === victim && ghost);
  }, victim)));
  const ghostClient = victim === playerId ? guest : host;
  const livingClient = victim === playerId ? host : guest;
  assert(!settlement.players.find(({ id }) => id === victim).bot);
  const alive = (await state(livingClient.page)).player.position;
  for (let attempt = 0; attempt < 16; attempt++) {
    const { player, tick } = await state(ghostClient.page);
    if (horizontalGap(player.position, alive) < 1.8) break;
    await steer(ghostClient.page, player.position, alive, () =>
      wait(ghostClient.page, (tick) => window.fatfishDebug.snapshot().tick >= tick + 11, tick));
  }
  assert(horizontalGap((await state(ghostClient.page)).player.position, alive) < 2.1);
  await ghostClient.page.keyboard.press('KeyF');
  await wait(livingClient.page, () => window.fatfishDebug.snapshot().player.ragdoll > 0);
  console.log(`联机 2 人、2 机器人。两端确认 27 秒入夜、同一围栏和木料、39 秒结算，${settlement.campaign.lastCycle.eaten.name}成为幽灵并绊倒了另一位玩家。`);
  await Promise.all([host, guest].map(({ context }) => context.close()));
}

try {
  if (pagesOnly) await localSuccess();
  else if (process.env.ROOM_ONLY === '1') await room();
  else if (process.env.LOCAL_ONLY === '1') {
    await localSuccess();
    await localGhost();
  } else {
    await localSuccess();
    await localGhost();
    await room();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
