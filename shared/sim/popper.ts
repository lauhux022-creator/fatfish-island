import { ISLAND } from './config';
import type { Vec3 } from './types';

export const POPPER = {
  throwReach: 5,
  landInset: 0.55,
  radius: 2.7,
  fuseSeconds: 0.75,
  burstSeconds: 0.25,
  cooldownSeconds: 7,
  rehitSeconds: 5,
  catchSeconds: 1.2,
  catchHeight: 0.72,
  airCatchMultiplier: 1.45,
  fishRiseSpeed: 6.3,
  fishDrift: 0.95,
  driftSeconds: 0.7,
  looseFishHeight: 1.4,
} as const;

export interface PopperView {
  id: string;
  ownerId: string;
  position: Vec3;
  phase: 'fuse' | 'burst';
  remaining: number;
  radius: number;
}

type Point = Pick<Vec3, 'x' | 'z'>;

export function popperTarget(origin: Point, aim: Point | null): Vec3 | null {
  if (!aim || !Number.isFinite(aim.x) || !Number.isFinite(aim.z)) return null;
  const { landInset, throwReach } = POPPER;
  if (aim.x < ISLAND.minX + landInset || aim.x > ISLAND.maxX - landInset
    || aim.z < ISLAND.shoreZ + landInset || aim.z > ISLAND.backZ - landInset
    || Math.hypot(aim.x - origin.x, aim.z - origin.z) > throwReach) return null;
  return { x: aim.x, y: ISLAND.groundY, z: aim.z };
}
