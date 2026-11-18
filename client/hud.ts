import { ISLAND, PLAY } from '../shared/sim/config';
import type { FishView, SimSnapshot } from '../shared/sim/types';

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
      return { title: '鱼钩在飞', desktop: '', touch: '' };
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
      title: '工伤休息中',
      desktop: '站起来就能继续干活。',
      touch: '站起来就能继续干活。',
      meter: player.ragdoll / PLAY.ragdollSeconds,
    };
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

  const isOnLand = (item: FishView) => item.position.z >= ISLAND.shoreZ - .6;
  if (fish.some((item) => item.state === 'stunned' && isOnLand(item))) {
    return {
      title: '趁鱼晕着，快抬走',
      desktop: '走近晕鱼，按 E 抬鱼。',
      touch: '走近晕鱼，按「搬／扔」抬鱼。',
    };
  }

  if (fish.some((item) => item.state === 'flopping' && isOnLand(item))) {
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
      <p class="shift-strip"><span data-day>第 — 天</span><i></i><span>单人值班</span></p>
    </div>
    <section class="ledger" aria-label="渔场账本">
      <div class="money"><span>本班入账</span><strong data-cash>¥0</strong></div>
      <div class="sales"><span>已交渔获</span><strong data-sold>0 <small>尾</small></strong></div>
    </section>
  </header>
  <p class="notice" data-notice role="status" hidden></p>
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
      <span><kbd>E</kbd> 搬／扔</span>
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
          <li><b>交鱼</b> 靠近晕鱼按 E 抬起，靠近并瞄准橙色秤盘，按 E 扔进去。</li>
        </ol>
        <ol class="touch-guide">
          <li><b>钓鱼</b> 点海面瞄准。长按抛竿，咬钩后连点收线。</li>
          <li><b>拍晕</b> 用方向键追上鱼，点鱼瞄准，按「挥桨」。</li>
          <li><b>交鱼</b> 靠近晕鱼按「搬／扔」，到橙色秤前点秤盘瞄准，再按一下。</li>
        </ol>
        <p>鱼钩也能勾住海上的木箱。当心岸上的危险箱，撞一下就得躺两秒。</p>
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
    writeText(day, `第 ${snapshot.day} 天`);
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
    });
    const entities = [...fish.filter((item) => item.state !== 'swimming'), ...crates];
    writeText(debugText, [
      `seed ${meta.seed}   tick ${tick}   ${time.toFixed(1)} s`,
      `人 ${position(player.position)}${player.ragdoll ? `   倒地 ${player.ragdoll.toFixed(1)} s` : ''}`,
      `钩 ${hook.phase}${hook.target ? ` · ${hook.target}` : ''}`,
      ...entities.map((item) => `${item.id} ${item.state} ${position(item.position)}`),
    ].join('\n'));
  }

  function setError(message: string) {
    error.hidden = false;
    writeText(error, message);
  }

  return { canvas, update, setError };
}
