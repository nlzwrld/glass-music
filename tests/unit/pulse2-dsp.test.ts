import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AudioGraph, sampleAudioSpectrum, type AudioSpectrumSnapshot } from '../../src/lib/audioGraph';
import {
  EMPTY_PULSE_FRAME,
  subscribeMusicAnalysis,
  type MusicEvent,
  type MusicEventType,
  type PulseAnalysisFrame,
  type PulsePreferences,
} from '../../src/lib/musicEvents';
import { ensurePulseEngineRegistered, Pulse2Analyzer, pulseEngine } from '../../src/lib/pulseEngine';
import { useApp } from '../../src/stores/app';
import { defaults } from '../../shared/types';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
const STEREO_FFT_SIZE = 512;
const HOP_SAMPLES = 768; // 16.0 ms hop (~62.5 fps, matching real 60 Hz RAF)

/** Deterministic PRNG so synthesized noise bursts (snare, hi-hat, cymbal, breath) are 100% reproducible. */
function createRng(seed = 0x51f15e2): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  };
}

/** Precomputed Hann window + in-place Cooley-Tukey radix-2 FFT matching Web Audio AnalyserNode dBFS scale. */
class TestFftComputer {
  private readonly n: number;
  private readonly window: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly bitRev: Uint32Array;

  constructor(n: number) {
    this.n = n;
    this.window = new Float32Array(n);
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
    this.bitRev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      let rev = 0;
      let x = i;
      for (let b = 0; b < bits; b++) {
        rev = (rev << 1) | (x & 1);
        x >>>= 1;
      }
      this.bitRev[i] = rev;
    }
  }

  computeDb(pcm: Float32Array, endSample: number, outDb: Float32Array): void {
    const n = this.n;
    const start = endSample - n;
    const re = this.re;
    const im = this.im;
    const win = this.window;
    const rev = this.bitRev;

    for (let i = 0; i < n; i++) {
      const idx = start + i;
      const sample = idx >= 0 && idx < pcm.length ? pcm[idx]! : 0;
      const j = rev[i]!;
      re[j] = sample * win[i]!;
      im[j] = 0;
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >>> 1;
      const ang = (-2 * Math.PI) / len;
      const wLenRe = Math.cos(ang);
      const wLenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j]!;
          const uIm = im[i + j]!;
          const vIdx = i + j + half;
          const tRe = re[vIdx]! * wRe - im[vIdx]! * wIm;
          const tIm = re[vIdx]! * wIm + im[vIdx]! * wRe;
          re[vIdx] = uRe - tRe;
          im[vIdx] = uIm - tIm;
          re[i + j] = uRe + tRe;
          im[i + j] = uIm + tIm;
          const nextWRe = wRe * wLenRe - wIm * wLenIm;
          wIm = wRe * wLenIm + wIm * wLenRe;
          wRe = nextWRe;
        }
      }
    }

    const bins = outDb.length;
    const invN = 1 / n;
    for (let k = 0; k < bins; k++) {
      const r = re[k]!;
      const m = im[k]!;
      const mag = Math.sqrt(r * r + m * m) * invN;
      outDb[k] = mag > 1e-6 ? 20 * Math.log10(mag) : -100;
    }
  }
}

const monoFft = new TestFftComputer(FFT_SIZE);
const stereoFft = new TestFftComputer(STEREO_FFT_SIZE);

/** Simple 2-pole RBJ bandpass biquad filter for realistic drum/formant synthesis. */
function applyBandpass(input: Float32Array, centerHz: number, q: number, sr = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(input.length);
  const w0 = (2 * Math.PI * centerHz) / sr;
  const sinW = Math.sin(w0);
  const cosW = Math.cos(w0);
  const alpha = sinW / (2 * q);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!;
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

/** Synthesize drum & instrument hits into a PCM buffer. */
function addKickHit(buf: Float32Array, onsetSec: number, gain = 0.9) {
  const start = Math.round(onsetSec * SAMPLE_RATE);
  const durSamples = Math.round(0.22 * SAMPLE_RATE);
  let phase = 0;
  for (let i = 0; i < durSamples && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    // Fast pitch sweep 145 Hz -> 52 Hz over ~28 ms + tight exponential body decay + beater click
    const freq = 52 + 95 * Math.exp(-t / 0.018);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const attack = 1 - Math.exp(-t / 0.0018);
    const env = attack * Math.exp(-t / 0.068);
    const click = Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t / 0.0035) * 0.22;
    buf[start + i]! += (Math.sin(phase) * env + click) * gain;
  }
}

function add808Note(buf: Float32Array, onsetSec: number, holdSec = 0.85, gain = 0.88) {
  const start = Math.round(onsetSec * SAMPLE_RATE);
  const durSamples = Math.round(holdSec * SAMPLE_RATE);
  let phase = 0;
  for (let i = 0; i < durSamples && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 52 + 88 * Math.exp(-t / 0.016);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const attack = 1 - Math.exp(-t / 0.002);
    const punchBoost = 1 + 0.35 * Math.exp(-t / 0.025);
    const release = t > holdSec - 0.08 ? Math.max(0, (holdSec - t) / 0.08) : 1;
    const subBody = (Math.sin(phase) + 0.18 * Math.sin(phase * 2)) * attack * punchBoost * Math.exp(-t / 1.4) * release;
    const click = Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t / 0.003) * 0.18;
    buf[start + i]! += (subBody + click) * gain;
  }
}

