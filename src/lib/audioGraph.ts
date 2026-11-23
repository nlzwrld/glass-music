import type { Preferences } from '../../shared/types';

type OutputContext = AudioContext & { setSinkId?(id: string): Promise<void> };
type DevicePicker = MediaDevices & { selectAudioOutput?(): Promise<MediaDeviceInfo> };

export async function audioOutputDevices() {
  const devices = (await navigator.mediaDevices?.enumerateDevices()) || [];
  return devices.filter(d => d.kind === 'audiooutput');
}

export async function requestAudioOutput() {
  const picker = navigator.mediaDevices as DevicePicker;
  if (!picker?.selectAudioOutput) {
    throw new Error('Selecione a saída de som nas configurações de som do Windows.');
  }
  return picker.selectAudioOutput();
}

export const PLAYBACK_FADE_MS = 500;
export const PLAYBACK_FADE_SECONDS = PLAYBACK_FADE_MS / 1000;

export class PlaybackFadeController {
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fadingOut = false;
  private pendingFadeIn = false;

  constructor(private readonly fadeMs = PLAYBACK_FADE_MS) {}

  isFadingOut(): boolean {
    return this.fadingOut;
  }

  hasPendingFadeIn(): boolean {
    return this.pendingFadeIn;
  }

  consumePendingFadeIn(): boolean {
    const had = this.pendingFadeIn;
    this.pendingFadeIn = false;
    return had;
  }

  cancel(): void {
    this.seq++;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.fadingOut = false;
    this.pendingFadeIn = false;
  }

  pause(opts: {
    isPlaying: boolean;
    currentLevel: number;
    silent: boolean;
    rampTo: (value: number, seconds: number) => void;
    commitPause: () => void;
    onFadeStart?: () => void;
  }): void {
    this.seq++;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingFadeIn = false;
    if (!opts.isPlaying || opts.silent) {
      this.fadingOut = false;
      opts.rampTo(0, 0);
      opts.commitPause();
      return;
    }
    const clamped = Math.max(
      0.05,
      Math.min(1, Number.isFinite(opts.currentLevel) ? opts.currentLevel : 1),
    );
    const durationSec = Math.max(0.05, (this.fadeMs / 1000) * clamped);
    this.fadingOut = true;
    opts.onFadeStart?.();
    opts.rampTo(0, durationSec);
    const mySeq = this.seq;
    this.timer = setTimeout(() => {
      if (this.seq !== mySeq) return;
      this.timer = undefined;
      this.fadingOut = false;
      opts.commitPause();
    }, Math.ceil(durationSec * 1000) + 15);
  }

  resume(opts: {
    wasPaused: boolean;
    currentLevel: number;
    silent: boolean;
    rampTo: (value: number, seconds: number) => void;
    startPlayback: () => void;
  }): { resumedFromMidFade: boolean } {
    this.seq++;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const wasFadingOut = this.fadingOut;
    this.fadingOut = false;

    if (opts.silent) {
      this.pendingFadeIn = false;
      opts.rampTo(1, 0);
      if (opts.wasPaused) opts.startPlayback();
      return { resumedFromMidFade: !opts.wasPaused && wasFadingOut };
    }

    if (!opts.wasPaused && wasFadingOut) {
      this.pendingFadeIn = false;
      const clamped = Math.max(
        0,
        Math.min(1, Number.isFinite(opts.currentLevel) ? opts.currentLevel : 0),
      );
      const durationSec = Math.max(0.06, (this.fadeMs / 1000) * (1 - clamped));
      opts.rampTo(1, durationSec);
      return { resumedFromMidFade: true };
    }

    if (opts.wasPaused) {
      this.pendingFadeIn = true;
      opts.rampTo(0, 0);
      opts.startPlayback();
      return { resumedFromMidFade: false };
    }

    this.pendingFadeIn = false;
    opts.rampTo(1, 0.06);
    return { resumedFromMidFade: false };
  }
}

export function transitionSeconds(value: number) {
  return Math.min(10, Math.max(0.5, Number.isFinite(value) ? value : 3));
}

