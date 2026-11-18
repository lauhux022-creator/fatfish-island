export const TICKS_PER_SECOND = 60;
export const STEP_SECONDS = 1 / TICKS_PER_SECOND;

export const ISLAND = {
  minX: -10,
  maxX: 10,
  shoreZ: -4,
  backZ: 9,
  groundY: 0,
  seaY: -0.5,
  scale: { x: 5.5, y: 1, z: 0.7, radius: 1.05, aimAssistDistance: 5.2 },
  spawn: { x: 0, y: 0.85, z: 2.2 },
  supplyCrate: { x: -3.3, y: -0.32, z: -6.1 },
  trainingCrate: { x: -3.2, y: 0.53, z: 1.3 },
} as const;

export const CREW = [
  { id: 'player', name: '你', bot: false, spawn: ISLAND.spawn },
  { id: 'bot-1', name: '阿铲', bot: true, spawn: { x: -5.4, y: ISLAND.spawn.y, z: -1.8 } },
  { id: 'bot-2', name: '桶桶', bot: true, spawn: { x: 2.95, y: ISLAND.spawn.y, z: -1.05 } },
  { id: 'bot-3', name: '溜溜', bot: true, spawn: { x: 7.3, y: ISLAND.spawn.y, z: -1.9 } },
] as const;

export const PLAY = {
  gravity: 18,
  moveSpeed: 5.25,
  jumpSpeed: 6.1,
  ragdollSeconds: 2,
  crateTripSpeed: 4,
  reach: 2.35,
  swingReach: 2.65,
  swingSeconds: 0.29,
  comboWindow: 1.25,
  comboBonus: 0.2,
  airBonus: 0.35,
  maxMultiplier: 2.4,
  stunSeconds: 14,
  stealGrace: 0.42,
  friendlyKnockback: 4.4,
  friendlyArc: 0.55,
  daySeconds: 240,
  nightSeconds: 120,
} as const;

export const FISHING = {
  chargeSeconds: 1.12,
  minRange: 2.8,
  maxRange: 12.4,
  biteMin: 0.75,
  biteMax: 1.47,
  approachSeconds: 0.37,
  lineSlackSeconds: 5.5,
  minFishingZ: -17,
  maxFishingX: 13,
  crateTaps: 5,
  teammateHookRadius: 0.8,
  teammateSlackSeconds: 6,
  baitBiteSeconds: 0.76,
  baitWeights: { sardine: 0, puffer: 58, grouper: 42 },
} as const;

export const FISH = {
  sardine: { name: '银条鱼', price: 20, size: 0.82, taps: 6, hits: 1, weight: 52 },
  puffer: { name: '气鼓鱼', price: 34, size: 1.04, taps: 7, hits: 2, weight: 32 },
  grouper: { name: '欠薪斑', price: 52, size: 1.27, taps: 8, hits: 3, weight: 16 },
} as const;

export const SHIFT = {
  bonus: 20,
  resultSeconds: 8,
  shortestSeconds: 10,
  optimizationSpeed: 0.9,
} as const;

// Team targets for the three-day cycles in the design. Settlement arrives in M5.
export const TEAM_KPI = [125, 195, 290, 420] as const;

export const BOTS = {
  laneZ: -1.55,
  castZ: -8.1,
  dropZ: -0.36,
  shoreInset: 0.86,
  castHold: [0.59, 0.75],
  reelCadence: [0.13, 0.25],
  throwWindup: [0.29, 0.43],
  shiftBreak: [7.4, 11.8],
  firstMischief: [11, 16],
  mischiefCooldown: [7, 12],
  mischiefReach: 1.95,
  roughhouseChance: 0.13,
  profiles: {
    'bot-1': { laneX: -6.1, dropX: 3.3, start: 3.85, jumpChance: 0.16, stealChance: 0.31 },
    'bot-2': { laneX: 2.85, dropX: 4.2, start: 5.3, jumpChance: 0.48, stealChance: 0.46 },
    'bot-3': { laneX: 7.25, dropX: 7.2, start: 4.6, jumpChance: 0.29, stealChance: 0.64 },
  },
} as const;
