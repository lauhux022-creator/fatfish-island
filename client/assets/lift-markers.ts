import * as T from 'three';
import { CARGO } from '../../shared/sim/cargo';
import { ISLAND } from '../../shared/sim/config';
import type { FishView, PlayerView, Vec3 } from '../../shared/sim/types';
import type { GeometryKit } from './geometry';

const up = new T.Vector3(0, 1, 0);

export function makeLiftMarkers(parent: T.Object3D, kit: GeometryKit) {
  const group = kit.group(parent);
  const geometry = new T.RingGeometry(0.73, 1, 30);
  const grips = [-1, 1].map(side => {
    const circle = new T.Mesh(geometry, new T.MeshBasicMaterial({
      color: 0xecaa55, transparent: true, depthWrite: false, toneMapped: false,
    }));
    circle.rotation.x = -Math.PI / 2;
    group.add(circle);
    const handle = kit.box(group, 0xb88e54, 0, 0, 0, 0.051, 1, 0.051);
    handle.castShadow = false;
    return { side, circle, handle };
  });
  const facing = new T.Vector3();
  const orientation = new T.Quaternion();
  const start = new T.Vector3();
  const hand = new T.Vector3();
  const segment = new T.Vector3();

  function animate(
    fish: FishView,
    players: readonly PlayerView[],
    center: Vec3,
    seconds: number,
    findHand: (id: string, point: T.Vector3) => T.Vector3 | undefined,
  ) {
    group.visible = fish.state === 'stunned' || fish.state === 'carried'
      || (fish.state === 'thrown' && fish.position.y < 1.15);
    if (!group.visible) return;
    const lead = players.find(player => player.id === (fish.carrierId ?? fish.liftClaimId));
    const helper = players.find(player => player.id === fish.helperId);
    const holders = [lead, helper];
    let freeOffset = 1.02;

    if (lead) {
      facing.set(center.x - lead.position.x, 0, center.z - lead.position.z);
      freeOffset = Math.min(freeOffset, Math.max(0.35, CARGO.pairReach - facing.length() - 0.24));
    } else {
      const rotation = fish.rotation;
      facing.set(1, 0, 0).applyQuaternion(orientation.set(rotation.x, rotation.y, rotation.z, rotation.w)).setY(0);
    }
    if (facing.lengthSq() < 0.003) facing.set(1, 0, 0);
    facing.normalize();

    for (const [index, { side, circle, handle }] of grips.entries()) {
      const holder = holders[index];
      const x = holder?.position.x ?? T.MathUtils.clamp(
        center.x + facing.x * side * freeOffset, ISLAND.minX + 0.26, ISLAND.maxX - 0.26,
      );
      const z = holder?.position.z ?? T.MathUtils.clamp(
        center.z + facing.z * side * freeOffset, ISLAND.shoreZ + 0.26, ISLAND.backZ - 0.26,
      );
      const onIsland = x >= ISLAND.minX && x <= ISLAND.maxX && z >= ISLAND.shoreZ && z <= ISLAND.backZ;
      circle.visible = onIsland;
      circle.position.set(x, ISLAND.groundY + 0.062, z);
      circle.material.color.setHex(holder ? 0x45c4a4 : 0xdd7d32);
      circle.material.opacity = holder ? 0.88 : 0.68 + Math.sin(seconds * 5) * 0.21;
      circle.scale.setScalar(holder ? 0.49 : 0.44 + Math.sin(seconds * 5) * 0.035);
      handle.visible = Boolean(holder);
      if (!holder) continue;
      const arm = findHand(holder.id, hand) ?? hand.set(holder.position.x, holder.position.y + 0.13, holder.position.z);
      start.set(center.x + side * facing.x * 0.57, center.y + 0.12, center.z + side * facing.z * 0.57);
      segment.subVectors(arm, start);
      handle.scale.y = Math.max(0.02, segment.length());
      handle.position.copy(start).lerp(arm, 0.5);
      handle.quaternion.setFromUnitVectors(up, segment.normalize());
    }
  }

  return {
    animate,
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      for (const { circle } of grips) circle.material.dispose();
    },
  };
}
