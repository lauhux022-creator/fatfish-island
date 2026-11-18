import type { IncomingMessage } from 'node:http';
import { ROOM_CODE_PATTERN, ROOM_MAX_NAME, type RoomClientMessage } from '../shared/net/types';
import { BUILD_KINDS, type BuildKind } from '../shared/sim/campaign-types';
import { isWorkerRoleId } from '../shared/sim/cast';
import { CAMPAIGN, PLAY, SHIFT } from '../shared/sim/config';
import { isShopItemId } from '../shared/sim/shop';
import type { SimInput } from '../shared/sim/types';

const TOKEN_PATTERN = /^[\w-]{24}$/;
const INPUT_FLAGS = [
  'castHeld', 'castPressed', 'castReleased', 'swingPressed', 'interactPressed', 'jumpPressed', 'continuePressed', 'revivePressed',
] as const;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, limit: number) {
  return Math.min(limit, Math.max(-limit, value));
}

function normalize(value: string, limit: number) {
  return [...value.replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim()].slice(0, limit).join('');
}

function parseInput(value: unknown): SimInput | null {
  if (!record(value) || !finite(value.moveX) || !finite(value.moveZ)) return null;
  const aim = value.aim;
  if (aim !== null && (!record(aim) || !finite(aim.x) || !finite(aim.z))) return null;
  if (INPUT_FLAGS.some((flag) => value[flag] !== undefined && typeof value[flag] !== 'boolean')) return null;
  if (value.build !== undefined && !BUILD_KINDS.includes(value.build as BuildKind)) return null;
  const buy = value.buy;
  if (buy !== undefined && !isShopItemId(buy)) return null;
  if (value.chat !== undefined && typeof value.chat !== 'string') return null;
  const input: SimInput = {
    moveX: clamp(value.moveX, 1),
    moveZ: clamp(value.moveZ, 1),
    aim: aim === null ? null : { x: clamp(Number(aim.x), 100), z: clamp(Number(aim.z), 100) },
    castHeld: value.castHeld === true,
    castPressed: value.castPressed === true,
    castReleased: value.castReleased === true,
    swingPressed: value.swingPressed === true,
    interactPressed: value.interactPressed === true,
    jumpPressed: value.jumpPressed === true,
    continuePressed: value.continuePressed === true,
    revivePressed: value.revivePressed === true,
    build: value.build as BuildKind | undefined,
    buy,
  };
  if (typeof value.chat === 'string') input.chat = normalize(value.chat, 120);
  return input;
}

export function readRoomMessage(data: string): RoomClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!record(value)) return null;
  switch (value.type) {
    case 'create': {
      if (typeof value.name !== 'string') return null;
      if (value.roleId !== undefined && !isWorkerRoleId(value.roleId)) return null;
      if (value.seed !== undefined && typeof value.seed !== 'string') return null;
      if (value.day !== undefined && !Number.isSafeInteger(value.day)) return null;
      if (value.shiftSeconds !== undefined && !finite(value.shiftSeconds)) return null;
      if (value.nightSeconds !== undefined && !finite(value.nightSeconds)) return null;
      const seed = typeof value.seed === 'string' ? normalize(value.seed, 80) : undefined;
      return {
        type: 'create',
        name: normalize(value.name, ROOM_MAX_NAME),
        roleId: value.roleId,
        seed: seed || undefined,
        day: value.day === undefined ? undefined : Math.max(1, Math.min(999, Number(value.day))),
        shiftSeconds: value.shiftSeconds === undefined ? undefined
          : Math.max(SHIFT.shortestSeconds, Math.min(PLAY.daySeconds, Number(value.shiftSeconds))),
        nightSeconds: value.nightSeconds === undefined ? undefined
          : Math.max(CAMPAIGN.nightMinimumSeconds, Math.min(CAMPAIGN.nightSeconds, Number(value.nightSeconds))),
      };
    }
    case 'join':
      if (typeof value.code !== 'string' || !ROOM_CODE_PATTERN.test(value.code) || typeof value.name !== 'string') return null;
      if (value.roleId !== undefined && !isWorkerRoleId(value.roleId)) return null;
      return { type: 'join', code: value.code, name: normalize(value.name, ROOM_MAX_NAME), roleId: value.roleId };
    case 'resume':
      if (typeof value.code !== 'string' || !ROOM_CODE_PATTERN.test(value.code)
        || typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) return null;
      return { type: 'resume', code: value.code, token: value.token };
    case 'input': {
      if (!finite(value.seq) || !Number.isSafeInteger(value.seq) || value.seq <= 0) return null;
      const input = parseInput(value.input);
      return input && { type: 'input', seq: value.seq, input };
    }
    case 'leave':
      return { type: 'leave' };
    default:
      return null;
  }
}

export function isRoomOriginAllowed(request: IncomingMessage, allowed: readonly string[]) {
  const { origin, host } = request.headers;
  if (origin === undefined) return true;
  try {
    const source = new URL(origin);
    if (source.origin !== origin || !['http:', 'https:'].includes(source.protocol)) return false;
    if (allowed.includes(source.origin)) return true;
    if (!host) return false;
    const destination = new URL(`http://${host}`);
    return source.hostname === destination.hostname
      || (loopback.has(source.hostname) && loopback.has(destination.hostname));
  } catch {
    return false;
  }
}
