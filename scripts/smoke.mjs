import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const screenshotDirectory = process.env.SCREENSHOT_DIR;
const expectedCommit = process.env.EXPECTED_COMMIT;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const remoteRequests = new Set();

page.on('pageerror', (error) => errors.push(error.message));
page.on('requestfailed', (request) => errors.push(`${request.failure()?.errorText}: ${request.url()}`));
page.on('request', (request) => {
  const url = new URL(request.url());
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== base.origin) remoteRequests.add(url.origin);
});

const waitFor = (predicate, arg, timeout = 15000) => page.waitForFunction(predicate, arg, { timeout });
const read = () => page.evaluate(() => window.fatfishDebug.snapshot());

async function photo(slug) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  for (let quality = 80; quality >= 35; quality -= 10) {
    const frame = await page.screenshot({
      type: 'jpeg',
      quality,
      style: '[data-debug] { visibility: hidden !important; }',
    });
    if (frame.length < 300_000) {
      await writeFile(join(screenshotDirectory, `m1-${slug}.jpg`), frame);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${slug}`);
}

async function openShift() {
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm1-review', day: '3', debug: '1' }).toString();
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  await waitFor(() => window.fatfishDebug?.snapshot().tick > 5);
  const state = await read();
  assert.equal(state.seed, 'm1-review');
  assert.equal(state.day, 3);
  assert.equal(state.sold, 0);
  assert.match(await page.title(), /大肥鱼的黑心渔场/);
  assert.equal(await page.locator('[data-debug]').isVisible(), true);
  if (expectedCommit) assert.match(await page.locator('[data-commit]').textContent(), new RegExp(expectedCommit));
}

async function aimAt(position) {
  const projected = await page.evaluate((point) => window.fatfishDebug.project(point), position);
  const { width, height } = page.viewportSize();
  assert(projected.x > 0 && projected.x < width && projected.y > 0 && projected.y < height,
    `Aim falls outside viewport: ${JSON.stringify({ position, projected })}`);
  await page.mouse.move(projected.x, projected.y);
}

async function castAt(position, target) {
  await aimAt(position);
  await page.mouse.down();
  await waitFor(() => window.fatfishDebug.snapshot().hook.charge >= 0.96);
  await page.mouse.up();
  await waitFor((type) => {
    const hook = window.fatfishDebug.snapshot().hook;
    return hook.phase === 'bite' && hook.target === type;
  }, target);
}

async function reel(onTap) {
  for (let tap = 0; tap < 8; tap++) {
    const before = await read();
    if (before.hook.phase === 'idle') return;
    await page.mouse.click(...await page.evaluate(() => {
      const s = window.fatfishDebug.snapshot();
      const p = window.fatfishDebug.project(s.hook.position);
      return [p.x, p.y];
    }));
    await waitFor((progress) => {
      const hook = window.fatfishDebug.snapshot().hook;
      return hook.phase === 'idle' || hook.progress > progress;
    }, before.hook.progress, 3500);
    if (onTap) await onTap(tap + 1);
  }
  assert.equal((await read()).hook.phase, 'idle');
}

async function moveUntil(key, predicate, arg) {
  await page.keyboard.down(key);
  try {
    await waitFor(predicate, arg, 6000);
  } finally {
    await page.keyboard.up(key);
  }
}

async function fishAndSell() {
  await openShift();
  await photo('01-shift');
  await castAt({ x: 0, y: -0.5, z: -8 }, 'fish');
  assert.equal((await read()).fish[0]?.kind, 'puffer');
  await photo('02-bite');
  await reel();
  assert.equal((await read()).fish[0]?.state, 'flopping');

  for (let hit = 0; hit < 3; hit++) {
    const state = await read();
    const fish = state.fish[0];
    assert(fish, 'fish got away before the paddle landed');
    if (fish.state === 'stunned') break;
    await aimAt({ ...fish.position, y: 0 });
    await page.keyboard.press('KeyF');
    await waitFor(() => window.fatfishDebug.snapshot().player.swing > 0);
    await waitFor(() => window.fatfishDebug.snapshot().player.swing === 0);
  }
  assert.equal((await read()).fish[0]?.state, 'stunned');
  await moveUntil('KeyW', () => {
    const { player, fish: [fish] } = window.fatfishDebug.snapshot();
    return fish && Math.hypot(player.position.x - fish.position.x, player.position.z - fish.position.z) < 1.5;
  });
  await page.keyboard.press('KeyE');
  await waitFor(() => Boolean(window.fatfishDebug.snapshot().player.carrying));

  await moveUntil('KeyD', (x) => window.fatfishDebug.snapshot().player.position.x >= x, 3.25);
  const scale = { x: 5.5, y: 0, z: 0.7 };
  await aimAt(scale);
  await page.keyboard.press('KeyE');
  await waitFor(() => window.fatfishDebug.snapshot().sold === 1);
  const result = await read();
  assert(result.cash >= 34);
  assert.match(await page.locator('.ledger [data-cash]').textContent(), new RegExp(String(result.cash)));
  await photo('03-sale');
  console.log(`鱼上钩 → 挥桨 → 搬运 → 实体抛进秤盘 · ¥${result.cash}`);
}

async function hookSupplyCrate() {
  await openShift();
  await castAt({ x: -3.3, y: -0.5, z: -6.1 }, 'crate');
  assert.equal((await read()).crates.find((crate) => crate.state === 'hooked')?.id, 'supply-crate');
  await reel(async (tap) => { if (tap === 3) await photo('04-crate'); });
  const crate = (await read()).crates.find((item) => item.id === 'supply-crate');
  assert.equal(crate?.state, 'loose');
  assert(crate.position.z > -4);
  console.log('海上木箱上钩 → 连点拖上岸');
}

async function tripOnCrate() {
  await openShift();
  await moveUntil('KeyW', () => window.fatfishDebug.snapshot().player.position.z < 1.55);
  await moveUntil('KeyA', () => window.fatfishDebug.snapshot().player.ragdoll > 1.5);
  const down = await read();
  assert.equal(down.player.parts.length, 6);
  if (screenshotDirectory) {
    await waitFor(() => window.fatfishDebug.snapshot().player.ragdoll < 1.25);
    await photo('05-ragdoll');
  }
  await waitFor(() => window.fatfishDebug.snapshot().player.ragdoll === 0);
  const recovered = await read();
  assert.equal(recovered.player.parts.length, 0);
  assert(recovered.tick >= down.tick + Math.round(down.player.ragdoll * 60));
  console.log('撞箱进入六节物理布娃娃 → 两秒恢复');
}

try {
  await fishAndSell();
  await hookSupplyCrate();
  await tripOnCrate();
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual([...remoteRequests], [], 'local mode requested an external service');
} catch (error) {
  console.error('Last game state:', JSON.stringify(await read().catch(() => null)));
  throw error;
} finally {
  await browser.close();
}
