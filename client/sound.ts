import type { SimSnapshot } from '../shared/sim/types';

export function createSound() {
  let context: AudioContext | undefined;
  let muted = false;

  function unlock() {
    if (muted || typeof AudioContext === 'undefined') return;
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
  }

  function tone(startHz: number, endHz: number, length: number, level: number, wave: OscillatorType, delay = 0) {
    if (muted || !context || context.state !== 'running') return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(startHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(endHz, start + length);
    volume.gain.setValueAtTime(level, start);
    volume.gain.exponentialRampToValueAtTime(0.001, start + length);
    oscillator.connect(volume).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + length);
  }

  function update(before: SimSnapshot, after: SimSnapshot) {
    if (after.sold > before.sold) {
      tone(659.25, 659.25, 0.2, 0.09, 'triangle');
      tone(880, 880, 0.22, 0.08, 'triangle', 0.08);
      tone(1318.51, 1318.51, 0.28, 0.06, 'triangle', 0.16);
    }
    if (after.result && after.result.day !== before.result?.day) {
      tone(523.25, 523.25, 0.26, 0.07, 'triangle');
      tone(392, 392, 0.3, 0.07, 'triangle', 0.18);
    }
    if (after.notice?.cue === 'fish_escape' && after.notice.id !== before.notice?.id) {
      tone(210, 62, 0.23, 0.12, 'sine');
      tone(310, 114, 0.11, 0.06, 'triangle', 0.08);
      tone(160, 91, 0.13, 0.05, 'sine', 0.18);
    }
    if (after.hook.phase !== before.hook.phase) {
      if (after.hook.phase === 'bait') {
        tone(160, 310, 0.11, 0.08, 'triangle');
        tone(375, 610, 0.17, 0.07, 'triangle', 0.11);
      }
      if (after.hook.phase === 'flying') tone(300, 670, 0.17, 0.08, 'sine');
      if (after.hook.phase === 'waiting') tone(230, 65, 0.14, 0.09, 'sine');
      if (after.hook.phase === 'bite') {
        tone(420, 790, 0.12, 0.1, 'triangle');
        tone(620, 1050, 0.15, 0.1, 'triangle', 0.09);
      }
    }
    if (after.hook.progress > before.hook.progress) tone(270, 195, 0.07, 0.06, 'triangle');
    if (after.player.swing > before.player.swing) tone(175, 72, 0.1, 0.07, 'sawtooth');
    if (after.fish.some((fish) => fish.state === 'stunned' &&
      before.fish.some((previous) => previous.id === fish.id && previous.state === 'flopping'))) {
      tone(152, 50, 0.16, 0.14, 'triangle');
    }
    if (after.player.ragdoll > 0 && before.player.ragdoll === 0) {
      tone(234, 72, 0.34, 0.13, 'triangle');
      tone(190, 58, 0.2, 0.09, 'sine', 0.19);
    }
  }

  return {
    unlock,
    update,
    toggle: () => {
      muted = !muted;
      if (!muted) unlock();
      return muted;
    },
    dispose: () => { if (context) void context.close(); },
  };
}
