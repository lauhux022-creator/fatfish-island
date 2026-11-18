import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket from 'ws';
import { attachRoomServer } from '../server/rooms';
import { DeepSeekBrain } from '../server/fish-brain';
import {
  ROOM_SOCKET_PATH, type RoomClientMessage, type RoomServerMessage, type RoomSnapshotMessage,
} from '../shared/net/types';
import { emptyInput } from '../shared/sim/types';

test('room authority seats players, serves one shared DeepSeek decision, and resumes spectators', { timeout: 12000 }, async () => {
  let modelCalls = 0;
  const server = createServer();
  const authority = attachRoomServer(server, {
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
  const sockets: WebSocket[] = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');

  async function open() {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${ROOM_SOCKET_PATH}`);
    const messages: RoomServerMessage[] = [];
    sockets.push(socket);
    socket.on('message', (event) => messages.push(JSON.parse(event.toString())));
    await once(socket, 'open');
    return {
      socket,
      messages,
      send: (message: RoomClientMessage) => socket.send(JSON.stringify(message)),
    };
  }

  type Peer = Awaited<ReturnType<typeof open>>;
  async function find<T extends RoomServerMessage>(
    peer: Peer,
    predicate: (message: RoomServerMessage) => message is T,
  ) {
    for (let tries = 0; tries < 130; tries++) {
      const result = peer.messages.find(predicate);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Expected packet was not received');
  }
  const isWelcome = (message: RoomServerMessage): message is Extract<RoomServerMessage, { type: 'welcome' }> =>
    message.type === 'welcome';

  try {
    const host = await open();
    host.send({ type: 'create', name: '阿浪', seed: 'authority-fixture', day: 3 });
    const created = await find(host, isWelcome);
    assert.match(created.code, /^\d{4}$/);
    assert.equal(created.brain, 'deepseek');
    assert.equal(created.role, 'player');
    await find(host, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.state.boss.line?.say === '今天的账，已经记好了。');
    assert.equal(modelCalls, 1);

    const guest = await open();
    guest.send({ type: 'join', code: created.code, name: '黑豆' });
    const joined = await find(guest, isWelcome);
    assert.notEqual(joined.playerId, created.playerId);
    const initial = await find(guest, (message): message is RoomSnapshotMessage =>
      message.type === 'snapshot' && message.state.players.filter(({ bot }) => !bot).length === 2);
    const guestStart = initial.state.players.find(({ id }) => id === joined.playerId)!;
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
      message.state.players.find(({ id }) => id === joined.playerId)?.bot === true);

    const observer = await open();
    observer.send({ type: 'resume', code: joined.code, token: joined.token });
    const resumed = await find(observer, isWelcome);
    assert.equal(resumed.role, 'spectator');
    assert.equal(resumed.playerId, null);
    assert.equal(resumed.focusId, joined.playerId);
    observer.send({ type: 'input', seq: 1, input: { ...emptyInput, moveZ: 1 } });
    await find(observer, (message): message is Extract<RoomServerMessage, { type: 'error' }> =>
      message.type === 'error' && message.code === 'forbidden');
  } finally {
    for (const socket of sockets) socket.terminate();
    authority.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
