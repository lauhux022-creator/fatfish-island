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
  if (!message) return reply('挨近点，我这边都是水声。', 'calm');
  const speaker = players.find(({ id }) => id === message.authorId);
  if (!speaker) return reply('账本上还没你的名字。', 'calm');
  const text = normalizePlayerChat(message.text);

  switch (classifyFishChat(text)) {
    case 'bribe': {
      const cost = Math.min(speaker.cash, share(speaker, 0.12));
      return cost > 0
        ? reply('茶钱我收了，下次喊你骨干。', 'smug', 'fine', speaker.id, cost)
        : reply('茶钱等发工资再议，心意我收了。', 'calm');
    }
    case 'bargain':
      return priced(input, '给你松一格价，嘴甜果然有用。', 'smug', speaker.favor > 0 ? 1.12 : 1.06);
    case 'praise': {
      const bonus = share(speaker, 0.08);
      return bonus > 0
        ? reply('会说话。这点奖金记作宣传费。', 'happy', 'bonus', speaker.id, bonus)
        : reply('会说话，等你交鱼我再发红包。', 'happy');
    }
    case 'gift':
      return reply('鱼饵给你，指标还给大家。', 'happy', 'gift_item', speaker.id, 1);
    case 'supplies':
      return reply('发个补给箱，拆开记得说谢谢。', 'smug', 'spawn_event', 'crate', 1);
    case 'complaint': {
      const accused = players.find(({ id, name }) =>
        id !== speaker.id && (text.includes(id) || text.includes(name)));
      if (!accused) return reply('告状先写名字，我的耳朵不认匿名。', 'annoyed');

      const witnessed = recentEvents.some((event) =>
        event.day === input.event.day && input.event.time - event.time <= 120 &&
        event.actorId === accused.id && event.relatedId === speaker.id && /抢鱼|抢走|截胡|挥桨/u.test(event.summary));
      const backed = witnessed || accused.shiftSold < speaker.shiftSold || accused.favor < speaker.favor - 15;
      const responsible = backed ? accused : speaker;
      const fine = Math.min(responsible.cash, share(responsible, 0.18));
      const line = backed ? '这笔我记他头上，下回记得留证据。' : '证据没过秤，先记你这头。';
      return reply(line, 'annoyed', 'fine', responsible.id, fine);
    }
    case 'other':
      return reply('你继续说，我躺着也是在开会。', 'calm');
  }
}

function interview(input: FishBrainInput): FishBrainOutput {
  if (input.teamRevenue >= input.teamTarget) {
    return reply('全队达标。头名领真饼，其余的我慢慢画。', 'happy');
  }
  if (input.teamRevenue === 0) return reply('全班最省钱的项目，是今天的奖金。', 'annoyed');
  return reply('鱼不够，饼管够。明天接着捞。', 'smug');
}

const openings = [
  { rate: 1.04, say: '今天指标涨一点，算给你们热身。' },
  { rate: 1.09, say: '海这边包场了，指标也一起包。' },
  { rate: 1, say: '今班照表交鱼，海浪不算加班。' },
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
          ? priced(input, '这鱼沾了点人情，价给你抬一格。', 'happy', 1.03)
          : priced(input, '鱼在秤上蹦，价目表跟着跳低点。', 'smug', 0.96);
      }
      case 'chat':
        return handleChat(input);
      case 'death':
        return reply('先上岸。工伤表我替你泡湿了。', 'surprised');
      case 'shift_end':
        return interview(input);
    }
  }
}
