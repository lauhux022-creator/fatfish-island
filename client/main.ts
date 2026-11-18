import { STEP_SECONDS } from '../shared/sim/config';
import { emptyInput, type SimInput, type SimSnapshot, type Vec3 } from '../shared/sim/types';
import { createHud } from './hud';
import { createSound } from './sound';
import './style.css';

declare const __GAME_VERSION__: string;
declare const __COMMIT_SHA__: string;

declare global {
  interface Window {
    fatfishDebug?: Readonly<{
      snapshot: () => SimSnapshot;
      project: (position: Vec3) => { x: number; y: number };
    }>;
  }
}

const params = new URLSearchParams(location.search);
const seed = params.get('seed')?.trim().slice(0, 80) || crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const dayParam = Number.parseInt(params.get('day') ?? '1', 10);
const day = Number.isFinite(dayParam) ? Math.min(999, Math.max(1, dayParam)) : 1;
const debug = params.get('debug') === '1';

const app = document.querySelector<HTMLElement>('#app')!;
const hud = createHud(app, { version: __GAME_VERSION__, commit: __COMMIT_SHA__, seed, debug });

async function startGame() {
  const [{ createSimulation }, { createScene }] = await Promise.all([
    import('../shared/sim'),
    import('./scene'),
  ]);
  const scene = createScene(hud.canvas);
  const sim = await createSimulation({ seed, day });
  const sound = createSound();
  const events = new AbortController();
  const options = { signal: events.signal };
  const input: SimInput = { ...emptyInput };
  const pressed = new Set<string>();
  const touch = new Map<number, string>();
  let aimPointer: { x: number; y: number } | null = null;
  let mouseCast = false;
  let snapshot = sim.snapshot();

  if (debug) {
    window.fatfishDebug = Object.freeze({ snapshot: () => snapshot, project: scene.project });
  }

  function setCast(held: boolean) {
    if (held === input.castHeld) return;
    input.castHeld = held;
    if (held) input.castPressed = true;
    else input.castReleased = true;
  }

  function toggleMute() {
    const muted = sound.toggle();
    const button = app.querySelector<HTMLElement>('[data-control="sound"]');
    if (button) {
      button.setAttribute('aria-pressed', String(muted));
      button.dataset.muted = String(muted);
    }
  }

  addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;
    if (target instanceof HTMLElement && target.closest('button, summary') && event.code === 'Space') return;
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Space', 'KeyF', 'KeyE', 'KeyM'].includes(event.code)) return;
    event.preventDefault();
    sound.unlock();
    pressed.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') input.jumpPressed = true;
    if (event.code === 'KeyF') input.swingPressed = true;
    if (event.code === 'KeyE') input.interactPressed = true;
    if (event.code === 'KeyM') toggleMute();
  }, options);

  addEventListener('keyup', (event) => pressed.delete(event.code), options);
  addEventListener('blur', () => {
    pressed.clear();
    touch.clear();
    mouseCast = false;
    setCast(false);
  }, options);

  hud.canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'touch') aimPointer = { x: event.clientX, y: event.clientY };
  }, options);

  hud.canvas.addEventListener('pointerdown', (event) => {
    sound.unlock();
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    aimPointer = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      input.aim = scene.aim(event.clientX, event.clientY);
      aimPointer = null;
      return;
    }
    if (event.button === 0) {
      hud.canvas.setPointerCapture(event.pointerId);
      mouseCast = true;
      setCast(true);
    }
    if (event.button === 2) input.swingPressed = true;
  }, options);

  function releaseMouse(event: PointerEvent) {
    if (event.type === 'pointerup' && event.button !== 0) return;
    if (event.pointerType === 'touch' || !mouseCast) return;
    mouseCast = false;
    setCast([...touch.values()].includes('cast'));
  }

  addEventListener('pointerup', releaseMouse, options);
  hud.canvas.addEventListener('pointercancel', releaseMouse, options);
  hud.canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);

  app.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>('[data-control]');
    const control = button?.dataset.control;
    if (!button || !control) return;
    sound.unlock();
    if (control === 'sound') return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touch.set(event.pointerId, control);
    if (control === 'cast') setCast(true);
    if (control === 'swing') input.swingPressed = true;
    if (control === 'interact') input.interactPressed = true;
    if (control === 'jump') input.jumpPressed = true;
  }, options);

  const releaseTouch = (event: PointerEvent) => {
    if (touch.get(event.pointerId) === 'cast') {
      touch.delete(event.pointerId);
      setCast(mouseCast || [...touch.values()].includes('cast'));
    }
    touch.delete(event.pointerId);
  };

  app.addEventListener('pointerup', releaseTouch, options);
  app.addEventListener('pointercancel', releaseTouch, options);
  app.addEventListener('lostpointercapture', releaseTouch, options);
  app.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-control="sound"]')) {
      sound.unlock();
      toggleMute();
    }
  }, options);

  function direction(key: string, arrow: string, control: string) {
    return Number(pressed.has(key) || pressed.has(arrow) || [...touch.values()].includes(control));
  }

  const stepMs = STEP_SECONDS * 1000;
  let previous = performance.now();
  const start = previous;
  let accumulated = 0;
  let raf = 0;
  let lastUiTick = -20;

  function frame(now: number) {
    accumulated += Math.min(now - previous, 100);
    previous = now;

    while (accumulated >= stepMs) {
      input.moveX = direction('KeyD', 'ArrowRight', 'right') - direction('KeyA', 'ArrowLeft', 'left');
      input.moveZ = direction('KeyS', 'ArrowDown', 'down') - direction('KeyW', 'ArrowUp', 'up');
      if (aimPointer) input.aim = scene.aim(aimPointer.x, aimPointer.y);
      sim.step(input);
      const next = sim.snapshot();
      sound.update(snapshot, next);
      snapshot = next;
      input.castPressed = false;
      input.castReleased = false;
      input.swingPressed = false;
      input.interactPressed = false;
      input.jumpPressed = false;
      accumulated -= stepMs;
    }

    scene.render(snapshot, (now - start) / 1000);
    // Charging and reeling need direct feedback. Other HUD updates can share the same refresh.
    if (snapshot.tick !== lastUiTick) {
      hud.update(snapshot);
      lastUiTick = snapshot.tick;
    }
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
  import.meta.hot?.dispose(() => {
    events.abort();
    cancelAnimationFrame(raf);
    scene.dispose();
    sim.dispose();
    sound.dispose();
    delete window.fatfishDebug;
  });
}

startGame().catch((error: unknown) => {
  console.error(error);
  hud.setError('渔场启动失败。请开启 WebGL 2 或换用支持 WebGL 2 的浏览器，然后刷新页面。');
});
