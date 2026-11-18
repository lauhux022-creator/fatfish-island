import { PLAY, SHIFT, STEP_SECONDS } from './config';
import type { PlayerView, Rotation, SimInput } from './types';

type MovementState = Pick<PlayerView, 'position' | 'velocity' | 'grounded' | 'carrying' | 'optimization' | 'baitedBy'>;

export function yawRotation(yaw: number): Rotation {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

export function resolveMovement(worker: MovementState, input: SimInput) {
  const { position, velocity, grounded } = worker;
  const moveLength = Math.max(1, Math.hypot(input.moveX, input.moveZ));
  const move = { x: input.moveX / moveLength, z: input.moveZ / moveLength };
  const focus = input.aim ? { x: input.aim.x - position.x, z: input.aim.z - position.z } : move;
  const focusLength = Math.hypot(focus.x, focus.z);
  const direction = focusLength > 0.05 ? { x: focus.x / focusLength, z: focus.z / focusLength } : null;
  const easing = grounded ? 0.36 : 0.12;
  const penalty = worker.optimization ? SHIFT.optimizationSpeed : 1;
  const speed = worker.baitedBy ? 0 : PLAY.moveSpeed * penalty * (worker.carrying ? PLAY.carrySpeed : 1);
  const jumped = input.jumpPressed && grounded && !worker.baitedBy;

  return {
    direction,
    jumped,
    desiredSpeed: Math.hypot(move.x, move.z) * speed,
    velocity: {
      x: velocity.x + (move.x * speed - velocity.x) * easing,
      y: jumped ? PLAY.jumpSpeed : velocity.y,
      z: velocity.z + (move.z * speed - velocity.z) * easing,
    },
  };
}

/** Replay one unacknowledged steering input. Contact, height and actions come from the authority. */
export function predictPlayerMovement(player: PlayerView, input: SimInput): PlayerView {
  if (player.ragdoll > 0 || player.baitedBy) return player;
  const { direction, velocity } = resolveMovement(player, input);
  const yaw = direction ? Math.atan2(-direction.x, -direction.z) : player.yaw;
  return {
    ...player,
    position: {
      x: player.position.x + velocity.x * STEP_SECONDS,
      y: player.position.y,
      z: player.position.z + velocity.z * STEP_SECONDS,
    },
    velocity: { ...velocity, y: player.velocity.y },
    yaw,
    rotation: yawRotation(yaw),
    speed: Math.hypot(velocity.x, velocity.z),
  };
}
