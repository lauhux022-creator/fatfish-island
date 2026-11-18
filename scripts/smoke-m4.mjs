import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = new URL(process.env.GAME_URL || 'http://127.0.0.1:5173/fatfish-island/');
const roomPath = '/fatfish-island/rooms';
const pagesOnly = process.env.PAGES_ONLY === '1';
const shots = process.env.SCREENSHOT_DIR;
const readyTimeout = Number(process.env.BROWSER_READY_TIMEOUT_MS ?? 30_000);
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH,
  args: process.platform === 'darwin' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const clients = [];

const wait = (client, predicate, value, timeout = 20000) =>
  client.page.waitForFunction(predicate, value, { timeout });
const debug = (client) => client.page.evaluate(() => window.fatfishDebug.network());
const state = (client) => client.page.evaluate(() => window.fatfishDebug.snapshot());

async function makeDropRelay() {
  assert.equal(base.protocol, 'http:', 'The automatic-disconnect fixture runs against local HTTP/Vite');
  const connections = new Set();
  let blockedUntil = 0;
  const relay = createServer((downstream) => {
    if (performance.now() < blockedUntil) {
      downstream.destroy();
      return;
    }
    const upstream = connect({ host: base.hostname, port: Number(base.port || 80) });
    const pair = { upstream, downstream };
    const close = () => {
      connections.delete(pair);
      downstream.destroy();
      upstream.destroy();
    };
    connections.add(pair);
    upstream.on('close', close).on('error', close);
    downstream.on('close', close).on('error', close);
    downstream.pipe(upstream).pipe(downstream);
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  function drop(duration) {
    blockedUntil = performance.now() + duration;
    for (const { upstream, downstream } of connections) {
      upstream.destroy();
      downstream.destroy();
    }
  }
  return {
    url: `ws://127.0.0.1:${relay.address().port}${roomPath}`,
    drop,
    close: () => {
      drop(0);
      relay.close();
    },
  };
}

async function boot(name, { roleId = 'gpt', droppable = false, first = false } = {}) {
  const context = await browser.newContext({ viewport: first ? { width: 1280, height: 800 } : { width: 1000, height: 625 } });
  const page = await context.newPage();
  const client = { context, page, name, roleId, errors: [], frames: [], sent: [], connections: 0 };
  clients.push(client);
  page.on('pageerror', (err) => client.errors.push(err.message));
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== roomPath) return;
    client.connections += 1;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'snapshot') {
        client.frames.push({ tick: message.serverTick, at: performance.now() });
      }
    });
    socket.on('framesent', ({ payload }) => {
      const { type } = JSON.parse(String(payload));
      client.sent.push(type);
    });
  });
  if (droppable) client.relay = await makeDropRelay();
  const url = new URL(base);
  url.search = new URLSearchParams({ seed: 'm4-review', day: '3', debug: '1', role: roleId }).toString();
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: readyTimeout });
  assert.equal(response?.status(), 200);
  await wait(client, (roleId) => {
    const game = window.fatfishDebug;
    return game?.snapshot().tick > 2 && game.snapshot().player.roleId === roleId && game.network().mode === 'local';
  }, roleId, readyTimeout);
  if (process.env.EXPECTED_COMMIT) {
    assert.equal(await page.locator('[data-commit]').textContent(), process.env.EXPECTED_COMMIT);
  }
  assert.equal(client.connections, 0, 'local mode must not open a room socket');
  return client;
}

async function roomDialog(client) {
  await client.page.locator('[data-room-toggle]').click();
  assert(await client.page.locator('[data-room-dialog]').isVisible());
}

async function occupy(client, code) {
  await roomDialog(client);
  await client.page.locator('[data-room-name]').fill(client.name);
  await client.page.locator('[data-room-character]').selectOption(client.roleId);
  if (client.relay) {
    await client.page.locator('[data-room-address] summary').click();
    await client.page.locator('[data-room-endpoint]').fill(client.relay.url);
  }
  if (code) {
    await client.page.locator('[data-room-code-input]').fill(code);
    await client.page.locator('[data-room-join]').click();
  } else {
    await client.page.locator('[data-room-create]').click();
  }
}

async function playing(client) {
  await wait(client, () => {
    const net = window.fatfishDebug.network();
    return net.mode === 'playing' && net.serverTick > 0;
  });
  assert.equal(await client.page.locator('[data-room-dialog]').isVisible(), false);
  assert.equal((await state(client)).player.roleId, client.roleId);
  return debug(client);
}

