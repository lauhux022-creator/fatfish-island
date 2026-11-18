import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const pagesOnly = process.env.PAGES_ONLY === '1';
const screenshots = process.env.SCREENSHOT_DIR;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const wait = (page, predicate, arg, timeout = 25_000) => page.waitForFunction(predicate, arg, { timeout });
const read = (page) => page.evaluate(() => window.fatfishDebug.snapshot());
const net = (page) => page.evaluate(() => window.fatfishDebug.network());
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

async function ready(page, virtual, pace) {
  if (virtual) {
    await page.waitForLoadState('networkidle', { timeout: 45_000 });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
    }
  } else {
    await wait(page, () => window.fatfishDebug?.snapshot().tick > 2, null, 45_000);
  }
  const state = await read(page);
  assert(state.tick > 2);
  assert.equal(state.campaign.pace, pace);
  const version = await page.locator('[data-version]').textContent();
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version, process.env.EXPECTED_VERSION);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  return state;
}

async function boot({ pace = 'classic', virtual = false, seed = 'm8-quick' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 625 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  let rooms = 0;
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.endsWith('/rooms')) rooms += 1;
  });
  if (virtual) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60000);
  }
  const url = new URL(base);
  url.search = new URLSearchParams({ debug: '1', seed }).toString();
  if (pace === 'quick') url.searchParams.set('pace', pace);
  const start = performance.now();
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  const state = await ready(page, virtual, pace);
  const time = (performance.now() - start) / 1000;
  assert.equal(rooms, 0, 'Pages local startup has no room socket');
  assert.equal(state.players.filter(({ bot }) => bot).length, 3);
  return { page, context, time };
}

async function photo(page, suffix) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  for (const quality of [80, 70, 60, 50]) {
    const frame = await page.screenshot({ type: 'jpeg', quality, style: '[data-debug]{visibility:hidden!important}' });
    if (frame.length < 300_000) {
      await writeFile(join(screenshots, `m8-${suffix}.jpg`), frame);
      return;
    }
  }
  throw new Error('Screenshot exceeds 300 KB');
}

function walk(from, to) {
  const axis = (delta) => Math.abs(delta) > 0.35 ? Math.sign(delta) : 0;
  return { moveX: axis(to.x - from.x), moveZ: axis(to.z - from.z) };
}

function defend(state) {
  const { player, campaign } = state;
  if (player.ragdoll || player.ghost) return {};
  const { position: origin } = player;
  const patrol = { x: 0.2, z: 3.2 };
  const nearest = [...campaign.enemies].sort((a, b) => distance(origin, a.position) - distance(origin, b.position))[0];
  if (!nearest || nearest.position.z < -2.8) {
    return walk(origin, patrol);
  }
  const target = nearest.position;
  const danger = nearest.attack;
  if (danger && distance(origin, danger.position) < danger.radius + 0.3) {
    const heading = { x: origin.x - danger.position.x, z: origin.z - danger.position.z };
    const length = Math.hypot(heading.x, heading.z);
    return length < 0.2 ? { moveX: 1 } :
      walk(origin, { x: origin.x + 2 * heading.x / length, z: origin.z + 2 * heading.z / length });
  }
  if (distance(origin, target) < 2.2 && player.swing <= 0) {
    return { aim: target, swing: true };
  }
  return { ...walk(origin, target), aim: target };
}

async function openQuick(page) {
  await page.locator('[data-role-toggle]').click();
  await photo(page, '01-crew-setup');
  await page.locator('label').filter({ has: page.locator('[name="pace"][value="quick"]') }).click();
  await page.locator('[data-local-role-form] button[type=submit]').click();
  await page.waitForURL((url) => url.searchParams.get('pace') === 'quick');
  const state = await ready(page, true, 'quick');
  assert(state.campaign.remaining > 88 && state.campaign.remaining <= 90);
}

async function playUntil(page, controls, plan, done, max, delta) {
  let view = await read(page);
  const limit = view.time + max;
  for (let ticks = 0; !done(view) && view.time < limit && ticks < Math.ceil(max * 1200 / delta); ticks++) {
    await controls.apply(view, plan(view));
    await page.clock.runFor(delta);
    view = await read(page);
  }
  await controls.stop();
  assert(done(view), JSON.stringify({
    phase: view.campaign.phase, time: view.time, day: view.day, paused: view.shiftPaused,
    secured: view.campaign.cycle.secured, target: view.campaign.cycle.target, sold: view.sold,
  }));
  return view;
}

