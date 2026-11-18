import { BOSS, TICKS_PER_SECOND } from '../sim/config';
import type { FishBrain, FishBrainInput, FishBrainOutput, FishChat, FishEvent, FishObservedEvent } from './types';
import { validateFishOutput } from './validation';

export interface FishRequest {
  event: FishEvent;
  message: FishChat | null;
}

type Context = Pick<FishBrainInput, 'players' | 'teamTarget' | 'teamRevenue' | 'priceMultiplier'>;

interface ActiveRequest {
  request: FishRequest;
  output?: FishBrainOutput;
}

const priority: Record<FishEvent['trigger'], number> = {
  sale: 0,
  death: 1,
  chat: 2,
  shift_start: 3,
  shift_end: 4,
};

export class FishBrainRuntime {
  private clock = 0;
  private nextCall = 0;
  private active: ActiveRequest | null = null;
  private readonly queued: FishRequest[] = [];
  private readonly recent: FishObservedEvent[] = [];
  private callCount = 0;

  constructor(private readonly brain: FishBrain) {}

  get calls() { return this.callCount; }
  get pending() { return Boolean(this.active || this.queued.length); }
  get cooldownSeconds() { return Math.max(0, this.nextCall - this.clock) / TICKS_PER_SECOND; }

  observe(event: FishObservedEvent) {
    this.recent.push(event);
    if (this.recent.length > BOSS.maxRecentEvents) this.recent.shift();
  }

  request(event: FishEvent, message: FishChat | null = null) {
    this.observe(event);
    const request = { event, message };
    // A busy scale should contribute context without leaving a backlog of stale price calls.
    if (event.trigger === 'sale' || event.trigger === 'death') {
      const duplicate = this.queued.findIndex(({ event: previous }) => previous.trigger === event.trigger);
      if (duplicate >= 0) this.queued.splice(duplicate, 1);
    }
    this.queued.push(request);
    if (this.queued.length > BOSS.maxPending) {
      const lowest = Math.min(...this.queued.map(({ event: entry }) => priority[entry.trigger]));
      this.queued.splice(this.queued.findIndex(({ event: entry }) => priority[entry.trigger] === lowest), 1);
    }
  }

  startDay(day: number) {
    for (let index = this.queued.length - 1; index >= 0; index--) {
      if (this.queued[index].event.day !== day) this.queued.splice(index, 1);
    }
  }

  advance(day: number, context: () => Context, apply: (request: FishRequest, output: FishBrainOutput) => void) {
    this.clock += 1;
    if (this.active?.output) {
      const { request, output } = this.active;
      this.active = null;
      if (request.event.day === day) apply(request, output);
    }
    if (this.active || this.clock < this.nextCall || !this.queued.length) return;

    let next = 0;
    for (let index = 1; index < this.queued.length; index++) {
      if (priority[this.queued[index].event.trigger] > priority[this.queued[next].event.trigger]) next = index;
    }
    const [request] = this.queued.splice(next, 1);
    this.nextCall = this.clock + BOSS.cooldownSeconds * TICKS_PER_SECOND;
    this.callCount += 1;

    let output: FishBrainOutput;
    try {
      const result = this.brain.respond({
        ...context(),
        event: { ...request.event },
        recentEvents: this.recent.map((event) => ({ ...event })),
        message: request.message && { ...request.message },
      });
      if (result && 'then' in result && typeof result.then === 'function') {
        const active: ActiveRequest = { request };
        this.active = active;
        const finish = (value: unknown) => {
          if (this.active === active) active.output = validateFishOutput(value);
        };
        void Promise.resolve(result).then(finish, () => finish(undefined));
        return;
      }
      output = validateFishOutput(result);
    } catch {
      output = validateFishOutput(undefined);
    }
    apply(request, output);
  }

  dispose() {
    this.active = null;
    this.queued.length = 0;
    this.recent.length = 0;
  }
}
