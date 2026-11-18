import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const screenshotDirectory = process.env.SCREENSHOT_DIR;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const controls = createBrowserControls(page);
const errors = [];
const external = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.protocol.startsWith('http') && url.origin !== base.origin) external.add(url.origin);
});
const read = () => page.evaluate(() => window.fatfishDebug?.snapshot());

async function photo(name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  const frame = await page.screenshot({
    type: 'jpeg',
    quality: 78,
    style: '[data-debug] { visibility: hidden !important; }',
  });
  assert(frame.length < 300_000);
  await writeFile(join(screenshotDirectory, `m3-${name}.jpg`), frame);
}

async function waitFor(description, predicate, seconds = 15) {
  for (let elapsed = 0; elapsed <= seconds * 1000; elapsed += 100) {
    const state = await read();
    if (state && predicate(state)) return state;
    await page.clock.runFor(100);
  }
  throw new Error(`超时：${description}`);
}

async function openShift({ short, day = 3 } = {}) {
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm2-review', day: String(day), debug: '1' }).toString();
  if (short) url.searchParams.set('shiftSeconds', String(short));
  assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  await page.waitForLoadState('networkidle', { timeout: 45000 });
  for (let tries = 0; tries < 100; tries++) {
    if (await read()) break;
    await page.clock.runFor(100);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const version = await page.locator('[data-version]').textContent();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version, process.env.EXPECTED_VERSION);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  const state = await waitFor('开工发指标', (s) => s.boss.line?.trigger === 'shift_start');
  assert.equal(state.boss.calls, 1);
  assert.equal(state.players.filter(({ bot }) => bot).length, 3);
  assert((await page.locator('[data-boss-say]').textContent()).includes(state.boss.line.say));
  return state;
}

async function send(text) {
  const field = page.locator('[data-boss-input]');
  if (!await field.isVisible()) await page.keyboard.press('KeyT');
  await field.fill(text);
  await field.press('Enter');
}

async function chat(text, action) {
  const before = await read();
  const lastId = before.boss.line?.id;
  await send(text);
  const after = await waitFor(`回复 ${text}`,
    (s) => s.boss.line?.id !== lastId && s.boss.line?.trigger === 'chat', 28);
  assert.equal(after.boss.line.action, action);
  assert([...after.boss.line.say].length <= 30);
  return after;
}

async function fishUntilSale() {
  const plan = createReviewPolicy();
  try {
    for (let frame = 0; frame < 1000; frame++) {
      const state = await read();
      if (state.player.sold > 0) return state;
      await controls.apply(state, plan(state));
      await page.clock.runFor(100);
    }
    throw new Error('玩家未完成交鱼');
  } finally {
    await controls.stop();
  }
}

try {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);

  const opening = await openShift({ day: 1 });
  await photo('01-opening-kpi');
  await send('老板发个鱼饵');
  await page.clock.runFor(350);
  const queued = await read();
  assert.equal(queued.boss.calls, opening.boss.calls);
  assert.equal(queued.boss.pending, true);
  const gift = await waitFor('冷却结束后赠饵', (state) => state.boss.line?.action === 'gift_item', 12);
  assert.equal(gift.boss.calls, 2);
  assert(gift.time >= opening.time + 7.85, 'boss called twice within eight seconds');
  assert(gift.player.giftedBait);
  await photo('02-chat-gift');
  console.log('开工 KPI、聊天队列、至少八秒限频、赠饵均生效');

  await openShift();
  const sold = await fishUntilSale();
  assert(sold.player.shiftCash > 0);
  await waitFor('交鱼触发价格裁决', (s) => s.boss.line?.trigger === 'sale', 17);
  const praised = await chat('老板真英明', 'bonus');
  assert(praised.player.favor > 0);
  assert(praised.player.cash > sold.player.cash);
  await photo('03-flattery');

  const bribe = await chat('请老板喝茶，送你红包', 'fine');
  assert(bribe.player.cash < praised.player.cash);
  assert(bribe.player.favor > praised.player.favor);
  assert(bribe.player.memory.length > 0);

  const argued = await chat('收鱼能涨价吗', 'price_change');
  assert(argued.boss.priceMultiplier >= 1.03);
  const complaint = await chat('老板，桶桶偷鱼，我来告状', 'fine');
  assert(complaint.boss.line.target === 'player' || complaint.boss.line.target === 'bot-2');
  await photo('04-complaint');
  console.log('交鱼砍价、拍马屁加好感、贿赂扣款、讨价与告状裁决通过');

  await openShift();
  await page.keyboard.down('KeyS');
  await waitFor('走出岛外触发工亡', (state) => state.player.ragdoll > 0, 6);
  await page.keyboard.up('KeyS');
  await waitFor('工亡触发吐槽', (state) => state.boss.line?.trigger === 'death', 13);
  console.log('落水工亡触发大肥鱼吐槽');

  await openShift({ short: 12 });
  const paused = await waitFor('日末暂停', (s) => s.shiftPaused, 14);
  const reviewed = await waitFor('绩效面谈出现在结算榜', (s) =>
    s.boss.interview?.trigger === 'shift_end', 14);
  assert.equal(reviewed.tick, paused.tick);
  assert.equal(await page.locator('[data-shift-interview]').isVisible(), true);
  assert((await page.locator('[data-shift-interview]').textContent()).includes(reviewed.boss.interview.say));
  await photo('05-shift-interview');
  await page.keyboard.press('Enter');
  await waitFor('进入次日', (s) => s.day === 4 && !s.shiftPaused, 3);
  console.log('日末停表、面谈显示和 Enter 续班通过');

  assert.deepEqual(errors, []);
  assert.deepEqual([...external], [], 'local MockBrain should not contact external services');
} catch (error) {
  const state = await read().catch(() => null);
  console.error('Last preview state', JSON.stringify(state && {
    time: state.time,
    player: state.player,
    boss: state.boss,
    shiftPaused: state.shiftPaused,
    fish: state.fish,
  }));
  throw error;
} finally {
  await browser.close();
}