async function local() {
  const { page, context } = await boot({ virtual: true });
  const classic = await read(page);
  assert(classic.campaign.remaining > 238);
  await openQuick(page);
  const controls = createBrowserControls(page);
  let close;
  for (let day = 1; day <= 3; day++) {
    const start = await read(page);
    assert.equal(start.day, day);
    const dusk = await playUntil(page, controls, createReviewPolicy(), ({ campaign }) => campaign.phase === 'night', 91, 100);
    assert(dusk.time >= (day - 1) * 120 + 90 && dusk.time < (day - 1) * 120 + 90.3);
    if (day === 1) {
      assert(dusk.sold >= 1, 'the player should earn a sale in the first short day');
      await page.clock.runFor(900);
      await photo(page, '02-short-night');
    }
    close = await playUntil(page, controls, () => ({}), ({ shiftPaused }) => shiftPaused, 31, 500);
    assert.equal(close.time, day * 120);
    console.log(`短班第 ${day} 天结束 t${close.time}s · 保住 ¥${close.campaign.cycle.secured} · 个人累计 ${close.sold} 尾`);
    if (day === 3) await photo(page, '04-cycle-board');
    await page.keyboard.press('Enter');
    await page.clock.runFor(125);
  }
  assert.equal(close.campaign.lastCycle?.passed, true, JSON.stringify(close.campaign.lastCycle));
  assert(close.sold >= 3);
  const finished = await playUntil(page, controls, defend, ({ campaign }) => campaign.phase === 'cleared', 45, 150);
  assert.equal(await page.locator('[data-campaign-victory]').isVisible(), true);
  await photo(page, '05-victory-recap');
  console.log(`六分钟完整短班 · ¥${close.campaign.lastCycle.secured}/¥${close.campaign.lastCycle.target} · 螃蟹战 ${(finished.time - close.time).toFixed(2)} 秒。`);
  await context.close();
}

async function connect(page, code) {
  await page.locator('[data-room-toggle]').click();
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator('[data-room-pace]').selectOption(code ? 'classic' : 'quick');
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
  await wait(page, () => {
    const room = window.fatfishDebug.network();
    return room.mode === 'playing' || Boolean(room.error);
  });
  const result = await net(page);
  assert.equal(result.mode, 'playing', result.error ?? 'Could not join');
  return result;
}

async function room() {
  const [host, guest] = await Promise.all([boot({ seed: 'm8-room' }), boot({ seed: 'm8-room' })]);
  const { code } = await connect(host.page);
  await connect(guest.page, code);
  for (const { page } of [host, guest]) {
    await wait(page, () => {
      const s = window.fatfishDebug.snapshot();
      return s.campaign.pace === 'quick' && s.campaign.remaining > 83 && s.campaign.remaining <= 90;
    });
  }
  await Promise.all([host, guest].map(({ page }) =>
    wait(page, () => window.fatfishDebug.snapshot().campaign.phase === 'night', null, 100_000)));
  const night = await read(guest.page);
  const pos = night.player.position;
  assert(night.time >= 90 && night.time < 91);
  assert(night.campaign.remaining > 28 && night.campaign.remaining <= 30);
  const point = await guest.page.evaluate(({ x, z }) =>
    window.fatfishDebug.project({ x, y: 0, z: z + 2 }), pos);
  await guest.page.mouse.move(point.x, point.y);
  await guest.page.keyboard.press('Digit1');
  for (const { page } of [host, guest]) {
    await wait(page, () => window.fatfishDebug.snapshot().campaign.structures.some(({ kind }) => kind === 'fence'));
  }
  await photo(host.page, '03-room-night');
  await Promise.all([host, guest].map(({ page }) => wait(page, () => window.fatfishDebug.snapshot().shiftPaused, null, 40_000)));
  assert.equal((await read(host.page)).time, 120);
  assert.deepEqual((await read(host.page)).result, (await read(guest.page)).result);
  await guest.page.keyboard.press('Enter');
  await wait(host.page, () => window.fatfishDebug.snapshot().day === 2);
  console.log('双客户端从同一短班开工至 t120s 结算，客端全程使用房主班型，两端确认围栏与次日。');
  await Promise.all([host.context.close(), guest.context.close()]);
}

async function verifyPublished() {
  const { page, context, time } = await boot({ pace: 'quick' });
  assert.equal((await net(page)).mode, 'local');
  assert((await read(page)).campaign.remaining > 85);
  assert.match(await page.locator('[data-pace-label]').textContent(), /短班/);
  await page.keyboard.down('KeyD');
  try {
    await wait(page, () => window.fatfishDebug.snapshot().player.position.x > 0.65);
  } finally {
    await page.keyboard.up('KeyD');
  }
  console.log(`Pages v0.8.0 在 ${time.toFixed(2)} 秒进入短班，确认实际移位及三名机器人。`);
  await context.close();
}

try {
  if (pagesOnly) await verifyPublished();
  else if (process.env.ROOM_ONLY === '1') await room();
  else {
    await local();
    if (process.env.LOCAL_ONLY !== '1') await room();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
