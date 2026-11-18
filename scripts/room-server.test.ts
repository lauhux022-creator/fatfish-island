import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import WebSocket from 'ws';
import { attachRoomServer } from '../server/rooms';
import { DeepSeekBrain } from '../server/fish-brain';
import { readRoomMessage } from '../server/room-wire';
import {
  ROOM_SOCKET_PATH, type RoomClientMessage, type RoomServerMessage, type RoomSnapshotMessage,
} from '../shared/net/types';
import { MockBrain } from '../shared/fish-brain/mock';
import { FISHING, ISLAND } from '../shared/sim/config';
import { SALVAGE } from '../shared/sim/salvage';
import { emptyInput, type SimInput, type SimSnapshot, type Vec3 } from '../shared/sim/types';

interface Peer {
  socket: WebSocket;
  messages: RoomServerMessage[];
  send(message: RoomClientMessage): void;
}

async function roomFixture(options?: Parameters<typeof attachRoomServer>[1]) {
  const server = createServer();
  const authority = attachRoomServer(server, options);
  const sockets: WebSocket[] = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    async open(): Promise<Peer> {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${ROOM_SOCKET_PATH}`);
      const messages: RoomServerMessage[] = [];
      sockets.push(socket);
      socket.on('message', (event) => messages.push(JSON.parse(event.toString())));
      await once(socket, 'open');
      return { socket, messages, send: (message: RoomClientMessage) => socket.send(JSON.stringify(message)) };
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      authority.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isWelcome = (message: RoomServerMessage): message is Extract<RoomServerMessage, { type: 'welcome' }> =>
  message.type === 'welcome';

async function find<T extends RoomServerMessage>(peer: Peer,
  predicate: (message: RoomServerMessage) => message is T, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = peer.messages.find(predicate);
    if (result) return result;
    await setTimeout(20);
  } while (performance.now() < deadline);
  throw new Error('Expected packet was not received');
}

function waitForState(peer: Peer, predicate: (state: SimSnapshot) => boolean, timeoutMs = 4000) {
  return find(peer, (message): message is RoomSnapshotMessage => message.type === 'snapshot' && predicate(message.state), timeoutMs);
}

test('room input accepts only shop item IDs and preserves the requested item', () => {
  for (const buy of ['rod', 'pan', 'bait'] as const) {
    const packet = readRoomMessage(JSON.stringify({ type: 'input', seq: 1, input: { ...emptyInput, buy } }));
    assert.equal(packet?.type, 'input');
    assert.equal(packet.input.buy, buy);
  }
  for (const buy of ['unlisted', ['rod', 'pan'], null]) {
    assert.equal(readRoomMessage(JSON.stringify({ type: 'input', seq: 1, input: { ...emptyInput, buy } })), null);
  }
});

test('only room creation accepts a whitelisted pace, alongside independent debug durations', () => {
  for (const pace of ['quick', 'classic'] as const) {
    const create = readRoomMessage(JSON.stringify({ type: 'create', name: '阿浪', pace, shiftSeconds: 12, nightSeconds: 8 }));
    assert.equal(create?.type, 'create');
    assert.equal(create.pace, pace);
    assert.equal(create.shiftSeconds, 12);
    assert.equal(create.nightSeconds, 8);
  }
  for (const pace of ['unknown', ['quick'], null]) {
    assert.equal(readRoomMessage(JSON.stringify({ type: 'create', name: '阿浪', pace })), null);
  }
  const join = readRoomMessage(JSON.stringify({ type: 'join', code: '4523', name: '黑豆', pace: 'classic' }));
  assert.equal(join?.type, 'join');
  assert(!Object.hasOwn(join, 'pace'));
});

test('room authority seats players, serves one shared DeepSeek decision, and resumes spectators', { timeout: 12000 }, async () => {
  let modelCalls = 0;
  const { open, close } = await roomFixture({
    createBrain: () => new DeepSeekBrain('test-fixture', 'fixture-model', async () => {
      modelCalls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        say: '今天的账，已经记好了。',
        emotion: 'smug',
        action: 'none',
        target: null,
        amount: 0,
      }) } }] });
    }),
  });
  try {
    const host = await open();
    host.send({ type: 'create', name: '阿浪', roleId: 'grok', seed: 'authority-fixture', day: 3, pace: 'quick' });
    const created = await find(host, isWelcome);
    assert.match(created.code, /^\d{4}$/);
    assert.equal(created.brain, 'deepseek');
    assert.equal(created.role, 'player');
    const quickStart = await find(host, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.serverTick === 0);
    assert.equal(quickStart.state.campaign.pace, 'quick');
    assert.equal(quickStart.state.campaign.remaining, 90);
    const opening = await find(host, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.state.boss.line?.say === '今天的账，已经记好了。');
    assert.equal(opening.state.player.roleId, 'grok');
    assert.deepEqual(new Set(opening.state.players.map(({ roleId }) => roleId)), new Set(['claude', 'gpt', 'grok', 'kimi']));
    assert.equal(modelCalls, 1);

    const guest = await open();
    guest.send({ type: 'join', code: created.code, name: '黑豆', roleId: 'grok' });
    await find(guest, (message): message is Extract<RoomServerMessage, { type: 'error' }> =>
      message.type === 'error' && message.code === 'character_taken');
    guest.socket.send(JSON.stringify({ type: 'join', code: created.code, name: '黑豆', roleId: 'kimi', pace: 'classic' }));
    const joined = await find(guest, isWelcome);
    assert.notEqual(joined.playerId, created.playerId);
    const initial = await find(guest, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.state.players.filter(({ bot }) => !bot).length === 2);
    const guestStart = initial.state.players.find(({ id }) => id === joined.playerId)!;
    assert.equal(initial.state.campaign.pace, 'quick');
    assert(Math.abs(initial.state.campaign.remaining + initial.state.time - 90) < 1e-9);
    assert.equal(guestStart.roleId, 'kimi');
    assert.equal(guestStart.name, '黑豆');
    guest.send({ type: 'input', seq: 1, input: { ...emptyInput, moveZ: 1 } });
    const moved = await find(guest, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.ack === 1 &&
      (message.state.players.find(({ id }) => id === joined.playerId)?.position.z ?? 0) > guestStart.position.z + 0.25);
    await find(host, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.serverTick === moved.serverTick &&
      message.state.players.find(({ id }) => id === joined.playerId)?.position.z ===
        moved.state.players.find(({ id }) => id === joined.playerId)?.position.z);
    assert(guest.messages.filter((message) => message.type === 'snapshot').slice(1)
      .every((message, n, snapshots) => n === 0 || message.serverTick - snapshots[n - 1].serverTick === 3));

    guest.socket.close();
    await once(guest.socket, 'close');
    await find(host, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.serverTick > moved.serverTick &&
      message.state.players.some(({ id, bot, roleId, name }) => id === joined.playerId && bot && roleId === 'kimi' && name === 'Kimi'));

    const observer = await open();
    observer.send({ type: 'resume', code: joined.code, token: joined.token });
    const resumed = await find(observer, isWelcome);
    assert.equal(resumed.role, 'spectator');
    assert.equal(resumed.playerId, null);
    assert.equal(resumed.focusId, joined.playerId);
    observer.send({ type: 'input', seq: 1, input: { ...emptyInput, moveZ: 1 } });
    await find(observer, (message): message is Extract<RoomServerMessage, { type: 'error' }> =>
      message.type === 'error' && message.code === 'forbidden');

    const classic = await open();
    classic.send({ type: 'create', name: '老船长', pace: 'classic' });
    const classicStart = await find(classic, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.serverTick === 0);
    assert.equal(classicStart.state.campaign.pace, 'classic');
    assert.equal(classicStart.state.campaign.remaining, 240);
  } finally {
    await close();
  }
});

function worker(snapshot: SimSnapshot, id: string) {
  const entry = snapshot.players.find((player) => player.id === id);
  assert(entry);
  return entry;
}

function controls(peer: Peer, id: string) {
  let seq = 0;
  async function input(changes: Partial<SimInput> = {}) {
    const next = ++seq;
    peer.send({ type: 'input', seq: next, input: { ...emptyInput, ...changes } });
    return (await find(peer, (message): message is RoomSnapshotMessage => message.type === 'snapshot' && message.ack >= next)).state;
  }
  async function walk(to: Pick<Vec3, 'x' | 'z'>) {
    let state = await input();
    const until = state.time + 8;
    while (state.time < until) {
      const { position, grounded } = worker(state, id);
      const x = to.x - position.x;
      const z = to.z - position.z;
      const gap = Math.hypot(x, z);
      if (gap < 0.32 && grounded) return input();
      const speed = Math.max(0.6, gap);
      state = await input({ moveX: x / speed, moveZ: z / speed });
    }
    assert.fail(`Seat ${id} could not reach (${to.x}, ${to.z})`);
  }
  return { input, walk };
}

test('two WebSocket players hand off a salvage crate and the guest alone receives the bucket', { timeout: 90000 }, async (t) => {
  const { open, close } = await roomFixture({ createBrain: () => new MockBrain() });
  t.after(close);
  const host = await open();
  host.send({ type: 'create', name: '钩箱人', roleId: 'gpt', seed: 'm11-salvage', shiftSeconds: 48 });
  const created = await find(host, isWelcome);
  const guest = await open();
  guest.send({ type: 'join', name: '投秤人', roleId: 'claude', code: created.code });
  const joined = await find(guest, isWelcome);
  const hostId = created.playerId;
  const guestId = joined.playerId;
  assert(hostId && guestId && hostId !== guestId);
  assert.equal(created.role, 'player');
  assert.equal(joined.role, 'player');
  const angler = controls(host, hostId);
  const courier = controls(guest, guestId);
  const id = 'salvage-1';

  await Promise.all([
    courier.walk({ x: -6.15, z: -0.65 }),
    (async () => {
      await angler.walk({ x: 0, z: -2.5 });
      await angler.walk({ x: -7.35, z: -2.5 });
      await angler.walk({ x: -7.35, z: -1.6 });
    })(),
  ]);
  const floating = (await waitForState(host, ({ crates }) => crates.some((box) => box.id === id && box.salvage), 22000)).state;
  assert.equal(floating.players.filter(({ bot }) => !bot).length, 2);
  assert(floating.time >= SALVAGE.spawnSeconds);
  const aim = floating.crates.find((box) => box.id === id)!.position;
  const hold = { aim, castHeld: true };
  let charged = await angler.input({ ...hold, castPressed: true });
  for (let frame = 0; frame < 30 && worker(charged, hostId).hook.charge < 0.72; frame++) charged = await angler.input(hold);
  assert(worker(charged, hostId).hook.charge >= 0.72);
  await angler.input({ aim, castReleased: true });
  const hooked = (state: SimSnapshot) => worker(state, hostId).hook.targetId === id;
  await Promise.all([waitForState(host, hooked), waitForState(guest, hooked)]);
  for (let tap = 0; tap < FISHING.crateTaps; tap++) await angler.input({ castPressed: true });

  const landed = (await waitForState(guest, ({ crates }) => crates.some((box) => box.id === id && box.state === 'loose'))).state;
  const crate = landed.crates.find((box) => box.id === id)!;
  const approached = await courier.walk({ x: crate.position.x + 0.95, z: crate.position.z + 0.8 });
  const resting = approached.crates.find((box) => box.id === id)!;
  const holding = await courier.input({ aim: resting.position, interactPressed: true });
  assert.equal(worker(holding, guestId).carrying, id);
  assert.equal(worker(holding, hostId).carrying, null);
  await courier.walk({ x: 0, z: -2.5 });
  const atScale = await courier.walk({ x: 3.2, z: 1.75 });
  assert.equal(worker(atScale, guestId).carrying, id);
  assert(atScale.players.every(({ equipment }) => !equipment.popper));
  await courier.input({ aim: ISLAND.scale, interactPressed: true });

  const paid = (state: SimSnapshot) => state.tick > atScale.tick && !state.crates.some((box) => box.id === id)
    && worker(state, guestId).equipment.popper;
  const receipts = await Promise.all([waitForState(host, paid, 6000), waitForState(guest, paid, 6000)]);
  for (const { state } of receipts) {
    assert.equal(worker(state, guestId).carrying, null);
    assert.equal(worker(state, guestId).bot, false);
    assert.equal(worker(state, hostId).bot, false);
    assert(!worker(state, hostId).equipment.popper);
    assert.deepEqual(state.players.filter(({ equipment }) => equipment.popper).map(({ id }) => id), [guestId]);
    assert.equal(worker(state, guestId).cash, worker(atScale, guestId).cash);
    assert.equal(worker(state, guestId).shiftSold, worker(atScale, guestId).shiftSold);
  }
  t.diagnostic(`Both clients confirmed the guest's reward at ${receipts[0].state.time.toFixed(2)}s.`);
});