async function observeHumans(client, humans) {
  await wait(client, (count) => window.fatfishDebug.snapshot().players.filter(({ bot }) => !bot).length === count, humans);
}

async function photo(client, slug) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  for (let quality = 80; quality >= 40; quality -= 10) {
    const frame = await client.page.screenshot({
      type: 'jpeg', quality, style: '[data-debug] { visibility: hidden !important; }',
    });
    if (frame.length < 300_000) {
      await writeFile(join(shots, `m4-${slug}.jpg`), frame);
      return;
    }
  }
  throw new Error(`Screenshot exceeds 300 KB: ${slug}`);
}

async function syncMovement(host, guest, owner) {
  const start = await state(host);
  const fromX = start.players.find(({ id }) => id === owner).position.x;
  await host.page.keyboard.down('KeyD');
  try {
    await wait(host, () => {
      const api = window.fatfishDebug;
      return api.network().predicted && api.displayed().player.position.x > api.snapshot().player.position.x + 0.015;
    });
    await wait(guest, ({ playerId, before }) => {
      const api = window.fatfishDebug;
      const remote = api.snapshot().players.find(({ id }) => id === playerId);
      const net = api.network();
      return remote.position.x > before + 0.55 && net.interpolationTick < net.serverTick;
    }, { playerId: owner, before: fromX });
  } finally {
    await host.page.keyboard.up('KeyD');
  }
  await wait(host, () => window.fatfishDebug.snapshot().player.speed < 0.4);
  const stationary = (await state(host)).player.position.x;
  await wait(guest, ({ playerId, want }) => {
    const visible = window.fatfishDebug.displayed().players.find(({ id }) => id === playerId);
    return Math.abs(visible.position.x - want) < 0.13;
  }, { playerId: owner, want: stationary });
  const net = await debug(host);
  assert(net.ack > 0, 'server must acknowledge processed seat input');
}

