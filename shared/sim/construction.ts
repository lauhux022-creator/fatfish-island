import type { EnemyView, StructureView } from './campaign-types';
import { CAMPAIGN, ISLAND } from './config';
import type { Vec3 } from './types';

type Point = Pick<Vec3, 'x' | 'z'>;

export function buildAhead(origin: Point, yaw: number): Vec3 {
  return {
    x: origin.x - Math.sin(yaw) * CAMPAIGN.buildReach,
    y: ISLAND.groundY,
    z: origin.z - Math.cos(yaw) * CAMPAIGN.buildReach,
  };
}

export function snapBuildSite(point: Point): Vec3 {
  const grid = CAMPAIGN.buildGrid;
  return {
    x: Math.round(point.x / grid) * grid,
    y: ISLAND.groundY,
    z: Math.round(point.z / grid) * grid,
  };
}

export function buildSiteAvailable(at: Point, structures: readonly StructureView[], enemies: readonly EnemyView[]): boolean {
  const grid = CAMPAIGN.buildGrid;
  if (!Number.isFinite(at.x) || !Number.isFinite(at.z) || structures.length >= CAMPAIGN.maxStructures) return false;
  if (at.x <= ISLAND.minX + grid || at.x >= ISLAND.maxX - grid
      || at.z <= ISLAND.shoreZ + grid || at.z >= ISLAND.backZ - grid) return false;
  const gap = (other: Point) => Math.hypot(at.x - other.x, at.z - other.z);
  return gap(CAMPAIGN.warehouse) > CAMPAIGN.warehouseRadius
    && gap(ISLAND.scale) > ISLAND.scale.radius + grid
    && !structures.some(({ position }) => gap(position) < CAMPAIGN.buildSpacing)
    && !enemies.some(({ position }) => gap(position) < grid + 0.1);
}
