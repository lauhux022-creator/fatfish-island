import { FISHING, PLAY } from './config';

export const SHOP_ITEM_IDS = ['rod', 'pan', 'bait'] as const;
export type ShopItemId = (typeof SHOP_ITEM_IDS)[number];
export type ShopEquipment = Record<ShopItemId, boolean>;

export const SHOP = {
  position: { x: -7.3, y: 0, z: 1.2 },
  radius: 2.2,
  items: {
    rod: { name: '快收线竿', price: 90, description: '蓄力更快，收鱼少点一下', chargeSeconds: 0.78, fewerTaps: 1 },
    pan: { name: '平底锅', price: 120, description: '拍鱼算两下，出手慢、打得近', reach: 2.1, swingSeconds: 0.47, fishDamage: 2 },
    bait: { name: '加急鱼饵', price: 24, description: '让下一条鱼提前 2 秒咬钩', biteReduction: 2 },
  },
} as const;

const PADDLE = { reach: PLAY.swingReach, swingSeconds: PLAY.swingSeconds, fishDamage: 1 } as const;

export function isShopItemId(value: unknown): value is ShopItemId {
  return SHOP_ITEM_IDS.some((id) => id === value);
}

export function castChargeSeconds(equipment: Pick<ShopEquipment, 'rod'>) {
  return equipment.rod ? SHOP.items.rod.chargeSeconds : FISHING.chargeSeconds;
}

export function weaponStats(equipment: Pick<ShopEquipment, 'pan'>) {
  return equipment.pan ? SHOP.items.pan : PADDLE;
}