export function boostedGain(volume: number, boost: number) {
  return (
    Math.min(1, Math.max(0, volume / 100)) *
    10 ** (Math.min(12, Math.max(0, boost || 0)) / 20)
  );
}

export interface AudioReactiveFrame {
  bass: number;
  subBass: number;
  mid: number;
  energy: number;
}

/**
 * Computes normalized sub-bass & kick-bass energy (0..1) from FFT byte bins (0..255).
 * Targets ~20 Hz – 175 Hz with sub-bass weighting and peak-bin blending so tight 808 kicks
 * and deep basslines hit crisply even at high FFT resolution (fftSize = 2048).
 */
export function computeBassModulation(
  bins: ArrayLike<number>,
  sampleRate = 48000,
  fftSize = 2048,
): AudioReactiveFrame {
  const count = bins.length;
  if (!count) return { bass: 0, subBass: 0, mid: 0, energy: 0 };
  const hzPerBin = sampleRate / Math.max(32, fftSize);
  const bassStart = Math.max(1, Math.floor(20 / hzPerBin));
  const subEnd = Math.min(count - 1, Math.max(bassStart, Math.ceil(95 / hzPerBin)));
  const bassEnd = Math.min(count - 1, Math.max(subEnd, Math.ceil(175 / hzPerBin)));
  const midEnd = Math.min(count - 1, Math.max(bassEnd + 1, Math.ceil(2000 / hzPerBin)));

  let subSum = 0;
  let subPeak = 0;
  const subCount = Math.max(1, subEnd - bassStart + 1);
  for (let i = bassStart; i <= subEnd; i++) {
    const v = Math.max(0, Math.min(255, bins[i] || 0));
    subSum += v;
    if (v > subPeak) subPeak = v;
  }

  let bassSum = 0;
  let bassWeight = 0;
  let top1 = 0;
  let top2 = 0;
  for (let i = bassStart; i <= bassEnd; i++) {
    const v = Math.max(0, Math.min(255, bins[i] || 0));
    const w = i <= subEnd ? 1.65 : 1.1;
    bassSum += v * w;
    bassWeight += 255 * w;
    if (v >= top1) {
      top2 = top1;
      top1 = v;
    } else if (v > top2) {
      top2 = v;
    }
  }

  let midSum = 0;
  const midCount = Math.max(1, midEnd - bassEnd);
  for (let i = bassEnd + 1; i <= midEnd; i++) {
    midSum += Math.max(0, Math.min(255, bins[i] || 0));
  }

  const weightedBass = bassWeight > 0 ? bassSum / bassWeight : 0;
  const peakBass = (top1 + (bassEnd > bassStart ? top2 : top1)) / (2 * 255);
  const rawSub = (subSum / (subCount * 255)) * 0.45 + (subPeak / 255) * 0.55;
  const rawBass = Math.max(weightedBass * 0.48 + peakBass * 0.52, rawSub * 0.92);

  // Noise-floor gate + musical curve so silence stays calm while real kicks/808s punch
  const gatedBass = Math.max(0, (rawBass - 0.1) / 0.9);
  const bass = Math.min(1, Math.pow(gatedBass, 1.2));

  const gatedSub = Math.max(0, (rawSub - 0.1) / 0.9);
  const subBass = Math.min(1, Math.pow(gatedSub, 1.15));

  const mid = Math.min(1, midSum / (midCount * 255));
  const energy = Math.min(1, bass * 0.65 + subBass * 0.15 + mid * 0.2);
  return { bass, subBass, mid, energy };
}

let activeAudioGraph: AudioGraph | null = null;

export function getAudioReactiveFrame(): AudioReactiveFrame {
  if (!activeAudioGraph) return { bass: 0, subBass: 0, mid: 0, energy: 0 };
  return activeAudioGraph.sampleFrequencyEnergy();
}

export class AudioGraph {
  readonly context: OutputContext;
  readonly decks = new Map<HTMLAudioElement, GainNode>();
  private filters: BiquadFilterNode[];
  private boost: GainNode;
  private limiter: DynamicsCompressorNode;
  private analyser: AnalyserNode | null = null;
  private freqBins: Uint8Array<ArrayBuffer> | null = null;
  private limited = false;
  private silent = false;
  private sink = 'default';

