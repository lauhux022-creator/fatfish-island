import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createBrowserControls, createReviewPolicy } from './review-policy.mjs';

const url = new URL(process.env.GAME_URL ?? 'http://127.0.0.1:5173/fatfish-island/');
url.search = new URLSearchParams({ seed: 'm2-review', day: '3', debug: '1' }).toString();
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const snapshot = () => page.evaluate(() => window.fatfishDebug.snapshot());
const plan = createReviewPolicy();
const realtime = process.env.REVIEW_REALTIME === '1';
const controls = createBrowserControls(page);

function summarize(state) {
  return {
    seconds: Number(state.time.toFixed(2)),
    revenue: state.teamRevenue,
    target: state.teamTarget,
    fish: state.metrics,
    workers: state.players.map(({ id, name, shiftCash, shiftSold, metrics }) =>
      ({ id, name, cash: shiftCash, sold: shiftSold, ...metrics })),
  };
}

try {
  if (!realtime) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  if (realtime) {
    await page.waitForFunction(() => window.fatfishDebug?.snapshot().tick > 2);
  } else {
    for (let tries = 0; tries < 100; tries++) {
      if (await page.evaluate(() => window.fatfishDebug?.snapshot().tick > 2)) break;
      await page.clock.runFor(100);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(await page.locator('[data-debug]').isVisible(), true);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  let nextLog = 30;
  let state = await snapshot();
  const start = Date.now();
  // The original review measures only the daylight shift. The smoke test checks
  // ranking bonuses and fines after the night has finished.
  while (state.campaign.phase === 'day' && state.time < 241) {
    if (Date.now() - start > 12 * 60 * 1000) throw new Error('未能在 12 分钟内完成 240 模拟秒');
    await controls.apply(state, plan(state));
    if (realtime) {
      await page.waitForFunction((tick) => {
        const next = window.fatfishDebug.snapshot();
        return next.campaign.phase !== 'day' || next.tick >= tick + 5;
      }, state.tick, { timeout: 8000 });
    } else {
      await page.clock.runFor(100);
    }
    state = await snapshot();
    if (state.time >= nextLog) {
      console.log(JSON.stringify(summarize(state)));
      nextLog += 30;
    }
  }
  await controls.stop();
  assert.equal(state.day, 3);
  assert(state.time >= 240 && state.time < 241);
  assert.equal(state.campaign.phase, 'night');
  assert.equal(state.shiftPaused, false);
  console.log('M2.5 daylight shift', JSON.stringify(summarize(state)));
  assert(state.player.metrics.interference >= 4, '玩家实际被干扰至少 4 次');
  assert(state.metrics.fishIncidents >= 2, '至少 2 条不同的鱼逃跑或易手');
  assert(state.player.shiftSold >= 8 && state.player.shiftSold <= 12, '熟练玩家目标为 8–12 尾');
  assert(state.teamTarget / Math.max(1, state.teamRevenue) > 0.57 &&
    state.teamTarget / Math.max(1, state.teamRevenue) < 0.83, '团队指标应约为正常产出的七成');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
