import { CAMPAIGN, PLAY } from './config';

export const CAMPAIGN_PACES = {
  classic: { daySeconds: PLAY.daySeconds, nightSeconds: CAMPAIGN.nightSeconds },
  quick: { daySeconds: 90, nightSeconds: 30 },
} as const;

export type CampaignPace = keyof typeof CAMPAIGN_PACES;

export function isCampaignPace(value: unknown): value is CampaignPace {
  return value === 'classic' || value === 'quick';
}
