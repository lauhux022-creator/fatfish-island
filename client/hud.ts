import { normalizePlayerChat } from '../shared/fish-brain/chat';
import { crewReaction } from '../shared/fish-brain/reactions';
import { bossBust, crewBust, updatePortrait } from './assets/portraits';
import { BUILD_KINDS, type CampaignCycleResult, type WarehouseView } from '../shared/sim/campaign-types';
import { CAMPAIGN, ISLAND, PLAY, SHIFT } from '../shared/sim/config';
import { SHOP, SHOP_ITEM_IDS } from '../shared/sim/shop';
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
  desktop: '瞄准海上的浅金涟漪，左键蓄满（约 1 秒）再松开。',
  touch: '轻点浅金涟漪，按住「投／收」蓄满再松开。',
};

const nextCast: Guide = {
  ...firstCast,
  title: '鱼款到手，再甩一竿',
};

const stunFish: Guide = {
  title: '鱼要跑路！',
  desktop: '追着鱼瞄准，连按 F 挥桨，直到鱼晕过去。',
  touch: '点鱼瞄准，连按「挥桨」。鱼弹远了就追上去。',
};

function fishingGuide(snapshot: SimSnapshot): Guide | undefined {
  const { hook } = snapshot;
  const catchName = hook.target === 'crate' ? '箱子' : '鱼';

  switch (hook.phase) {
    case 'charging':
      return hook.charge >= 0.99
        ? { title: '蓄力已满', desktop: '松开左键抛竿。', touch: '松开「投／收」抛竿。', meter: hook.charge }
        : { title: '蓄力中', desktop: '等落点圈越过海岸，或把蓄力条拉满。', touch: '等落点圈越过海岸再松手。', meter: hook.charge };
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
  const { player, fish, sold, campaign } = snapshot;
  if (player.ghost) {
    return {
      title: '今天你是幽灵',
      desktop: 'F 推队友。按 R 还魂，缺钱可就近请机器人帮付。',
      touch: '按「作怪」推队友。缺钱时靠近机器人请它帮付。',
      meter: player.revivePaid / campaign.reviveCost,
    };
  }
  if (player.ragdoll > 0) {
    return {
      title: player.baitedBy ? '今天你是鱼饵' : '工伤休息中',
      desktop: '站起来就能继续干活。',
      touch: '站起来就能继续干活。',
      meter: player.ragdoll / PLAY.ragdollSeconds,
    };
  }

  if (campaign.phase === 'night' || campaign.phase === 'boss') {
    return campaign.phase === 'boss' ? {
      title: '夹紧渔场，螃蟹来了',
      desktop: '躲开红圈，等螃蟹收钳再按 F 挥桨。',
      touch: '躲开红圈，等螃蟹收钳再挥桨。',
    } : {
      title: '海怪上岸了，守住仓库！',
      desktop: 'F 挥桨。瞄准附近的地面，按 1／2／3 放置。',
      touch: '挥桨赶走海怪。点地面瞄准，再点右侧部件。',
    };
  }
  if (player.baitedBy) {
    return { title: '你被队友钩住了！', desktop: '', touch: '' };
  }

  const waiting = fish.find(item => item.heavy && item.id === player.lifting);
  if (waiting) {
    return {
      title: '抓住了一边，等人搭手',
      desktop: '让队友到空着的圆圈按 E。再按 E 可以松手。',
      touch: '队友点「搬／扔」帮抬。你再点一次可松手。',
    };
  }

  const heldFish = fish.find((item) => item.id === player.carrying);
  if (heldFish) {
    if (heldFish.heavy) {
      const nearScale = Math.hypot(heldFish.position.x - ISLAND.scale.x, heldFish.position.z - ISLAND.scale.z)
        < ISLAND.scale.aimAssistDistance;
      return nearScale ? {
        title: '到秤前了，一起上秤',
        desktop: '朝橙色秤盘按 E，合力抛上去。',
        touch: '点橙色秤盘瞄准，再按「搬／扔」。',
      } : {
        title: '两人抓牢了，抬去橙秤',
        desktop: 'WASD 和队友一起靠近秤盘，到了再按 E。',
        touch: '和队友一起走向橙色秤盘，到了再按「搬／扔」。',
      };
    }
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
  const nearbyCargo = fish.find(item => item.heavy && (item.state === 'stunned' || item.state === 'thrown') && nearby(item));
  if (nearbyCargo) {
    return {
      title: nearbyCargo.liftClaimId ? '队友在等你搭把手' : '巨型活饵鱼 · 要两个人抬',
      desktop: '走到大鱼旁的空圈，按 E 抓住一边。',
      touch: '走到大鱼旁的空圈，点「搬／扔」抓住一边。',
    };
  }
  if (fish.some((item) => item.caughtBy === player.id && item.state === 'flopping' && nearby(item))) return stunFish;
  const unfinishedCatch = fish.some((item) => item.caughtBy === player.id && item.state === 'stunned' && nearby(item));
  if (!unfinishedCatch && sold > 0 && !SHOP_ITEM_IDS.some((id) => player.equipment?.[id])) {
    return {
      title: '鱼款到手，渔具摊开张',
      desktop: '去左侧条纹棚，按 Q 看竿、锅和鱼饵。',
      touch: '去左侧条纹棚，点「渔具摊」就能买。',
    };
  }
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
    return stunFish;
  }

  return sold > 0 ? nextCast : firstCast;
}

function recapMarkup(prefix: 'cycle' | 'victory') {
  return `<dl class="recap-values" data-${prefix}-recap>
    <div><dt>货款／指标</dt><dd data-${prefix}-secured></dd></div>
    <div><dt>守住的鱼</dt><dd data-${prefix}-stock></dd></div>
    <div><dt>海怪抢走</dt><dd data-${prefix}-lost></dd></div>
  </dl>`;
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
      <p class="shift-strip"><span data-day>第 — 天</span><i></i><span><span data-phase-label>白天</span> <time data-clock>—:—</time></span><span class="pace-tag" data-pace-label hidden>短班</span></p>
      <section class="shift-kpi" aria-label="当日团队指标" data-kpi>
        <div class="shift-kpi-label">
          <span>团队指标</span>
          <strong><span data-team-revenue>¥0</span><span class="kpi-divider"> / </span><span data-team-target>—</span></strong>
        </div>
        <progress max="1" value="0" aria-label="团队指标完成进度" data-team-progress></progress>
      </section>
      <div class="campaign-ledger" data-campaign-ledger>
        <p><span data-cycle-label>三天指标</span><strong data-cycle-total></strong></p>
        <p><span>仓库</span><strong data-warehouse></strong></p>
      </div>
    </div>
    <div class="account">
      <section class="ledger" aria-label="渔场账本">
        <div class="money"><span>可用鱼款</span><strong data-cash>¥0</strong></div>
        <div class="sales"><span>已交渔获</span><strong data-sold>0 <small>尾</small></strong></div>
      </section>
      <button class="board-toggle" type="button" aria-controls="standings" aria-expanded="false" data-standings-toggle>绩效榜</button>
    </div>
  </header>
  <p class="notice" data-notice role="status" hidden></p>
  <aside class="boss-bubble" aria-label="大肥鱼" data-boss-bubble role="status" hidden>
    <img data-boss-portrait alt="" hidden>
    <span><span data-boss-say></span><small data-crew-reaction hidden></small></span>
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
      <section class="cycle-result" data-cycle-result aria-label="三天结算" hidden>
        <p data-cycle-verdict></p>
        ${recapMarkup('cycle')}
      </section>
      <p class="standings-note" data-standings-note></p>
      <section class="shift-interview" data-shift-interview role="status" hidden>
        <div class="interview-speaker">
          <img data-interview-boss alt="" hidden>
          <div><b>大肥鱼</b><span data-shift-interview-say></span><small data-shift-interview-effect hidden></small></div>
        </div>
        <div class="interview-workers">
          <figure><img data-interview-winner alt="" hidden><figcaption data-interview-winner-name></figcaption></figure>
          <figure><img data-interview-last alt="" hidden><figcaption data-interview-last-name></figcaption></figure>
        </div>
      </section>
      <button type="button" class="shift-continue" data-control="continue"><span data-next-shift>开始下一班</span> <kbd>Enter</kbd></button>
    </div>
  </dialog>
  <aside class="task" aria-label="当前操作">
    <div class="task-mark" aria-hidden="true"><i></i></div>
    <div class="task-content">
      <strong data-task>渔场开门中</strong>
      <p class="desktop-guide" data-desktop></p>
      <p class="touch-guide" data-touch></p>
      <progress data-task-meter aria-label="当前动作进度" max="1" value="0" hidden></progress>
    </div>
  </aside>
  <aside class="campaign-controls" aria-label="守仓和还魂操作" data-campaign-controls hidden>
    <div class="campaign-build" data-build-panel hidden>
      <p><b>守仓建造</b><strong data-wood></strong></p>
      <div>
        ${BUILD_KINDS.map((kind, index) => {
          const label = { fence: '围栏', trap: '捕兽夹', lure: '诱饵筐' }[kind];
          return `<button type="button" data-control="build:${kind}"><kbd>${index + 1}</kbd> ${label} <small>${CAMPAIGN.build[kind].cost} 木</small></button>`;
        }).join('')}
      </div>
    </div>
    <div class="campaign-revive" data-revive-panel hidden>
      <span data-revive-progress></span>
      <button type="button" data-control="revive"><kbd>R</kbd> 投钱还魂</button>
    </div>
  </aside>
  <aside class="campaign-boss" data-crab-hud hidden>
    <span>螃蟹 Boss</span><b data-crab-health></b>
    <progress aria-label="螃蟹生命" data-crab-progress value="0" max="1"></progress>
  </aside>
  <section class="campaign-victory" data-campaign-victory aria-labelledby="campaign-victory-title" hidden>
    <h2 id="campaign-victory-title">本岛通关</h2>
    <p>螃蟹倒下了。今天的加班，到此为止。</p>
    ${recapMarkup('victory')}
    <p class="victory-ghosts" data-victory-ghosts hidden></p>
    <button type="button" data-control="campaign-exit">再玩一局</button>
  </section>
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
  <section class="gear-shop" id="gear-shop" data-shop-panel aria-labelledby="gear-shop-title" hidden>
    <header>
      <h2 id="gear-shop-title">渔具摊</h2>
      <strong data-shop-cash></strong>
      <button type="button" class="gear-shop-close" data-shop-close aria-label="关闭渔具摊">×</button>
    </header>
    <p class="gear-shop-location" data-shop-info></p>
    <div class="gear-shop-items">
      ${SHOP_ITEM_IDS.map((id) => {
        const item = SHOP.items[id];
        return `<button type="button" data-shop-buy="${id}">
          <strong>${item.name}</strong><b>¥${item.price}</b>
          <small>${item.description}</small><em data-shop-item-state hidden></em>
        </button>`;
      }).join('')}
    </div>
  </section>
  <div class="hud-foot">
    <div class="key-legend" aria-label="快捷键">
      <span><kbd>W A S D</kbd> 移动</span>
      <span><kbd>左键</kbd> 抛竿／收线</span>
      <span><kbd>F</kbd> 挥桨</span>
      <span><kbd>E</kbd> 搬／抢／扔</span>
      <span><kbd>空格</kbd> 跳</span>
    </div>
    <button class="boss-chat-toggle gear-shop-toggle" type="button" aria-controls="gear-shop" aria-expanded="false" data-shop-toggle hidden>
      <kbd aria-hidden="true">Q</kbd> 渔具摊
    </button>
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
          <li><b>大鱼</b> 巨型活饵鱼得两人各按一次 E 抓住两端，抬到秤前再扔。</li>
          <li><b>截胡</b> 靠近别人手里的鱼或半空中的鱼，朝鱼按 E 抢。</li>
          <li><b>队友饵</b> 朝队友甩钩，再瞄准海面点左键。活饵渔获售价更高，饵员拿不到绩效。</li>
        </ol>
        <ol class="touch-guide">
          <li><b>钓鱼</b> 点海面瞄准。长按抛竿，咬钩后连点收线。</li>
          <li><b>拍晕</b> 用方向键追上鱼，点鱼瞄准，按「挥桨」。</li>
          <li><b>交鱼</b> 靠近晕鱼按「搬／扔」，朝橙色秤盘再按一下。</li>
          <li><b>大鱼</b> 两人分别点「搬／扔」抓住巨型活饵鱼，抬到秤前再扔。</li>
          <li><b>截胡</b> 靠近并瞄准别人手里或半空中的鱼，点「搬／扔」抢。</li>
          <li><b>队友饵</b> 点队友瞄准并甩钩，再点海面按「投／收」。活饵渔获售价更高，饵员拿不到绩效。</li>
        </ol>
        <p class="desktop-guide">左侧渔具摊按 Q 买装备。夜里按 1／2／3 建造守仓。每三天达标就迎战螃蟹，掉队成幽灵后可按 R 凑还魂费。</p>
        <p class="touch-guide">左侧渔具摊可买装备。夜里点工事按钮守仓。每三天达标就迎战螃蟹，幽灵可点「还魂」交钱。</p>
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
  const bossPortrait = ui<HTMLImageElement>('[data-boss-portrait]');
  const reactionText = ui<HTMLElement>('[data-crew-reaction]');
  const bossSay = ui('[data-boss-say]');
  const bossToggle = ui<HTMLButtonElement>('[data-boss-chat-toggle]');
  const bossForm = ui<HTMLFormElement>('[data-boss-form]');
  const bossInput = ui<HTMLInputElement>('[data-boss-input]');
  const bossStatus = ui('[data-boss-status]');
  const bossFavor = ui('[data-boss-favor]');
  const bossMemory = ui<HTMLElement>('[data-boss-memory]');
  const bossEffect = ui<HTMLElement>('[data-boss-effect]');
  const gearShop = ui<HTMLElement>('[data-shop-panel]');
  const shopToggle = ui<HTMLButtonElement>('[data-shop-toggle]');
  const shopClose = ui<HTMLButtonElement>('[data-shop-close]');
  const shopCash = ui('[data-shop-cash]');
  const shopInfo = ui('[data-shop-info]');
  const shopItems = SHOP_ITEM_IDS.map((id) => {
    const button = ui<HTMLButtonElement>(`[data-shop-buy="${id}"]`);
    return { id, button, state: button.querySelector<HTMLElement>('[data-shop-item-state]')! };
  });
  const interview = ui<HTMLElement>('[data-shift-interview]');
  const interviewBoss = ui<HTMLImageElement>('[data-interview-boss]');
  const interviewWinner = ui<HTMLImageElement>('[data-interview-winner]');
  const interviewLast = ui<HTMLImageElement>('[data-interview-last]');
  const winnerName = ui('[data-interview-winner-name]');
  const lastName = ui('[data-interview-last-name]');
  for (const portrait of [bossPortrait, interviewBoss, interviewWinner, interviewLast]) {
    portrait.addEventListener('error', () => { portrait.hidden = true; });
  }
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
  const meter = ui<HTMLProgressElement>('[data-task-meter]');
  const notice = ui<HTMLParagraphElement>('[data-notice]');
  const headerColumns = [...root.querySelectorAll<HTMLElement>('.hud-head > *')];
  const bossObstacles = [...headerColumns, notice];
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
  const nextShift = ui('[data-next-shift]');
  const cycleResult = ui<HTMLElement>('[data-cycle-result]');
  const cycleVerdict = ui('[data-cycle-verdict]');
  const cycleRecap = recapView('cycle');
  const phaseLabel = ui('[data-phase-label]');
  const paceLabel = ui<HTMLElement>('[data-pace-label]');
  const cycleLabel = ui('[data-cycle-label]');
  const cycleTotal = ui('[data-cycle-total]');
  const warehouse = ui('[data-warehouse]');
  const campaignControls = ui<HTMLElement>('[data-campaign-controls]');
  const buildPanel = ui<HTMLElement>('[data-build-panel]');
  const wood = ui('[data-wood]');
  const revivePanel = ui<HTMLElement>('[data-revive-panel]');
  const touchSwing = ui('[data-control="swing"]');
  const reviveProgress = ui('[data-revive-progress]');
  const crabHud = ui<HTMLElement>('[data-crab-hud]');
  const crabHealth = ui('[data-crab-health]');
  const crabProgress = ui<HTMLProgressElement>('[data-crab-progress]');
  const victory = ui<HTMLElement>('[data-campaign-victory]');
  const victoryButton = ui<HTMLButtonElement>('[data-control="campaign-exit"]');
  const victoryRecap = recapView('victory');
  const victoryGhosts = ui<HTMLElement>('[data-victory-ghosts]');
  let roomCode = '';
  let previousBoard = '';
  let boardPinned = false;
  let latest: SimSnapshot | undefined;
  let lastLineId: number | undefined;
  let speakUntil = 0;
  let composing = false;

  function recapView(prefix: 'cycle' | 'victory') {
    return {
      secured: ui(`[data-${prefix}-secured]`),
      stock: ui(`[data-${prefix}-stock]`),
      lost: ui(`[data-${prefix}-lost]`),
    };
  }

  function fillRecap(
    recap: ReturnType<typeof recapView>,
    { secured, target }: Pick<CampaignCycleResult, 'secured' | 'target'>,
    { stock, lostFish, lostValue }: WarehouseView,
  ) {
    writeText(recap.secured, `¥${secured} / ¥${target}`);
    writeText(recap.stock, `${stock} 尾`);
    writeText(recap.lost, `${lostFish} 尾${lostValue ? ` · ¥${lostValue}` : ''}`);
  }

  function setShopOpen(open: boolean) {
    if (open) {
      setChatOpen(false);
      manual.open = false;
    }
    gearShop.hidden = !open;
    shopToggle.setAttribute('aria-expanded', String(open));
    task.hidden = open || !bossForm.hidden;
    if (open && latest) {
      updateShop(latest);
      shopClose.focus({ preventScroll: true });
    }
  }

  function shopAllowed(snapshot: SimSnapshot) {
    return snapshot.campaign.phase === 'day' && !snapshot.shiftPaused && !snapshot.player.ghost
      && root.dataset.roomMode !== 'spectating' && root.dataset.roomMode !== 'reconnecting';
  }

  function toggleShop() {
    if (!latest || shopToggle.hidden || !shopAllowed(latest)) return false;
    setShopOpen(gearShop.hidden);
    return true;
  }

  function closeShop() {
    if (gearShop.hidden || root.querySelector('dialog:modal')) return false;
    setShopOpen(false);
    shopToggle.focus({ preventScroll: true });
    return true;
  }

  function setChatOpen(open: boolean) {
    if (open && !gearShop.hidden) setShopOpen(false);
    bossForm.hidden = !open;
    bossToggle.setAttribute('aria-expanded', String(open));
    task.hidden = open || !gearShop.hidden;
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
  shopToggle.addEventListener('click', toggleShop);
  shopClose.addEventListener('click', closeShop);
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
      updatePortrait(bossPortrait, bossBust(line.emotion));
      const speaker = snapshot.players.find(({ id }) => line.target === id);
      const reaction = speaker && crewReaction(speaker.roleId, line.action);
      reactionText.hidden = !reaction;
      if (reaction) writeText(reactionText, `${speaker.name}：${reaction}`);
    }
    bossBubble.hidden = !line || shiftPaused || performance.now() >= speakUntil;
    if (shiftPaused && !bossForm.hidden) setChatOpen(false);
    const meeting = shiftPaused && boss.interview?.day === snapshot.day ? boss.interview : null;
    const meetingPending = shiftPaused && boss.pending;
    interview.hidden = !meeting && !meetingPending;
    if (!interview.hidden) {
      interview.dataset.emotion = meeting?.emotion ?? 'calm';
      updatePortrait(interviewBoss, bossBust(meeting?.emotion ?? 'calm'));
      const winner = snapshot.result?.ranking[0];
      const last = snapshot.result?.ranking.at(-1);
      updatePortrait(interviewWinner, winner ? crewBust(winner.roleId, 'smug') : undefined);
      updatePortrait(interviewLast, last ? crewBust(last.roleId, 'cry') : undefined);
      writeText(winnerName, winner ? `榜首 · ${winner.name}` : '');
      writeText(lastName, last ? `末位 · ${last.name}` : '');
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
    const height = bossBubble.offsetHeight;
    const gutter = width / 2 + 8;
    const x = Math.max(gutter, Math.min(root.clientWidth - gutter, point.x));
    let y = Math.max(height + 12, point.y);
    let docked = false;
    if (root.clientWidth <= 600) {
      const left = x - width / 2;
      const right = x + width / 2;
      for (const area of bossObstacles) {
        if (area.hidden) continue;
        const rect = area.getBoundingClientRect();
        if (left >= rect.right + 6 || right <= rect.left - 6 || y <= rect.top - 6 || y - height >= rect.bottom + 8) continue;
        y = rect.bottom + height + 8;
        docked = true;
      }
    }
    const tail = Math.max(14, Math.min(width - 14, point.x - x + width / 2));
    if (bossBubble.dataset.docked !== String(docked)) bossBubble.dataset.docked = String(docked);
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
    const settled = shiftPaused && snapshot.campaign.phase !== 'cleared' ? result : null;
    const spectator = root.dataset.roomMode === 'spectating' || root.dataset.roomMode === 'reconnecting';
    const modal = Boolean(settled) && !spectator && !root.querySelector('[data-room-dialog][open], [data-local-role-dialog][open]');
    if (shiftPaused && !spectator) boardPinned = false;
    const visible = snapshot.campaign.phase !== 'cleared' && ((Boolean(settled) && !spectator) || boardPinned);
    continueButton.hidden = spectator;
    if (standings.open && (!visible || standings.matches(':modal') !== modal)) standings.close();
    if (standings.hidden === visible) {
      standings.hidden = !visible;
      toggle.setAttribute('aria-expanded', String(visible));
    }
    if (!visible) return;

    const ranking = settled?.ranking ?? [...players]
      .sort((a, b) => b.shiftCash - a.shiftCash || b.shiftSold - a.shiftSold)
      .map(({ id, roleId, name, bot, shiftCash, shiftSold }, index) => ({
        id, roleId, name, bot, rank: index + 1, revenue: shiftCash, sold: shiftSold, bonus: 0, fine: 0, optimization: false,
      }));
    const displayDay = settled?.day ?? snapshot.day;
    const cycle = settled && snapshot.campaign.lastCycle?.day === displayDay ? snapshot.campaign.lastCycle : null;
    const { warehouse } = snapshot.campaign;
    const totals = cycle ? [warehouse.stock, warehouse.lostFish, warehouse.lostValue] : null;
    const key = JSON.stringify([displayDay, Boolean(settled), teamRevenue, teamTarget, ranking, cycle, totals]);
    if (key !== previousBoard) {
      previousBoard = key;
      standings.dataset.day = String(displayDay);
      standings.dataset.settled = String(Boolean(settled));
      writeText(standingsTitle, `第 ${displayDay} 天绩效榜`);
      stamp.hidden = !settled;
      settlement.hidden = !settled;
      cycleResult.hidden = !cycle;
      if (cycle) {
        cycleResult.dataset.passed = String(cycle.passed);
        const verdict = cycle.passed ? '三天达标，螃蟹上岸了'
          : cycle.eaten ? `三天未达标，${cycle.eaten.name}被吞，下一班成幽灵` : '三天未达标';
        writeText(cycleVerdict, verdict);
        fillRecap(cycleRecap, cycle, warehouse);
      }
      writeText(nextShift, cycle?.passed ? '迎战螃蟹' : '开始下一班');
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

  function updateShop(snapshot: SimSnapshot) {
    const { player } = snapshot;
    const allowed = shopAllowed(snapshot);
    if (!allowed && !gearShop.hidden) setShopOpen(false);
    shopToggle.hidden = !allowed || (!player.sold && !player.shopOpen && gearShop.hidden);
    shopToggle.dataset.nearby = String(Boolean(player.shopOpen));
    if (gearShop.hidden) return;
    writeText(shopCash, `¥${player.cash}`);
    writeText(shopInfo, player.shopOpen ? '点选装备即可购买' : '走到岛左侧的条纹棚旁购买');
    for (const { id, button, state } of shopItems) {
      const owned = Boolean(player.equipment?.[id]);
      const affordable = player.cash >= SHOP.items[id].price;
      button.disabled = !player.shopOpen || owned || !affordable;
      button.dataset.owned = String(owned);
      state.hidden = !owned && (!player.shopOpen || affordable);
      if (!state.hidden) writeText(state, owned ? (id === 'bait' ? '鱼饵待用' : '已装备') : '鱼款不足');
    }
  }

  function updateCampaign(snapshot: SimSnapshot) {
    const { campaign, player, players, shiftPaused } = snapshot;
    const { phase, pace, cycle, warehouse: { lostFish, lostValue, stock } } = campaign;
    root.dataset.campaignPhase = phase;
    root.dataset.campaignPace = pace ?? 'classic';
    root.dataset.ghost = String(player.ghost);
    writeText(touchSwing, player.ghost ? '作怪' : '挥桨');
    writeText(phaseLabel, { day: '白天', night: '夜晚', boss: '决战', cleared: '通关' }[phase]);
    paceLabel.hidden = pace !== 'quick';
    writeText(cycleLabel, `三天指标 · 第 ${cycle.lastDay} 天结算`);
    writeText(cycleTotal, `¥${cycle.secured} / ¥${cycle.target}`);
    writeText(warehouse, `${stock} 尾${lostFish ? ` · 被抢 ${lostFish} 尾（¥${lostValue}）` : ''}`);
    const observing = root.dataset.roomMode === 'spectating' || root.dataset.roomMode === 'reconnecting';
    const building = (phase === 'night' || phase === 'boss') && !player.ghost;
    const reviving = player.ghost ? player : players.filter(({ ghost }) => ghost).sort((a, b) =>
      Math.hypot(a.position.x - player.position.x, a.position.z - player.position.z)
      - Math.hypot(b.position.x - player.position.x, b.position.z - player.position.z))[0];
    campaignControls.hidden = observing || shiftPaused || phase === 'cleared' || (!building && !reviving);
    buildPanel.hidden = !building;
    if (building) {
      writeText(wood, `漂流木 ${campaign.wood}`);
      for (const kind of BUILD_KINDS) {
        ui<HTMLButtonElement>(`[data-control="build:${kind}"]`).disabled = campaign.wood < CAMPAIGN.build[kind].cost;
      }
    }
    revivePanel.hidden = !reviving;
    if (reviving) writeText(reviveProgress, `${reviving.name}的还魂费 ¥${reviving.revivePaid} / ¥${campaign.reviveCost}`);
    const crab = campaign.enemies.find(({ kind }) => kind === 'crab');
    crabHud.hidden = !crab;
    if (crab) {
      writeText(crabHealth, `${crab.hp} / ${crab.maxHp}`);
      crabProgress.max = crab.maxHp;
      crabProgress.value = crab.hp;
    }
    const openedVictory = victory.hidden && phase === 'cleared';
    victory.hidden = phase !== 'cleared';
    if (!victory.hidden) {
      fillRecap(victoryRecap, campaign.lastCycle ?? cycle, campaign.warehouse);
      const ghosts = players.filter(({ ghost }) => ghost).map(({ name }) => name);
      victoryGhosts.hidden = !ghosts.length;
      if (!victoryGhosts.hidden) writeText(victoryGhosts, `仍是幽灵的船员 · ${ghosts.join('、')}`);
      writeText(victoryButton, root.dataset.roomMode === 'local' ? '再玩一局' : '离开房间');
      if (openedVictory && !root.querySelector('dialog:modal')) victoryButton.focus({ preventScroll: true });
    }
  }

  function update(snapshot: SimSnapshot) {
    const nextRoomCode = root.dataset.roomCode ?? '';
    if (roomCode !== nextRoomCode) {
      roomCode = nextRoomCode;
      if (!gearShop.hidden) setShopOpen(false);
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
    const seconds = Math.max(0, Math.ceil(snapshot.campaign.remaining));
    writeText(day, `第 ${snapshot.day} 天`);
    clock.hidden = snapshot.campaign.phase === 'boss' || snapshot.campaign.phase === 'cleared';
    writeText(clock, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    updateKpi(snapshot);
    updateCampaign(snapshot);
    updateShop(snapshot);
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
    if (!notice.hidden && root.clientWidth <= 600) {
      const headerBottom = Math.max(...headerColumns.map(area => area.getBoundingClientRect().bottom));
      const top = `${Math.ceil(headerBottom + 8)}px`;
      if (notice.style.getPropertyValue('--hud-notice-top') !== top) notice.style.setProperty('--hud-notice-top', top);
    }

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
      campaignPhase: snapshot.campaign.phase,
      warehouseStock: String(snapshot.campaign.warehouse.stock),
      warehouseLost: String(snapshot.campaign.warehouse.lostFish),
      structures: snapshot.campaign.structures.map(({ kind }) => kind).join(','),
      ghosts: snapshot.players.filter(({ ghost }) => ghost).map(({ id }) => id).join(','),
      crabHp: String(snapshot.campaign.enemies.find(({ kind }) => kind === 'crab')?.hp ?? ''),
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

  return { canvas, update, setError, focusChat, toggleShop, closeShop, setBossAnchor, isBossSpeaking: () => !bossBubble.hidden };
}
