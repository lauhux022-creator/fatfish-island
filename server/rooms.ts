import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { FishBrain } from '../shared/fish-brain/types';
import {
  ROOM_SNAPSHOT_HZ, ROOM_SOCKET_PATH, type RoomBrain, type RoomClientMessage, type RoomErrorCode,
  type RoomServerMessage,
} from '../shared/net/types';
import { createSimulation } from '../shared/sim';
import { CREW, TICKS_PER_SECOND } from '../shared/sim/config';
import { emptyInput, type SimInput } from '../shared/sim/types';
import { createOnlineFishBrain, DeepSeekBrain } from './fish-brain';
import { isRoomOriginAllowed, readRoomMessage } from './room-wire';

const STEP_MS = 1000 / TICKS_PER_SECOND;
const SNAPSHOT_INTERVAL = TICKS_PER_SECOND / ROOM_SNAPSHOT_HZ;
const EMPTY_ROOM_MS = 120_000;
const INPUT_IDLE_MS = 400;
const HEARTBEAT_MS = 10_000;
const HANDSHAKE_MS = 10_000;
const MAX_QUEUE = 12;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_ROOMS = 24;
const MAX_CONNECTIONS = 160;
const MAX_SPECTATORS = 8;
const MAX_TICKETS = 64;

type SeatId = typeof CREW[number]['id'];
type Simulation = Awaited<ReturnType<typeof createSimulation>>;
type InputMessage = Extract<RoomClientMessage, { type: 'input' }>;

interface Ticket {
  token: string;
  focusId: SeatId;
  peer: Peer | null;
}

interface Room {
  code: string;
  brain: RoomBrain;
  sim: Simulation;
  serverTick: number;
  peers: Set<Peer>;
  tickets: Map<string, Ticket>;
  emptySince: number | null;
}

interface Peer {
  socket: WebSocket;
  room: Room | null;
  seat: SeatId | null;
  ticket: Ticket | null;
  creating: boolean;
  alive: boolean;
  queue: InputMessage[];
  latestSeq: number;
  ack: number;
  held: SimInput;
  lastInputAt: number;
}

interface RoomOptions {
  origins?: readonly string[];
  createBrain?: () => FishBrain;
}

const errors: Record<RoomErrorCode, string> = {
  invalid: '这张工牌不对，检查房间码再试。',
  not_found: '没找到这间渔场，房间可能已经关门。',
  full: '渔场满员了，等一个工位空出来再试。',
  unavailable: '渔场暂时开不了门，稍后再试。',
  active_session: '原来的工牌还在打卡，等它断开再重连。',
  forbidden: '观战工牌不能操作船员。',
};

function send(peer: Peer, message: RoomServerMessage) {
  if (peer.socket.readyState !== WebSocket.OPEN) return;
  if (peer.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    peer.socket.terminate();
    return;
  }
  peer.socket.send(JSON.stringify(message));
}

function error(peer: Peer, code: RoomErrorCode) {
  send(peer, { type: 'error', code, message: errors[code] });
}

function nextInput(peer: Peer, now: number): SimInput {
  const message = peer.queue.shift();
  if (message) {
    const { moveX, moveZ, aim, castHeld } = message.input;
    peer.held = { ...emptyInput, moveX, moveZ, aim, castHeld };
    peer.ack = message.seq;
    return message.input;
  }
  if (now - peer.lastInputAt > INPUT_IDLE_MS) {
    // A lost input stream behaves like releasing held controls once.
    const released = { ...emptyInput, castReleased: peer.held.castHeld, aim: peer.held.aim };
    peer.held = emptyInput;
    return released;
  }
  return peer.held;
}

