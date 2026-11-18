import assert from 'node:assert/strict';
import type { createSimulation } from '../shared/sim';
import { FISH, ISLAND, TICKS_PER_SECOND } from '../shared/sim/config';
import { emptyInput, type SimInput, type SimSnapshot, type Vec3 } from '../shared/sim/types';

export type CargoSimulation = Awaited<ReturnType<typeof createSimulation>>;
type Point = Pick<Vec3, 'x' | 'z'>;
const idleCrew = { 'bot-1': emptyInput, 'bot-2': emptyInput, 'bot-3': emptyInput };

export function cargoStep(sim: CargoSimulation, inputs: Record<string, SimInput> = {}) {
  sim.step(inputs.player ?? emptyInput, { ...idleCrew, ...inputs });
  return sim.snapshot();
}

export function cargoUntil(sim: CargoSimulation, check: (snapshot: SimSnapshot) => boolean, maxTicks: number) {
  let view = sim.snapshot();
  for (let tick = 0; !check(view) && tick < maxTicks; tick++) view = cargoStep(sim);
  assert(check(view), `Cargo fixture did not reach the expected state at ${view.time.toFixed(2)}s`);
  return view;
}

export function cargoWorker(snapshot: SimSnapshot, id: string) {
  const worker = snapshot.players.find((entry) => entry.id === id);
  assert(worker, `Unknown worker ${id}`);
  return worker;
}

export function cargoFish(snapshot: SimSnapshot, id: string) {
  const fish = snapshot.fish.find((entry) => entry.id === id);
  assert(fish, `Missing fish ${id}`);
  return fish;
}

export function nearCargoWorker(sim: CargoSimulation, id: string, destination: Point, stop = 0.25) {
  for (let tick = 0; tick < 4 * TICKS_PER_SECOND; tick++) {
    const worker = cargoWorker(sim.snapshot(), id);
    const dx = destination.x - worker.position.x;
    const dz = destination.z - worker.position.z;
    const gap = Math.hypot(dx, dz);
    if (gap < stop && (worker.grounded || worker.ghost)) return;
    cargoStep(sim, { [id]: { ...emptyInput, moveX: gap < stop ? 0 : dx / gap, moveZ: gap < stop ? 0 : dz / gap } });
  }
  assert.fail(`Worker ${id} could not reach (${destination.x}, ${destination.z})`);
}

/** Use the real hook, teammate bait, reel and paddle with otherwise idle crew seats. */
export function prepareCargo(sim: CargoSimulation) {
  for (let tick = 0; tick < 10; tick++) cargoStep(sim);
  const { position: mate } = cargoWorker(sim.snapshot(), 'bot-2');
  for (let tick = 0; tick < 30; tick++) {
    cargoStep(sim, { player: { ...emptyInput, aim: mate, castHeld: true, castPressed: tick === 0 } });
  }
  cargoStep(sim, { player: { ...emptyInput, aim: mate, castReleased: true } });
  const hooked = cargoUntil(sim, ({ hook }) => hook.phase === 'bait', 2 * TICKS_PER_SECOND);
  assert.equal(hooked.hook.targetId, 'bot-2');
  const water = { x: 1.6, z: -8.1 };
  cargoStep(sim, { player: { ...emptyInput, aim: water, castPressed: true } });
  const bite = cargoUntil(sim, ({ hook }) => hook.phase === 'bite', 3 * TICKS_PER_SECOND);
  assert(bite.hook.targetId);
  const fish = cargoFish(bite, bite.hook.targetId);
  assert.equal(fish.kind, 'grouper');
  assert.equal(fish.heavy, true);
  assert.equal(fish.baitPlayerId, 'bot-2');

  for (let tap = 0; tap < FISH.grouper.taps; tap++) cargoStep(sim, { player: { ...emptyInput, aim: water, castPressed: true } });
  assert.equal(cargoFish(sim.snapshot(), fish.id).state, 'flopping');

  for (let tick = 0; tick < 6 * TICKS_PER_SECOND; tick++) {
    const view = sim.snapshot();
    const live = cargoFish(view, fish.id);
    if (live.state === 'stunned') return fish.id;
    assert.equal(live.state, 'flopping');
    const { position, swing } = view.player;
    const dx = live.position.x - position.x;
    const dz = Math.max(ISLAND.shoreZ + 0.85, live.position.z + 0.3) - position.z;
    const gap = Math.hypot(dx, dz);
    const strike = swing === 0 && Math.hypot(dx, live.position.z - position.z) < 2.35 && Math.abs(live.position.y - position.y) < 1.35;
    cargoStep(sim, { player: { ...emptyInput, aim: live.position, swingPressed: strike,
      moveX: gap > 0.65 ? dx / gap : 0, moveZ: gap > 0.65 ? dz / gap : 0 } });
  }
  assert.fail('Live-bait grouper was not stunned');
}
