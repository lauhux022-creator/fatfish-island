import { WORKER_ROLES, type WorkerRoleId } from '../sim/cast';
import type { FishAction } from './types';

const bonusReplies: Record<WorkerRoleId, string> = {
  claude: '谢谢。领这个需要先签字吗？',
  gpt: '第一步，先把奖金收好。',
  grok: '够痛快！下一条鱼给我。',
  kimi: '奖金到账这段，我也记住了。',
};

export function crewReaction(roleId: WorkerRoleId, action: FishAction): string | null {
  if (action === 'bonus') return bonusReplies[roleId];
  if (action === 'fine') return WORKER_ROLES[roleId].catchphrase;
  return null;
}