  constructor() {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.filters = [60, 230, 910, 3600, 14000].map(f => {
      const node = this.context.createBiquadFilter();
      node.type = 'peaking';
      node.frequency.value = f;
      node.Q.value = 0.8;
      return node;
    });
    this.boost = this.context.createGain();
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    this.filters.forEach((f, i) => f.connect(this.filters[i + 1] || this.boost));
    this.boost.connect(this.context.destination);

    if (typeof this.context.createAnalyser === 'function') {
      try {
        const analyser = this.context.createAnalyser();
        // 2048 FFT gives ~23.4 Hz/bin at 48 kHz so 30–120 Hz sub-bass & 808 kicks resolve cleanly
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.36;
        analyser.minDecibels = -82;
        analyser.maxDecibels = -10;
        // Tap PRE-volume (after EQ, before boost) so bass analysis works identically at any volume
        const preVolumeNode = this.filters[this.filters.length - 1] || this.boost;
        preVolumeNode.connect(analyser);
        this.analyser = analyser;
        this.freqBins = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        this.analyser = null;
      }
    }
    activeAudioGraph = this;
  }

  sampleFrequencyEnergy(): AudioReactiveFrame {
    if (!this.analyser || !this.freqBins || this.silent || this.context.state !== 'running') {
      return { bass: 0, subBass: 0, mid: 0, energy: 0 };
    }
    this.analyser.getByteFrequencyData(this.freqBins);
    return computeBassModulation(this.freqBins, this.context.sampleRate, this.analyser.fftSize);
  }

  attach(element: HTMLAudioElement) {
    if (this.decks.has(element)) return;
    const gain = this.context.createGain();
    this.context.createMediaElementSource(element).connect(gain);
    gain.connect(this.filters[0]);
    this.decks.set(element, gain);
  }

  getLevel(element: HTMLAudioElement): number {
    const value = this.decks.get(element)?.gain.value;
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 1;
  }

  level(element: HTMLAudioElement, value: number, seconds = 0, equalPower = false) {
    const gain = this.decks.get(element)?.gain;
    if (!gain) return;
    const target = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    const time = this.context.currentTime;
    const current = Math.max(0, Math.min(1, Number.isFinite(gain.value) ? gain.value : 0));
    if (typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(time);
    } else {
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(current, time);
    }
    if (seconds > 0) {
      gain.setValueAtTime(current, time);
      if (
        equalPower &&
        ((current <= 0.15 && target >= 0.9) || (current >= 0.85 && target <= 0.1))
      ) {
        gain.linearRampToValueAtTime(0.707, time + seconds * 0.5);
        gain.linearRampToValueAtTime(target, time + seconds);
      } else {
        gain.linearRampToValueAtTime(target, time + seconds);
      }
    } else {
      gain.setValueAtTime(target, time);
    }
  }

  async configure(p: Preferences) {
    const time = this.context.currentTime;
    this.silent = (p.volume ?? 0) <= 0;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(p.eq[i] || 0, time, 0.025));
    this.boost.gain.setTargetAtTime(boostedGain(p.volume, p.volumeBoost), time, 0.025);
    if (p.limiter !== this.limited) {
      this.boost.disconnect();
      this.limiter.disconnect();
      this.limited = p.limiter;
      if (this.limited) {
        this.boost.connect(this.limiter);
        this.limiter.connect(this.context.destination);
      } else {
        this.boost.connect(this.context.destination);
      }
    }
    const output = p.outputDevice || 'default';
    if (output !== this.sink) {
      if (!this.context.setSinkId && output !== 'default') {
        throw new Error('Esta versão do Windows usa a saída padrão de som.');
      }
      if (this.context.setSinkId) {
        await this.context.setSinkId(output === 'default' ? '' : output);
      }
      this.sink = output;
    }
  }

  async resume() {
    activeAudioGraph = this;
    await this.context.resume();
  }

  close() {
    if (activeAudioGraph === this) activeAudioGraph = null;
    return this.context.close();
  }
}
