import type { SimInput, SimSnapshot } from '../sim/types.ts';
import type { WorkerRoleId } from '../sim/cast.ts';

export const ROOM_SOCKET_PATH = '/fatfish-island/rooms';
export const ROOM_SNAPSHOT_HZ = 20;
export const ROOM_CODE_PATTERN = /^\d{4}$/;
export const ROOM_MAX_NAME = 12;

export type RoomBrain = 'mock' | 'deepseek';
export type RoomErrorCode = 'invalid' | 'not_found' | 'full' | 'character_taken' | 'unavailable' | 'active_session' | 'forbidden';

export type RoomClientMessage =
  | {
    type: 'create'; name: string; roleId?: WorkerRoleId; seed?: string; day?: number;
    shiftSeconds?: number; nightSeconds?: number;
  }
  | { type: 'join'; code: string; name: string; roleId?: WorkerRoleId }
  | { type: 'resume'; code: string; token: string }
  | { type: 'input'; seq: number; input: SimInput }
  | { type: 'leave' };

export interface RoomWelcome {
  type: 'welcome';
  code: string;
  token: string;
  role: 'player' | 'spectator';
  playerId: string | null;
  focusId: string;
  brain: RoomBrain;
}

export interface RoomSnapshotMessage {
  type: 'snapshot';
  serverTick: number;
  ack: number;
  state: SimSnapshot;
}

export interface RoomError {
  type: 'error';
  code: RoomErrorCode;
  message: string;
}

export type RoomServerMessage = RoomWelcome | RoomSnapshotMessage | RoomError;
