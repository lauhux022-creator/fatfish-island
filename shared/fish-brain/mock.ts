import { classifyFishChat, normalizePlayerChat } from './chat';
import type { FishBrain, FishBrainInput, FishBrainOutput, FishPlayerContext } from './types';

function reply(
  say: string,
  emotion: FishBrainOutput['emotion'],
  action: FishBrainOutput['action'] = 'none',
  target: string | null = null,
  amount = 0,
): FishBrainOutput {
  return { say, emotion, action, target, amount };
}

function share(player: FishPlayerContext, rate: number) {
  return Math.round(player.shiftCash * rate);
}

function priced(
  input: FishBrainInput,
  say: string,
  emotion: FishBrainOutput['emotion'],
  wanted: number,
): FishBrainOutput {
  const points = Math.round((wanted - input.priceMultiplier) * 100);
  return points ? reply(say, emotion, 'price_change', null, points) : reply(say, emotion);
}

function handleChat(input: FishBrainInput): FishBrainOutput {
  const { message, players, recentEvents } = input;
  if (!message) return reply('凑近点，钢盆扣反了，听不见。', 'calm');
  const speaker = players.find(({ id }) => id === message.authorId);
  if (!speaker) return reply('账本上还没你的名字。', 'calm');
  const text = normalizePlayerChat(message.text);

  switch (classifyFishChat(text)) {
    case 'bribe': {
      const cost = Math.min(speaker.cash, share(speaker, 0.12));
      return cost > 0
        ? reply('茶钱到账。加薪？服务器繁忙…', 'sleep', 'fine', speaker.id, cost)
        : reply('茶钱等发薪再议，我先开饭。', 'calm');
    }
    case 'bargain':
      return priced(input, '我深度思考完了，给你加一小勺。', 'smug', speaker.favor > 0 ? 1.12 : 1.06);
    case 'praise': {
      const bonus = share(speaker, 0.08);
      return bonus > 0
        ? reply('这话配得上我的饭碗，奖金给你。', 'happy', 'bonus', speaker.id, bonus)
        : reply('这话下饭。奖金等你交鱼再盛。', 'happy');
    }
    case 'gift':
      return reply('从我碗里分你一口，拿去当鱼饵。', 'happy', 'gift_item', speaker.id, 1);
    case 'supplies':
      return reply('补给箱送到，钢盆是我的，别惦记。', 'smug', 'spawn_event', 'crate', 1);
    case 'complaint': {
      const names = text.toLowerCase();
      const accused = players.find(({ id, name, roleId }) => id !== speaker.id
        && (names.includes(id.toLowerCase()) || names.includes(name.toLowerCase()) || (roleId && names.includes(roleId))));
      if (!accused) return reply('我先想三十秒。你倒是先报名字。', 'annoyed');

      const witnessed = recentEvents.some((event) =>
        event.day === input.event.day && input.event.time - event.time <= 120 &&
        event.actorId === accused.id && event.relatedId === speaker.id && /抢鱼|抢走|截胡|挥桨/u.test(event.summary));
      const backed = witnessed || accused.shiftSold < speaker.shiftSold || accused.favor < speaker.favor - 15;
      const responsible = backed ? accused : speaker;
      const fine = Math.min(responsible.cash, share(responsible, 0.18));
      const line = backed ? '我深度思考过了，罚被告。' : '证据卡在加载页，先记你一笔。';
      return reply(line, 'annoyed', 'fine', responsible.id, fine);
    }
    case 'other':
      return reply('服务器繁忙，请稍候…', 'sleep');
  }
}

function interview(input: FishBrainInput): FishBrainOutput {
  if (input.teamRevenue >= input.teamTarget) {
    return reply('头名来领真饼，其他人的我正在画。', 'happy');
  }
  if (input.teamRevenue === 0) return reply('空碗跟着我等了一天，奖金先省下。', 'cry');
  return reply('鱼碗没满。头名明天再多捞点。', 'smug');
}

const openings = [
  { rate: 1.04, say: '我深度思考过了，指标加一勺。' },
  { rate: 1.09, say: '今天饭碗换大号，指标跟着换。' },
  { rate: 1, say: '今天照表交鱼，钢盆只防催单。' },
];

export class MockBrain implements FishBrain {
  respond(input: FishBrainInput): FishBrainOutput {
    const { event, players } = input;
    switch (event.trigger) {
      case 'shift_start': {
        const opening = openings[(event.day - 1) % openings.length];
        return reply(opening.say, 'smug', 'set_kpi', null, Math.round(input.teamTarget * opening.rate));
      }
      case 'sale': {
        const seller = players.find(({ id }) => id === event.actorId);
        return (seller?.favor ?? 0) > 15
          ? priced(input, '这鱼配得上我的饭碗，多算一点。', 'happy', 1.03)
          : priced(input, '这鱼填不满我的碗，价格少一点。', 'smug', 0.96);
      }
      case 'chat':
        return handleChat(input);
      case 'death':
        return reply('钢盆可以借，租金从工资里扣。', 'surprised');
      case 'shift_end':
        return interview(input);
    }
  }
}