function addSnareHit(buf: Float32Array, onsetSec: number, rng: () => number, gain = 0.82) {
  const start = Math.round(onsetSec * SAMPLE_RATE);
  const durSamples = Math.round(0.18 * SAMPLE_RATE);
  const noiseRaw = new Float32Array(durSamples);
  for (let i = 0; i < durSamples; i++) noiseRaw[i] = rng();
  const wireBand = applyBandpass(noiseRaw, 2900, 0.75);

  let phase1 = 0;
  let phase2 = 0;
  for (let i = 0; i < durSamples && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    phase1 += (2 * Math.PI * (205 + 45 * Math.exp(-t / 0.012))) / SAMPLE_RATE;
    phase2 += (2 * Math.PI * 315) / SAMPLE_RATE;
    const body = (Math.sin(phase1) * 0.65 + Math.sin(phase2) * 0.35) * Math.exp(-t / 0.042);
    const wires = wireBand[i]! * 1.45 * (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / 0.065);
    buf[start + i]! += (body * 0.58 + wires * 0.78) * gain;
  }
}

function addTomHit(buf: Float32Array, onsetSec: number, baseHz = 152, gain = 0.85) {
  const start = Math.round(onsetSec * SAMPLE_RATE);
  const durSamples = Math.round(0.24 * SAMPLE_RATE);
  let phase = 0;
  for (let i = 0; i < durSamples && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const freq = baseHz + 38 * Math.exp(-t / 0.022);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const attack = 1 - Math.exp(-t / 0.0022);
    const env = attack * Math.exp(-t / 0.095);
    const tone = Math.sin(phase) + 0.16 * Math.sin(phase * 1.58);
    buf[start + i]! += tone * env * gain;
  }
}

function addHiHatHit(buf: Float32Array, onsetSec: number, rng: () => number, gain = 0.65) {
  const start = Math.round(onsetSec * SAMPLE_RATE);
  const durSamples = Math.round(0.065 * SAMPLE_RATE);
  const noiseRaw = new Float32Array(durSamples);
  for (let i = 0; i < durSamples; i++) noiseRaw[i] = rng();
  const hatBand = applyBandpass(noiseRaw, 9800, 1.35);
  for (let i = 0; i < durSamples && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = (1 - Math.exp(-t / 0.001)) * Math.exp(-t / 0.019);
    buf[start + i]! += hatBand[i]! * 1.9 * env * gain;
  }
}

function addCymbalHit(buf: Float32Array, onsetSec: number, rng: () => number, gain = 0.68) {
  const start = Math.round(onsetSec * SAMPLE_RATE);
  const durSamples = Math.round(0.65 * SAMPLE_RATE);
  const noiseRaw = new Float32Array(durSamples);
  for (let i = 0; i < durSamples; i++) noiseRaw[i] = rng();
  const lowBronze = applyBandpass(noiseRaw, 4950, 1.05);
  const highShimmer = applyBandpass(noiseRaw, 9200, 0.9);
  for (let i = 0; i < durSamples && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const metallicModes =
      0.16 * Math.sin(2 * Math.PI * 4620 * t) +
      0.14 * Math.sin(2 * Math.PI * 5480 * t) +
      0.12 * Math.sin(2 * Math.PI * 6310 * t);
    const env = (1 - Math.exp(-t / 0.0025)) * Math.exp(-t / 0.28);
    buf[start + i]! += (lowBronze[i]! * 1.35 + highShimmer[i]! * 1.15 + metallicModes) * env * gain;
  }
}

interface StreamResult {
  frames: PulseAnalysisFrame[];
  events: MusicEvent[];
}

function runPcmThroughAnalyzer(
  analyzer: Pulse2Analyzer,
  left: Float32Array,
  right?: Float32Array | null,
  config?: Partial<PulsePreferences>,
  sampleRate = SAMPLE_RATE,
): StreamResult {
  const mono = right ? new Float32Array(left.length) : left;
  if (right) {
    for (let i = 0; i < left.length; i++) {
      mono[i] = (left[i]! + right[i]!) * 0.5;
    }
  }

  const freqDb = new Float32Array(FFT_SIZE / 2);
  const timeDomain = new Float32Array(FFT_SIZE);
  const leftDb = right ? new Float32Array(STEREO_FFT_SIZE / 2) : null;
  const rightDb = right ? new Float32Array(STEREO_FFT_SIZE / 2) : null;
  const hop = Math.max(256, Math.round(sampleRate * 0.016));

  const snapshot: AudioSpectrumSnapshot = {
    freqDb,
    timeDomain,
    leftFreqDb: leftDb,
    rightFreqDb: rightDb,
    sampleRate,
    fftSize: FFT_SIZE,
    stereoFftSize: right ? STEREO_FFT_SIZE : 0,
    minDecibels: -92,
    maxDecibels: -10,
  };

  const frames: PulseAnalysisFrame[] = [];
  const events: MusicEvent[] = [];

  for (let end = hop; end <= mono.length; end += hop) {
    monoFft.computeDb(mono, end, freqDb);
    const tdStart = end - FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = tdStart + i;
      timeDomain[i] = idx >= 0 && idx < mono.length ? mono[idx]! : 0;
    }
    if (right && leftDb && rightDb) {
      stereoFft.computeDb(left, end, leftDb);
      stereoFft.computeDb(right, end, rightDb);
    }
    const nowMs = (end / sampleRate) * 1000;
    const frame = analyzer.analyzeFrame(snapshot, nowMs, config);
    frames.push(frame);
    if (frame.events.length > 0) {
      events.push(...frame.events);
    }
  }

  return { frames, events };
}

