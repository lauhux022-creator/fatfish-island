import type { EnemyView } from '../../shared/sim/campaign-types';
import type { HookView, PlayerView, Pose, Rotation, SimSnapshot, Vec3 } from '../../shared/sim/types';

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function vector(from: Vec3, to: Vec3, amount: number): Vec3 {
  return { x: lerp(from.x, to.x, amount), y: lerp(from.y, to.y, amount), z: lerp(from.z, to.z, amount) };
}

function rotation(from: Rotation, to: Rotation, amount: number): Rotation {
  const sign = from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w < 0 ? -1 : 1;
  const x = lerp(from.x, to.x * sign, amount);
  const y = lerp(from.y, to.y * sign, amount);
  const z = lerp(from.z, to.z * sign, amount);
  const w = lerp(from.w, to.w * sign, amount);
  const length = Math.hypot(x, y, z, w) || 1;
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

function yawBlend(from: number, to: number, amount: number) {
  const arc = to - from;
  return from + Math.atan2(Math.sin(arc), Math.cos(arc)) * amount;
}

function poses(from: Pose, to: Pose, amount: number): Pose {
  return { position: vector(from.position, to.position, amount), rotation: rotation(from.rotation, to.rotation, amount) };
}

function interpolateHook(current: HookView, from: HookView, to: HookView, amount: number): HookView {
  if (current.phase !== from.phase || current.phase !== to.phase || current.targetId !== from.targetId
    || current.targetId !== to.targetId || !from.position || !to.position) return current;
  return { ...current, position: vector(from.position, to.position, amount) };
}

function interpolatePlayer(current: PlayerView, from: PlayerView, to: PlayerView, amount: number): PlayerView {
  const ragdoll = current.ragdoll > 0;
  if (ragdoll !== (from.ragdoll > 0) || ragdoll !== (to.ragdoll > 0)
    || current.ghost !== from.ghost || current.ghost !== to.ghost) return current;
  return {
    ...current,
    ...poses(from, to, amount),
    yaw: yawBlend(from.yaw, to.yaw, amount),
    speed: lerp(from.speed, to.speed, amount),
    velocity: vector(from.velocity, to.velocity, amount),
    hook: interpolateHook(current.hook, from.hook, to.hook, amount),
    parts: current.parts.map((part) => {
      const earlier = from.parts.find((item) => item.limb === part.limb);
      const later = to.parts.find((item) => item.limb === part.limb);
      return earlier && later ? { ...part, ...poses(earlier, later, amount) } : part;
    }),
  };
}

function interpolateEntities<T extends Pose & { id: string; state: string }>(
  current: T[], from: T[], to: T[], amount: number,
): T[] {
  return current.map((item) => {
    const earlier = from.find(({ id }) => id === item.id);
    const later = to.find(({ id }) => id === item.id);
    if (!earlier || !later || earlier.state !== item.state || later.state !== item.state) return item;
    return { ...item, ...poses(earlier, later, amount) };
  });
}

function interpolateEnemies(current: EnemyView[], from: EnemyView[], to: EnemyView[], amount: number) {
  return current.map((enemy) => {
    const earlier = from.find(({ id }) => id === enemy.id);
    const later = to.find(({ id }) => id === enemy.id);
    if (!earlier || !later || earlier.state !== enemy.state || later.state !== enemy.state) return enemy;
    return {
      ...enemy,
      position: vector(earlier.position, later.position, amount),
      yaw: yawBlend(earlier.yaw, later.yaw, amount),
    };
  });
}

export function selectPerspective(state: SimSnapshot, focusId: string, playerId: string | null): SimSnapshot {
  const player = state.players.find((item) => item.id === focusId) ?? state.player;
  return {
    ...state,
    player,
    hook: player.hook,
    cash: player.cash,
    sold: player.sold,
    notice: playerId ? state.notices[playerId] ?? null : null,
    boss: { ...state.boss, favor: player.favor, memory: player.memory },
  };
}

export function interpolateRoom(
  latest: SimSnapshot, from: SimSnapshot, to: SimSnapshot, amount: number, playerId: string | null,
): SimSnapshot {
  if (latest.day !== from.day || latest.day !== to.day || latest.shiftPaused || from.shiftPaused || to.shiftPaused) {
    return latest;
  }
  return {
    ...latest,
    players: latest.players.map((current) => {
      if (current.id === playerId) return current;
      const earlier = from.players.find(({ id }) => id === current.id);
      const later = to.players.find(({ id }) => id === current.id);
      return earlier && later ? interpolatePlayer(current, earlier, later, amount) : current;
    }),
    fish: interpolateEntities(latest.fish, from.fish, to.fish, amount),
    crates: interpolateEntities(latest.crates, from.crates, to.crates, amount),
    campaign: {
      ...latest.campaign,
      enemies: interpolateEnemies(latest.campaign.enemies, from.campaign.enemies, to.campaign.enemies, amount),
    },
  };
}
