export const WORKER_ROLE_IDS = ['claude', 'gpt', 'grok', 'kimi'] as const;
export type WorkerRoleId = (typeof WORKER_ROLE_IDS)[number];

export const DEFAULT_WORKER_ROLE: WorkerRoleId = 'gpt';
const SEAT_ROLES: readonly WorkerRoleId[] = [DEFAULT_WORKER_ROLE, 'claude', 'kimi', 'grok'];

export const WORKER_ROLES = {
  claude: { name: 'Claude', personality: '礼貌守规矩，爱提醒风险', catchphrase: '这样做可能不太安全哦。' },
  gpt: { name: 'GPT', personality: '爱指挥，什么都能列三点', catchphrase: '我给你三个建议！' },
  grok: { name: 'Grok', personality: '性子冲，最爱正面刚', catchphrase: '有意见冲我来！' },
  kimi: { name: 'Kimi', personality: '慢热认真，上次抢鱼还记得', catchphrase: '上下文还在！' },
} as const satisfies Record<WorkerRoleId, { name: string; personality: string; catchphrase: string }>;

export const WORKER_ANIMATIONS = [
  'idle', 'walk', 'run', 'chop', 'box_01', 'fall', 'dive', 'victory_celebration', 'afraid',
] as const;
export type WorkerAnimation = (typeof WORKER_ANIMATIONS)[number];

export function isWorkerRoleId(value: unknown): value is WorkerRoleId {
  return WORKER_ROLE_IDS.some((role) => role === value);
}

export function isWorkerAnimation(value: unknown): value is WorkerAnimation {
  return WORKER_ANIMATIONS.some((animation) => animation === value);
}

export function assignWorkerRoles(first: WorkerRoleId): WorkerRoleId[] {
  return SEAT_ROLES.map((role, index) => index === 0 ? first : role === first ? DEFAULT_WORKER_ROLE : role);
}
