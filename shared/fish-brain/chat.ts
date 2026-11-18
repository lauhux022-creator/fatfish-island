export type FishChatIntent = 'complaint' | 'bribe' | 'bargain' | 'praise' | 'gift' | 'supplies' | 'other';

export function normalizePlayerChat(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, 120).join('').trimEnd();
}

export function classifyFishChat(text: string): FishChatIntent {
  if (/告状|偷鱼|抢鱼|偷懒|摸鱼|举报/u.test(text)) return 'complaint';
  if (/红包|贿赂|喝茶|孝敬|礼金|茶水费/u.test(text)) return 'bribe';
  if (/涨价|加价|砍价|便宜|多给|太低|讨价|少扣|降价/u.test(text)) return 'bargain';
  if (/英明|厉害|伟大|夸夸|帅气|最好|老板好|大方|辛苦/u.test(text)) return 'praise';
  if (/鱼饵|福利|加急/u.test(text)) return 'gift';
  if (/补给|物资|箱子|木箱/u.test(text)) return 'supplies';
  return 'other';
}