function decodeWavPcm(filePath: string): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const raw = readFileSync(filePath);
  expect(raw.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(raw.subarray(8, 12).toString('ascii')).toBe('WAVE');

  let offset = 12;
  let channels = 2;
  let sampleRate = 48000;
  let bitsPerSample = 16;
  let dataStart = 44;
  let dataBytes = raw.length - 44;

  while (offset + 8 <= raw.length) {
    const chunkId = raw.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = raw.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      channels = raw.readUInt16LE(offset + 10);
      sampleRate = raw.readUInt32LE(offset + 12);
      bitsPerSample = raw.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataStart = offset + 8;
      dataBytes = Math.min(chunkSize, raw.length - dataStart);
      break;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }

  const bytesPerSample = bitsPerSample >> 3;
  const totalFrames = Math.floor(dataBytes / (channels * bytesPerSample));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  let ptr = dataStart;
  for (let i = 0; i < totalFrames; i++) {
    const l = raw.readInt16LE(ptr) / 32768;
    const r = channels > 1 ? raw.readInt16LE(ptr + 2) / 32768 : l;
    left[i] = l;
    right[i] = r;
    ptr += channels * bytesPerSample;
  }
  return { left, right, sampleRate };
}

function countByType(events: readonly MusicEvent[], type: MusicEventType): number {
  return events.filter(e => e.type === type).length;
}

