import cheer from '../assets/dafeiyu/sfx/cheer.wav?url';
import coin from '../assets/dafeiyu/sfx/coin.wav?url';
import hit1 from '../assets/dafeiyu/sfx/hit1.wav?url';
import hit2 from '../assets/dafeiyu/sfx/hit2.wav?url';
import hit3 from '../assets/dafeiyu/sfx/hit3.wav?url';
import pop from '../assets/dafeiyu/sfx/pop.wav?url';
import splash from '../assets/dafeiyu/sfx/splash.wav?url';
import thud from '../assets/dafeiyu/sfx/thud.wav?url';
import whoosh1 from '../assets/dafeiyu/sfx/whoosh1.wav?url';
import whoosh2 from '../assets/dafeiyu/sfx/whoosh2.wav?url';
import win from '../assets/dafeiyu/sfx/win.wav?url';
import type { SimSnapshot } from '../shared/sim/types';

const hitClips = [hit1, hit2, hit3];
const swingClips = [whoosh1, whoosh2];
const clips = [coin, cheer, win, splash, thud, pop, ...hitClips, ...swingClips];

export function createSound() {
  const samples = new Map<string, AudioBuffer>();
  const downloads = new AbortController();
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let muted = false;
  let nextSwing = 0;
  let nextHit = 0;

  function unlock() {
    if (muted || downloads.signal.aborted || typeof AudioContext === 'undefined') return;
    if (!context) {
      const audio = new AudioContext();
      context = audio;
      master = audio.createGain();
      master.connect(audio.destination);
      for (const url of clips) {
        void fetch(url, { signal: downloads.signal }).then((response) => {
          if (!response.ok) throw new Error(`Audio clip returned HTTP ${response.status}`);
          return response.arrayBuffer();
        }).then((bytes) => audio.decodeAudioData(bytes)).then((sample) => {
          if (!downloads.signal.aborted) samples.set(url, sample);
        }).catch(() => {
          // Events use synthesized sound while a sample loads or if it fails.
        });
      }
    }
    if (context.state === 'suspended') void context.resume().catch(() => {});
  }

  function effect(url: string, level: number, fallback: () => void) {
    if (muted || !context || !master || context.state !== 'running') return;
    const sample = samples.get(url);
    if (!sample) {
      fallback();
      return;
    }
    const source = context.createBufferSource();
    const volume = context.createGain();
    source.buffer = sample;
    volume.gain.value = level;
    source.connect(volume).connect(master);
    source.start();
  }

  function tone(startHz: number, endHz: number, length: number, level: number, wave: OscillatorType, delay = 0) {
    if (muted || !context || !master || context.state !== 'running') return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(startHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(endHz, start + length);
    volume.gain.setValueAtTime(level, start);
    volume.gain.exponentialRampToValueAtTime(0.001, start + length);
    oscillator.connect(volume).connect(master);
    oscillator.start(start);
    oscillator.stop(start + length);
  }

  function update(before: SimSnapshot, after: SimSnapshot) {
    const cue = after.notice?.id !== before.notice?.id ? after.notice?.cue : undefined;
    if (after.poppers?.some(({ id, phase }) => phase === 'burst'
      && !before.poppers?.some(prior => prior.id === id && prior.phase === 'burst'))) {
      effect(pop, 0.34, () => {
        tone(235, 96, 0.16, 0.12, 'triangle');
        tone(460, 820, 0.18, 0.09, 'sine', 0.05);
      });
    }
    if (after.fish.some(fish => fish.carrierId === after.player.id && fish.airCatchMultiplier > 1
      && before.fish.some(old => old.id === fish.id && old.airCatchMultiplier === 1))) {
      tone(480, 760, 0.13, 0.09, 'triangle');
      tone(800, 1220, 0.16, 0.07, 'sine', 0.09);
    }
    if (after.sold > before.sold) {
      effect(coin, 0.38, () => {
        tone(659.25, 659.25, 0.2, 0.09, 'triangle');
        tone(880, 880, 0.22, 0.08, 'triangle', 0.08);
        tone(1318.51, 1318.51, 0.28, 0.06, 'triangle', 0.16);
      });
    }
    if (after.result && after.result.day !== before.result?.day) {
      const won = after.result.ranking[0]?.id === after.player.id;
      effect(won ? win : cheer, 0.31, () => {
        tone(523.25, 523.25, 0.26, 0.07, 'triangle');
        tone(392, 392, 0.3, 0.07, 'triangle', 0.18);
      });
    }
    if (cue === 'fish_escape' || cue === 'water_fall') {
      effect(splash, 0.42, () => {
        tone(210, 62, 0.23, 0.12, 'sine');
        tone(310, 114, 0.11, 0.06, 'triangle', 0.08);
        tone(160, 91, 0.13, 0.05, 'sine', 0.18);
      });
    }
    if (after.hook.phase !== before.hook.phase) {
      if (after.hook.phase === 'bait') {
        tone(160, 310, 0.11, 0.08, 'triangle');
        tone(375, 610, 0.17, 0.07, 'triangle', 0.11);
      }
      if (after.hook.phase === 'flying') tone(300, 670, 0.17, 0.08, 'sine');
      if (after.hook.phase === 'waiting') effect(splash, 0.16, () => tone(230, 65, 0.14, 0.09, 'sine'));
      if (after.hook.phase === 'bite') {
        tone(420, 790, 0.12, 0.1, 'triangle');
        tone(620, 1050, 0.15, 0.1, 'triangle', 0.09);
      }
    }
    if (after.hook.progress > before.hook.progress) tone(270, 195, 0.07, 0.06, 'triangle');
    if (after.player.swing > before.player.swing) {
      effect(swingClips[nextSwing], 0.24, () => tone(175, 72, 0.1, 0.07, 'sawtooth'));
      nextSwing = (nextSwing + 1) % swingClips.length;
    }
    if (cue === 'fish_hit' || after.fish.some((fish) => fish.state === 'stunned' &&
      before.fish.some((previous) => previous.id === fish.id && previous.state === 'flopping'))) {
      effect(hitClips[nextHit], cue === 'fish_hit' ? 0.43 : 0.24, () => tone(152, 50, 0.16, 0.14, 'triangle'));
      nextHit = (nextHit + 1) % hitClips.length;
    }
    if (after.player.ragdoll > 0 && before.player.ragdoll === 0 && cue !== 'water_fall') {
      effect(thud, 0.44, () => {
        tone(234, 72, 0.34, 0.13, 'triangle');
        tone(190, 58, 0.2, 0.09, 'sine', 0.19);
      });
    }
  }

  return {
    unlock,
    update,
    toggle: () => {
      muted = !muted;
      if (!muted) unlock();
      if (context && master) master.gain.setValueAtTime(muted ? 0 : 1, context.currentTime);
      return muted;
    },
    dispose: () => {
      downloads.abort();
      samples.clear();
      if (context) void context.close().catch(() => {});
    },
  };
}
