import type { FishKind } from './types';

export const DAILY_ORDER_IDS = ['delivery', 'variety', 'trick'] as const;
export type DailyOrderId = (typeof DAILY_ORDER_IDS)[number];
type DailyOrderStatus = 'open' | 'complete' | 'expired';

export const DAILY_ORDERS = {
  delivery: { title: '码头催单', requirement: '交两尾鱼', target: 2, woodReward: 2 },
  variety: { title: '换口味', requirement: '交两种不同的鱼', target: 2, woodReward: 2 },
  trick: { title: '节目效果', requirement: '交一尾活饵鱼或空接鱼', target: 1, woodReward: 3 },
} as const;

export interface DailyOrderView {
  id: DailyOrderId;
  day: number;
  progress: number;
  target: number;
  woodReward: number;
  status: DailyOrderStatus;
}

export class DailyOrder {
  private readonly id: DailyOrderId;
  private readonly species = new Set<FishKind>();
  private progress = 0;
  private status: DailyOrderStatus = 'open';
  private closed = false;

  constructor(private readonly day: number) {
    this.id = DAILY_ORDER_IDS[(day - 1) % DAILY_ORDER_IDS.length];
  }

  /** Return the promised reward when this sale completes the order. */
  recordSale(kind: FishKind, trick: boolean) {
    if (this.status !== 'open' || (this.id === 'trick' && !trick)) return 0;

    if (this.id === 'variety') {
      this.species.add(kind);
      this.progress = this.species.size;
    } else this.progress++;

    const { target, woodReward } = DAILY_ORDERS[this.id];
    if (this.progress < target) return 0;
    this.status = 'complete';
    return woodReward;
  }

  closeAtDusk() {
    if (this.closed) return 0;
    this.closed = true;
    if (this.status === 'complete') return DAILY_ORDERS[this.id].woodReward;
    this.status = 'expired';
    return 0;
  }

  snapshot(): DailyOrderView {
    const { target, woodReward } = DAILY_ORDERS[this.id];
    return { id: this.id, day: this.day, target, woodReward, progress: this.progress, status: this.status };
  }
}
