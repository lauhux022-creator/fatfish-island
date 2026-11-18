import { FISH_ACTIONS, FISH_EMOTIONS, type FishBrainOutput } from './types';

const outputKeys = ['say', 'emotion', 'action', 'target', 'amount'];
const actions = new Set<unknown>(FISH_ACTIONS);
const emotions = new Set<unknown>(FISH_EMOTIONS);
const hiddenOrMarkup = /[\p{Cc}\p{Cf}<>]/u;

function noAction(): FishBrainOutput {
  return { say: '这笔账我先记着。', emotion: 'calm', action: 'none', target: null, amount: 0 };
}

export function validateFishOutput(value: unknown): FishBrainOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return noAction();
  if (Object.keys(value).length !== outputKeys.length || !outputKeys.every((key) => Object.hasOwn(value, key))) {
    return noAction();
  }

  const { say, emotion, action, target, amount } = value as Record<string, unknown>;
  if (typeof say !== 'string' || !say.trim() || Array.from(say).length > 30 || hiddenOrMarkup.test(say)) return noAction();
  if (!emotions.has(emotion) || !actions.has(action)) return noAction();
  if (target !== null && (typeof target !== 'string' || !target.trim() || target.length > 40 || hiddenOrMarkup.test(target))) {
    return noAction();
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return noAction();

  return {
    say: say.trim(),
    emotion: emotion as FishBrainOutput['emotion'],
    action: action as FishBrainOutput['action'],
    target: action === 'none' || target === null ? null : target.trim(),
    amount: action === 'none' ? 0 : amount,
  };
}
