import {
  ROOM_CODE_PATTERN, ROOM_MAX_NAME, ROOM_SNAPSHOT_HZ,
  type RoomBrain, type RoomClientMessage, type RoomServerMessage, type RoomSnapshotMessage, type RoomWelcome,
} from '../../shared/net/types';
import { STEP_SECONDS } from '../../shared/sim/config';
import { predictPlayerMovement } from '../../shared/sim/prediction';
import { emptyInput, type PlayerView, type SimInput, type SimSnapshot } from '../../shared/sim/types';
import { interpolateRoom, selectPerspective } from './interpolation';

const storageKey = 'fatfish:room:v1';
const stepMs = STEP_SECONDS * 1000;
const playoutDelayMs = 2 * 1000 / ROOM_SNAPSHOT_HZ;
const bufferLimit = 12;
const inputLimit = 32;
const gapMs = 300;
const connectTimeoutMs = 7000;
const retryWindowMs = 70_000;
const correctionMs = 105;

export interface RoomConnectIntent {
  url: string;
  name: string;
  code?: string;
}

export interface RoomClientStatus {
  mode: 'local' | 'connecting' | 'playing' | 'reconnecting' | 'spectating';
  code: string | null;
  playerId: string | null;
  focusId: string | null;
  brain: RoomBrain | null;
  error: string | null;
  humans: number;
}

export interface RoomDebugState extends RoomClientStatus {
  serverTick: number | null;
  ack: number;
  snapshotCount: number;
  interpolationTick: number | null;
  bufferedSnapshots: number;
  pendingInputs: number;
  lastReceivedAt: number | null;
  predicted: boolean;
}

interface ResumeSession {
  url: string;
  code: string;
  token: string;
}

interface ClientOptions {
  seed?: string;
  day?: number;
  shiftSeconds?: number;
  onStatus: (status: RoomClientStatus) => void;
}

interface BufferedSnapshot {
  tick: number;
  state: SimSnapshot;
}

const localStatus: RoomClientStatus = {
  mode: 'local', code: null, playerId: null, focusId: null, brain: null, error: null, humans: 0,
};

function endpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    if (url.username || url.password || url.hash || (location.protocol === 'https:' && url.protocol !== 'wss:')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function readSession(): ResumeSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    const saved = raw && JSON.parse(raw);
    if (!saved || typeof saved.url !== 'string' || !endpoint(saved.url) || typeof saved.code !== 'string'
      || !ROOM_CODE_PATTERN.test(saved.code) || typeof saved.token !== 'string' || !saved.token.length
      || saved.token.length > 192) return null;
    return { url: saved.url, code: saved.code, token: saved.token };
  } catch {
    return null;
  }
}

