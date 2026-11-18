import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const photos = process.env.SCREENSHOT_DIR;
const pagesOnly = process.env.PAGES_ONLY === '1';
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

function snapshot(page) {
  return page.evaluate(() => window.fatfishDebug.snapshot());
}

function wait(page, predicate, value, timeout = 20_000) {
  return page.waitForFunction(predicate, value, { timeout });
}

async function shot(page, suffix) {
  if (!photos) return;
  await mkdir(photos, { recursive: true });
  for (const quality of [80, 70, 60, 50]) {
    const frame = await page.screenshot({
      type: 'jpeg', quality, style: '[data-debug] { visibility: hidden !important; }',
    });
    if (frame.length < 300_000) {
      await writeFile(join(photos, `m4.5-${suffix}.jpg`), frame);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${suffix}`);
}

async function boot({ role = 'gpt', day = 3, seconds = 30 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  const models = [];
  let rooms = 0;
  page.on('request', (request) => {
    const asset = new URL(request.url()).pathname.split('/').at(-1);
    const model = /^(feiyu|claude|gpt|grok|kimi)([-.]|$)/.exec(asset);
    if (model && asset.endsWith('.glb')) models.push(model[1]);
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.endsWith('/rooms')) rooms++;
  });
  const url = new URL(base);
  url.search = new URLSearchParams({ debug: '1', seed: 'm4.5-crew', day, role, shiftSeconds: seconds });
  const started = performance.now();
  const response = await page.goto(url.href, { waitUntil: 'commit', timeout: 30_000 });
  assert.equal(response?.status(), 200);
  await wait(page, (role) => {
    const local = window.fatfishDebug?.snapshot();
    return local?.tick > 2 && local.player.roleId === role;
  }, role, 25_000);
  const ready = (performance.now() - started) / 1000;
  if (process.env.CHECK_STARTUP === '1') assert(ready < 5, `Startup took ${ready.toFixed(2)}s`);
  assert.equal(rooms, 0, 'local preview must not connect to a room');
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  return { page, context, models, ready };
}

async function waitForCast(page) {
  await wait(page, () => {
    const model = document.querySelector('canvas');
    const have = new Set(model?.dataset.loadedRoles?.split(','));
    return model?.dataset.bossModel === 'feiyu' && ['claude', 'gpt', 'grok', 'kimi'].every((id) => have.has(id));
  }, null, 45_000);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

async function paddleFriend(page) {
  for (let attempt = 0; attempt < 27; attempt++) {
    const { players, player, tick } = await snapshot(page);
    const target = players.filter(({ id, ragdoll }) => id !== player.id && !ragdoll)
      .sort((a, b) => distance(a.position, player.position) - distance(b.position, player.position))[0];
    if (!target || player.ragdoll) {
      await wait(page, (tick) => window.fatfishDebug.snapshot().tick >= tick + 12, tick);
      continue;
    }
    if (distance(target.position, player.position) < 1.75) {
      const point = await page.evaluate((position) =>
        window.fatfishDebug.project(position), target.position);
      await page.mouse.move(point.x, point.y);
      await page.keyboard.press('KeyF');
      await wait(page, () => window.fatfishDebug.snapshot().players.some(
        ({ bot, ragdoll, animation }) => bot && ragdoll > 1.5 && animation === 'fall'), null, 3000);
      return;
    }
    const keys = [];
    const dx = target.position.x - player.position.x;
    const dz = target.position.z - player.position.z;
    if (Math.abs(dx) > 0.5) keys.push(dx < 0 ? 'KeyA' : 'KeyD');
    if (Math.abs(dz) > 0.5) keys.push(dz < 0 ? 'KeyW' : 'KeyS');
    for (const key of keys) await page.keyboard.down(key);
    try {
      await wait(page, (tick) => window.fatfishDebug.snapshot().tick >= tick + 10, tick);
    } finally {
      for (const key of keys) await page.keyboard.up(key);
    }
  }
  throw new Error('Could not approach a teammate and verify paddle ragdoll');
}

async function local() {
  const { page, context, models, ready } = await boot();
  assert.equal(await page.locator('[data-version]').textContent(), '0.4.5');
  await waitForCast(page);
  assert.deepEqual(new Set(models.slice(0, 2)), new Set(['feiyu', 'gpt']));
  await wait(page, () => {
    const bust = document.querySelector('img[data-boss-portrait]');
    return bust?.naturalWidth > 0;
  });
  console.log(`可操作 ${ready.toFixed(2)} 秒，首批模型 ${models.slice(0, 2).join(' + ')}，四名角色及老板加载成功。`);
  if (pagesOnly) {
    await page.keyboard.down('KeyD');
    try {
      await wait(page, () => window.fatfishDebug.snapshot().player.position.x > 0.6);
    } finally {
      await page.keyboard.up('KeyD');
    }
    return context.close();
  }

  await shot(page, '01-boss');
  await page.locator('[data-role-toggle]').click();
  await page.locator('label').filter({ has: page.locator('[name="role"][value="grok"]') }).click();
  await page.locator('[data-local-role-form] button[type=submit]').click();
  await wait(page, () => window.fatfishDebug?.snapshot().player.roleId === 'grok');
  await waitForCast(page);
  const crew = (await snapshot(page)).players;
  assert.deepEqual(new Set(crew.map(({ roleId }) => roleId)), new Set(['claude', 'gpt', 'grok', 'kimi']));
  await shot(page, '02-crew');
  await paddleFriend(page);
  await wait(page, () => window.fatfishDebug.snapshot().players.some(
    ({ bot, ragdoll }) => bot && ragdoll > 1.1 && ragdoll < 1.75));
  await shot(page, '03-paddle');
  await wait(page, () => window.fatfishDebug.snapshot().shiftPaused, null, 45_000);
  await wait(page, () => window.fatfishDebug.snapshot().boss.interview?.trigger === 'shift_end');
  await wait(page, () => [...document.querySelectorAll('.shift-interview img')].every(
    (image) => !image.hidden && image.naturalWidth > 0));
  assert.match(await page.locator('[data-interview-winner-name]').textContent(), /榜首/);
  assert.match(await page.locator('[data-interview-last-name]').textContent(), /末位/);
  await shot(page, '04-interview');
  console.log('角色选择、四个不同角色、物理倒地及面谈三幅立绘通过。');
  await context.close();
}

async function lobby(page, role, code) {
  await page.locator('[data-room-toggle]').click();
  await page.locator('[data-room-character]').selectOption(role);
  if (code) await page.locator('[data-room-code-input]').fill(code);
  await page.locator(code ? '[data-room-join]' : '[data-room-create]').click();
}

async function rooms() {
  const [host, guest] = await Promise.all([boot({ seconds: 90 }), boot({ seconds: 90 })]);
  await lobby(host.page, 'kimi');
  await wait(host.page, () => window.fatfishDebug.network().mode === 'playing');
  const { code } = await host.page.evaluate(() => window.fatfishDebug.network());
  assert.equal((await snapshot(host.page)).player.roleId, 'kimi');
  await lobby(guest.page, 'kimi', code);
  await wait(guest.page, () => window.fatfishDebug.network().error);
  assert.match(await guest.page.locator('[data-room-feedback]').textContent(), /角色|工位/);
  await guest.page.locator('[data-room-character]').selectOption('claude');
  await guest.page.locator('[data-room-join]').click();
  await wait(guest.page, () => window.fatfishDebug.network().mode === 'playing');
  assert.equal((await snapshot(guest.page)).player.roleId, 'claude');
  await wait(host.page, () => window.fatfishDebug.snapshot().players.some(({ roleId, bot }) => roleId === 'claude' && !bot));
  console.log('联机建房与加房可选身份，重复角色被拒绝，两个客户端看到同一角色分配。');
  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  await local();
  if (!pagesOnly) await rooms();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
