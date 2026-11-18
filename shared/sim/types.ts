import type { FishBrainOutput, FishTrigger } from '../fish-brain/types';
import type { BuildKind, CampaignView } from './campaign-types';
import type { WorkerAnimation, WorkerRoleId } from './cast';
import type { PopperView } from './popper';
import type { ShopEquipment, ShopItemId } from './shop';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rotation extends Vec3 {
  w: number;
}

export interface Pose {
  position: Vec3;
  rotation: Rotation;
}

export const emptyInput = {
  moveX: 0,
  moveZ: 0,
  aim: null,
  castHeld: false,
  castPressed: false,
  castReleased: false,
  swingPressed: false,
  interactPressed: false,
  jumpPressed: false,
} satisfies SimInput;

export interface SimInput {
  moveX: number;
  moveZ: number;
  aim: { x: number; z: number } | null;
  castHeld: boolean;
  castPressed: boolean;
  castReleased: boolean;
  swingPressed: boolean;
  interactPressed: boolean;
  jumpPressed: boolean;
  build?: BuildKind;
  buy?: ShopItemId;
  popperPressed?: boolean;
  revivePressed?: boolean;
  continuePressed?: boolean;
  chat?: string;
}

export type RagdollLimb = 'torso' | 'head' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export interface RagdollPart extends Pose {
  limb: RagdollLimb;
}

export interface PlayerMetrics {
  interference: number;
  paddleHits: number;
  popperHits: number;
  fishStolen: number;
  knockdowns: number;
  fishEscaped: number;
  fishIncidents: number;
}

export interface ShiftMetrics {
  fishEscaped: number;
  fishTransferred: number;
  /** Distinct fish that either escaped or changed hands. */
  fishIncidents: number;
}

export interface PlayerView extends Pose {
  id: string;
  roleId: WorkerRoleId;
  animation: WorkerAnimation;
  velocity: Vec3;
  name: string;
  bot: boolean;
  cash: number;
  equipment: ShopEquipment;
  shopOpen: boolean;
  popperCooldown: number;
  sold: number;
  shiftCash: number;
  shiftSold: number;
  favor: number;
  memory: string;
  giftedBait: boolean;
  metrics: PlayerMetrics;
  optimization: boolean;
  ghost: boolean;
  revivePaid: number;
  /** ID of the teammate who hooked or launched this worker. */
  baitedBy: string | null;
  hook: HookView;
  yaw: number;
  speed: number;
  grounded: boolean;
  /** Swing animation time remaining, normalized to [0, 1]. */
  swing: number;
  /** Ragdoll time remaining in seconds. */
  ragdoll: number;
  parts: RagdollPart[];
  carrying: string | null;
  /** Heavy fish awaiting a second grip. The first worker is not carrying it yet. */
  lifting: string | null;
}

export type HookPhase = 'idle' | 'charging' | 'flying' | 'waiting' | 'bite' | 'reeling' | 'bait';

export interface HookView {
  phase: HookPhase;
  position: Vec3 | null;
  charge: number;
  progress: number;
  target: 'fish' | 'crate' | 'player' | null;
  targetId: string | null;
}

export type FishKind = 'sardine' | 'puffer' | 'grouper';
export type FishState = 'swimming' | 'hooked' | 'flopping' | 'escaping' | 'stunned' | 'carried' | 'thrown';

export interface FishView extends Pose {
  id: string;
  kind: FishKind;
  heavy: boolean;
  state: FishState;
  multiplier: number;
  baitMultiplier: number;
  airCatchMultiplier: number;
  popCatchUntil: number | null;
  caughtBy: string;
  lastTouch: string | null;
  stealReady: boolean;
  carrierId: string | null;
  helperId: string | null;
  liftClaimId: string | null;
  liftClaimAt: number | null;
  baitPlayerId: string | null;
}

export interface CrateView extends Pose {
  id: string;
  state: 'floating' | 'hooked' | 'loose' | 'carried' | 'thrown';
  salvage: boolean;
}

export interface SimNotice {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
  cue?: 'fish_escape' | 'fish_hit' | 'water_fall' | 'air_catch';
}

export interface ShiftEntry {
  id: string;
  roleId: WorkerRoleId;
  name: string;
  bot: boolean;
  rank: number;
  revenue: number;
  sold: number;
  bonus: number;
  fine: number;
  optimization: boolean;
}

export interface ShiftResult {
  day: number;
  ranking: ShiftEntry[];
}

export interface BossLine extends FishBrainOutput {
  id: number;
  trigger: FishTrigger;
  day: number;
  effect?: string;
}

export interface BossView {
  line: BossLine | null;
  interview: BossLine | null;
  pending: boolean;
  cooldownSeconds: number;
  calls: number;
  favor: number;
  memory: string;
  priceMultiplier: number;
}

export interface SimSnapshot {
  tick: number;
  time: number;
  day: number;
  seed: string;
  player: PlayerView;
  players: PlayerView[];
  shiftRemaining: number;
  shiftPaused: boolean;
  teamRevenue: number;
  teamTarget: number;
  metrics: ShiftMetrics;
  result: ShiftResult | null;
  campaign: CampaignView;
  boss: BossView;
  hook: HookView;
  fish: FishView[];
  poppers: PopperView[];
  crates: CrateView[];
  cash: number;
  sold: number;
  notice: SimNotice | null;
  notices: Readonly<Partial<Record<string, SimNotice>>>;
}
