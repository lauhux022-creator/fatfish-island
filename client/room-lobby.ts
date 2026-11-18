import { ROOM_CODE_PATTERN, ROOM_MAX_NAME, ROOM_SOCKET_PATH } from '../shared/net/types';
import type { RoomClientStatus, RoomConnectIntent } from './net/room-client';

const markup = `
  <div class="room-dialog-head">
    <div>
      <h2 id="room-dialog-title">码头房间</h2>
      <p>2–4 人同班，空位由机器人代班。</p>
    </div>
    <button type="button" class="room-dismiss" aria-label="关闭房间面板" data-room-dismiss>×</button>
  </div>
  <form class="room-form" data-room-form>
    <label>工牌名<input type="text" maxlength="${ROOM_MAX_NAME}" autocomplete="off" placeholder="打工人" data-room-name></label>
    <div class="room-form-actions">
      <button type="button" class="room-create" data-room-create>创建房间</button>
      <label class="room-code-field">房间码<input type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"
        autocomplete="off" placeholder="4 位数字" data-room-code-input required></label>
      <button type="submit" data-room-join>加入</button>
    </div>
    <details class="room-address" data-room-address>
      <summary>房间服务地址</summary>
      <label><span class="sr-only">房间服务地址</span><input type="url" inputmode="url" autocomplete="off"
        placeholder="wss://…" data-room-endpoint></label>
    </details>
  </form>
  <section class="room-joined" aria-label="房间信息" data-room-joined hidden>
    <div class="room-slip">
      <div><span>房间码</span><output data-room-display-code></output></div>
      <div class="room-slip-meta">
        <strong data-room-crew></strong>
        <span data-room-role></span>
      </div>
    </div>
    <button type="button" data-room-copy>复制房间码</button>
    <button type="button" class="room-leave" data-room-leave>离开房间</button>
  </section>
  <p class="room-feedback" data-room-feedback role="status"></p>
`;

function defaultEndpoint() {
  const configured = import.meta.env.VITE_ROOM_URL?.trim();
  if (configured) return configured;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!import.meta.env.DEV && !loopback) return '';
  const url = new URL(ROOM_SOCKET_PATH, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function roomEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (location.protocol === 'https:' && url.protocol !== 'wss:') return null;
    if (url.pathname === '/') url.pathname = ROOM_SOCKET_PATH;
    return url.href;
  } catch {
    return null;
  }
}

export function createRoomLobby(
  app: HTMLElement,
  controls: { connect(intent: RoomConnectIntent): void; leave(): void },
) {
  const tools = document.createElement('div');
  tools.className = 'account-tools';
  const account = app.querySelector<HTMLElement>('.account')!;
  const standings = account.querySelector<HTMLButtonElement>('[data-standings-toggle]')!;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'board-toggle room-toggle';
  toggle.dataset.roomToggle = '';
  toggle.setAttribute('aria-controls', 'room-dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '联机';
  tools.append(standings, toggle);
  account.append(tools);

  const status = document.createElement('p');
  status.className = 'room-status';
  status.dataset.roomStatus = '';
  status.setAttribute('role', 'status');
  status.hidden = true;
  account.append(status);

  const dialog = document.createElement('dialog');
  dialog.id = 'room-dialog';
  dialog.className = 'room-dialog';
  dialog.dataset.roomDialog = '';
  dialog.setAttribute('aria-labelledby', 'room-dialog-title');
  dialog.innerHTML = markup;
  app.append(dialog);

  const find = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  const form = find<HTMLFormElement>('[data-room-form]');
  const joined = find<HTMLElement>('[data-room-joined]');
  const endpoint = find<HTMLInputElement>('[data-room-endpoint]');
  const address = find<HTMLDetailsElement>('[data-room-address]');
  const name = find<HTMLInputElement>('[data-room-name]');
  const code = find<HTMLInputElement>('[data-room-code-input]');
  const create = find<HTMLButtonElement>('[data-room-create]');
  const join = find<HTMLButtonElement>('[data-room-join]');
  const feedback = find<HTMLElement>('[data-room-feedback]');
  const displayCode = find<HTMLOutputElement>('[data-room-display-code]');
  const count = find<HTMLElement>('[data-room-crew]');
  const role = find<HTMLElement>('[data-room-role]');
  endpoint.value = defaultEndpoint();
  address.open = !endpoint.value;
  let mode: RoomClientStatus['mode'] = 'local';
  let lastUpdate = '';

  function connect(roomCode?: string) {
    const url = roomEndpoint(endpoint.value.trim());
    if (!url) {
      feedback.textContent = location.protocol === 'https:' ? '请填写有效的 wss:// 房间服务地址。' : '请填写有效的房间服务地址。';
      address.open = true;
      endpoint.focus();
      return;
    }
    const workerName = [...name.value.trim()].slice(0, ROOM_MAX_NAME).join('') || '打工人';
    feedback.textContent = '';
    controls.connect({ url, name: workerName, code: roomCode });
  }

  toggle.addEventListener('click', () => {
    if (dialog.open) return;
    app.dispatchEvent(new Event('fatfish:room-open'));
    dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
  });
  dialog.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
  find<HTMLButtonElement>('[data-room-dismiss]').addEventListener('click', () => dialog.close());
  create.addEventListener('click', () => connect());
  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 4); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ROOM_CODE_PATTERN.test(code.value)) connect(code.value);
  });
  find<HTMLButtonElement>('[data-room-leave]').addEventListener('click', () => {
    controls.leave();
    dialog.close();
  });
  find<HTMLButtonElement>('[data-room-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(displayCode.value);
      feedback.textContent = '房间码已复制。';
    } catch {
      feedback.textContent = `房间码 ${displayCode.value}`;
    }
  });

  function update(next: RoomClientStatus) {
    const key = JSON.stringify([next.mode, next.code, next.humans, next.error, next.brain]);
    if (key === lastUpdate) return;
    lastUpdate = key;
    const previousMode = mode;
    mode = next.mode;
    app.dataset.roomMode = mode;
    app.dataset.roomCode = next.code ?? '';
    const waiting = mode === 'connecting';
    const active = mode === 'playing' || mode === 'spectating';
    const inRoom = Boolean(next.code) && (active || mode === 'reconnecting');
    const spectating = mode === 'spectating';
    if (active && mode !== previousMode && dialog.open) dialog.close();

    form.hidden = inRoom;
    joined.hidden = !inRoom;
    create.disabled = waiting;
    join.disabled = waiting;
    displayCode.value = next.code ?? '';
    count.textContent = `${next.humans} / 4 在岗`;
    role.textContent = spectating ? '只读观战' : mode === 'reconnecting' ? '连接中断' : '联机值班';
    status.hidden = mode === 'local' && !next.error;
    status.dataset.mode = mode;
    status.textContent = mode === 'local' ? next.error ?? '' : mode === 'reconnecting' ? '正在重连…' : waiting ? '正在连接…'
      : spectating ? `观战 · 房间 ${next.code}` : `房间 ${next.code} · ${next.humans}/4`;
    toggle.textContent = inRoom ? '房间' : '联机';
    feedback.textContent = next.error || (waiting ? '正在联系码头…'
      : mode === 'reconnecting' ? '连接恢复后会进入观战。'
      : spectating ? '跟随原工位，机器人已接手。'
      : inRoom ? '把房间码发给在同一服务地址的队友。'
      : endpoint.value ? '' : '填写房间服务地址即可联机。关闭后可继续本地试玩。');
  }

  return { update };
}
