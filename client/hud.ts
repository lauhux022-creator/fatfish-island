import { ISLAND, PLAY } from '../shared/sim/config';
import type { FishView, ShiftEntry, SimSnapshot } from '../shared/sim/types';
import { crewColor } from './crew-colors';

interface HudMeta {
  version: string;
  commit: string;
  seed: string;
  debug: boolean;
}

interface Guide {
  title: string;
  desktop: string;
  touch: string;
  meter?: number;
}

const firstCast: Guide = {
  title: '上工了，先甩一竿',
  desktop: '瞄准海面，按住鼠标左键蓄力，松手抛竿。',
  touch: '轻点海面瞄准，按住「投／收」蓄力，松手抛竿。',
};

const nextCast: Guide = {
  ...firstCast,
  title: '鱼款到手，再甩一竿',
};

function fishingGuide(snapshot: SimSnapshot): Guide | undefined {
  const { hook } = snapshot;
  const catchName = hook.target === 'crate' ? '箱子' : '鱼';

  switch (hook.phase) {
    case 'charging':
      return { title: '蓄力中', desktop: '松开左键抛竿', touch: '松开「投／收」抛竿', meter: hook.charge };
    case 'flying':
      return hook.target === 'player'
        ? { title: '队友饵起飞！', desktop: '', touch: '' }
        : { title: '鱼钩在飞', desktop: '', touch: '' };
    case 'bait':
      return {
        title: '钩到队友了！',
        desktop: '瞄准海面，再点左键把队友甩出去。',
        touch: '轻点海面瞄准，再按「投／收」把队友甩出去。',
      };
    case 'waiting':
      return { title: '鱼在开会，等等', desktop: '浮标沉下去就开始收线。', touch: '浮标沉下去就开始收线。' };
    case 'bite':
    case 'reeling':
      return {
        title: hook.target === 'crate' ? '钩到箱子了！' : '鱼咬钩啦！',
        desktop: `连点鼠标左键，把${catchName}拽上岸。`,
        touch: `连点「投／收」，把${catchName}拽上岸。`,
        meter: hook.progress,
      };
    case 'idle':
      return undefined;
  }
}

function guideFor(snapshot: SimSnapshot): Guide {
  const { player, fish, sold } = snapshot;
  if (player.ragdoll > 0) {
    return {
      title: player.baitedBy ? '今天你是鱼饵' : '工伤休息中',
      desktop: '站起来就能继续干活。',
      touch: '站起来就能继续干活。',
      meter: player.ragdoll / PLAY.ragdollSeconds,
    };
  }

  if (player.baitedBy) {
    return { title: '你被队友钩住了！', desktop: '', touch: '' };
  }

  if (player.carrying && fish.some((item) => item.id === player.carrying)) {
    return {
      title: '把鱼扔进橙色秤盘',
      desktop: '走到秤前，朝秤盘按 E 抛鱼。',
      touch: '走到秤前，轻点秤盘瞄准，再按「搬／扔」。',
    };
  }

  if (player.carrying) {
    return {
      title: '箱子只能搬，不能卖',
      desktop: '朝空地按 E 把箱子扔出去。',
      touch: '点空地瞄准，再按「搬／扔」。',
    };
  }

  const fishing = fishingGuide(snapshot);
  if (fishing) return fishing;

  const distanceTo = (item: FishView) =>
    Math.hypot(item.position.x - player.position.x, item.position.z - player.position.z);
  const nearby = (item: FishView) => distanceTo(item) < 4.5 && item.position.z >= ISLAND.shoreZ - 0.6;
  if (fish.some((item) => item.state === 'stunned' && nearby(item))) {
    return {
      title: '趁鱼晕着，快抬走',
      desktop: '走近晕鱼，按 E 抬鱼。',
      touch: '走近晕鱼，按「搬／扔」抬鱼。',
    };
  }

  if (fish.some((item) => (item.state === 'carried' || item.state === 'thrown') &&
      distanceTo(item) < PLAY.reach && Math.abs(item.position.y - player.position.y) < 1.65)) {
    return {
      title: '有鱼可以截胡',
      desktop: '朝鱼靠近，按 E 抢鱼。',
      touch: '点鱼瞄准，再按「搬／扔」抢鱼。',
    };
  }

  if (fish.some((item) => item.state === 'flopping' && nearby(item))) {
    return {
      title: '鱼要跑路！',
      desktop: '追上去，瞄准鱼按 F 挥桨。',
      touch: '追上去，轻点鱼瞄准，再按「挥桨」。',
    };
  }

  return sold > 0 ? nextCast : firstCast;
}