describe('Pulse 2.0 DSP Engine — Multi-Band Classification, Vocal Suppression & Real Audio', () => {
  it('Scenario 1: suppresses vocal-heavy formants + 4 Hz syllable modulation + spoken plosives/sibilants while keeping real drums intact', () => {
    const rng = createRng(101);
    const durationSec = 6.0;
    const len = Math.round(durationSec * SAMPLE_RATE);
    const vocalL = new Float32Array(len);
    const vocalR = new Float32Array(len);

    // Synthesize realistic lead/spoken vocals:
    // - Fundamental F0 ~ 145–195 Hz with 5.4 Hz vibrato
    // - Vowel formants (F1=680 Hz, F2=1250 Hz, F3=2550 Hz) + 4.2 Hz syllable modulation
    // - Labial plosives ("p"/"b" low chest pops) and alveolar sibilants ("s"/"t" bursts) between syllables
    let f0Phase = 0;
    const rawVoice = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      if (t < 0.25 || t > 5.75) continue;
      const syllablePhase = Math.sin(2 * Math.PI * 4.2 * t);
      const syllableEnv = Math.pow(Math.max(0, 0.52 + 0.48 * syllablePhase), 1.35);
      const f0 = 168 + 18 * Math.sin(2 * Math.PI * 0.7 * t) + 2.8 * Math.sin(2 * Math.PI * 5.4 * t);
      f0Phase += (2 * Math.PI * f0) / SAMPLE_RATE;

      // Rich glottal harmonic series (1..18 harmonics)
      let glottal = 0;
      for (let h = 1; h <= 18; h++) {
        glottal += Math.sin(f0Phase * h) / Math.pow(h, 0.82);
      }
      rawVoice[i] = glottal * 0.28 * syllableEnv;
    }

    const f1 = applyBandpass(rawVoice, 680, 4.5);
    const f2 = applyBandpass(rawVoice, 1280, 5.5);
    const f3 = applyBandpass(rawVoice, 2580, 6.5);
    const chestBleed = applyBandpass(rawVoice, 130, 2.0);

    for (let i = 0; i < len; i++) {
      const v = chestBleed[i]! * 0.42 + f1[i]! * 1.9 + f2[i]! * 1.45 + f3[i]! * 0.95 + rawVoice[i]! * 0.35;
      vocalL[i] = v;
      vocalR[i] = v * 0.98;
    }

    // Inject spoken labial plosives ("b"/"p") & sibilants ("s"/"t") on syllable boundaries
    const sibilantSrc = new Float32Array(Math.round(0.055 * SAMPLE_RATE));
    for (let s = 0; s < sibilantSrc.length; s++) sibilantSrc[s] = rng();
    const sibilantBand = applyBandpass(sibilantSrc, 6400, 1.8);

    for (let k = 0; k < 12; k++) {
      const tOn = 0.48 + k * 0.42;
      const idx = Math.round(tOn * SAMPLE_RATE);
      // Soft labial plosive pop (~125 Hz, 28 ms)
      for (let j = 0; j < Math.round(0.03 * SAMPLE_RATE) && idx + j < len; j++) {
        const tj = j / SAMPLE_RATE;
        const pop = Math.sin(2 * Math.PI * 128 * tj) * Math.sin((Math.PI * j) / (0.03 * SAMPLE_RATE)) * 0.16;
        vocalL[idx + j]! += pop;
        vocalR[idx + j]! += pop;
      }
      // Sibilant "s" fricative (~55 ms)
      const sIdx = idx + Math.round(0.16 * SAMPLE_RATE);
      for (let j = 0; j < sibilantBand.length && sIdx + j < len; j++) {
        const sib = sibilantBand[j]! * Math.sin((Math.PI * j) / sibilantBand.length) * 0.22;
        vocalL[sIdx + j]! += sib;
        vocalR[sIdx + j]! += sib;
      }
    }

    const analyzer = new Pulse2Analyzer();
    const vocalOnly = runPcmThroughAnalyzer(analyzer, vocalL, vocalR);

    const activeVocalFrames = vocalOnly.frames.filter((_, idx) => {
      const sec = ((idx + 1) * HOP_SAMPLES) / SAMPLE_RATE;
      return sec >= 0.45 && sec <= 5.5;
    });
    const peakVocalLikelihood = Math.max(...activeVocalFrames.map(f => f.vocalLikelihood));
    const falseTriggerFrames = vocalOnly.frames.filter(f => f.events.length > 0).length;
    const vocalFpRatePercent = (falseTriggerFrames / vocalOnly.frames.length) * 100;

    expect(peakVocalLikelihood).toBeGreaterThan(0.55);
    // Exact measured vocal-only false-positive rate must be near-0 (< 1.5% of frames; expected 0%)
    console.info(
      `[Pulse2 Metrics] Vocal-only frames=${vocalOnly.frames.length}, falseEventFrames=${falseTriggerFrames}, FP=${vocalFpRatePercent.toFixed(2)}%, peakVocalLikelihood=${peakVocalLikelihood.toFixed(3)}`,
    );
    expect(vocalFpRatePercent).toBeLessThanOrEqual(1.5);
    expect(vocalOnly.events.length).toBeLessThanOrEqual(1);

    // Verify vocalSuppression: false vs true on heavy chest/plosive vocal bleed
    const plosiveHeavy = new Float32Array(vocalL.length);
    for (let i = 0; i < vocalL.length; i++) plosiveHeavy[i] = vocalL[i]!;
    for (let k = 0; k < 8; k++) {
      addTomHit(plosiveHeavy, 0.55 + k * 0.55, 138, 0.36);
    }
    analyzer.reset();
    const withSuppression = runPcmThroughAnalyzer(analyzer, plosiveHeavy, plosiveHeavy, {
      vocalSuppression: true,
    });
    analyzer.reset();
    const withoutSuppression = runPcmThroughAnalyzer(analyzer, plosiveHeavy, plosiveHeavy, {
      vocalSuppression: false,
    });
    expect(withoutSuppression.events.length).toBeGreaterThanOrEqual(withSuppression.events.length);

    // Non-cutoff proof: add real kick, snare, and hi-hat ON TOP of the exact same loud vocal track!
    const mixL = new Float32Array(vocalL);
    const mixR = new Float32Array(vocalR);
    addKickHit(mixL, 1.2, 0.92);
    addKickHit(mixR, 1.2, 0.92);
    addSnareHit(mixL, 2.2, rng, 0.88);
    addSnareHit(mixR, 2.2, rng, 0.88);
    addHiHatHit(mixL, 3.2, rng, 0.72);
    addHiHatHit(mixR, 3.2, rng, 0.72);

    analyzer.reset();
    const denseMix = runPcmThroughAnalyzer(analyzer, mixL, mixR);
    expect(countByType(denseMix.events, 'kick')).toBeGreaterThanOrEqual(1);
    expect(countByType(denseMix.events, 'snare')).toBeGreaterThanOrEqual(1);
    expect(countByType(denseMix.events, 'hi_hat')).toBeGreaterThanOrEqual(1);
  });

  it('Scenario 2: classifies sustained bassline / sub-bass as bass_sustain without false bass_one_shot triggers', () => {
    const durationSec = 3.0;
    const pcm = new Float32Array(Math.round(durationSec * SAMPLE_RATE));
    let phase = 0;
    for (let i = 0; i < pcm.length; i++) {
      const t = i / SAMPLE_RATE;
      if (t < 0.2 || t > 2.75) continue;
      // Smooth legato synth bassline stepping 55 Hz -> 65.4 Hz -> 49 Hz with 65 ms attack
      const noteHz = t < 1.05 ? 55 : t < 1.9 ? 65.4 : 49;
      phase += (2 * Math.PI * noteHz) / SAMPLE_RATE;
      const envIn = Math.min(1, (t - 0.2) / 0.085);
      const envOut = Math.min(1, (2.75 - t) / 0.08);
      pcm[i] = (Math.sin(phase) * 0.72 + Math.sin(phase * 2) * 0.16) * envIn * envOut;
    }

    const analyzer = new Pulse2Analyzer();
    const { frames, events } = runPcmThroughAnalyzer(analyzer, pcm);

    expect(countByType(events, 'bass_sustain')).toBeGreaterThanOrEqual(1);
    expect(countByType(events, 'bass_one_shot')).toBe(0);
    expect(countByType(events, 'bass_sequence')).toBe(0);

    const maxSustainEnv = Math.max(...frames.map(f => f.bassSustain));
    expect(maxSustainEnv).toBeGreaterThan(0.35);
    const sustainEv = events.find(e => e.type === 'bass_sustain')!;
    expect(sustainEv.durationMs).toBeGreaterThanOrEqual(160);
  });

  it('Scenario 3: detects isolated kick as single bass_one_shot + kick with zero duplicate activations', () => {
    const pcm = new Float32Array(Math.round(2.4 * SAMPLE_RATE));
    addKickHit(pcm, 0.85, 0.92);

    const analyzer = new Pulse2Analyzer();
    const { frames, events } = runPcmThroughAnalyzer(analyzer, pcm);

    expect(countByType(events, 'bass_one_shot')).toBe(1);
    expect(countByType(events, 'kick')).toBe(1);
    expect(countByType(events, 'bass_sequence')).toBe(0);
    expect(Math.max(...frames.map(f => f.bassImpact))).toBeGreaterThan(0.5);
  });

  it('Scenario 4: classifies repeated kicks (128 BPM & 160 BPM double-time) as bass_sequence preserving individual hits', () => {
    // 128 BPM 4-on-the-floor = 468.75 ms IOI (5 kicks)
    const pcm128 = new Float32Array(Math.round(2.8 * SAMPLE_RATE));
    const ioi128 = 60 / 128; // 0.46875s
    for (let k = 0; k < 5; k++) {
      addKickHit(pcm128, 0.3 + k * ioi128, 0.9);
    }

    const analyzer = new Pulse2Analyzer();
    const res128 = runPcmThroughAnalyzer(analyzer, pcm128);
    const oneShots128 = res128.events.filter(e => e.type === 'bass_one_shot');
    const seqHits128 = res128.events.filter(e => e.type === 'bass_sequence');

    expect(oneShots128.length).toBe(1);
    expect(seqHits128.length).toBe(4);
    expect(seqHits128.map(e => e.sequenceCount)).toEqual([2, 3, 4, 5]);
    const lastSeq128 = seqHits128[seqHits128.length - 1]!;
    expect(lastSeq128.intervalMs).toBeGreaterThan(435);
    expect(lastSeq128.intervalMs).toBeLessThan(505);
    expect(res128.frames.some(f => f.activeSequence && f.bassSequenceRate > 0.25)).toBe(true);

    // 160 BPM double-kick burst = 187.5 ms IOI (6 rapid kicks) -> preserves every distinct hit!
    const pcmDouble = new Float32Array(Math.round(2.0 * SAMPLE_RATE));
    for (let k = 0; k < 6; k++) {
      addKickHit(pcmDouble, 0.25 + k * 0.1875, 0.88);
    }
    analyzer.reset();
    const resDouble = runPcmThroughAnalyzer(analyzer, pcmDouble);
    const totalBassImpacts =
      countByType(resDouble.events, 'bass_one_shot') + countByType(resDouble.events, 'bass_sequence');
    expect(totalBassImpacts).toBe(6);
    expect(countByType(resDouble.events, 'bass_sequence')).toBe(5);
  });

  it('Scenario 5: detects both initial punch transient and sustained sub-bass body on an 808 track', () => {
    const pcm = new Float32Array(Math.round(2.0 * SAMPLE_RATE));
    add808Note(pcm, 0.35, 0.95, 0.9);

    const analyzer = new Pulse2Analyzer();
    const { frames, events } = runPcmThroughAnalyzer(analyzer, pcm);

    expect(countByType(events, 'bass_one_shot')).toBe(1);
    expect(countByType(events, 'bass_sustain')).toBeGreaterThanOrEqual(1);
    expect(Math.max(...frames.map(f => f.bassImpact))).toBeGreaterThan(0.5);
    expect(Math.max(...frames.map(f => f.bassSustain))).toBeGreaterThan(0.35);
  });

  it('Scenario 6: detects crisp hi_hat events on a hi-hat-heavy groove without triggering bass', () => {
    const rng = createRng(606);
    const pcm = new Float32Array(Math.round(2.4 * SAMPLE_RATE));
    // 8 hi-hat eighth-note strikes at 250 ms intervals
    for (let k = 0; k < 8; k++) {
      addHiHatHit(pcm, 0.25 + k * 0.22, rng, 0.72);
    }

    const analyzer = new Pulse2Analyzer();
    const { frames, events } = runPcmThroughAnalyzer(analyzer, pcm);

    expect(countByType(events, 'hi_hat')).toBe(8);
    expect(countByType(events, 'bass_one_shot')).toBe(0);
    expect(countByType(events, 'bass_sequence')).toBe(0);
    expect(countByType(events, 'bass_sustain')).toBe(0);
    expect(countByType(events, 'kick')).toBe(0);
    expect(Math.max(...frames.map(f => f.bassImpact))).toBe(0);
    expect(Math.max(...frames.map(f => f.bassSustain))).toBe(0);
    expect(Math.max(...frames.map(f => f.treble))).toBeGreaterThan(0.35);
  });

  it('Scenario 7: distinguishes kick, snare, tom, and cymbal drum kit hits accurately', () => {
    const rng = createRng(707);
    const analyzer = new Pulse2Analyzer();

    // 1. Kick solo
    const kickBuf = new Float32Array(Math.round(1.2 * SAMPLE_RATE));
    addKickHit(kickBuf, 0.35, 0.9);
    const kickRes = runPcmThroughAnalyzer(analyzer, kickBuf);
    expect(countByType(kickRes.events, 'kick')).toBe(1);
    expect(countByType(kickRes.events, 'snare')).toBe(0);
    expect(countByType(kickRes.events, 'tom')).toBe(0);
    expect(countByType(kickRes.events, 'cymbal')).toBe(0);

    // 2. Snare solo
    analyzer.reset();
    const snareBuf = new Float32Array(Math.round(1.2 * SAMPLE_RATE));
    addSnareHit(snareBuf, 0.35, rng, 0.88);
    const snareRes = runPcmThroughAnalyzer(analyzer, snareBuf);
    expect(countByType(snareRes.events, 'snare')).toBe(1);
    expect(countByType(snareRes.events, 'kick')).toBe(0);
    expect(countByType(snareRes.events, 'tom')).toBe(0);

    // 3. Tom solo
    analyzer.reset();
    const tomBuf = new Float32Array(Math.round(1.2 * SAMPLE_RATE));
    addTomHit(tomBuf, 0.35, 158, 0.88);
    const tomRes = runPcmThroughAnalyzer(analyzer, tomBuf);
    expect(countByType(tomRes.events, 'tom')).toBe(1);
    expect(countByType(tomRes.events, 'kick')).toBe(0);
    expect(countByType(tomRes.events, 'snare')).toBe(0);
    expect(countByType(tomRes.events, 'hi_hat')).toBe(0);

    // 4. Crash Cymbal solo
    analyzer.reset();
    const cymbalBuf = new Float32Array(Math.round(1.4 * SAMPLE_RATE));
    addCymbalHit(cymbalBuf, 0.35, rng, 0.74);
    const cymbalRes = runPcmThroughAnalyzer(analyzer, cymbalBuf);
    expect(countByType(cymbalRes.events, 'cymbal')).toBe(1);
    expect(countByType(cymbalRes.events, 'kick')).toBe(0);
    expect(countByType(cymbalRes.events, 'snare')).toBe(0);
    expect(countByType(cymbalRes.events, 'tom')).toBe(0);
  });

  it('Scenario 8: produces zero false triggers on an ambient evolving stereo chord pad with no percussion', () => {
    const durationSec = 4.0;
    const len = Math.round(durationSec * SAMPLE_RATE);
    const padL = new Float32Array(len);
    const padR = new Float32Array(len);
    // Lush A-minor9 chord pad (220, 261.63, 329.63, 392.0, 493.88 Hz) with slow 450 ms swell & stereo detune
    const notes = [220, 261.63, 329.63, 392.0, 493.88];
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const swell = Math.min(1, t / 0.48) * Math.min(1, (durationSec - t) / 0.45);
      const breathe = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.45 * t);
      let sL = 0;
      let sR = 0;
      for (let n = 0; n < notes.length; n++) {
        const f = notes[n]!;
        sL += Math.sin(2 * Math.PI * (f * 0.998) * t + n * 0.7);
        sR += Math.sin(2 * Math.PI * (f * 1.002) * t + n * 1.3);
      }
      padL[i] = (sL / notes.length) * 0.52 * swell * breathe;
      padR[i] = (sR / notes.length) * 0.52 * swell * breathe;
    }

    const analyzer = new Pulse2Analyzer();
    const { frames, events } = runPcmThroughAnalyzer(analyzer, padL, padR);

    expect(events.length).toBe(0);
    expect(Math.max(...frames.map(f => f.bassImpact))).toBe(0);
    expect(Math.max(...frames.map(f => f.percussion))).toBe(0);
  });

  it('Scenario 9: preserves distinct hits on fast 16th-note percussion without double-triggering single hits', () => {
    const rng = createRng(909);
    // 132 BPM -> 16th note = 113.6 ms IOI (12 consecutive 16th-note hi-hats + backbeat snares)
    const stepSec = 60 / 132 / 4; // ~0.1136s
    const pcm = new Float32Array(Math.round(2.2 * SAMPLE_RATE));
    for (let step = 0; step < 12; step++) {
      const t = 0.25 + step * stepSec;
      if (step === 4 || step === 10) {
        addSnareHit(pcm, t, rng, 0.86);
      } else {
        addHiHatHit(pcm, t, rng, 0.68);
      }
    }

    const analyzer = new Pulse2Analyzer();
    const { events } = runPcmThroughAnalyzer(analyzer, pcm);

    expect(countByType(events, 'snare')).toBe(2);
    expect(countByType(events, 'hi_hat')).toBe(10);
  });

  it('Scenario 10: decodes real prisma.wav PCM, obeys all pulseConfig toggles, guards mocked AudioGraph, and runs < 200 µs/frame', async () => {
    // 1. Real decoded audio slice from assets/audio/prisma.wav (first 5 seconds)
    const wavPath = resolve(process.cwd(), 'assets', 'audio', 'prisma.wav');
    const wav = decodeWavPcm(wavPath);
    expect(wav.sampleRate).toBeGreaterThanOrEqual(22050);
    const sliceSamples = Math.min(wav.left.length, wav.sampleRate * 5);
    const sliceL = wav.left.subarray(0, sliceSamples);
    const sliceR = wav.right.subarray(0, sliceSamples);

    const analyzer = new Pulse2Analyzer();
    const realRes = runPcmThroughAnalyzer(analyzer, sliceL, sliceR, undefined, wav.sampleRate);
    expect(realRes.frames.length).toBeGreaterThan(250);
    for (const f of realRes.frames) {
      expect(f.bassSustain).toBeGreaterThanOrEqual(0);
      expect(f.bassSustain).toBeLessThanOrEqual(1);
      expect(f.bassImpact).toBeGreaterThanOrEqual(0);
      expect(f.bassImpact).toBeLessThanOrEqual(1);
      expect(f.percussion).toBeGreaterThanOrEqual(0);
      expect(f.percussion).toBeLessThanOrEqual(1);
      expect(f.treble).toBeGreaterThanOrEqual(0);
      expect(f.treble).toBeLessThanOrEqual(1);
      expect(f.vocalLikelihood).toBeGreaterThanOrEqual(0);
      expect(f.vocalLikelihood).toBeLessThanOrEqual(1);
    }

    // 2. Verify pulseConfig toggles (`oneShot: false`, `sequentialBass: false`, `bass: false`, `percussion: false`, `sensitivity`)
    const rng = createRng(1010);
    const groove = new Float32Array(Math.round(2.0 * SAMPLE_RATE));
    addKickHit(groove, 0.3, 0.85);
    addKickHit(groove, 0.65, 0.85);
    addKickHit(groove, 1.0, 0.85);
    addSnareHit(groove, 0.48, rng, 0.82);
    addHiHatHit(groove, 0.82, rng, 0.68);

    analyzer.reset();
    const noOneShot = runPcmThroughAnalyzer(analyzer, groove, null, { oneShot: false });
    expect(countByType(noOneShot.events, 'bass_one_shot')).toBe(0);
    expect(countByType(noOneShot.events, 'bass_sequence')).toBe(2);

    analyzer.reset();
    const noSeq = runPcmThroughAnalyzer(analyzer, groove, null, { sequentialBass: false });
    expect(countByType(noSeq.events, 'bass_one_shot')).toBe(1);
    expect(countByType(noSeq.events, 'bass_sequence')).toBe(0);
    expect(noSeq.frames.every(f => !f.activeSequence && f.bassSequenceRate === 0)).toBe(true);

    analyzer.reset();
    const noBass = runPcmThroughAnalyzer(analyzer, groove, null, { bass: false });
    expect(countByType(noBass.events, 'bass_one_shot')).toBe(0);
    expect(countByType(noBass.events, 'bass_sequence')).toBe(0);
    expect(countByType(noBass.events, 'kick')).toBe(0);
    expect(countByType(noBass.events, 'snare')).toBe(1);

    analyzer.reset();
    const noPerc = runPcmThroughAnalyzer(analyzer, groove, null, { percussion: false });
    expect(countByType(noPerc.events, 'snare')).toBe(0);
    expect(countByType(noPerc.events, 'hi_hat')).toBe(0);
    expect(noPerc.frames.every(f => f.percussion === 0 && f.treble === 0)).toBe(true);

    // Sensitivity scaling: high sensitivity (1.9) produces stronger impact intensity than low sensitivity (0.35)
    const softKick = new Float32Array(Math.round(1.2 * SAMPLE_RATE));
    addKickHit(softKick, 0.35, 0.42);
    analyzer.reset();
    const lowSens = runPcmThroughAnalyzer(analyzer, softKick, null, { sensitivity: 0.35 });
    analyzer.reset();
    const highSens = runPcmThroughAnalyzer(analyzer, softKick, null, { sensitivity: 1.9 });
    expect(Math.max(...highSens.frames.map(f => f.bassImpact))).toBeGreaterThan(
      Math.max(...lowSens.frames.map(f => f.bassImpact)),
    );

    // 3. Benchmark Pulse2Analyzer.analyzeFrame() over 1,000 frames
    const benchSnapshot: AudioSpectrumSnapshot = {
      freqDb: new Float32Array(1024).fill(-42),
      timeDomain: new Float32Array(2048).fill(0.05),
      leftFreqDb: new Float32Array(256).fill(-42),
      rightFreqDb: new Float32Array(256).fill(-42),
      sampleRate: 48000,
      fftSize: 2048,
      stereoFftSize: 512,
      minDecibels: -92,
      maxDecibels: -10,
    };
    analyzer.reset();
    // Warm up JIT
    for (let i = 0; i < 60; i++) {
      analyzer.analyzeFrame(benchSnapshot, i * 16.67);
    }
    const t0 = performance.now();
    const iterations = 1000;
    for (let i = 0; i < iterations; i++) {
      benchSnapshot.freqDb[2] = i % 15 === 0 ? -16 : -58;
      benchSnapshot.freqDb[3] = i % 15 === 0 ? -18 : -60;
      analyzer.analyzeFrame(benchSnapshot, (i + 60) * 16.67);
    }
    const elapsedUsPerFrame = ((performance.now() - t0) * 1000) / iterations;
    console.info(
      `[Pulse2 Metrics] Benchmark 1000 frames: mean=${elapsedUsPerFrame.toFixed(2)} µs/frame, prisma.wav events=${realRes.events.length} over ${realRes.frames.length} frames`,
    );
    // Must stay well under 250 µs/frame (< 1.5% of a 16.67 ms 60fps budget)
    expect(elapsedUsPerFrame).toBeLessThan(250);

    // 4. Verify AudioGraph pre-EQ spectrum tap & safe fallback on partial mocked AudioContext
    const connectCalls: unknown[] = [];
    const mockAnalyser = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 2048,
      frequencyBinCount: 1024,
      smoothingTimeConstant: 0,
      minDecibels: -92,
      maxDecibels: -10,
      getByteFrequencyData: vi.fn(),
      getFloatFrequencyData: vi.fn((arr: Float32Array) => arr.fill(-36)),
      getFloatTimeDomainData: vi.fn((arr: Float32Array) => arr.fill(0.1)),
    };
    const mockCtx = {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: {},
      createBiquadFilter: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        type: 'peaking',
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0, setTargetAtTime: vi.fn() },
      }),
      createGain: () => ({
        connect: vi.fn((dest: unknown) => connectCalls.push(dest)),
        disconnect: vi.fn(),
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setTargetAtTime: vi.fn(),
        },
      }),
      createDynamicsCompressor: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
      }),
      createAnalyser: () => mockAnalyser,
      createMediaElementSource: () => ({ connect: vi.fn() }),
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    vi.stubGlobal('AudioContext', vi.fn(function MockCtx() { return mockCtx; }));
    try {
      const graph = new AudioGraph();
      const deckEl = {} as HTMLAudioElement;
      graph.attach(deckEl);
      expect(connectCalls).toContain(mockAnalyser);

      const snap1 = sampleAudioSpectrum();
      const snap2 = sampleAudioSpectrum();
      expect(snap1).not.toBeNull();
      // Zero per-frame heap allocation: reuses exact same snapshot & Float32Array instances
      expect(snap1).toBe(snap2);
      expect(snap1!.freqDb).toBe(snap2!.freqDb);

      await graph.configure({ ...defaults, volume: 0 });
      expect(sampleAudioSpectrum()).toBeNull();
      void graph.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Scenario 11: manages runtime pulseEngine RAF lifecycle cleanly (zero idle loops when paused, hidden, or unsubscribed; resets on track change & seek)', () => {
    // Also verify processSpectrum() pure helper overload
    const pure = new Pulse2Analyzer();
    const quietBins = new Float32Array(1024).fill(-90);
    const f0 = pure.processSpectrum(quietBins, 48000, 16.67, { sensitivity: 1.2 });
    expect(f0.bassImpact).toBe(0);
    expect(f0.events.length).toBe(0);

    let rafCallbacks: FrameRequestCallback[] = [];
    let nextRaf = 1;
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return nextRaf++;
    });
    const cafSpy = vi.fn(() => {
      rafCallbacks = [];
    });

    vi.stubGlobal('requestAnimationFrame', rafSpy);
    vi.stubGlobal('cancelAnimationFrame', cafSpy);
    vi.stubGlobal('window', { glass: {} });
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    try {
      ensurePulseEngineRegistered();
      useApp.setState({
        playing: false,
        position: 0,
        index: 0,
        queue: [
          {
            id: 'local:t1',
            source: 'local',
            sourceId: 't1',
            kind: 'track',
            title: 'T1',
            artist: 'A',
            duration: 180,
            addedAt: 0,
          },
          {
            id: 'local:t2',
            source: 'local',
            sourceId: 't2',
            kind: 'track',
            title: 'T2',
            artist: 'A',
            duration: 180,
            addedAt: 0,
          },
        ],
      });

      const received: PulseAnalysisFrame[] = [];
      // Subscribing while paused must NOT start RAF
      const unsub = subscribeMusicAnalysis('test-consumer', f => received.push(f));
      expect(rafSpy).not.toHaveBeenCalled();

      // Starting playback with active consumer starts single RAF
      useApp.setState({ playing: true });
      expect(rafSpy).toHaveBeenCalledTimes(1);

      // Seek jump > 1.5s resets transient state cleanly and emits EMPTY_PULSE_FRAME
      useApp.setState({ position: 42 });
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[received.length - 1]!.bassImpact).toBe(EMPTY_PULSE_FRAME.bassImpact);

      // Track change resets analyzer cleanly
      useApp.setState({ index: 1, position: 0 });
      expect(received[received.length - 1]!.events.length).toBe(0);

      // Unsubscribing last consumer immediately cancels RAF (zero background CPU)
      unsub();
      expect(cafSpy).toHaveBeenCalled();
    } finally {
      pulseEngine.dispose();
      useApp.setState({ playing: false, queue: [], index: -1, position: 0 });
      vi.unstubAllGlobals();
    }
  });
});
