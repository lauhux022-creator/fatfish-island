import { normalizePlayerChat } from '../shared/fish-brain/chat';
import { ISLAND, PLAY, SHIFT } from '../shared/sim/config';
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
  desktop: '瞄准海上的浅金涟漪，按住左键蓄力，松手抛竿。',
  touch: '轻点浅金涟漪，按住「投／收」蓄力，松手抛竿。',
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
    case 'reeling': {
      const baitMultiplier = snapshot.fish.find((item) => item.id === hook.targetId)?.baitMultiplier ?? 1;
      return {
        title: baitMultiplier > 1 ? `活饵溢价 ×${baitMultiplier}` :
          hook.target === 'crate' ? '钩到箱子了！' : '鱼咬钩啦！',
        desktop: `连点鼠标左键，把${catchName}拽上岸。`,
        touch: `连点「投／收」，把${catchName}拽上岸。`,
        meter: hook.progress,
      };
    }
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

  const heldFish = fish.find((item) => item.id === player.carrying);
  if (heldFish) {
    return {
      title: heldFish.baitMultiplier > 1 ? `活饵溢价 ×${heldFish.baitMultiplier}，快上秤` : '把鱼扔进橙色秤盘',
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
      <section class="shift-kpi" aria-label="当日团队指标" data-kpi>
        <div class="shift-kpi-label">
          <span>团队指标</span>
          <strong><span data-team-revenue>¥0</span><span class="kpi-divider"> / </span><span data-team-target>—</span></strong>
        </div>
        <progress max="1" value="0" aria-label="团队指标完成进度" data-team-progress></progress>
      </section>
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
  <aside class="boss-bubble" aria-label="大肥鱼" data-boss-bubble role="status" hidden>
    <span data-boss-say></span>
  </aside>
  <dialog class="standings" id="standings" aria-labelledby="standings-title" data-standings hidden>
    <div class="standings-head">
      <h2 id="standings-title" data-standings-title></h2>
      <span class="standings-stamp" data-standings-stamp>已结算</span>
    </div>
    <table>
      <thead><tr><th scope="col">名次</th><th scope="col">打工人</th><th scope="col">尾数</th><th scope="col">渔获款</th></tr></thead>
      <tbody data-standings-rows></tbody>
    </table>
    <div class="settlement" data-settlement hidden>
      <div class="settlement-summary">
        <span>团队指标</span>
        <strong data-settlement-kpi></strong>
        <span class="settlement-status" data-settlement-status></span>
      </div>
      <p class="standings-note" data-standings-note></p>
      <p class="shift-interview" data-shift-interview role="status" hidden><b>大肥鱼</b><span data-shift-interview-say></span><small data-shift-interview-effect hidden></small></p>
      <button type="button" class="shift-continue" data-control="continue">开始下一班 <kbd>Enter</kbd></button>
    </div>
  </dialog>
  <aside class="task" aria-label="当前操作">
    <div class="task-mark" aria-hidden="true"><i></i></div>
    <div class="task-content">
      <strong data-task>渔场开门中</strong>
      <p class="desktop-guide" data-desktop></p>
      <p class="touch-guide" data-touch></p>
      <progress title="当前动作进度" max="1" value="0" hidden></progress>
    </div>
  </aside>
  <form class="boss-chat" id="boss-chat" data-boss-form hidden>
    <label for="boss-message">跟大肥鱼说</label>
    <div class="boss-chat-row">
      <input id="boss-message" data-boss-input type="text" autocomplete="off" maxlength="120" placeholder="求加价、拍拍马屁，或者告个状">
      <button type="submit" data-boss-send>递话</button>
    </div>
    <div class="boss-chat-info">
      <span data-boss-favor></span><span data-boss-status aria-live="off"></span>
    </div>
    <p class="boss-effect" data-boss-effect hidden></p>
    <p class="boss-memory" data-boss-memory hidden></p>
  </form>
  <div class="hud-foot">
    <div class="key-legend" aria-label="快捷键">
      <span><kbd>W A S D</kbd> 移动</span>
      <span><kbd>左键</kbd> 抛竿／收线</span>
      <span><kbd>F</kbd> 挥桨</span>
      <span><kbd>E</kbd> 搬／抢／扔</span>
      <span><kbd>空格</kbd> 跳</span>
    </div>
    <button class="boss-chat-toggle" type="button" aria-controls="boss-chat" aria-expanded="false" data-boss-chat-toggle>
      <kbd aria-hidden="true">T</kbd> 找老板
    </button>
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
          <li><b>队友饵</b> 朝队友甩钩，再瞄准海面点左键。活饵渔获售价更高，饵员拿不到绩效。</li>
        </ol>
        <ol class="touch-guide">
          <li><b>钓鱼</b> 点海面瞄准。长按抛竿，咬钩后连点收线。</li>
          <li><b>拍晕</b> 用方向键追上鱼，点鱼瞄准，按「挥桨」。</li>
          <li><b>交鱼</b> 靠近晕鱼按「搬／扔」，朝橙色秤盘再按一下。</li>
          <li><b>截胡</b> 靠近并瞄准别人手里或半空中的鱼，点「搬／扔」抢。</li>
          <li><b>队友饵</b> 点队友瞄准并甩钩，再点海面按「投／收」。活饵渔获售价更高，饵员拿不到绩效。</li>
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

export function createHud(root: HTMLElement, meta: HudMeta, sendChat: (text: string) => void) {
  root.classList.add('game');
  root.innerHTML = markup;

  const ui = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
  const canvas = ui<HTMLCanvasElement>('.world');
  const bossBubble = ui<HTMLElement>('[data-boss-bubble]');
  const bossSay = ui('[data-boss-say]');
  const bossToggle = ui<HTMLButtonElement>('[data-boss-chat-toggle]');
  const bossForm = ui<HTMLFormElement>('[data-boss-form]');
  const bossInput = ui<HTMLInputElement>('[data-boss-input]');
  const bossStatus = ui('[data-boss-status]');
  const bossFavor = ui('[data-boss-favor]');
  const bossMemory = ui<HTMLElement>('[data-boss-memory]');
  const bossEffect = ui<HTMLElement>('[data-boss-effect]');
  const interview = ui<HTMLElement>('[data-shift-interview]');
  const interviewSay = ui('[data-shift-interview-say]');
  const interviewEffect = ui<HTMLElement>('[data-shift-interview-effect]');
  const task = ui<HTMLElement>('.task');
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
  const kpi = ui<HTMLElement>('[data-kpi]');
  const teamRevenue = ui('[data-team-revenue]');
  const teamTarget = ui('[data-team-target]');
  const teamProgress = ui<HTMLProgressElement>('[data-team-progress]');
  const standings = ui<HTMLDialogElement>('[data-standings]');
  const toggle = ui<HTMLButtonElement>('[data-standings-toggle]');
  const standingsTitle = ui('[data-standings-title]');
  const stamp = ui<HTMLElement>('[data-standings-stamp]');
  const standingsRows = ui<HTMLTableSectionElement>('[data-standings-rows]');
  const settlement = ui<HTMLElement>('[data-settlement]');
  const settlementKpi = ui('[data-settlement-kpi]');
  const settlementStatus = ui('[data-settlement-status]');
  const continueButton = ui<HTMLButtonElement>('[data-control="continue"]');
  let roomCode = '';
  let previousBoard = '';
  let boardPinned = false;
  let latest: SimSnapshot | undefined;
  let lastLineId: number | undefined;
  let speakUntil = 0;
  let composing = false;

  function setChatOpen(open: boolean) {
    bossForm.hidden = !open;
    bossToggle.setAttribute('aria-expanded', String(open));
    task.hidden = open;
  }

  function focusChat() {
    if (!latest || latest.shiftPaused || root.dataset.roomMode === 'spectating') return false;
    setChatOpen(true);
    bossInput.focus();
    return true;
  }

  bossToggle.addEventListener('click', () => {
    if (bossForm.hidden) focusChat();
    else setChatOpen(false);
  });
  bossInput.addEventListener('compositionstart', () => { composing = true; });
  bossInput.addEventListener('compositionend', () => { composing = false; });
  bossForm.addEventListener('keydown', (event) => {
    if (composing || event.isComposing || event.key !== 'Escape') return;
    event.preventDefault();
    setChatOpen(false);
    bossToggle.focus();
  });
  bossForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (composing || !latest || latest.shiftPaused) return;
    const text = normalizePlayerChat(bossInput.value);
    if (!text) {
      bossInput.focus();
      return;
    }
    sendChat(text);
    bossInput.value = '';
    bossInput.blur();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && bossForm.contains(focused)) focused.blur();
    writeText(bossStatus, '已递话');
  });

  function updateBoss(snapshot: SimSnapshot) {
    const { boss, shiftPaused } = snapshot;
    const line = boss.line;
    if (line && line.id !== lastLineId) {
      lastLineId = line.id;
      speakUntil = performance.now() + 7600;
      Object.assign(bossBubble.dataset, {
        lineId: String(line.id),
        emotion: line.emotion,
        trigger: line.trigger,
        action: line.action,
      });
      writeText(bossSay, line.say);
    }
    bossBubble.hidden = !line || shiftPaused || performance.now() >= speakUntil;
    if (shiftPaused && !bossForm.hidden) setChatOpen(false);
    const meeting = shiftPaused && boss.interview?.day === snapshot.day ? boss.interview : null;
    const meetingPending = shiftPaused && boss.pending;
    interview.hidden = !meeting && !meetingPending;
    if (!interview.hidden) {
      interview.dataset.emotion = meeting?.emotion ?? 'calm';
      writeText(interviewSay, meeting?.say ?? '正在对账…');
      interviewEffect.hidden = !meeting?.effect;
      if (meeting?.effect) writeText(interviewEffect, meeting.effect);
    }
    if (bossForm.hidden) return;
    const effect = line?.trigger === 'chat' ? line.effect : '';
    bossEffect.hidden = !effect;
    if (effect) writeText(bossEffect, effect);
    const bait = snapshot.player.giftedBait ? ' · 已备加急饵' : '';
    writeText(bossFavor, `好感 ${boss.favor > 0 ? '+' : ''}${boss.favor}${bait}`);
    const cooldown = Math.max(0, Math.ceil(boss.cooldownSeconds));
    const wait = cooldown ? `${cooldown} 秒后可回话` : '';
    writeText(bossStatus, boss.pending ? (cooldown ? `等老板 · ${cooldown} 秒` : '等老板回话…') : wait);
    bossMemory.hidden = !boss.memory;
    if (boss.memory) writeText(bossMemory, boss.memory);
  }

  function setBossAnchor(point: { x: number; y: number }) {
    const width = bossBubble.offsetWidth;
    const gutter = width / 2 + 8;
    const x = Math.max(gutter, Math.min(root.clientWidth - gutter, point.x));
    const y = Math.max(bossBubble.offsetHeight + 12, point.y);
    const tail = Math.max(14, Math.min(width - 14, point.x - x + width / 2));
    bossBubble.style.setProperty('--boss-x', `${Math.round(x)}px`);
    bossBubble.style.setProperty('--boss-y', `${Math.round(y)}px`);
    bossBubble.style.setProperty('--boss-tail', `${Math.round(tail)}px`);
  }

  const speedPenalty = Math.round((1 - SHIFT.optimizationSpeed) * 100);
  writeText(ui('[data-standings-note]'), `待优化次日移速 −${speedPenalty}%`);

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
      if (entry.bonus || entry.optimization || entry.fine) {
        const award = document.createElement('small');
        award.className = entry.bonus ? 'earnings-badge' : 'optimization-badge';
        award.textContent = entry.bonus ? `奖金 +¥${entry.bonus}` :
          entry.fine ? `待优化 −¥${entry.fine}` : '明日待优化';
        name.append(award);
      }
      row.insertCell().textContent = String(entry.sold);
      row.insertCell().textContent = `¥${entry.revenue}`;
      return row;
    });
    standingsRows.replaceChildren(...rows);
  }

  function updateKpi({ teamRevenue: total, teamTarget: target }: SimSnapshot) {
    writeText(teamRevenue, `¥${total}`);
    writeText(teamTarget, `¥${target}`);
    const value = Math.min(total, target);
    if (teamProgress.max !== target) teamProgress.max = target;
    if (teamProgress.value !== value) teamProgress.value = value;
    const met = String(total >= target);
    if (kpi.dataset.met !== met) kpi.dataset.met = met;
  }

  function updateStandings(snapshot: SimSnapshot) {
    const { result, players, player, shiftPaused, teamRevenue, teamTarget } = snapshot;
    const settled = shiftPaused ? result : null;
    const spectator = root.dataset.roomMode === 'spectating' || root.dataset.roomMode === 'reconnecting';
    const modal = shiftPaused && !spectator && !root.querySelector('[data-room-dialog][open]');
    if (shiftPaused && !spectator) boardPinned = false;
    const visible = (shiftPaused && !spectator) || boardPinned;
    continueButton.hidden = spectator;
    if (standings.open && (!visible || standings.matches(':modal') !== modal)) standings.close();
    if (standings.hidden === visible) {
      standings.hidden = !visible;
      toggle.setAttribute('aria-expanded', String(visible));
    }
    if (!visible) return;

    const ranking = settled?.ranking ?? [...players]
      .sort((a, b) => b.shiftCash - a.shiftCash || b.shiftSold - a.shiftSold)
      .map(({ id, name, bot, shiftCash, shiftSold }, index) => ({
        id, name, bot, rank: index + 1, revenue: shiftCash, sold: shiftSold, bonus: 0, fine: 0, optimization: false,
      }));
    const displayDay = settled?.day ?? snapshot.day;
    const key = JSON.stringify([displayDay, Boolean(settled), teamRevenue, teamTarget, ranking]);
    if (key !== previousBoard) {
      previousBoard = key;
      standings.dataset.day = String(displayDay);
      standings.dataset.settled = String(Boolean(settled));
      writeText(standingsTitle, `第 ${displayDay} 天绩效榜`);
      stamp.hidden = !settled;
      settlement.hidden = !settled;
      if (settled) {
        writeText(settlementKpi, `¥${teamRevenue} / ¥${teamTarget}`);
        writeText(settlementStatus, teamRevenue >= teamTarget ? '达标' : '未达标');
        settlementStatus.classList.toggle('met', teamRevenue >= teamTarget);
      }
      fillStandings(ranking, spectator ? '' : player.id);
    }
    if (!standings.open) {
      if (modal) standings.showModal();
      else standings.show();
    }
  }

  toggle.addEventListener('click', () => {
    if (!latest || (latest.shiftPaused && root.dataset.roomMode !== 'spectating' && root.dataset.roomMode !== 'reconnecting')) return;
    boardPinned = !boardPinned;
    updateStandings(latest);
  });
  standings.addEventListener('cancel', (event) => event.preventDefault());

  writeText(ui('[data-version]'), meta.version);
  writeText(ui('[data-commit]'), meta.commit);
  debug.hidden = !meta.debug;
  manual.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') manual.open = false;
  });

  let lastNotice: number | null = null;
  let noticeUntil = 0;

  function update(snapshot: SimSnapshot) {
    const nextRoomCode = root.dataset.roomCode ?? '';
    if (roomCode !== nextRoomCode) {
      roomCode = nextRoomCode;
      lastLineId = undefined;
      lastNotice = null;
      speakUntil = 0;
      previousBoard = '';
      boardPinned = false;
      if (!bossForm.hidden) setChatOpen(false);
    }
    if (root.dataset.roomMode === 'spectating' && !bossForm.hidden) setChatOpen(false);
    const { hook, player, fish, crates, notice: event, tick, time } = snapshot;
    if (root.dataset.ready !== 'true') root.dataset.ready = 'true';
    latest = snapshot;
    const seconds = Math.max(0, Math.ceil(snapshot.shiftRemaining));
    writeText(day, `第 ${snapshot.day} 天`);
    writeText(clock, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    updateKpi(snapshot);
    updateBoss(snapshot);
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

    if (!meta.debug) return;
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
      shiftPaused: String(snapshot.shiftPaused),
      teamRevenue: String(snapshot.teamRevenue),
      teamTarget: String(snapshot.teamTarget),
      interference: String(player.metrics.interference),
      paddleHits: String(player.metrics.paddleHits),
      fishStolen: String(player.metrics.fishStolen),
      knockdowns: String(player.metrics.knockdowns),
      playerFishEscaped: String(player.metrics.fishEscaped),
      playerFishIncidents: String(player.metrics.fishIncidents),
      fishEscaped: String(snapshot.metrics.fishEscaped),
      fishTransferred: String(snapshot.metrics.fishTransferred),
      fishIncidents: String(snapshot.metrics.fishIncidents),
      bossFavor: String(snapshot.boss.favor),
      bossAction: snapshot.boss.line?.action ?? '',
      bossCooldown: snapshot.boss.cooldownSeconds.toFixed(2),
      players: snapshot.players.map(({ id, shiftCash, shiftSold }) => `${id}:${shiftCash}/${shiftSold}`).join(','),
    });
    const entities = [...fish.filter((item) => item.state !== 'swimming'), ...crates];
    writeText(debugText, [
      `seed ${meta.seed}   tick ${tick}   ${time.toFixed(1)} s`,
      `人 ${position(player.position)}${player.ragdoll ? `   倒地 ${player.ragdoll.toFixed(1)} s` : ''}`,
      `钩 ${hook.phase}${hook.targetId ? ` · ${hook.targetId}` : ''}`,
      `个人 干扰 ${player.metrics.interference} · 被抢 ${player.metrics.fishStolen} · 挨桨 ${player.metrics.paddleHits} · 倒地 ${player.metrics.knockdowns}`,
      `个人渔获 逃跑 ${player.metrics.fishEscaped} · 涉鱼 ${player.metrics.fishIncidents}`,
      `全队 逃跑 ${snapshot.metrics.fishEscaped} · 易手 ${snapshot.metrics.fishTransferred} · 涉鱼 ${snapshot.metrics.fishIncidents}`,
      `老板 好感 ${snapshot.boss.favor} · 鱼价 ×${snapshot.boss.priceMultiplier.toFixed(2)}${player.giftedBait ? ' · 加急饵' : ''}`,
      ...snapshot.players.filter((member) => member.bot).map((member) =>
        `${member.name} ${position(member.position)} ¥${member.shiftCash} ${member.hook.phase} 干扰 ${member.metrics.interference}`),
      ...entities.map((item) => `${item.id} ${item.state} ${position(item.position)}`),
    ].join('\n'));
  }

  function setError(message: string) {
    error.hidden = false;
    writeText(error, message);
  }

  return { canvas, update, setError, focusChat, setBossAnchor, isBossSpeaking: () => !bossBubble.hidden };
}