const markup = `
  <canvas class="world" aria-label="黑心渔场三维游戏画面"></canvas>
  <div class="edge-shade" aria-hidden="true"></div>
  <header class="hud-head">
    <div class="identity">
      <div class="brand-sign">
        <span class="brand-mark" aria-hidden="true"><i></i></span>
        <h1><small>大肥鱼的</small>黑心渔场</h1>
      </div>
      <p class="shift-strip"><span data-day>第 — 天</span><i></i><span>下班 <time data-clock>—:—</time></span></p>
    </div>
    <div class="account">
      <section class="ledger" aria-label="渔场账本">
        <div class="money"><span>累计入账</span><strong data-cash>¥0</strong></div>
        <div class="sales"><span>已交渔获</span><strong data-sold>0 <small>尾</small></strong></div>
      </section>
      <button class="board-toggle" type="button" aria-controls="standings" aria-expanded="false" data-standings-toggle>绩效榜</button>
    </div>
  </header>
  <p class="notice" data-notice role="status" hidden></p>
  <aside class="standings" id="standings" aria-labelledby="standings-title" data-standings hidden>
    <div class="standings-head">
      <h2 id="standings-title" data-standings-title></h2>
      <span class="standings-stamp" data-standings-stamp>已结算</span>
    </div>
    <table>
      <thead><tr><th scope="col">名次</th><th scope="col">打工人</th><th scope="col">尾数</th><th scope="col">渔获款</th></tr></thead>
      <tbody data-standings-rows></tbody>
    </table>
    <p class="standings-note" data-standings-note>待优化次日移速 −10%</p>
  </aside>
  <aside class="task" aria-label="当前操作">
    <div class="task-mark" aria-hidden="true"><i></i></div>
    <div class="task-content">
      <strong data-task>渔场开门中</strong>
      <p class="desktop-guide" data-desktop></p>
      <p class="touch-guide" data-touch></p>
      <progress title="当前动作进度" max="1" value="0" hidden></progress>
    </div>
  </aside>
  <div class="hud-foot">
    <div class="key-legend" aria-label="快捷键">
      <span><kbd>W A S D</kbd> 移动</span>
      <span><kbd>左键</kbd> 抛竿／收线</span>
      <span><kbd>F</kbd> 挥桨</span>
      <span><kbd>E</kbd> 搬／抢／扔</span>
      <span><kbd>空格</kbd> 跳</span>
    </div>
    <button class="sound" type="button" data-control="sound" aria-pressed="false" title="静音">静音</button>
    <details class="manual">
      <summary><b aria-hidden="true">?</b> 操作指南</summary>
      <div class="manual-page">
        <h2>码头操作指南</h2>
        <ol class="desktop-guide">
          <li><b>钓鱼</b> 移动鼠标瞄准。左键长按抛竿，咬钩后连点左键收线。</li>
          <li><b>拍晕</b> WASD 追上鱼，瞄准后按 F 或右键挥桨，空格跳起还能接一桨。</li>
          <li><b>交鱼</b> 靠近晕鱼按 E 抬起，朝橙色秤盘按 E 扔进去。</li>
          <li><b>截胡</b> 靠近别人手里的鱼或半空中的鱼，朝鱼按 E 抢。</li>
          <li><b>队友饵</b> 朝队友甩钩，再瞄准海面点左键。大鱼上钩后，鱼饵本人拿不到绩效。</li>
        </ol>
        <ol class="touch-guide">
          <li><b>钓鱼</b> 点海面瞄准。长按抛竿，咬钩后连点收线。</li>
          <li><b>拍晕</b> 用方向键追上鱼，点鱼瞄准，按「挥桨」。</li>
          <li><b>交鱼</b> 靠近晕鱼按「搬／扔」，朝橙色秤盘再按一下。</li>
          <li><b>截胡</b> 靠近并瞄准别人手里或半空中的鱼，点「搬／扔」抢。</li>
          <li><b>队友饵</b> 点队友瞄准并甩钩，再点海面按「投／收」。鱼饵本人拿不到绩效。</li>
        </ol>
        <p>桨能把队友拍飞，躺两秒就能起来。鱼钩也能勾海上的木箱。</p>
      </div>
    </details>
  </div>
  <div class="touch-controls" aria-label="触屏控制">
    <div class="dpad">
      <button type="button" data-control="up" aria-label="向前">▲</button>
      <button type="button" data-control="left" aria-label="向左">◀</button>
      <button type="button" data-control="down" aria-label="向后">▼</button>
      <button type="button" data-control="right" aria-label="向右">▶</button>
    </div>
    <div class="touch-actions">
      <button type="button" data-control="cast">投／收</button>
      <button type="button" data-control="swing">挥桨</button>
      <button type="button" data-control="interact">搬／扔</button>
      <button type="button" data-control="jump">跳</button>
    </div>
  </div>
  <p class="build-info"><span data-version></span><span data-commit></span></p>
  <aside class="debug" data-debug aria-label="调试状态" hidden>
    <h2>调试面板</h2>
    <pre data-debug-text></pre>
  </aside>
  <p class="startup-error" data-error role="alert" hidden></p>
`;

