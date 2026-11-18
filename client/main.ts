import { BUILD_KINDS, type BuildKind } from '../shared/sim/campaign-types';
import { DEFAULT_WORKER_ROLE, isWorkerRoleId } from '../shared/sim/cast';
import { STEP_SECONDS } from '../shared/sim/config';
import { isCampaignPace } from '../shared/sim/pace';
import { isShopItemId } from '../shared/sim/shop';
import { emptyInput, type SimInput, type SimSnapshot, type Vec3 } from '../shared/sim/types';
import { createHud } from './hud';
import { createSound } from './sound';
import { createRoomClient, type RoomDebugState } from './net/room-client';
import { createRoomLobby } from './room-lobby';
import { createRolePicker } from './role-picker';
import './style.css';

declare const __GAME_VERSION__: string;
declare const __COMMIT_SHA__: string;

declare global {
  interface Window {
    fatfishDebug?: Readonly<{
      snapshot: () => SimSnapshot;
      displayed: () => SimSnapshot;
      network: () => RoomDebugState;
      project: (position: Vec3) => { x: number; y: number };
    }>;
  }
}

const params = new URLSearchParams(location.search);
const seed = params.get('seed')?.trim().slice(0, 80) || crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const dayParam = Number.parseInt(params.get('day') ?? '1', 10);
const day = Number.isFinite(dayParam) ? Math.min(999, Math.max(1, dayParam)) : 1;
const debug = params.get('debug') === '1';
const selectedRole = params.get('role');
const roleId = isWorkerRoleId(selectedRole) ? selectedRole : DEFAULT_WORKER_ROLE;
const selectedPace = params.get('pace');
const pace = isCampaignPace(selectedPace) ? selectedPace : 'classic';
const shiftSeconds = debug && params.has('shiftSeconds') ? Number(params.get('shiftSeconds')) : undefined;
const nightSeconds = debug && params.has('nightSeconds') ? Number(params.get('nightSeconds')) : undefined;
const buildKeys = new Map<string, BuildKind>(BUILD_KINDS.map((kind, index) => [`Digit${index + 1}`, kind]));
const buildControls = new Map<string, BuildKind>(BUILD_KINDS.map((kind) => [`build:${kind}`, kind]));

const app = document.querySelector<HTMLElement>('#app')!;
let queuedChat: string | undefined;
const hud = createHud(app, { version: __GAME_VERSION__, commit: __COMMIT_SHA__, seed, debug }, (text) => {
  queuedChat = text;
});

