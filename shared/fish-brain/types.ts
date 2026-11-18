import type { WorkerRoleId } from '../sim/cast';

export const FISH_ACTIONS = [
  'none', 'bonus', 'fine', 'set_kpi', 'price_change', 'spawn_event', 'gift_item', 'eat_player',
] as const;

export const FISH_EMOTIONS = ['calm', 'happy', 'annoyed', 'smug', 'surprised', 'cry', 'sleep'] as const;

export type FishAction = typeof FISH_ACTIONS[number];
export type FishEmotion = typeof FISH_EMOTIONS[number];
export type FishTrigger = 'shift_start' | 'sale' | 'chat' | 'death' | 'shift_end';

export interface FishEvent {
  trigger: FishTrigger;
  day: number;
  time: number;
  actorId: string | null;
  relatedId?: string;
  summary: string;
  amount?: number;
}

export interface FishObservedEvent extends Omit<FishEvent, 'trigger'> {
  trigger: FishTrigger | 'theft' | 'friendly_hit';
}

export interface FishChat {
  authorId: string;
  text: string;
}

export interface FishPlayerContext {
  id: string;
  name: string;
  roleId?: WorkerRoleId;
  cash: number;
  shiftCash: number;
  shiftSold: number;
  favor: number;
  memory: string;
}

export interface FishBrainInput {
  event: FishEvent;
  recentEvents: FishObservedEvent[];
  players: FishPlayerContext[];
  message: FishChat | null;
  teamTarget: number;
  teamRevenue: number;
  priceMultiplier: number;
}

export interface FishBrainOutput {
  say: string;
  emotion: FishEmotion;
  action: FishAction;
  target: string | null;
  amount: number;
}

export interface FishBrain {
  respond(input: FishBrainInput): FishBrainOutput | Promise<FishBrainOutput>;
}
