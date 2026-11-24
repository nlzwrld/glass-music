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
 * Strictly isolates ~26 Hz – 112 Hz low-end weight and suppresses midrange/vocal spectral leakage
 * so Beat Pulse triggers exclusively on real bass kicks and 808 sub-bass.
 */
export function computeBassModulation(
  bins: ArrayLike<number>,
  sampleRate = 48000,
  fftSize = 4096,
): AudioReactiveFrame {
  const count = bins.length;
  if (!count) return { bass: 0, subBass: 0, mid: 0, energy: 0 };
  const hzPerBin = sampleRate / Math.max(32, fftSize);
  const maxKickHz = hzPerBin > 100 ? 380 : 112;
  const bassStart = Math.max(1, Math.floor(26 / hzPerBin));
  const subEnd = Math.min(count - 1, Math.max(bassStart, Math.ceil(80 / hzPerBin)));
  const bassEnd = Math.min(count - 1, Math.max(subEnd, Math.ceil(maxKickHz / hzPerBin)));
  const midStart = Math.min(count - 1, Math.max(bassEnd + 1, Math.floor(150 / hzPerBin)));
  const midEnd = Math.min(count - 1, Math.max(midStart, Math.ceil(3200 / hzPerBin)));

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
    const w = i <= subEnd ? 1.85 : 1.0;
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
  let midPeak = 0;
  const midCount = Math.max(1, midEnd - midStart + 1);
  for (let i = midStart; i <= midEnd; i++) {
    const v = Math.max(0, Math.min(255, bins[i] || 0));
    midSum += v;
    if (v > midPeak) midPeak = v;
  }

  const weightedBass = bassWeight > 0 ? bassSum / bassWeight : 0;
  const peakBass = (top1 + (bassEnd > bassStart ? top2 : top1)) / (2 * 255);
  const rawSub = (subSum / (subCount * 255)) * 0.34 + (subPeak / 255) * 0.66;
  const rawKick = weightedBass * 0.42 + peakBass * 0.58;
  const lowRaw = rawSub * 0.65 + rawKick * 0.35;

  const midMean = midSum / (midCount * 255);
  const rawMid = midMean * 0.6 + (midPeak / 255) * 0.4;

  // Suppress false triggers when vocals/guitars/snares (150-3200 Hz) dominate without genuine sub-bass
  const dominance =
    rawMid <= 0.18
      ? 1
      : Math.max(0, Math.min(1, (rawSub - rawMid * 0.68 + 0.14) / 0.32));

  // Elevated noise-floor gate (0.36) + deadzone so whispers, vocals, hi-hats and room tone stay strictly at 0
  const gatedBass = Math.max(0, (lowRaw - 0.36) / 0.64) * dominance;
  const rawBassOut = Math.min(1, Math.pow(gatedBass, 1.32));
  const bass = rawBassOut < 0.015 ? 0 : rawBassOut;

  const gatedSub = Math.max(0, (rawSub - 0.36) / 0.64) * dominance;
  const rawSubOut = Math.min(1, Math.pow(gatedSub, 1.24));
  const subBass = rawSubOut < 0.015 ? 0 : rawSubOut;

  const mid = Math.min(1, midMean);
  const energy = Math.min(1, bass * 0.8 + subBass * 0.2);
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
        // 4096 FFT gives ~11.7 Hz/bin at 48 kHz with crisp 0.22 smoothing so 28–110 Hz kicks isolate cleanly from vocals
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0.22;
        analyser.minDecibels = -76;
        analyser.maxDecibels = -12;
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
    if (typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(time);
    } else {
      const fallbackCurrent = Math.max(0, Math.min(1, Number.isFinite(gain.value) ? gain.value : 0));
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(fallbackCurrent, time);
    }
    const current = Math.max(0, Math.min(1, Number.isFinite(gain.value) ? gain.value : 0));
    if (seconds > 0) {
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
