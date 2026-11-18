// Input plan shared by the scripted browser review and fast simulation checks.
const lane = { x: 0.1, z: -0.85 };
const castingWater = { x: 0.15, z: -8.8 };
const scale = { x: 5.5, z: 0.7 };
const delivery = { x: 3.85, z: 0.85 };

export function createReviewPolicy() {
  let lastTap = -Infinity;
  let lastSwing = -Infinity;
  let lastInteract = -Infinity;

  function walkToward(origin, target) {
    const axis = (delta) => Math.abs(delta) < 0.24 ? 0 : Math.sign(delta);
    return { moveX: axis(target.x - origin.x), moveZ: axis(target.z - origin.z) };
  }

  function range(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  return function plan(snapshot) {
    const { player, hook, fish, time } = snapshot;
    const origin = player.position;
    if (player.ragdoll || player.baitedBy || snapshot.shiftPaused) return {};
    if (player.carrying) {
      if (range(origin, delivery) < 0.6 && time - lastInteract >= 0.22) {
        lastInteract = time;
        return { aim: scale, interact: true };
      }
      return { ...walkToward(origin, delivery), aim: scale };
    }
    if (hook.phase === 'charging') {
      return { aim: castingWater, cast: hook.charge >= 0.93 ? 'release' : undefined };
    }
    if (hook.phase === 'waiting' || hook.phase === 'flying') return { aim: castingWater };
    if (hook.phase === 'bite' || hook.phase === 'reeling' || hook.phase === 'bait') {
      if (time - lastTap < 0.15) return { aim: castingWater };
      lastTap = time;
      return { aim: castingWater, cast: 'tap' };
    }

    const catchView = fish.find((candidate) => candidate.caughtBy === player.id &&
      (candidate.state === 'flopping' || candidate.state === 'stunned'));
    if (catchView) {
      const target = catchView.position;
      const distance = range(origin, target);
      if (catchView.state === 'stunned' && distance < 1.85 && Math.abs(target.y - origin.y) < 1.35 &&
          time - lastInteract >= 0.25) {
        lastInteract = time;
        return { aim: target, interact: true };
      }
      if (catchView.state === 'flopping' && distance < 2.2 && Math.abs(target.y - origin.y) < 1.2 &&
          player.swing <= 0 && time - lastSwing >= 0.33) {
        lastSwing = time;
        return { aim: target, swing: true };
      }
      return {
        ...walkToward(origin, { x: Math.max(-8.7, Math.min(8.7, target.x)), z: Math.max(-3.15, target.z + 0.35) }),
        aim: target,
      };
    }

    if (range(origin, lane) > 0.42) return { ...walkToward(origin, lane), aim: castingWater };
    return { aim: castingWater, cast: 'hold' };
  };
}

// Use real keyboard and pointer events while observing only the public debug snapshot.
export function createBrowserControls(page) {
  const held = new Set();
  let castHeld = false;

  async function move({ moveX = 0, moveZ = 0 }) {
    const next = new Set();
    if (moveX) next.add(moveX < 0 ? 'KeyA' : 'KeyD');
    if (moveZ) next.add(moveZ < 0 ? 'KeyW' : 'KeyS');
    for (const key of held) {
      if (next.has(key)) continue;
      await page.keyboard.up(key);
      held.delete(key);
    }
    for (const key of next) {
      if (held.has(key)) continue;
      await page.keyboard.down(key);
      held.add(key);
    }
  }

  async function apply(state, input) {
    await move(input);
    if (castHeld && (input.cast === 'release' || state.hook.phase !== 'charging')) {
      await page.mouse.up();
      castHeld = false;
      return;
    }
    if (!input.aim || (!input.cast && !input.swing && !input.interact)) return;
    const aim = await page.evaluate(({ x, z }) =>
      window.fatfishDebug.project({ x, y: z < -4 ? -0.5 : 0, z }), input.aim);
    const { width, height } = page.viewportSize();
    if (aim.x < 0 || aim.y < 0 || aim.x >= width || aim.y >= height) return;
    await page.mouse.move(aim.x, aim.y);
    if (input.cast === 'hold' && !castHeld) {
      await page.mouse.down();
      castHeld = true;
    } else if (input.cast === 'tap') {
      await page.mouse.click(aim.x, aim.y);
    }
    if (input.swing) await page.keyboard.press('KeyF');
    if (input.interact) await page.keyboard.press('KeyE');
  }

  return {
    apply,
    async stop() {
      await move({});
      if (castHeld) await page.mouse.up();
      castHeld = false;
    },
  };
}
