import type { DailyOrderView } from './orders';
import type { CampaignPace } from './pace';
import type { Vec3 } from './types';

export const BUILD_KINDS = ['fence', 'trap', 'lure'] as const;
export type BuildKind = typeof BUILD_KINDS[number];
export type CampaignPhase = 'day' | 'night' | 'boss' | 'cleared';

export interface StructureView {
  id: string;
  kind: BuildKind;
  position: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
}

export interface EnemyView {
  id: string;
  kind: 'raider' | 'crab';
  position: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  state: 'advance' | 'windup' | 'recover';
  attack?: { position: Vec3; radius: number };
}

export interface WarehouseView {
  position: Vec3;
  stock: number;
  value: number;
  lostFish: number;
  lostValue: number;
}

export interface CampaignCycle {
  firstDay: number;
  lastDay: number;
  secured: number;
  target: number;
}

export interface CampaignCycleResult {
  day: number;
  secured: number;
  target: number;
  passed: boolean;
  eaten: { id: string; name: string } | null;
}

export interface CampaignView {
  pace: CampaignPace;
  phase: CampaignPhase;
  remaining: number;
  wood: number;
  structures: StructureView[];
  enemies: EnemyView[];
  warehouse: WarehouseView;
  cycle: CampaignCycle;
  lastCycle: CampaignCycleResult | null;
  order: DailyOrderView;
  reviveCost: number;
}
