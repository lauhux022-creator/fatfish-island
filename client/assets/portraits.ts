import type { FishEmotion } from '../../shared/fish-brain/types';
import type { WorkerRoleId } from '../../shared/sim/cast';

const busts = import.meta.glob('/assets/dafeiyu/bust/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const portraits = import.meta.glob('/assets/dafeiyu/portraits/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const bossExpressions = {
  calm: 'base',
  happy: 'teary_smile',
  annoyed: 'angry',
  smug: 'smug',
  surprised: 'overheat',
  cry: 'cry',
  sleep: 'sleep',
};

export function crewPortrait(roleId: WorkerRoleId) {
  return portraits[`/assets/dafeiyu/portraits/${roleId}.jpg`];
}

export function crewBust(roleId: WorkerRoleId, expression: 'smug' | 'cry') {
  return busts[`/assets/dafeiyu/bust/${roleId}_${expression}.webp`];
}

export function bossBust(emotion: FishEmotion) {
  const expression = bossExpressions[emotion];
  return busts[`/assets/dafeiyu/bust/feiyu_${expression}.webp`];
}

export function updatePortrait(image: HTMLImageElement, url: string | undefined) {
  if (url && image.getAttribute('src') === url) return;
  image.hidden = !url;
  if (url) image.src = url;
  else image.removeAttribute('src');
}
