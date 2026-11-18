import { ISLAND } from './config';
import type { Vec3 } from './types';

export const SALVAGE = {
  spawnSeconds: 12,
  origin: { x: -7.4, y: ISLAND.supplyCrate.y, z: -8.3 },
  halfSize: 0.43,
  driftAmplitude: 0.65,
  driftRate: 0.48,
  bobAmplitude: 0.065,
  bobRate: 2.1,
  cashReward: 12,
} as const;

export function salvageDrift(anchor: Vec3, seconds: number, direction: -1 | 1): Vec3 {
  return {
    x: anchor.x + direction * SALVAGE.driftAmplitude * Math.sin(seconds * SALVAGE.driftRate),
    y: anchor.y + SALVAGE.bobAmplitude * Math.sin(seconds * SALVAGE.bobRate),
    z: anchor.z,
  };
}