async function rate(client) {
  const deadline = performance.now() + 6000;
  while (client.frames.length < 34 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const samples = client.frames.slice(-32);
  assert(samples.length >= 24);
  const gap = samples.at(-1).tick - samples[0].tick;
  const elapsed = (samples.at(-1).at - samples[0].at) / 1000;
  const hertz = (samples.length - 1) / elapsed;
  assert(samples.slice(1).every(({ tick }, i) => tick - samples[i].tick === 3));
  assert(hertz > 17 && hertz < 23, `Expected 20Hz, got ${hertz.toFixed(2)}Hz over ${gap} server ticks`);
  return hertz;
}

async function verifyPages(host) {
  const view = await state(host);
  assert.equal(view.players.filter(({ bot }) => bot).length, 3);
  await wait(host, () => window.fatfishDebug.snapshot().boss.line?.trigger === 'shift_start');
  await roomDialog(host);
  const endpoint = host.page.locator('[data-room-endpoint]');
  if (base.protocol === 'https:') assert.equal(await endpoint.inputValue(), '');
  await host.page.locator('[data-room-dismiss]').click();
  await host.page.keyboard.down('KeyD');
  try {
    await wait(host, (x) => window.fatfishDebug.snapshot().player.position.x > x + 0.45, view.player.position.x);
  } finally {
    await host.page.keyboard.up('KeyD');
  }
  assert.equal(host.connections, 0);
  console.log('静态 Pages 本地移动、三名机器人、老板开工与房间入口通过，未连接房间服务');
}

async function bossChat(sender, host) {
  const last = (await state(host)).boss.line?.id;
  await sender.page.keyboard.press('KeyT');
  await sender.page.locator('[data-boss-input]').fill('收鱼能涨价吗');
  await sender.page.locator('[data-boss-send]').click();
  await wait(host, (id) => {
    const line = window.fatfishDebug.snapshot().boss.line;
    return line?.id !== id && line?.trigger === 'chat' && line?.action === 'price_change';
  }, last);
  const authority = await state(host);
  await wait(sender, ({ id, price }) => {
    const { boss } = window.fatfishDebug.snapshot();
    return boss.line?.id === id && boss.priceMultiplier === price;
  }, { id: authority.boss.line.id, price: authority.boss.priceMultiplier });
  assert(authority.boss.priceMultiplier > 1);
  await photo(sender, '05-boss-chat');
  console.log(`由访客递话，服务端统一裁决鱼价 ×${authority.boss.priceMultiplier}`);
}

try {
  const host = await boot('阿浪', { first: true });
  if (pagesOnly) {
    await verifyPages(host);
  } else {
    await occupy(host);
    const hostRoom = await playing(host);
    assert.match(hostRoom.code, /^\d{4}$/);
    assert.equal((await state(host)).players.filter(({ bot }) => bot).length, 3);
    const hz = await rate(host);

    const guest = await boot('黑豆', { roleId: 'claude', droppable: true });
    await occupy(guest, hostRoom.code);
    const guestRoom = await playing(guest);
    assert.notEqual(guestRoom.playerId, hostRoom.playerId);
    await observeHumans(host, 2);
    await observeHumans(guest, 2);
    await roomDialog(host);
    assert.equal(await host.page.locator('[data-room-display-code]').textContent(), hostRoom.code);
    await photo(host, '01-room-code');
    await host.page.locator('[data-room-dismiss]').click();
    await syncMovement(host, guest, hostRoom.playerId);
    await photo(host, '02-two-workers');
    console.log(`四位房间码、2 人 + 2 机器人、独立视角与输入回执，实测 ${hz.toFixed(2)} Hz`);

    const [third, fourth] = await Promise.all([boot('泥巴', { roleId: 'grok' }), boot('小锚', { roleId: 'kimi' })]);
    await occupy(third, hostRoom.code);
    const thirdRoom = await playing(third);
    await observeHumans(host, 3);
    assert.equal((await state(host)).players.filter(({ bot }) => bot).length, 1);
    await occupy(fourth, hostRoom.code);
    const fourthRoom = await playing(fourth);
    const rest = [thirdRoom, fourthRoom];
    await Promise.all([host, guest, third, fourth].map((client) => observeHumans(client, 4)));
    assert.equal(new Set([hostRoom.playerId, guestRoom.playerId, ...rest.map(({ playerId }) => playerId)]).size, 4);
    await photo(host, '03-four-workers');

    const extra = await boot('候补', { roleId: guest.roleId });
    await occupy(extra, hostRoom.code);
    await wait(extra, () => Boolean(window.fatfishDebug.network().error));
    assert.equal((await debug(extra)).mode, 'local');
    assert.match(await extra.page.locator('[data-room-feedback]').textContent(), /满/);
    await extra.page.locator('[data-room-dismiss]').click();
    await bossChat(guest, host);

    const cdp = await guest.context.newCDPSession(guest.page);
    const freezeAt = (await debug(host)).serverTick;
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    try {
      await wait(host, (tick) => window.fatfishDebug.network().serverTick >= tick + 60, freezeAt);
    } finally {
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await cdp.detach();
    }
    const foreground = (await debug(host)).serverTick;
    await wait(guest, (tick) => {
      const net = window.fatfishDebug.network();
      return net.serverTick >= tick && net.serverTick - net.interpolationTick < 9;
    }, foreground);

    guest.relay.drop(1400);
    await wait(host, (id) => window.fatfishDebug.snapshot().players.find((player) => player.id === id)?.bot, guestRoom.playerId);
    await wait(guest, () => window.fatfishDebug.network().mode === 'spectating', null, 30000);
    const spectator = await debug(guest);
    assert.equal(spectator.playerId, null);
    assert.equal(spectator.focusId, guestRoom.playerId);
    assert.equal(spectator.code, hostRoom.code);
    assert(guest.connections >= 2);
    const sentBefore = guest.sent.filter((type) => type === 'input').length;
    await guest.page.keyboard.down('KeyW');
    await guest.page.keyboard.press('KeyF');
    for (let n = 0; n < 4; n++) await guest.page.waitForTimeout(90);
    await guest.page.keyboard.up('KeyW');
    assert.equal(guest.sent.filter((type) => type === 'input').length, sentBefore);
    await photo(guest, '04-reconnected-spectator');

    await occupy(extra, hostRoom.code);
    const replacement = await playing(extra);
    assert.equal(replacement.playerId, guestRoom.playerId);
    await observeHumans(host, 4);
    assert.equal((await debug(guest)).mode, 'spectating');
    await roomDialog(guest);
    await guest.page.locator('[data-room-leave]').click();
    await wait(guest, () => window.fatfishDebug.network().mode === 'local');
    console.log('4 人满房、切回页面追上权威快照、断线补位、自动重连观战与空位重新加入均通过');
  }
  for (const client of clients) assert.deepEqual(client.errors, [], `page errors: ${client.name}`);
} finally {
  for (const client of clients) client.relay?.close();
  await browser.close();
}
