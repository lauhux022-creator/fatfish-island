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
}

export type RagdollLimb = 'torso' | 'head' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export interface RagdollPart extends Pose {
  limb: RagdollLimb;
}

export interface PlayerView extends Pose {
  id: string;
  name: string;
  bot: boolean;
  cash: number;
  sold: number;
  shiftCash: number;
  shiftSold: number;
  optimization: boolean;
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
export type FishState = 'swimming' | 'hooked' | 'flopping' | 'stunned' | 'carried' | 'thrown';

export interface FishView extends Pose {
  id: string;
  kind: FishKind;
  state: FishState;
  multiplier: number;
  caughtBy: string;
  carrierId: string | null;
  baitPlayerId: string | null;
}

export interface CrateView extends Pose {
  id: string;
  state: 'floating' | 'hooked' | 'loose' | 'carried' | 'thrown';
}

export interface SimNotice {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

export interface ShiftEntry {
  id: string;
  name: string;
  bot: boolean;
  rank: number;
  revenue: number;
  sold: number;
  bonus: number;
  optimization: boolean;
}

export interface ShiftResult {
  day: number;
  ranking: ShiftEntry[];
  showUntil: number;
}

export interface SimSnapshot {
  tick: number;
  time: number;
  day: number;
  seed: string;
  player: PlayerView;
  players: PlayerView[];
  shiftRemaining: number;
  result: ShiftResult | null;
  hook: HookView;
  fish: FishView[];
  crates: CrateView[];
  cash: number;
  sold: number;
  notice: SimNotice | null;
}
