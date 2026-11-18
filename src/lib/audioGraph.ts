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

export function transitionSeconds(value: number) {
  return Math.min(10, Math.max(0.5, Number.isFinite(value) ? value : 3));
}

export function boostedGain(volume: number, boost: number) {
  return (
    Math.min(1, Math.max(0, volume / 100)) *
    10 ** (Math.min(12, Math.max(0, boost || 0)) / 20)
  );
}

/**
 * Computes normalized sub-bass & bass energy (0..1) from FFT byte bins (0..255).
 * Targets ~20 Hz – 185 Hz so kick drums and basslines modulate optical refraction cleanly.
 */
export function computeBassModulation(
  bins: ArrayLike<number>,
  sampleRate = 48000,
  fftSize = 256,
): { bass: number; mid: number; energy: number } {
  const count = bins.length;
  if (!count) return { bass: 0, mid: 0, energy: 0 };
  const hzPerBin = sampleRate / Math.max(32, fftSize);
  const bassStart = Math.max(1, Math.floor(20 / hzPerBin));
  const bassEnd = Math.min(count - 1, Math.max(bassStart, Math.ceil(185 / hzPerBin)));
  const midEnd = Math.min(count - 1, Math.max(bassEnd + 1, Math.ceil(2000 / hzPerBin)));

  let bassSum = 0;
  let bassWeight = 0;
  for (let i = bassStart; i <= bassEnd; i++) {
    const w = i <= bassStart + 2 ? 1.35 : 1.0;
    bassSum += Math.max(0, Math.min(255, bins[i] || 0)) * w;
    bassWeight += 255 * w;
  }

  let midSum = 0;
  const midCount = Math.max(1, midEnd - bassEnd);
  for (let i = bassEnd + 1; i <= midEnd; i++) {
    midSum += Math.max(0, Math.min(255, bins[i] || 0));
  }

  const rawBass = bassWeight > 0 ? bassSum / bassWeight : 0;
  // Noise-floor gate + smooth perceptual curve so quiet passages stay calm
  const gatedBass = Math.max(0, (rawBass - 0.12) / 0.88);
  const bass = Math.min(1, Math.pow(gatedBass, 1.35));
  const mid = Math.min(1, midSum / (midCount * 255));
  const energy = Math.min(1, bass * 0.7 + mid * 0.3);
  return { bass, mid, energy };
}

let activeAudioGraph: AudioGraph | null = null;

export function getAudioReactiveFrame(): { bass: number; mid: number; energy: number } {
  if (!activeAudioGraph) return { bass: 0, mid: 0, energy: 0 };
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
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        this.boost.connect(analyser);
        this.analyser = analyser;
        this.freqBins = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        this.analyser = null;
      }
    }
    activeAudioGraph = this;
  }

  sampleFrequencyEnergy(): { bass: number; mid: number; energy: number } {
    if (!this.analyser || !this.freqBins || this.context.state !== 'running') {
      return { bass: 0, mid: 0, energy: 0 };
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

  level(element: HTMLAudioElement, value: number, seconds = 0, equalPower = false) {
    const gain = this.decks.get(element)?.gain;
    if (!gain) return;
    const time = this.context.currentTime;
    const current = gain.value;
    gain.cancelAndHoldAtTime(time);
    if (seconds > 0) {
      if (equalPower && ((current <= 0.15 && value >= 0.9) || (current >= 0.85 && value <= 0.1))) {
        gain.linearRampToValueAtTime(0.707, time + seconds * 0.5);
        gain.linearRampToValueAtTime(value, time + seconds);
      } else {
        gain.linearRampToValueAtTime(value, time + seconds);
      }
    } else {
      gain.setValueAtTime(value, time);
    }
  }

  async configure(p: Preferences) {
    const time = this.context.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(p.eq[i] || 0, time, 0.025));
    this.boost.gain.setTargetAtTime(boostedGain(p.volume, p.volumeBoost), time, 0.025);
    if (p.limiter !== this.limited) {
      this.boost.disconnect();
      this.limiter.disconnect();
      this.limited = p.limiter;
      if (this.analyser) this.boost.connect(this.analyser);
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