function persist(session: ResumeSession | null) {
  try {
    if (session) sessionStorage.setItem(storageKey, JSON.stringify(session));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Network play still works in memory when storage is disabled.
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numbers(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function vector(value: unknown, quaternion = false) {
  return record(value) && numbers(value, quaternion ? ['x', 'y', 'z', 'w'] : ['x', 'y', 'z']);
}

function pose(value: unknown): value is Record<string, unknown> {
  return record(value) && vector(value.position) && vector(value.rotation, true);
}

function snapshotShape(value: unknown): value is SimSnapshot {
  if (!record(value) || !numbers(value, ['tick', 'day', 'time', 'shiftRemaining', 'teamRevenue', 'teamTarget'])
    || !record(value.notices) || !record(value.boss) || !numbers(value.boss, ['cooldownSeconds', 'priceMultiplier'])
    || !record(value.metrics) || !Array.isArray(value.players) || value.players.length !== 4
    || !Array.isArray(value.fish) || !Array.isArray(value.crates)) return false;
  return value.players.every((player: unknown) =>
    pose(player) && typeof player.id === 'string' && typeof player.name === 'string' && typeof player.bot === 'boolean'
    && numbers(player, ['yaw', 'speed', 'ragdoll', 'cash', 'sold', 'shiftCash', 'shiftSold', 'favor'])
    && vector(player.velocity) && record(player.metrics) && Array.isArray(player.parts) && player.parts.every(pose)
    && record(player.hook) && numbers(player.hook, ['charge', 'progress'])
    && (player.hook.position === null || vector(player.hook.position)))
    && value.fish.every(pose) && value.crates.every(pose);
}

function parseMessage(raw: unknown): RoomServerMessage | null {
  if (typeof raw !== 'string' || raw.length > 256_000) return null;
  try {
    const message: unknown = JSON.parse(raw);
    if (!record(message)) return null;
    switch (message.type) {
      case 'welcome':
        return typeof message.code === 'string' && ROOM_CODE_PATTERN.test(message.code)
          && typeof message.token === 'string' && message.token.length > 0 && message.token.length <= 192
          && (message.role === 'player' ? typeof message.playerId === 'string' : message.role === 'spectator' && message.playerId === null)
          && typeof message.focusId === 'string' && (message.brain === 'mock' || message.brain === 'deepseek')
          ? message as unknown as RoomWelcome : null;
      case 'snapshot':
        return typeof message.serverTick === 'number' && Number.isSafeInteger(message.serverTick) && message.serverTick >= 0
          && typeof message.ack === 'number' && Number.isSafeInteger(message.ack) && message.ack >= 0
          && snapshotShape(message.state)
          ? { type: 'snapshot', serverTick: message.serverTick, ack: message.ack, state: message.state } : null;
      case 'error':
        return typeof message.code === 'string' && typeof message.message === 'string'
          ? message as unknown as RoomServerMessage : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function shouldPredict(player: PlayerView, state: SimSnapshot) {
  return !state.shiftPaused && !player.ragdoll && !player.baitedBy;
}

function limitPrediction(guess: PlayerView, origin: PlayerView) {
  const lead = Math.hypot(guess.position.x - origin.position.x, guess.position.z - origin.position.z);
  return lead <= 2 ? guess : origin;
}

export function createRoomClient(options: ClientOptions) {
  let state = { ...localStatus };
  let socket: WebSocket | null = null;
  let session: ResumeSession | null = null;
  let retryTimer = 0;
  let handshakeTimer = 0;
  let retrySince = 0;
  let retries = 0;
  let lastReceivedAt: number | null = null;
  let snapshotCount = 0;
  let ack = 0;
  let seq = 0;
  let pendingInputs: { seq: number; input: SimInput }[] = [];
  let prediction: PlayerView | null = null;
  let correction: { x: number; z: number; at: number } | null = null;
  let lastDisplayedOwn: PlayerView | null = null;
  let clockOrigin = 0;
  let interpolationTick: number | null = null;
  let authority: SimSnapshot | null = null;
  let lastHeld = false;
  const buffer: BufferedSnapshot[] = [];

  function publish(next: RoomClientStatus) {
    state = next;
    options.onStatus(state);
  }

  function update(change: Partial<RoomClientStatus>) {
    const next = { ...state, ...change };
    if (Object.keys(change).some((key) => state[key as keyof RoomClientStatus] !== next[key as keyof RoomClientStatus])) {
      publish(next);
    }
  }

  function stopSocket(leaveRoom: boolean) {
    clearTimeout(retryTimer);
    clearTimeout(handshakeTimer);
    const old = socket;
    socket = null;
    if (!old) return;
    if (leaveRoom && old.readyState === WebSocket.OPEN) old.send(JSON.stringify({ type: 'leave' }));
    if (old.readyState <= WebSocket.OPEN) old.close();
  }

  function resetStream() {
    buffer.length = 0;
    lastReceivedAt = null;
    interpolationTick = null;
    ack = 0;
    seq = 0;
    pendingInputs = [];
    prediction = null;
    correction = null;
    lastDisplayedOwn = null;
    lastHeld = false;
  }

  function returnLocal(error: string | null = null) {
    stopSocket(true);
    resetStream();
    authority = null;
    snapshotCount = 0;
    retries = 0;
    retrySince = 0;
    session = null;
    persist(null);
    publish({ ...localStatus, error });
  }

  function reconnect() {
    if (!session) {
      returnLocal('房间连接中断，请重试。');
      return;
    }
    if (!retrySince) retrySince = Date.now();
    if (Date.now() - retrySince >= retryWindowMs) {
      returnLocal('重连超时，已回到本地试玩。');
      return;
    }
    update({ mode: 'reconnecting', playerId: null, error: null });
    const delay = Math.min(5000, 450 * 2 ** Math.min(retries++, 5));
    retryTimer = window.setTimeout(() => {
      if (session) open(session.url, { type: 'resume', code: session.code, token: session.token });
    }, delay);
  }

  function onSnapshot(message: RoomSnapshotMessage) {
    if (!state.focusId || (state.mode !== 'playing' && state.mode !== 'spectating')) return;
    const now = performance.now();
    const previous = buffer.at(-1);
    if (previous && message.serverTick <= previous.tick) return;
    if (!message.state.players.some(({ id }) => id === state.focusId)) return;

    if (!previous || lastReceivedAt === null || now - lastReceivedAt > gapMs
      || message.serverTick - previous.tick > 18 || previous.state.day !== message.state.day) {
      buffer.length = 0;
      interpolationTick = message.serverTick;
      clockOrigin = now - message.serverTick * stepMs;
      correction = null;
      lastDisplayedOwn = null;
    } else {
      // Use fast arrivals as the baseline, adapting slowly to sustained extra latency.
      const observed = now - message.serverTick * stepMs;
      clockOrigin += Math.min(1.5, Math.max(-12, (observed - clockOrigin) * 0.20));
    }
    buffer.push({ tick: message.serverTick, state: message.state });
    if (buffer.length > bufferLimit) buffer.shift();
    lastReceivedAt = now;
    snapshotCount += 1;
    ack = Math.max(ack, message.ack);
    pendingInputs = pendingInputs.filter((entry) => entry.seq > ack);
    authority = selectPerspective(message.state, state.focusId, state.playerId);
    const owner = authority.player;
    const predictive = state.mode === 'playing' && shouldPredict(owner, authority);
    prediction = predictive
      ? limitPrediction(pendingInputs.reduce((worker, { input }) => predictPlayerMovement(worker, input), owner), owner)
      : null;
    const visual = lastDisplayedOwn;
    if (prediction && visual && shouldPredict(visual, authority)) {
      const x = visual.position.x - prediction.position.x;
      const z = visual.position.z - prediction.position.z;
      correction = Math.hypot(x, z) < 0.95 ? { x, z, at: now } : null;
    } else correction = null;
    update({ humans: message.state.players.filter((player) => !player.bot).length });
  }

  function open(url: string, message: RoomClientMessage) {
    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      returnLocal('无法连接该地址，请检查房间服务。');
      return;
    }
    socket = current;
    handshakeTimer = window.setTimeout(() => {
      if (socket === current) current.close();
    }, connectTimeoutMs);
    current.addEventListener('open', () => {
      if (socket === current) current.send(JSON.stringify(message));
    });
    current.addEventListener('message', ({ data }) => {
      if (socket !== current) return;
      const reply = parseMessage(data);
      if (!reply) {
        returnLocal('房间服务器返回了无法识别的数据。');
        return;
      }
      if (reply.type === 'error') {
        if (message.type === 'resume' && reply.code === 'active_session') {
          // The previous socket may not have reached the server's close handler yet.
          stopSocket(false);
          reconnect();
        } else returnLocal(reply.message.slice(0, 150));
      } else if (reply.type === 'welcome' && (state.mode === 'connecting' || state.mode === 'reconnecting')) {
        clearTimeout(handshakeTimer);
        resetStream();
        retrySince = 0;
        retries = 0;
        session = { url, code: reply.code, token: reply.token };
        persist(session);
        update({
          mode: reply.role === 'player' ? 'playing' : 'spectating',
          code: reply.code, playerId: reply.playerId, focusId: reply.focusId, brain: reply.brain, error: null,
        });
      } else if (reply.type === 'snapshot') onSnapshot(reply);
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      socket = null;
      clearTimeout(handshakeTimer);
      resetStream();
      reconnect();
    });
  }

  function connect(intent: RoomConnectIntent) {
    const url = endpoint(intent.url.trim());
    if (!url) {
      update({ error: location.protocol === 'https:' ? '请输入 wss:// 房间服务地址。' : '请输入 ws:// 或 wss:// 房间服务地址。' });
      return;
    }
    const code = intent.code?.trim() ?? '';
    if (intent.code !== undefined && !ROOM_CODE_PATTERN.test(code)) {
      update({ error: '房间码需要 4 位数字。' });
      return;
    }
    const name = [...intent.name.trim()].slice(0, ROOM_MAX_NAME).join('');
    returnLocal();
    update({ mode: 'connecting', code: code || null });
    open(url, code
      ? { type: 'join', code, name }
      : { type: 'create', name, seed: options.seed, day: options.day, shiftSeconds: options.shiftSeconds });
  }

  function restore() {
    const saved = readSession();
    if (!saved) return;
    session = saved;
    retrySince = Date.now();
    update({ mode: 'reconnecting', code: saved.code });
    open(saved.url, { type: 'resume', code: saved.code, token: saved.token });
  }

  function step(input: SimInput) {
    if (state.mode !== 'playing' || !socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 24_000) return;
    const next = { ...input, aim: input.aim && { ...input.aim } };
    seq += 1;
    socket.send(JSON.stringify({ type: 'input', seq, input: next }));
    lastHeld = input.castHeld;
    pendingInputs.push({ seq, input: next });
    if (pendingInputs.length > inputLimit) pendingInputs.shift();
    if (authority && lastReceivedAt !== null && performance.now() - lastReceivedAt <= gapMs
      && shouldPredict(authority.player, authority)) {
      const origin = prediction ?? authority.player;
      prediction = limitPrediction(predictPlayerMovement(origin, next), authority.player);
    }
  }

  function visibilityChanged() {
    if (document.hidden && lastHeld) step({ ...emptyInput, castReleased: true });
    else if (document.hidden) step(emptyInput);
    const latest = buffer.at(-1);
    if (latest) {
      buffer.splice(0, buffer.length, latest);
      interpolationTick = latest.tick;
      clockOrigin = performance.now() - latest.tick * stepMs;
    }
    correction = null;
    lastDisplayedOwn = null;
    prediction = null;
  }

  function present(now: number): SimSnapshot | null {
    const latest = buffer.at(-1);
    if (!latest || !authority || !state.focusId || state.mode === 'reconnecting') return authority;
    const earliest = buffer[0];
    const wanted = Math.min(latest.tick, Math.max(
      earliest.tick, interpolationTick ?? 0, (now - clockOrigin - playoutDelayMs) / stepMs,
    ));
    interpolationTick = wanted;
    const afterIndex = buffer.findIndex((entry) => entry.tick >= wanted);
    const after = buffer[afterIndex] ?? latest;
    const before = buffer[Math.max(0, afterIndex - 1)] ?? after;
    const amount = after.tick === before.tick ? 1 : (wanted - before.tick) / (after.tick - before.tick);
    let frame = interpolateRoom(latest.state, before.state, after.state, amount, state.playerId);
    if (state.mode === 'playing' && prediction && state.playerId) {
      const guessed = prediction;
      const remaining = correction ? Math.max(0, 1 - (now - correction.at) / correctionMs) : 0;
      const corrected = correction && remaining > 0 ? {
        ...guessed,
        position: {
          ...guessed.position,
          x: guessed.position.x + correction.x * remaining,
          z: guessed.position.z + correction.z * remaining,
        },
      } : guessed;
      lastDisplayedOwn = corrected;
      frame = { ...frame, players: frame.players.map((player) => player.id === state.playerId ? corrected : player) };
    } else lastDisplayedOwn = null;
    return selectPerspective(frame, state.focusId, state.playerId);
  }

  return {
    connect, restore, step, present, visibilityChanged,
    leave: () => returnLocal(),
    dispose: () => stopSocket(false),
    status: () => state,
    authoritative: () => authority,
    debug: (): RoomDebugState => ({
      ...state, serverTick: buffer.at(-1)?.tick ?? null, ack, snapshotCount, interpolationTick,
      bufferedSnapshots: buffer.length, pendingInputs: pendingInputs.length, lastReceivedAt,
      predicted: prediction !== null,
    }),
  };
}