export function attachRoomServer(
  httpServer: Server,
  { origins = [], createBrain = createOnlineFishBrain }: RoomOptions = {},
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const rooms = new Map<string, Room>();
  const reserved = new Set<string>();
  const clients = new Map<WebSocket, Peer>();
  let closed = false;

  function disconnect(peer: Peer, forget = false) {
    const { room, seat, ticket } = peer;
    if (!room || !ticket) return;
    room.peers.delete(peer);
    if (seat) room.sim.setSeat(seat, null);
    ticket.peer = null;
    room.tickets.delete(ticket.token);
    if (!forget) room.tickets.set(ticket.token, ticket);
    peer.room = null;
    peer.seat = null;
    peer.ticket = null;
    peer.queue.length = 0;
    if (!room.peers.size) room.emptySince = performance.now();
  }

  function attach(peer: Peer, room: Room, seat: SeatId | null, ticket: Ticket) {
    peer.room = room;
    peer.seat = seat;
    peer.ticket = ticket;
    ticket.peer = peer;
    room.peers.add(peer);
    room.emptySince = null;
    send(peer, {
      type: 'welcome',
      code: room.code,
      token: ticket.token,
      role: seat ? 'player' : 'spectator',
      playerId: seat,
      focusId: ticket.focusId,
      brain: room.brain,
    });
    send(peer, { type: 'snapshot', serverTick: room.serverTick, ack: peer.ack, state: room.sim.snapshot() });
  }

  function join(peer: Peer, room: Room, name: string) {
    const occupied = new Set([...room.peers].map(({ seat }) => seat));
    const seatIndex = CREW.findIndex(({ id }) => !occupied.has(id));
    if (seatIndex < 0) return error(peer, 'full');
    const id = CREW[seatIndex].id;
    if (room.tickets.size >= MAX_TICKETS) {
      const expired = [...room.tickets.values()].find(({ peer: current }) => !current);
      if (expired) room.tickets.delete(expired.token);
    }
    const ticket = { token: randomBytes(18).toString('base64url'), focusId: id, peer };
    room.tickets.set(ticket.token, ticket);
    room.sim.setSeat(id, name || `工友 ${seatIndex + 1}`);
    attach(peer, room, id, ticket);
  }

  function resume(peer: Peer, room: Room, token: string) {
    const ticket = room.tickets.get(token);
    if (!ticket) return error(peer, 'not_found');
    if (ticket.peer) return error(peer, 'active_session');
    if ([...room.peers].filter(({ seat }) => !seat).length >= MAX_SPECTATORS) return error(peer, 'full');
    attach(peer, room, null, ticket);
  }

  async function create(peer: Peer, message: Extract<RoomClientMessage, { type: 'create' }>) {
    if (rooms.size + reserved.size >= MAX_ROOMS) return error(peer, 'unavailable');
    let code = '';
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = String(randomInt(10_000)).padStart(4, '0');
      if (!rooms.has(candidate) && !reserved.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) return error(peer, 'unavailable');
    reserved.add(code);
    peer.creating = true;
    try {
      const brain = createBrain();
      const sim = await createSimulation({
        seed: message.seed ?? randomBytes(8).toString('hex'),
        day: message.day,
        shiftSeconds: message.shiftSeconds,
        brain,
      });
      if (closed || peer.socket.readyState !== WebSocket.OPEN) {
        sim.dispose();
        return;
      }
      const room: Room = {
        code,
        brain: brain instanceof DeepSeekBrain ? 'deepseek' : 'mock',
        sim,
        serverTick: 0,
        peers: new Set(),
        tickets: new Map(),
        emptySince: null,
      };
      rooms.set(code, room);
      join(peer, room, message.name);
    } catch {
      error(peer, 'unavailable');
    } finally {
      reserved.delete(code);
      peer.creating = false;
    }
  }

  function dispatch(peer: Peer, message: RoomClientMessage) {
    if (message.type === 'leave') {
      disconnect(peer, true);
      peer.socket.close(1000, 'Room left');
      return;
    }
    if (message.type === 'input') {
      if (!peer.seat) return error(peer, 'forbidden');
      if (message.seq <= peer.latestSeq || peer.queue.length >= MAX_QUEUE) return;
      peer.latestSeq = message.seq;
      peer.lastInputAt = performance.now();
      peer.queue.push(message);
      return;
    }
    if (peer.room || peer.creating) return error(peer, 'active_session');
    if (message.type === 'create') {
      void create(peer, message);
      return;
    }
    const room = rooms.get(message.code);
    if (!room) return error(peer, 'not_found');
    if (message.type === 'join') join(peer, room, message.name);
    else resume(peer, room, message.token);
  }

  wss.on('connection', (socket) => {
    const peer: Peer = {
      socket, room: null, seat: null, ticket: null, creating: false, alive: true,
      queue: [], latestSeq: 0, ack: 0, held: emptyInput, lastInputAt: performance.now(),
    };
    clients.set(socket, peer);
    const handshake = setTimeout(() => {
      if (!peer.room) socket.close(1008, 'Room handshake timeout');
    }, HANDSHAKE_MS);
    handshake.unref();
    socket.on('message', (raw, isBinary) => {
      const message = isBinary ? null : readRoomMessage(raw.toString());
      if (message) dispatch(peer, message);
      else error(peer, 'invalid');
    });
    socket.on('pong', () => { peer.alive = true; });
    socket.on('error', () => { socket.terminate(); });
    socket.on('close', () => {
      clearTimeout(handshake);
      disconnect(peer);
      clients.delete(socket);
    });
  });

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (request.url?.split('?')[0] !== ROOM_SOCKET_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (clients.size >= MAX_CONNECTIONS || !isRoomOriginAllowed(request, origins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  }
  httpServer.on('upgrade', upgrade);

  let last = performance.now();
  let accumulated = 0;
  const stepTimer = setInterval(() => {
    const now = performance.now();
    accumulated += Math.min(now - last, STEP_MS * 6);
    last = now;
    while (accumulated >= STEP_MS) {
      for (const [code, room] of rooms) {
        if (room.emptySince !== null) {
          if (now - room.emptySince > EMPTY_ROOM_MS) {
            room.sim.dispose();
            rooms.delete(code);
          }
          continue;
        }
        const inputs: Record<string, SimInput> = {};
        for (const peer of room.peers) {
          if (peer.seat) inputs[peer.seat] = nextInput(peer, now);
        }
        room.sim.step(emptyInput, inputs);
        room.serverTick += 1;
        if (room.serverTick % SNAPSHOT_INTERVAL) continue;
        const state = room.sim.snapshot();
        for (const peer of room.peers) {
          send(peer, { type: 'snapshot', serverTick: room.serverTick, ack: peer.ack, state });
        }
      }
      accumulated -= STEP_MS;
    }
  }, STEP_MS / 2);
  stepTimer.unref();

  const heartbeat = setInterval(() => {
    for (const peer of clients.values()) {
      if (!peer.alive) peer.socket.terminate();
      else if (peer.socket.readyState === WebSocket.OPEN) {
        peer.alive = false;
        peer.socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    if (closed) return;
    closed = true;
    httpServer.off('upgrade', upgrade);
    clearInterval(stepTimer);
    clearInterval(heartbeat);
    for (const peer of clients.values()) {
      disconnect(peer, true);
      peer.socket.terminate();
    }
    for (const room of rooms.values()) room.sim.dispose();
    rooms.clear();
    wss.close();
  }

  httpServer.once('close', close);
  return { close };
}