function writeText(node: Element, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

function position({ x, y, z }: SimSnapshot['player']['position']) {
  return `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
}

export function createHud(root: HTMLElement, meta: HudMeta) {
  root.classList.add('game');
  root.innerHTML = markup;

  const ui = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
  const canvas = ui<HTMLCanvasElement>('.world');
  const day = ui('[data-day]');
  const cash = ui('[data-cash]');
  const sold = ui('[data-sold]');
  const count = sold.firstChild!;
  const title = ui('[data-task]');
  const desktop = ui<HTMLParagraphElement>('[data-desktop]');
  const touch = ui<HTMLParagraphElement>('[data-touch]');
  const meter = ui<HTMLProgressElement>('progress');
  const notice = ui<HTMLParagraphElement>('[data-notice]');
  const error = ui<HTMLParagraphElement>('[data-error]');
  const debug = ui<HTMLElement>('[data-debug]');
  const debugText = ui('[data-debug-text]');
  const manual = ui<HTMLDetailsElement>('.manual');
  const clock = ui<HTMLTimeElement>('[data-clock]');
  const standings = ui<HTMLElement>('[data-standings]');
  const toggle = ui<HTMLButtonElement>('[data-standings-toggle]');
  const standingsTitle = ui('[data-standings-title]');
  const stamp = ui<HTMLElement>('[data-standings-stamp]');
  const standingsNote = ui<HTMLElement>('[data-standings-note]');
  const standingsRows = ui<HTMLTableSectionElement>('[data-standings-rows]');
  let previousBoard = '';
  let boardPinned = false;
  let dismissedDay = 0;
  let latest: SimSnapshot | undefined;

  function fillStandings(ranking: ShiftEntry[], ownId: string) {
    const rows = ranking.map((entry) => {
      const row = document.createElement('tr');
      row.dataset.playerId = entry.id;
      row.classList.toggle('self-row', entry.id === ownId);
      row.insertCell().textContent = String(entry.rank);
      const name = row.insertCell();
      const swatch = document.createElement('i');
      swatch.className = 'crew-dot';
      swatch.style.background = crewColor(entry.id);
      name.append(swatch, entry.name);
      if (entry.bonus || entry.optimization) {
        const award = document.createElement('small');
        award.className = entry.bonus ? 'earnings-badge' : 'optimization-badge';
        award.textContent = entry.bonus ? `年终奖 +¥${entry.bonus}` : '明日待优化';
        name.append(award);
      }
      row.insertCell().textContent = String(entry.sold);
      row.insertCell().textContent = `¥${entry.revenue}`;
      return row;
    });
    standingsRows.replaceChildren(...rows);
  }

  function updateStandings(snapshot: SimSnapshot) {
    const { result, players, player, time } = snapshot;
    const settled = result && time < result.showUntil && result.day !== dismissedDay ? result : null;
    const visible = !!settled || boardPinned;
    const hidden = !visible;
    if (standings.hidden !== hidden) {
      standings.hidden = hidden;
      toggle.setAttribute('aria-expanded', String(visible));
    }
    if (hidden) return;

    const ranking = settled?.ranking ?? [...players]
      .sort((a, b) => b.shiftCash - a.shiftCash || b.shiftSold - a.shiftSold)
      .map(({ id, name, bot, shiftCash, shiftSold }, index) => ({
        id, name, bot, rank: index + 1, revenue: shiftCash, sold: shiftSold, bonus: 0, optimization: false,
      }));
    const displayDay = settled?.day ?? snapshot.day;
    const key = JSON.stringify([displayDay, Boolean(settled), ranking]);
    if (key === previousBoard) return;

    previousBoard = key;
    standings.dataset.day = String(displayDay);
    standings.dataset.settled = String(Boolean(settled));
    writeText(standingsTitle, `第 ${displayDay} 天绩效榜`);
    stamp.hidden = !settled;
    standingsNote.hidden = !settled;
    fillStandings(ranking, player.id);
  }

  toggle.addEventListener('click', () => {
    if (!latest) return;
    boardPinned = standings.hidden;
    if (!boardPinned) dismissedDay = latest.result?.day ?? 0;
    updateStandings(latest);
  });

  writeText(ui('[data-version]'), meta.version);
  writeText(ui('[data-commit]'), meta.commit);
  debug.hidden = !meta.debug;
  manual.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') manual.open = false;
  });

  let lastNotice: number | null = null;
  let noticeUntil = 0;
  let debugTick = -1;

  function update(snapshot: SimSnapshot) {
    const { hook, player, fish, crates, notice: event, tick, time } = snapshot;
    if (root.dataset.ready !== 'true') root.dataset.ready = 'true';
    latest = snapshot;
    const seconds = Math.max(0, Math.ceil(snapshot.shiftRemaining));
    writeText(day, `第 ${snapshot.day} 天`);
    writeText(clock, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    updateStandings(snapshot);
    writeText(cash, `¥${snapshot.cash}`);
    const soldCount = `${snapshot.sold} `;
    if (count.textContent !== soldCount) count.textContent = soldCount;

    const guide = guideFor(snapshot);
    writeText(title, guide.title);
    writeText(desktop, guide.desktop);
    writeText(touch, guide.touch);
    desktop.classList.toggle('empty-guide', !guide.desktop);
    touch.classList.toggle('empty-guide', !guide.touch);
    meter.hidden = guide.meter === undefined;
    if (guide.meter !== undefined) meter.value = Math.max(0, Math.min(1, guide.meter));

    if (event && event.id !== lastNotice) {
      lastNotice = event.id;
      noticeUntil = time + 3.6;
      writeText(notice, event.text);
      notice.dataset.tone = event.tone;
    }
    notice.hidden = !event || time >= noticeUntil;

    if (!meta.debug || debugTick === tick) return;
    debugTick = tick;
    Object.assign(debug.dataset, {
      tick: String(tick),
      day: String(snapshot.day),
      cash: String(snapshot.cash),
      sold: String(snapshot.sold),
      hook: hook.phase,
      hookTarget: hook.target ?? '',
      x: String(player.position.x),
      y: String(player.position.y),
      z: String(player.position.z),
      carrying: player.carrying ?? '',
      ragdoll: String(player.ragdoll),
      ragdollParts: String(player.parts.length),
      fishStates: fish.map((item) => `${item.kind}:${item.state}`).join(','),
      crateStates: crates.map((item) => `${item.id}:${item.state}`).join(','),
      shiftRemaining: snapshot.shiftRemaining.toFixed(2),
      players: snapshot.players.map(({ id, shiftCash, shiftSold }) => `${id}:${shiftCash}/${shiftSold}`).join(','),
    });
    const entities = [...fish.filter((item) => item.state !== 'swimming'), ...crates];
    writeText(debugText, [
      `seed ${meta.seed}   tick ${tick}   ${time.toFixed(1)} s`,
      `人 ${position(player.position)}${player.ragdoll ? `   倒地 ${player.ragdoll.toFixed(1)} s` : ''}`,
      `钩 ${hook.phase}${hook.targetId ? ` · ${hook.targetId}` : ''}`,
      ...snapshot.players.filter((member) => member.bot).map((member) =>
        `${member.name} ${position(member.position)} ¥${member.shiftCash} ${member.hook.phase}`),
      ...entities.map((item) => `${item.id} ${item.state} ${position(item.position)}`),
    ].join('\n'));
  }

  function setError(message: string) {
    error.hidden = false;
    writeText(error, message);
  }

  return { canvas, update, setError };
}