async function startGame() {
  const [{ createSimulation }, { createScene }] = await Promise.all([
    import('../shared/sim'),
    import('./scene'),
  ]);
  const scene = createScene(hud.canvas);
  const sim = await createSimulation({ seed, day, shiftSeconds, nightSeconds, roleId, pace });
  const sound = createSound();
  const events = new AbortController();
  const options = { signal: events.signal };
  const input: SimInput = { ...emptyInput };
  const pressed = new Set<string>();
  const touch = new Map<number, string>();
  let aimPointer: { x: number; y: number } | null = null;
  let mouseCast = false;
  let snapshot = sim.snapshot();
  let displayed = snapshot;
  let lastUiSnapshot: SimSnapshot | undefined;
  let lastMode: RoomDebugState['mode'] = 'local';
  let lobby: ReturnType<typeof createRoomLobby> | undefined;
  let picker: ReturnType<typeof createRolePicker> | undefined;
  const room = createRoomClient({
    seed,
    day: debug ? day : undefined,
    shiftSeconds,
    nightSeconds,
    onStatus(status) {
      if (status.mode !== lastMode) {
        clearControls();
        aimPointer = null;
        queuedChat = undefined;
        if (status.mode === 'local') {
          snapshot = sim.snapshot();
          displayed = snapshot;
          lastUiSnapshot = undefined;
        }
        lastMode = status.mode;
      }
      lobby?.update(status);
      picker?.setVisible(status.mode === 'local');
    },
  });

  lobby = createRoomLobby(app, { connect: room.connect, leave: room.leave }, roleId, pace);
  picker = createRolePicker(app, roleId, pace);
  lobby.update(room.status());

  function lobbyOpen() {
    return Boolean(app.querySelector('[data-room-dialog][open], [data-local-role-dialog][open]'));
  }

  function canPlay() {
    const mode = room.status().mode;
    return (mode === 'local' || mode === 'playing') && !lobbyOpen() && snapshot.campaign.phase !== 'cleared';
  }

  if (debug) {
    window.fatfishDebug = Object.freeze({
      snapshot: () => snapshot,
      displayed: () => displayed,
      network: room.debug,
      project: scene.project,
    });
  }

  function setCast(held: boolean) {
    if (held === input.castHeld) return;
    input.castHeld = held;
    if (held) input.castPressed = true;
    else input.castReleased = true;
  }

  function clearControls(release = false) {
    pressed.clear();
    touch.clear();
    mouseCast = false;
    input.castReleased = release && input.castHeld;
    input.castHeld = false;
    input.castPressed = false;
    input.swingPressed = false;
    input.interactPressed = false;
    input.jumpPressed = false;
    input.continuePressed = false;
    input.build = undefined;
    input.revivePressed = false;
    input.buy = undefined;
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
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.isComposing) return;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;
    if (lobbyOpen()) return;
    if (event.code === 'KeyM') {
      event.preventDefault();
      if (!event.repeat) {
        sound.unlock();
        toggleMute();
      }
      return;
    }
    if (!canPlay()) return;
    if (event.key === 'Escape' && hud.closeShop()) {
      event.preventDefault();
      return;
    }
    if (snapshot.shiftPaused) {
      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        event.preventDefault();
        if (!event.repeat) input.continuePressed = true;
      }
      return;
    }
    if (event.code === 'KeyT' && !event.repeat && hud.focusChat()) {
      event.preventDefault();
      return;
    }
    if (event.code === 'KeyQ' && !event.repeat && hud.toggleShop()) {
      event.preventDefault();
      return;
    }
    const build = buildKeys.get(event.code);
    if (build || event.code === 'KeyR') {
      event.preventDefault();
      if (!event.repeat) {
        sound.unlock();
        if (build) input.build = build;
        else input.revivePressed = true;
      }
      return;
    }
    if (target instanceof HTMLElement && target.closest('button, summary') && event.code === 'Space') return;
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Space', 'KeyF', 'KeyE'].includes(event.code)) return;
    event.preventDefault();
    sound.unlock();
    pressed.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') input.jumpPressed = true;
    if (event.code === 'KeyF') input.swingPressed = true;
    if (event.code === 'KeyE') input.interactPressed = true;
  }, options);

  addEventListener('keyup', (event) => pressed.delete(event.code), options);
  app.addEventListener('fatfish:room-open', () => {
    clearControls(true);
    queuedChat = undefined;
  }, options);
  app.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element) || !event.target.matches('[data-boss-input]')) return;
    pressed.clear();
    for (const [pointerId, control] of touch) {
      if (control !== 'cast') touch.delete(pointerId);
    }
    input.swingPressed = false;
    input.interactPressed = false;
    input.jumpPressed = false;
  }, options);
  function resizeComposer() {
    const viewport = window.visualViewport;
    const keyboardGap = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    app.style.setProperty('--chat-keyboard-gap', `${Math.round(keyboardGap)}px`);
  }
  window.visualViewport?.addEventListener('resize', resizeComposer, options);
  window.visualViewport?.addEventListener('scroll', resizeComposer, options);
  addEventListener('blur', () => clearControls(true), options);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearControls(true);
      queuedChat = undefined;
    }
    room.visibilityChanged();
  }, options);

  hud.canvas.addEventListener('pointermove', (event) => {
    if (canPlay() && !snapshot.shiftPaused && event.pointerType !== 'touch') aimPointer = { x: event.clientX, y: event.clientY };
  }, options);

  hud.canvas.addEventListener('pointerdown', (event) => {
    if (!canPlay() || snapshot.shiftPaused) return;
    sound.unlock();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('button, [data-boss-input]')) focused.blur();
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
    if (!canPlay() || snapshot.shiftPaused) return;
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>('[data-control]');
    const control = button?.dataset.control;
    if (!button || !control) return;
    sound.unlock();
    if (control === 'sound' || control === 'campaign-exit') return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touch.set(event.pointerId, control);
    if (control === 'cast') setCast(true);
    if (control === 'swing') input.swingPressed = true;
    if (control === 'interact') input.interactPressed = true;
    if (control === 'jump') input.jumpPressed = true;
    const build = buildControls.get(control);
    if (build) input.build = build;
    if (control === 'revive') input.revivePressed = true;
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
    if (!(event.target instanceof Element)) return;
    const shopItem = event.target.closest<HTMLButtonElement>('[data-shop-buy]')?.dataset.shopBuy;
    if (isShopItemId(shopItem) && canPlay() && !snapshot.shiftPaused) {
      input.buy = shopItem;
      return;
    }
    const control = event.target.closest<HTMLElement>('[data-control]')?.dataset.control;
    if (control === 'campaign-exit' && snapshot.campaign.phase === 'cleared') {
      if (room.status().mode === 'local') location.reload();
      else room.leave();
      return;
    }
    if (control === 'continue' && canPlay() && snapshot.shiftPaused) input.continuePressed = true;
    if (control === 'sound') {
      sound.unlock();
      toggleMute();
    }
  }, options);

  function direction(key: string, arrow: string, control: string) {
    return Number(pressed.has(key) || pressed.has(arrow) || [...touch.values()].includes(control));
  }

  const stepMs = STEP_SECONDS * 1000;
  let previous = performance.now();
  let sceneElapsed = 0;
  let accumulated = 0;
  let raf = 0;
  function frame(now: number) {
    const elapsedMs = Math.min(now - previous, 100);
    previous = now;
    accumulated += elapsedMs;
    if (!snapshot.shiftPaused) sceneElapsed += elapsedMs / 1000;

    while (accumulated >= stepMs) {
      const active = canPlay();
      input.moveX = active ? direction('KeyD', 'ArrowRight', 'right') - direction('KeyA', 'ArrowLeft', 'left') : 0;
      input.moveZ = active ? direction('KeyS', 'ArrowDown', 'down') - direction('KeyW', 'ArrowUp', 'up') : 0;
      if (active && !snapshot.shiftPaused && aimPointer) input.aim = scene.aim(aimPointer.x, aimPointer.y);
      input.chat = active ? queuedChat : undefined;
      queuedChat = undefined;

      const mode = room.status().mode;
      if (mode === 'local') sim.step(input);
      else if (mode === 'playing') room.step(input);
      const next = mode === 'local' ? sim.snapshot() : room.authoritative() ?? snapshot;
      if (next !== snapshot && next.player.id === snapshot.player.id && next.tick >= snapshot.tick) sound.update(snapshot, next);
      const pauseChanged = next.shiftPaused !== snapshot.shiftPaused;
      if (pauseChanged) clearControls();
      snapshot = next;
      input.castPressed = false;
      input.castReleased = false;
      input.swingPressed = false;
      input.interactPressed = false;
      input.jumpPressed = false;
      input.continuePressed = false;
      input.build = undefined;
      input.revivePressed = false;
      input.buy = undefined;
      accumulated = pauseChanged ? 0 : accumulated - stepMs;
    }

    if (snapshot !== lastUiSnapshot) {
      hud.update(snapshot);
      lastUiSnapshot = snapshot;
    }
    const status = room.status();
    displayed = status.mode === 'local' ? snapshot : room.present(now) ?? snapshot;
    const speaking = hud.isBossSpeaking();
    scene.render(displayed, sceneElapsed, speaking, status.mode === 'local' ? undefined : status.playerId);
    if (speaking) hud.setBossAnchor(scene.projectBossSpeech());
    raf = requestAnimationFrame(frame);
  }

  room.restore();
  raf = requestAnimationFrame(frame);
  import.meta.hot?.dispose(() => {
    events.abort();
    cancelAnimationFrame(raf);
    room.dispose();
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
