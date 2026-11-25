import { useApp } from '../stores/app';
import { sampleAudioSpectrum, type AudioSpectrumSnapshot } from './audioGraph';
import {
  EMPTY_PULSE_FRAME,
  emitMusicAnalysisFrame,
  getActiveMusicAnalysisConsumerCount,
  normalizePulsePreferences,
  registerMusicAnalysisDriver,
  type MusicAnalysisDriver,
  type MusicEvent,
  type MusicEventType,
  type PulseAnalysisFrame,
  type PulsePreferences,
} from './musicEvents';

const LN10_OVER_20 = Math.LN10 / 20; // ~0.11512925464970229
const EMPTY_EVENTS: readonly MusicEvent[] = Object.freeze([]);

const MIN_SEQUENCE_IOI_MS = 70;
const MAX_SEQUENCE_IOI_MS = 650;
const BASS_DEBOUNCE_MS = 78;
const DRUM_DEBOUNCE_MS = 68;
const HIHAT_DEBOUNCE_MS = 58;
const SUSTAIN_MIN_MS = 160;
const SUSTAIN_REEMIT_MS = 320;

interface BandRange {
  start: number;
  end: number;
}

interface BandLayout {
  sampleRate: number;
  fftSize: number;
  binCount: number;
  maxBin: number;
  sub: BandRange; // 24–75 Hz
  punch: BandRange; // 45–135 Hz
  beaterClick: BandRange; // 1800–4500 Hz
  tom: BandRange; // 95–260 Hz
  snareBody: BandRange; // 160–340 Hz
  snareSnap: BandRange; // 1600–5500 Hz
  midSnap: BandRange; // 1600–3800 Hz
  vocal: BandRange; // 250–3400 Hz
  vocalFlat: BandRange; // 300–3400 Hz
  percMid: BandRange; // 380–4200 Hz
  cymbalLow: BandRange; // 4000–6300 Hz
  cymbal: BandRange; // 4500–15000 Hz
  hiHat: BandRange; // 6000–16000 Hz
  hiHatCore: BandRange; // 6800–16000 Hz
}

export interface ProcessSpectrumOptions {
  config?: Partial<PulsePreferences> | null;
  fftSize?: number;
  timeDomain?: Float32Array | null;
  leftFreqDb?: Float32Array | null;
  rightFreqDb?: Float32Array | null;
  stereoFftSize?: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v >= 1 ? 1 : v;
}

function makeRange(minHz: number, maxHz: number, hzPerBin: number, maxIdx: number): BandRange {
  const start = Math.min(maxIdx, Math.max(1, Math.round(minHz / hzPerBin)));
  const end = Math.min(maxIdx, Math.max(start, Math.round(maxHz / hzPerBin)));
  return { start, end };
}

function buildBandLayout(sampleRate: number, fftSize: number, binCount: number): BandLayout {
  const safeRate = sampleRate > 8000 ? sampleRate : 48000;
  const safeFft = fftSize >= 64 ? fftSize : Math.max(64, binCount * 2);
  const hzPerBin = safeRate / safeFft;
  const maxIdx = Math.max(1, binCount - 1);
  const hiHat = makeRange(6000, 16000, hzPerBin, maxIdx);
  return {
    sampleRate: safeRate,
    fftSize: safeFft,
    binCount,
    maxBin: Math.min(maxIdx, Math.max(hiHat.end, Math.ceil(16500 / hzPerBin))),
    sub: makeRange(24, 75, hzPerBin, maxIdx),
    punch: makeRange(45, 135, hzPerBin, maxIdx),
    beaterClick: makeRange(1800, 4500, hzPerBin, maxIdx),
    tom: makeRange(95, 260, hzPerBin, maxIdx),
    snareBody: makeRange(160, 340, hzPerBin, maxIdx),
    snareSnap: makeRange(1600, 5500, hzPerBin, maxIdx),
    midSnap: makeRange(1600, 3800, hzPerBin, maxIdx),
    vocal: makeRange(250, 3400, hzPerBin, maxIdx),
    vocalFlat: makeRange(300, 3400, hzPerBin, maxIdx),
    percMid: makeRange(380, 4200, hzPerBin, maxIdx),
    cymbalLow: makeRange(4000, 6300, hzPerBin, maxIdx),
    cymbal: makeRange(4500, 15000, hzPerBin, maxIdx),
    hiHat,
    hiHatCore: makeRange(6800, 16000, hzPerBin, maxIdx),
  };
}

/**
 * Pure, deterministic real-time DSP music event & envelope analyzer for Liquid Hub Pulse 2.0.
 * - Pre-allocates Float32Array/Float64Array workspaces (zero per-frame typed-array allocations).
 * - Separates harmonic sustained components from percussive spectral flux (temporal HPSS).
 * - Classifies 3-way bass (`bass_sustain`, `bass_one_shot`, `bass_sequence`), drums (`kick`, `snare`,
 *   `hi_hat`, `cymbal`, `tom`, `percussion`), and honest multi-cue `vocalLikelihood`.
 */
export class Pulse2Analyzer {
  private linAmp: Float32Array;
  private prevAmp: Float32Array;
  private harmFloor: Float32Array;
  private percFlux: Float32Array;
  private transExcess: Float32Array;
  private layout: BandLayout | null = null;

  private initialized = false;
  private lastTimestamp = 0;

  // 2-frame linear band RMS history for distortion-free onset velocity
  private prevLowLin1 = 0;
  private prevLowLin2 = 0;
  private prevSubLin1 = 0;
  private prevPunchLin1 = 0;
  private prevTomLin1 = 0;
  private prevTomLin2 = 0;
  private prevSnareLin1 = 0;
  private prevSnareLin2 = 0;
  private prevHatLin1 = 0;
  private prevHatLin2 = 0;
  private prevCymLin1 = 0;
  private prevCymLin2 = 0;
  private prevPercLin1 = 0;
  private prevPercLin2 = 0;

  // Adaptive baselines & peak trackers
  private lowNoiseFloor = 0.04;
  private lowPeakEnv = 0.48;
  private midNoiseFloor = 0.04;
  private highNoiseFloor = 0.035;
  private highPeakEnv = 0.42;

  // Bass onset, hysteresis & sequence state
  private lastBassHitTs = -10000;
  private lastBassHitPeak = 0;
  private bassRearmed = true;
  private readonly bassHitRing = new Float64Array(8);
  private bassHitRingHead = 0;
  private bassHitRingCount = 0;
  private sequenceCount = 0;
  private estimatedIntervalMs = 0;
  private activeSequence = false;

  // Bass sustain state
  private sustainDurationMs = 0;
  private lastSustainEmitTs = -10000;

  // Drum debounce & hysteresis state
  private lastSnareTs = -10000;
  private snareRearmed = true;
  private lastSnarePeak = 0;
  private lastTomTs = -10000;
  private tomRearmed = true;
  private lastTomPeak = 0;
  private lastHatTs = -10000;
  private hatRearmed = true;
  private lastHatPeak = 0;
  private lastCymbalTs = -10000;
  private cymbalRearmed = true;
  private lastCymbalPeak = 0;
  private lastPercTs = -10000;
  private percRearmed = true;

  // Vocal syllable modulation & context trackers
  private vocalFastEnv = 0;
  private vocalSlowEnv = 0;
  private syllableModEnv = 0;
  private vocalLikelihoodEnv = 0;

  // Smooth output envelopes
  private bassSustainOut = 0;
  private bassImpactOut = 0;
  private bassSeqRateOut = 0;
  private percussionOut = 0;
  private trebleOut = 0;

  private latestFrame: PulseAnalysisFrame = EMPTY_PULSE_FRAME;

  constructor(initialBins = 1024) {
    const cap = Math.max(128, initialBins);
    this.linAmp = new Float32Array(cap);
    this.prevAmp = new Float32Array(cap);
    this.harmFloor = new Float32Array(cap);
    this.percFlux = new Float32Array(cap);
    this.transExcess = new Float32Array(cap);
  }

  private ensureCapacity(binCount: number): void {
    if (binCount <= this.linAmp.length) return;
    this.linAmp = new Float32Array(binCount);
    this.prevAmp = new Float32Array(binCount);
    this.harmFloor = new Float32Array(binCount);
    this.percFlux = new Float32Array(binCount);
    this.transExcess = new Float32Array(binCount);
    this.initialized = false;
  }

  reset(): void {
    this.linAmp.fill(0);
    this.prevAmp.fill(0);
    this.harmFloor.fill(0);
    this.percFlux.fill(0);
    this.transExcess.fill(0);
    this.initialized = false;
    this.lastTimestamp = 0;

    this.prevLowLin1 = 0;
    this.prevLowLin2 = 0;
    this.prevSubLin1 = 0;
    this.prevPunchLin1 = 0;
    this.prevTomLin1 = 0;
    this.prevTomLin2 = 0;
    this.prevSnareLin1 = 0;
    this.prevSnareLin2 = 0;
    this.prevHatLin1 = 0;
    this.prevHatLin2 = 0;
    this.prevCymLin1 = 0;
    this.prevCymLin2 = 0;
    this.prevPercLin1 = 0;
    this.prevPercLin2 = 0;

    this.lowNoiseFloor = 0.04;
    this.lowPeakEnv = 0.48;
    this.midNoiseFloor = 0.04;
    this.highNoiseFloor = 0.035;
    this.highPeakEnv = 0.42;

    this.lastBassHitTs = -10000;
    this.lastBassHitPeak = 0;
    this.bassRearmed = true;
    this.bassHitRing.fill(0);
    this.bassHitRingHead = 0;
    this.bassHitRingCount = 0;
    this.sequenceCount = 0;
    this.estimatedIntervalMs = 0;
    this.activeSequence = false;

    this.sustainDurationMs = 0;
    this.lastSustainEmitTs = -10000;

    this.lastSnareTs = -10000;
    this.snareRearmed = true;
    this.lastSnarePeak = 0;
    this.lastTomTs = -10000;
    this.tomRearmed = true;
    this.lastTomPeak = 0;
    this.lastHatTs = -10000;
    this.hatRearmed = true;
    this.lastHatPeak = 0;
    this.lastCymbalTs = -10000;
    this.cymbalRearmed = true;
    this.lastCymbalPeak = 0;
    this.lastPercTs = -10000;
    this.percRearmed = true;

    this.vocalFastEnv = 0;
    this.vocalSlowEnv = 0;
    this.syllableModEnv = 0;
    this.vocalLikelihoodEnv = 0;

    this.bassSustainOut = 0;
    this.bassImpactOut = 0;
    this.bassSeqRateOut = 0;
    this.percussionOut = 0;
    this.trebleOut = 0;
    this.latestFrame = EMPTY_PULSE_FRAME;
  }

  getLatestFrame(): PulseAnalysisFrame {
    return this.latestFrame;
  }

  processSpectrum(
    freqDb: Float32Array,
    sampleRate: number,
    timestampMs: number,
    options?: Partial<PulsePreferences> | ProcessSpectrumOptions | null,
  ): PulseAnalysisFrame {
    let cfg: Partial<PulsePreferences> | null | undefined;
    let fftSize = freqDb.length * 2;
    let timeDomain: Float32Array | null = null;
    let leftFreqDb: Float32Array | null = null;
    let rightFreqDb: Float32Array | null = null;
    let stereoFftSize = 0;

    if (options && ('config' in options || 'fftSize' in options || 'timeDomain' in options || 'leftFreqDb' in options)) {
      const opts = options as ProcessSpectrumOptions;
      cfg = opts.config;
      if (opts.fftSize) fftSize = opts.fftSize;
      timeDomain = opts.timeDomain ?? null;
      leftFreqDb = opts.leftFreqDb ?? null;
      rightFreqDb = opts.rightFreqDb ?? null;
      stereoFftSize = opts.stereoFftSize ?? (leftFreqDb ? leftFreqDb.length * 2 : 0);
    } else {
      cfg = options as Partial<PulsePreferences> | null | undefined;
    }

    return this.analyzeFrame(
      {
        freqDb,
        timeDomain,
        leftFreqDb,
        rightFreqDb,
        sampleRate,
        fftSize,
        stereoFftSize,
        minDecibels: -92,
        maxDecibels: -10,
      },
      timestampMs,
      cfg,
    );
  }

  analyzeFrame(
    snapshot: AudioSpectrumSnapshot,
    timestampMs: number,
    rawConfig?: Partial<PulsePreferences> | null,
  ): PulseAnalysisFrame {
    const cfg = normalizePulsePreferences(rawConfig);
    const freqDb = snapshot.freqDb;
    const binCount = freqDb.length;
    if (binCount < 16) {
      const empty: PulseAnalysisFrame = {
        ...EMPTY_PULSE_FRAME,
        timestamp: timestampMs,
      };
      this.latestFrame = empty;
      return empty;
    }

    this.ensureCapacity(binCount);
    const sampleRate = snapshot.sampleRate > 8000 ? snapshot.sampleRate : 48000;
    const fftSize = snapshot.fftSize >= 64 ? snapshot.fftSize : binCount * 2;
    if (
      !this.layout ||
      this.layout.sampleRate !== sampleRate ||
      this.layout.fftSize !== fftSize ||
      this.layout.binCount !== binCount
    ) {
      this.layout = buildBandLayout(sampleRate, fftSize, binCount);
    }
    const L = this.layout;

    const dtRaw = this.initialized ? timestampMs - this.lastTimestamp : 16.67;
    if (dtRaw < -50 || dtRaw > 2500) {
      // Clock discontinuity or long pause -> clear transient history cleanly
      this.initialized = false;
      this.sustainDurationMs = 0;
      this.activeSequence = false;
      this.sequenceCount = 0;
    }
    const dt = Math.max(4, Math.min(100, dtRaw > 0 ? dtRaw : 16.67));
    this.lastTimestamp = timestampMs;

    // 1. Time-domain transient crest & zero-crossing rate cues (most recent ~11 ms slice)
    let tdCrest = 1.6;
    let tdZcrHz = 800;
    let tdRms = 0;
    const td = snapshot.timeDomain;
    if (td && td.length >= 64) {
      const sliceLen = Math.min(td.length, Math.max(128, Math.round(sampleRate * 0.011)));
      const start = td.length - sliceLen;
      let sumSq = 0;
      let peak = 0;
      let crossings = 0;
      let prevSample = td[start] || 0;
      for (let i = start; i < td.length; i++) {
        const s = td[i] || 0;
        const abs = s < 0 ? -s : s;
        if (abs > peak) peak = abs;
        sumSq += s * s;
        if ((s >= 0 && prevSample < 0) || (s < 0 && prevSample >= 0)) {
          crossings++;
        }
        prevSample = s;
      }
      tdRms = Math.sqrt(sumSq / sliceLen);
      tdCrest = tdRms > 1e-4 ? Math.min(8, peak / tdRms) : 1.0;
      tdZcrHz = ((crossings / sliceLen) * sampleRate) * 0.5;
    }

    // 2. Per-bin linear amplitude + lightweight temporal HPSS
    const linAmp = this.linAmp;
    const prevAmp = this.prevAmp;
    const harmFloor = this.harmFloor;
    const percFlux = this.percFlux;
    const transExcess = this.transExcess;

    const harmRiseAlpha = 1 - Math.exp(-dt / 145);
    const harmFallAlpha = 1 - Math.exp(-dt / 62);
    const maxHarmStepScale = (dt / 16.67) * 0.085;
    const maxBin = L.maxBin;

    for (let k = 1; k <= maxBin; k++) {
      const db = freqDb[k];
      let a = 0;
      if (db !== undefined && db > -88 && Number.isFinite(db)) {
        a = Math.exp(Math.min(12, db + 12) * LN10_OVER_20);
        if (a < 0.00025) a = 0;
      }
      linAmp[k] = a;

      if (!this.initialized) {
        prevAmp[k] = 0;
        harmFloor[k] = a * 0.35;
        percFlux[k] = a;
        transExcess[k] = a * 0.65;
        continue;
      }

      const prev = prevAmp[k]!;
      const flux = a > prev ? a - prev : 0;
      percFlux[k] = flux;

      const prevH = harmFloor[k]!;
      let nextH: number;
      if (a > prevH) {
        const delta = (a - prevH) * harmRiseAlpha;
        const cap = (0.018 + prevH * 0.45) * maxHarmStepScale * 10;
        nextH = prevH + (delta < cap ? delta : cap);
      } else {
        nextH = prevH + (a - prevH) * harmFallAlpha;
      }
      if (nextH < 0.0002) nextH = 0;
      harmFloor[k] = nextH;

      const excess = a - nextH * 1.12;
      transExcess[k] = excess > 0 ? excess : 0;
    }

    // Helper: Parseval band linear RMS + perceptual level, harmonic floor, flux, and transient excess
    const bandStats = (range: BandRange) => {
      let sumE = 0;
      let sumH = 0;
      let sumF = 0;
      let sumT = 0;
      for (let k = range.start; k <= range.end; k++) {
        const a = linAmp[k]!;
        const h = harmFloor[k]!;
        const f = percFlux[k]!;
        const t = transExcess[k]!;
        sumE += a * a;
        sumH += h * h;
        sumF += f * f;
        sumT += t * t;
      }
      const lin = sumE > 1e-10 ? Math.sqrt(sumE) : 0;
      const linFlux = sumF > 1e-10 ? Math.sqrt(sumF) : 0;
      const level = sumE > 1e-8 ? Math.min(1.35, Math.pow(sumE, 0.28)) : 0;
      const harm = sumH > 1e-8 ? Math.min(1.35, Math.pow(sumH, 0.28)) : 0;
      const flux = sumF > 1e-8 ? Math.min(1.35, Math.pow(sumF, 0.28)) : 0;
      const trans = sumT > 1e-8 ? Math.min(1.35, Math.pow(sumT, 0.28)) : 0;
      return { lin, linFlux, level, harm, flux, trans, power: sumE };
    };

    const sub = bandStats(L.sub);
    const punch = bandStats(L.punch);
    const beater = bandStats(L.beaterClick);
    const tom = bandStats(L.tom);
    const snareBody = bandStats(L.snareBody);
    const snareSnap = bandStats(L.snareSnap);
    const midSnap = bandStats(L.midSnap);
    const vocal = bandStats(L.vocal);
    const percMid = bandStats(L.percMid);
    const cymbalLow = bandStats(L.cymbalLow);
    const cymbal = bandStats(L.cymbal);
    const hiHat = bandStats(L.hiHat);
    const hiHatCore = bandStats(L.hiHatCore);

    // Save current linAmp into prevAmp for next frame
    for (let k = 1; k <= maxBin; k++) {
      prevAmp[k] = linAmp[k]!;
    }
    this.initialized = true;

    // 3. Wiener Spectral Flatness & Formant Peakiness in Vocal Band (300–3400 Hz) and Snare Band (1.6–5.5 kHz)
    let vocalFlatness = 1;
    let vocalPeakCrest = 1;
    {
      const s = L.vocalFlat.start;
      const e = L.vocalFlat.end;
      const n = Math.max(1, e - s + 1);
      let sumP = 0;
      let sumLogP = 0;
      let maxP = 0;
      for (let k = s; k <= e; k++) {
        const a = linAmp[k]!;
        const p = a * a + 1e-11;
        sumP += p;
        sumLogP += Math.log(p);
        if (p > maxP) maxP = p;
      }
      const arithMean = sumP / n;
      if (arithMean > 1e-8) {
        const geomMean = Math.exp(sumLogP / n);
        vocalFlatness = clamp01(geomMean / arithMean);
        vocalPeakCrest = Math.min(20, Math.sqrt(maxP / arithMean));
      }
    }

    let snapFlatness = 0;
    {
      const s = L.snareSnap.start;
      const e = L.snareSnap.end;
      const n = Math.max(1, e - s + 1);
      let sumP = 0;
      let sumLogP = 0;
      for (let k = s; k <= e; k++) {
        const a = linAmp[k]!;
        const p = a * a + 1e-11;
        sumP += p;
        sumLogP += Math.log(p);
      }
      const arithMean = sumP / n;
      if (arithMean > 1e-8) {
        snapFlatness = clamp01(Math.exp(sumLogP / n) / arithMean);
      }
    }

    // 4. Vocal Likelihood (0..1): harmonic ratio + formant comb peakiness + 3–8 Hz syllable modulation + stereo center
    const fFastAlpha = 1 - Math.exp(-dt / 22);
    const fSlowAlpha = 1 - Math.exp(-dt / 105);
    this.vocalFastEnv += (vocal.level - this.vocalFastEnv) * fFastAlpha;
    this.vocalSlowEnv += (vocal.level - this.vocalSlowEnv) * fSlowAlpha;
    const modDiff = Math.abs(this.vocalFastEnv - this.vocalSlowEnv);
    const modAlpha = 1 - Math.exp(-dt / 260);
    this.syllableModEnv += (modDiff - this.syllableModEnv) * modAlpha;

    let stereoCenterCue = 0.62; // Neutral default when mono / splitter unavailable
    let hasStereoDiff = false;
    if (
      snapshot.leftFreqDb &&
      snapshot.rightFreqDb &&
      snapshot.leftFreqDb.length >= 32 &&
      snapshot.rightFreqDb.length === snapshot.leftFreqDb.length
    ) {
      const sBins = snapshot.leftFreqDb.length;
      const sFft = snapshot.stereoFftSize > 0 ? snapshot.stereoFftSize : sBins * 2;
      const sHz = sampleRate / sFft;
      const vStart = Math.min(sBins - 1, Math.max(1, Math.round(280 / sHz)));
      const vEnd = Math.min(sBins - 1, Math.max(vStart, Math.round(3400 / sHz)));
      let midEnergy = 0;
      let sideEnergy = 0;
      for (let k = vStart; k <= vEnd; k++) {
        const dbL = snapshot.leftFreqDb[k]!;
        const dbR = snapshot.rightFreqDb[k]!;
        const aL = dbL > -88 && Number.isFinite(dbL) ? Math.exp(Math.min(12, dbL + 12) * LN10_OVER_20) : 0;
        const aR = dbR > -88 && Number.isFinite(dbR) ? Math.exp(Math.min(12, dbR + 12) * LN10_OVER_20) : 0;
        const m = aL + aR;
        const side = aL - aR;
        midEnergy += m * m;
        sideEnergy += side * side;
      }
      if (midEnergy + sideEnergy > 1e-7) {
        hasStereoDiff = sideEnergy > midEnergy * 0.002;
        const centerRatio = midEnergy / (midEnergy + sideEnergy * 2.6);
        // Wide stereo pads (high sideEnergy) lower vocalLikelihood; dead-center vocals boost it
        stereoCenterCue = hasStereoDiff ? clamp01(centerRatio) : 0.68;
      }
    }

    const totalBroadLevel = sub.level + punch.level + vocal.level + hiHat.level + 1e-5;
    const vocalShare = vocal.level / totalBroadLevel;
    const vocalHarmRatio = vocal.level > 0.06 ? clamp01(vocal.harm / (vocal.level + 1e-4)) : 0;
    const formantCombScore =
      vocal.level > 0.06
        ? clamp01((1 - vocalFlatness * 2.1) * 0.62 + clamp01((vocalPeakCrest - 1.7) / 3.2) * 0.38)
        : 0;
    const syllableScore =
      vocal.level > 0.05 ? clamp01((this.syllableModEnv / (this.vocalSlowEnv + 0.06)) * 2.8) : 0;

    let instantVocal = 0;
    if (vocal.level > 0.08 && vocalShare > 0.22) {
      // Distinguish voiced vocals/speech from wide ambient chord pads:
      // Voiced vocals either show syllable modulation (3–8 Hz) OR centered formant dominance without wide stereo chorus
      const activityFactor = clamp01(0.35 + syllableScore * 0.65);
      const harmonicFormant = vocalHarmRatio * 0.44 + formantCombScore * 0.56;
      instantVocal =
        clamp01((vocalShare - 0.16) / 0.54) *
        harmonicFormant *
        (0.58 + stereoCenterCue * 0.42) *
        (hasStereoDiff && stereoCenterCue < 0.45 ? 0.35 : 1.0) *
        (0.52 + activityFactor * 0.48) *
        1.45;
    }
    const vTau = instantVocal > this.vocalLikelihoodEnv ? 34 : 265;
    this.vocalLikelihoodEnv +=
      (clamp01(instantVocal) - this.vocalLikelihoodEnv) * (1 - Math.exp(-dt / vTau));
    if (this.vocalLikelihoodEnv < 0.01) this.vocalLikelihoodEnv = 0;
    const vocalLikelihood = clamp01(this.vocalLikelihoodEnv);
    const vSuppress = cfg.vocalSuppression ? vocalLikelihood : 0;

    // Sensitivity scaling (0.25..2.0, default 1.0)
    const sens = cfg.sensitivity;
    const threshScale = 1 / Math.pow(sens, 0.72);
    const outGain = Math.pow(sens, 0.58);

    // 5. Low-Frequency Analysis & 3-Way Bass Classification
    // Suppress weak chest/plosive bleed in upper bass ONLY when genuine sub-bass (24–75 Hz) is weak relative to vocals
    const isChestOrPlosiveBleed =
      vSuppress > 0.28 &&
      vocal.level > punch.level * 0.92 &&
      sub.level < vocal.level * 0.36 &&
      sub.level < 0.34;
    const lowBleedPenalty = isChestOrPlosiveBleed ? Math.max(0.18, 1 - vSuppress * 0.78) : 1.0;

    const rawLow = Math.max(sub.level * 0.94, sub.level * 0.46 + punch.level * 0.64) * lowBleedPenalty;
    const rawLowLin = Math.max(sub.lin * 0.94, sub.lin * 0.46 + punch.lin * 0.64) * lowBleedPenalty;
    const rawLowHarm =
      Math.max(sub.harm * 0.94, sub.harm * 0.46 + punch.harm * 0.64) * lowBleedPenalty;
    const rawLowLinFlux =
      Math.max(sub.linFlux * 0.88, sub.linFlux * 0.42 + punch.linFlux * 0.68) * lowBleedPenalty;
    const rawLowTrans =
      Math.max(sub.trans * 0.88, sub.trans * 0.42 + punch.trans * 0.68) * lowBleedPenalty;

    // Update adaptive low noise floor & peak normalizer
    const lowFloorTau = rawLow > this.lowNoiseFloor ? 650 : 220;
    this.lowNoiseFloor = Math.max(
      0.03,
      Math.min(0.32, this.lowNoiseFloor + (rawLow - this.lowNoiseFloor) * (1 - Math.exp(-dt / lowFloorTau))),
    );
    const lowPeakTau = rawLow > this.lowPeakEnv ? 55 : 2400;
    this.lowPeakEnv = Math.max(
      0.42,
      this.lowPeakEnv + (rawLow - this.lowPeakEnv) * (1 - Math.exp(-dt / lowPeakTau)),
    );

    const lowLinRise1 = Math.max(0, rawLowLin - this.prevLowLin1);
    const lowLinRise2 = Math.max(0, rawLowLin - Math.min(this.prevLowLin1, this.prevLowLin2));
    const punchLinRise1 = Math.max(0, punch.lin * lowBleedPenalty - this.prevPunchLin1);
    const subLinRise1 = Math.max(0, sub.lin * lowBleedPenalty - this.prevSubLin1);
    const dtSlopeScale = Math.min(1.6, Math.max(0.65, 16.67 / dt));

    // Re-arm bass onset detector once envelope dips into a valley between hits or enough decay occurs
    if (!this.bassRearmed) {
      if (
        rawLowLin < this.lastBassHitPeak * 0.64 ||
        timestampMs - this.lastBassHitTs > 155 ||
        lowLinRise1 * dtSlopeScale > 0.14
      ) {
        this.bassRearmed = true;
      }
    }

    const events: MusicEvent[] = [];

    // Percussive bass transient score in LINEAR amplitude domain (immune to concave x^0.28 slope inflation near 0):
    // Smooth legato bass note entries (>= 50 ms fade-in, sinusoidal crest ~1.414) stay cleanly below threshold!
    const hasPercussiveAttack =
      beater.linFlux > 0.012 ||
      tdCrest > 1.72 ||
      lowLinRise1 * dtSlopeScale > 0.22 * threshScale;
    const bassImpulseScore =
      (lowLinRise1 * 0.54 + lowLinRise2 * 0.28 + rawLowLinFlux * 0.18) *
      dtSlopeScale *
      (rawLowTrans > rawLow * 0.28 ? 1.12 : 0.62);

    const vocalBassThreshBoost =
      vSuppress > 0.3 && vocal.lin > rawLowLin * 0.95 ? 1 + vSuppress * 0.85 : 1.0;
    const bassImpulseThreshold = 0.145 * threshScale * vocalBassThreshBoost;
    const bassMinLevel = Math.max(0.24 * threshScale, this.lowNoiseFloor * 1.38);

    const timeSinceBassHit = timestampMs - this.lastBassHitTs;
    let bassImpactTriggered = false;
    let bassImpactStrength = 0;

    if (
      this.bassRearmed &&
      hasPercussiveAttack &&
      timeSinceBassHit >= BASS_DEBOUNCE_MS &&
      rawLow >= bassMinLevel &&
      bassImpulseScore >= bassImpulseThreshold &&
      (subLinRise1 > 0.045 || punchLinRise1 > 0.055) &&
      // Guard against mid/tom-only hits lacking sub or low-kick body (< 105 Hz)
      (sub.lin >= tom.lin * 0.36 || punch.lin >= tom.lin * 0.88)
    ) {
      bassImpactTriggered = true;
      this.bassRearmed = false;
      this.lastBassHitTs = timestampMs;
      this.lastBassHitPeak = rawLowLin;

      const normStrength = clamp01(
        (0.42 + (rawLow / this.lowPeakEnv) * 0.36 + bassImpulseScore * 0.95) * outGain,
      );
      const conf = clamp01(0.55 + (bassImpulseScore / (bassImpulseThreshold + 0.18)) * 0.42);
      bassImpactStrength = normStrength;

      // Update sequence ring buffer & classify one-shot vs sequence
      const ioi = timeSinceBassHit;
      this.bassHitRing[this.bassHitRingHead] = timestampMs;
      this.bassHitRingHead = (this.bassHitRingHead + 1) % this.bassHitRing.length;
      if (this.bassHitRingCount < this.bassHitRing.length) this.bassHitRingCount++;

      if (ioi >= MIN_SEQUENCE_IOI_MS && ioi <= MAX_SEQUENCE_IOI_MS) {
        this.sequenceCount = Math.max(2, this.sequenceCount + 1);
        this.estimatedIntervalMs =
          this.estimatedIntervalMs > 0 ? this.estimatedIntervalMs * 0.45 + ioi * 0.55 : ioi;
        this.activeSequence = true;

        if (cfg.bass && cfg.sequentialBass) {
          events.push({
            type: 'bass_sequence',
            timestamp: timestampMs,
            intensity: normStrength,
            confidence: conf,
            intervalMs: Math.round(this.estimatedIntervalMs),
            sequenceCount: this.sequenceCount,
          });
        }
      } else {
        this.sequenceCount = 1;
        this.estimatedIntervalMs = 0;
        this.activeSequence = false;

        if (cfg.bass && cfg.oneShot) {
          events.push({
            type: 'bass_one_shot',
            timestamp: timestampMs,
            intensity: normStrength,
            confidence: conf,
          });
        }
      }

      // Emit `kick` classification when kick punch (45–135 Hz) is present with fast transient attack
      const isKickCharacter =
        punch.level >= sub.level * 0.36 &&
        (punch.trans > 0.08 || beater.flux > 0.06 || tdCrest > 1.95);
      if (isKickCharacter && cfg.bass && (this.activeSequence ? cfg.sequentialBass : cfg.oneShot)) {
        events.push({
          type: 'kick',
          timestamp: timestampMs,
          intensity: normStrength,
          confidence: clamp01(conf * 0.96 + (beater.flux > 0.08 ? 0.06 : 0)),
        });
      }
    }

    // Expire active sequence cleanly once cadence window lapses
    if (this.activeSequence) {
      const expireAfter = Math.min(720, Math.max(240, this.estimatedIntervalMs * 1.48));
      if (timestampMs - this.lastBassHitTs > expireAfter) {
        this.activeSequence = false;
        this.sequenceCount = 0;
        this.estimatedIntervalMs = 0;
      }
    }

    // Bass Sustain (Normal Bass): sustained low-band harmonic energy persisting >= 160 ms
    // Must NOT fire on wide midrange chord pads whose low tail is weaker than mids/vocals
    const lowDominatesPad =
      sub.level > 0.14 &&
      rawLow >= vocal.level * 0.52 &&
      (sub.level >= punch.level * 0.55 || rawLow > 0.34);
    const lowHarmRatio = rawLow > 0.08 ? rawLowHarm / (rawLow + 1e-4) : 0;
    const isSustainedBassFrame =
      lowDominatesPad &&
      rawLow > Math.max(0.16 * threshScale, this.lowNoiseFloor * 1.15) &&
      lowHarmRatio > 0.44 &&
      !bassImpactTriggered;

    if (isSustainedBassFrame) {
      this.sustainDurationMs += dt;
    } else if (rawLow < 0.12 * threshScale || !lowDominatesPad) {
      this.sustainDurationMs = Math.max(0, this.sustainDurationMs - dt * 2.4);
    }

    let targetBassSustain = 0;
    if (this.sustainDurationMs >= SUSTAIN_MIN_MS && cfg.bass) {
      targetBassSustain = clamp01(((rawLowHarm - 0.08) / Math.max(0.32, this.lowPeakEnv * 0.85)) * outGain);
      if (timestampMs - this.lastSustainEmitTs >= SUSTAIN_REEMIT_MS) {
        this.lastSustainEmitTs = timestampMs;
        events.push({
          type: 'bass_sustain',
          timestamp: timestampMs,
          intensity: Math.max(0.2, targetBassSustain),
          confidence: clamp01(0.55 + lowHarmRatio * 0.4),
          durationMs: Math.round(this.sustainDurationMs),
        });
      }
    }

    // 6. Non-Bass Drum & Percussion Classification (`snare`, `tom`, `hi_hat`, `cymbal`, `percussion`)
    const midLinRise = Math.max(0, snareSnap.lin - Math.min(this.prevSnareLin1, this.prevSnareLin2));
    const tomLinRise = Math.max(0, tom.lin - Math.min(this.prevTomLin1, this.prevTomLin2));
    const hatLinRise = Math.max(0, hiHat.lin - Math.min(this.prevHatLin1, this.prevHatLin2));
    const cymLinRise = Math.max(0, cymbal.lin - Math.min(this.prevCymLin1, this.prevCymLin2));
    const percLinRise = Math.max(0, percMid.lin - Math.min(this.prevPercLin1, this.prevPercLin2));

    this.midNoiseFloor = Math.max(
      0.03,
      Math.min(0.28, this.midNoiseFloor + (snareSnap.level - this.midNoiseFloor) * (1 - Math.exp(-dt / 420))),
    );
    this.highNoiseFloor = Math.max(
      0.025,
      Math.min(0.25, this.highNoiseFloor + (hiHat.level - this.highNoiseFloor) * (1 - Math.exp(-dt / 380))),
    );
    const hPeakTau = hiHat.level > this.highPeakEnv ? 50 : 2100;
    this.highPeakEnv = Math.max(
      0.32,
      this.highPeakEnv + (hiHat.level - this.highPeakEnv) * (1 - Math.exp(-dt / hPeakTau)),
    );

    if (!this.snareRearmed && (snareSnap.lin < this.lastSnarePeak * 0.6 || timestampMs - this.lastSnareTs > 130)) {
      this.snareRearmed = true;
    }
    if (!this.tomRearmed && (tom.lin < this.lastTomPeak * 0.6 || timestampMs - this.lastTomTs > 140)) {
      this.tomRearmed = true;
    }
    if (!this.hatRearmed && (hiHat.lin < this.lastHatPeak * 0.55 || timestampMs - this.lastHatTs > 95)) {
      this.hatRearmed = true;
    }
    if (
      !this.cymbalRearmed &&
      (cymbal.lin < this.lastCymbalPeak * 0.42 ||
        (timestampMs - this.lastCymbalTs > 220 && cymLinRise > this.lastCymbalPeak * 0.38))
    ) {
      this.cymbalRearmed = true;
    }
    if (!this.percRearmed && (percMid.lin < 0.08 || timestampMs - this.lastPercTs > 120)) {
      this.percRearmed = true;
    }

    let percImpulseStrength = 0;
    let trebleImpulseStrength = 0;
    let classifiedMidDrum = false;
    let classifiedHighMetal = false;

    // A) SNARE: 160–340 Hz body + broadband 1.6–5.5 kHz wire/snap noise burst
    const snareScore =
      (midLinRise * 0.58 + snareSnap.linFlux * 0.42) *
      dtSlopeScale *
      (0.6 + snapFlatness * 0.9) *
      (snareBody.lin > 0.03 ? 1.15 : 0.72);
    const vocalSnareBoost = 1 + vSuppress * (snapFlatness < 0.26 ? 2.1 : 0.65);
    const snareThreshold = 0.068 * threshScale * vocalSnareBoost;

    if (
      this.snareRearmed &&
      timestampMs - this.lastSnareTs >= DRUM_DEBOUNCE_MS &&
      snareScore >= snareThreshold &&
      snareSnap.lin > 0.075 * threshScale &&
      snareBody.lin > 0.03 &&
      // Require genuine broadband snare-wire noise (blocks narrowband kick beater clicks & vowel harmonics!)
      snapFlatness >= 0.18 &&
      !(bassImpactTriggered && sub.lin > snareSnap.lin * 2.1 && snapFlatness < 0.28) &&
      // Distinguish snare from pure hi-hat/cymbal (snare has body + 1.6–3.8 kHz mid-snap)
      snareBody.lin + midSnap.lin * 0.9 > hiHatCore.lin * 0.65
    ) {
      classifiedMidDrum = true;
      this.snareRearmed = false;
      this.lastSnareTs = timestampMs;
      this.lastSnarePeak = snareSnap.lin;
      const strength = clamp01((0.38 + snareSnap.level * 0.52 + snareBody.level * 0.25) * outGain);
      percImpulseStrength = Math.max(percImpulseStrength, strength);
      if (cfg.percussion) {
        events.push({
          type: 'snare',
          timestamp: timestampMs,
          intensity: strength,
          confidence: clamp01(0.55 + snapFlatness * 0.4 + snareScore * 0.8),
        });
      }
    }

    // B) TOM: resonant 95–260 Hz impact with minimal sub-bass (<75 Hz) and minimal >6 kHz wire/hat snap
    const tomScore =
      (tomLinRise * 0.62 + tom.linFlux * 0.38) *
      dtSlopeScale *
      (tom.trans > tom.level * 0.32 ? 1.12 : 0.62);
    const vocalTomBoost = 1 + vSuppress * 1.65;
    const tomThreshold = 0.11 * threshScale * vocalTomBoost;

    if (
      !classifiedMidDrum &&
      !bassImpactTriggered &&
      this.tomRearmed &&
      timestampMs - this.lastTomTs >= DRUM_DEBOUNCE_MS &&
      tomScore >= tomThreshold &&
      tom.lin > 0.14 * threshScale &&
      // Tom vs Kick: tom fundamental is 95–260 Hz, sub (<75 Hz) is much weaker
      sub.lin < tom.lin * 0.38 &&
      // Tom vs Snare/Cymbal: minimal high-frequency wire/hat burst
      hiHat.lin < tom.lin * 0.28 &&
      snareSnap.linFlux < tom.linFlux * 0.45 &&
      // Tom vs Male Vocal / Plosive: tom must dominate vocal context & formants when vocalSuppression active
      tom.lin > (vocal.lin + this.vocalSlowEnv * 0.35 * vSuppress) * (0.62 + vSuppress * 1.1)
    ) {
      classifiedMidDrum = true;
      this.tomRearmed = false;
      this.lastTomTs = timestampMs;
      this.lastTomPeak = tom.lin;
      const strength = clamp01((0.36 + tom.level * 0.62) * outGain);
      percImpulseStrength = Math.max(percImpulseStrength, strength);
      if (cfg.percussion) {
        events.push({
          type: 'tom',
          timestamp: timestampMs,
          intensity: strength,
          confidence: clamp01(0.56 + (tomScore / (tomThreshold + 0.12)) * 0.38),
        });
      }
    }

    // C) HI-HAT vs CYMBAL: high-frequency metallic transient (4.5–16 kHz)
    // Smooth continuous vocal-sibilant suppression (no step cliff): fricatives ("s", "sh") have softer
    // 40–60 ms rise & lower crest than crisp 1–2 ms metallic drumstick strikes.
    const highTransLin = Math.max(hiHat.lin, cymbal.lin * 0.92);
    const stickSharpness = clamp01((tdCrest - 2.2) / 1.8);
    const sibilantLikelihood =
      vSuppress * (1 - stickSharpness * 0.72) * clamp01(1.35 - highTransLin * 3.2);
    const highSibilantBoost = 1 + vSuppress * 0.45 + sibilantLikelihood * 2.15;

    const highLinRise = Math.max(hatLinRise, cymLinRise * 0.92);
    const highLinFlux = Math.max(hiHat.linFlux, cymbal.linFlux * 0.92);
    const hasHighTransientExcess =
      hiHat.trans > hiHat.level * 0.34 || cymbal.trans > cymbal.level * 0.36;
    const highScore =
      (highLinRise * 0.58 + highLinFlux * 0.42) *
      dtSlopeScale *
      (hasHighTransientExcess ? 1.1 : 0.48);
    const highThreshold = 0.054 * threshScale * highSibilantBoost;

    if (
      !classifiedMidDrum &&
      hasHighTransientExcess &&
      // Guard against trailing frame of a snare wire burst double-firing a hi-hat 16 ms later
      timestampMs - this.lastSnareTs >= 55 &&
      highScore >= highThreshold &&
      highTransLin > 0.06 * threshScale &&
      snareBody.linFlux < highLinFlux * 0.85
    ) {
      // Distinguish Cymbal (broad 4.0–15 kHz metallic wash with strong 4.0–6.3 kHz shimmer)
      // from crisp Hi-Hat (concentrated 6.5–16 kHz burst with high spectral centroid)
      const lowShimmerRatio = cymbalLow.power / (hiHatCore.power + 1e-7);
      const isCymbalWash =
        lowShimmerRatio >= 0.34 &&
        cymbal.lin >= 0.075 * threshScale &&
        snareBody.lin < cymbal.lin * 0.42;

      if (isCymbalWash) {
        if (this.cymbalRearmed && timestampMs - this.lastCymbalTs >= 135) {
          classifiedHighMetal = true;
          this.cymbalRearmed = false;
          this.lastCymbalTs = timestampMs;
          this.lastCymbalPeak = cymbal.lin;
          const strength = clamp01((0.36 + (cymbal.level / this.highPeakEnv) * 0.54) * outGain);
          percImpulseStrength = Math.max(percImpulseStrength, strength * 0.85);
          trebleImpulseStrength = Math.max(trebleImpulseStrength, strength);
          if (cfg.percussion) {
            events.push({
              type: 'cymbal',
              timestamp: timestampMs,
              intensity: strength,
              confidence: clamp01(0.56 + Math.min(0.38, lowShimmerRatio * 0.32)),
            });
          }
        }
      } else if (
        this.hatRearmed &&
        timestampMs - this.lastHatTs >= HIHAT_DEBOUNCE_MS &&
        // True hi-hat concentrates energy above 6.8 kHz rather than 1.6–3.8 kHz snare wires
        hiHatCore.lin >= midSnap.lin * 0.65
      ) {
        classifiedHighMetal = true;
        this.hatRearmed = false;
        this.lastHatTs = timestampMs;
        this.lastHatPeak = hiHat.lin;
        const strength = clamp01((0.34 + (hiHat.level / this.highPeakEnv) * 0.56) * outGain);
        percImpulseStrength = Math.max(percImpulseStrength, strength * 0.72);
        trebleImpulseStrength = Math.max(trebleImpulseStrength, strength);
        if (cfg.percussion) {
          events.push({
            type: 'hi_hat',
            timestamp: timestampMs,
            intensity: strength,
            confidence: clamp01(0.6 + (1 - Math.min(1, lowShimmerRatio * 2)) * 0.32),
          });
        }
      }
    }

    // D) GENERIC PERCUSSION: sharp rhythmic mid/high transient (woodblock, cowbell, rim, conga, shaker)
    const percScore =
      (percLinRise * 0.6 + percMid.linFlux * 0.4) *
      dtSlopeScale *
      (percMid.trans > percMid.level * 0.38 ? 1.12 : 0.52);
    const percThreshold = 0.105 * threshScale * (1 + vSuppress * 1.85);

    if (
      !classifiedMidDrum &&
      !classifiedHighMetal &&
      !bassImpactTriggered &&
      this.percRearmed &&
      timestampMs - this.lastPercTs >= DRUM_DEBOUNCE_MS &&
      percScore >= percThreshold &&
      percMid.lin > 0.12 * threshScale &&
      tdCrest > 2.35 &&
      vSuppress < 0.48
    ) {
      this.percRearmed = false;
      this.lastPercTs = timestampMs;
      const strength = clamp01((0.32 + percMid.level * 0.52) * outGain);
      percImpulseStrength = Math.max(percImpulseStrength, strength);
      if (cfg.percussion) {
        const type: MusicEventType = 'percussion';
        events.push({
          type,
          timestamp: timestampMs,
          intensity: strength,
          confidence: clamp01(0.52 + (percScore / (percThreshold + 0.12)) * 0.38),
        });
      }
    }

    // Update 2-frame linear history buffers
    this.prevLowLin2 = this.prevLowLin1;
    this.prevLowLin1 = rawLowLin;
    this.prevSubLin1 = sub.lin * lowBleedPenalty;
    this.prevPunchLin1 = punch.lin * lowBleedPenalty;
    this.prevTomLin2 = this.prevTomLin1;
    this.prevTomLin1 = tom.lin;
    this.prevSnareLin2 = this.prevSnareLin1;
    this.prevSnareLin1 = snareSnap.lin;
    this.prevHatLin2 = this.prevHatLin1;
    this.prevHatLin1 = hiHat.lin;
    this.prevCymLin2 = this.prevCymLin1;
    this.prevCymLin1 = cymbal.lin;
    this.prevPercLin2 = this.prevPercLin1;
    this.prevPercLin1 = percMid.lin;

    // 7. Smooth Output Envelopes (0..1)
    const sTau = targetBassSustain > this.bassSustainOut ? 42 : 165;
    this.bassSustainOut += (targetBassSustain - this.bassSustainOut) * (1 - Math.exp(-dt / sTau));
    if (!cfg.bass || this.bassSustainOut < 0.005) {
      if (!cfg.bass) this.bassSustainOut = 0;
      else if (this.bassSustainOut < 0.005) this.bassSustainOut = 0;
    }

    this.bassImpactOut *= Math.exp(-dt / 155);
    const allowBassImpact =
      cfg.bass && (this.activeSequence ? cfg.sequentialBass : cfg.oneShot);
    if (bassImpactTriggered && allowBassImpact && bassImpactStrength > this.bassImpactOut) {
      this.bassImpactOut = bassImpactStrength;
    }
    if (!cfg.bass || this.bassImpactOut < 0.005) {
      if (!cfg.bass) this.bassImpactOut = 0;
      else if (this.bassImpactOut < 0.005) this.bassImpactOut = 0;
    }

    let targetSeqRate = 0;
    if (this.activeSequence && cfg.bass && cfg.sequentialBass && this.estimatedIntervalMs > 0) {
      // Map 650 ms -> ~0.18 up to 90 ms -> 1.0
      targetSeqRate = clamp01(
        0.16 + ((MAX_SEQUENCE_IOI_MS - this.estimatedIntervalMs) / (MAX_SEQUENCE_IOI_MS - 85)) * 0.84,
      );
    }
    const seqTau = targetSeqRate > this.bassSeqRateOut ? 28 : 210;
    this.bassSeqRateOut += (targetSeqRate - this.bassSeqRateOut) * (1 - Math.exp(-dt / seqTau));
    if (this.bassSeqRateOut < 0.005) this.bassSeqRateOut = 0;

    this.percussionOut *= Math.exp(-dt / 125);
    if (cfg.percussion && percImpulseStrength > this.percussionOut) {
      this.percussionOut = percImpulseStrength;
    }
    if (!cfg.percussion || this.percussionOut < 0.005) {
      if (!cfg.percussion) this.percussionOut = 0;
      else if (this.percussionOut < 0.005) this.percussionOut = 0;
    }

    const shimmerFloor =
      cfg.percussion && sibilantLikelihood < 0.35 && cymbal.level > 0.18
        ? clamp01(((cymbal.level - 0.16) / this.highPeakEnv) * 0.55 * outGain)
        : 0;
    const trebleTarget = cfg.percussion ? Math.max(trebleImpulseStrength, shimmerFloor) : 0;
    this.trebleOut *= Math.exp(-dt / 115);
    if (trebleTarget > this.trebleOut) {
      this.trebleOut = trebleTarget;
    } else if (shimmerFloor > 0) {
      this.trebleOut += (shimmerFloor - this.trebleOut) * (1 - Math.exp(-dt / 65));
    }
    if (!cfg.percussion || this.trebleOut < 0.005) {
      if (!cfg.percussion) this.trebleOut = 0;
      else if (this.trebleOut < 0.005) this.trebleOut = 0;
    }

    // Touch tdZcrHz to suppress unused-local lint while slightly refining bright metallic confidence if ultra-high ZCR
    if (tdZcrHz > 5500 && cfg.percussion && this.trebleOut > 0.05) {
      this.trebleOut = clamp01(this.trebleOut * 1.03);
    }

    const frame: PulseAnalysisFrame = {
      timestamp: timestampMs,
      bassSustain: clamp01(this.bassSustainOut),
      bassImpact: clamp01(this.bassImpactOut),
      bassSequenceRate: clamp01(this.bassSeqRateOut),
      percussion: clamp01(this.percussionOut),
      treble: clamp01(this.trebleOut),
      vocalLikelihood,
      activeSequence: Boolean(this.activeSequence && cfg.bass && cfg.sequentialBass),
      events: events.length > 0 ? events : EMPTY_EVENTS,
    };

    this.latestFrame = frame;
    return frame;
  }
}

class RuntimePulseDriver implements MusicAnalysisDriver {
  private readonly analyzer = new Pulse2Analyzer(1024);
  private consumerCount = 0;
  private rafId = 0;
  private windowVisible = true;
  private listenersAttached = false;
  private lastTrackId: string | null = null;
  private lastPlaying = false;
  private lastPosition = 0;
  private lastPositionWallMs = 0;
  private offVisualVisibility: (() => void) | undefined;
  private offStore: (() => void) | undefined;

  private isDocHidden(): boolean {
    return typeof document !== 'undefined' && Boolean(document.hidden);
  }

  private attachLifecycleListeners(): void {
    if (this.listenersAttached || typeof window === 'undefined') return;
    this.listenersAttached = true;

    const initialState = useApp.getState();
    this.lastTrackId = initialState.queue[initialState.index]?.id ?? null;
    this.lastPlaying = initialState.playing;
    this.lastPosition = initialState.position;
    this.lastPositionWallMs = performance.now();

    if (window.glass?.visualState) {
      void window.glass
        .visualState()
        .then(v => {
          if (typeof v === 'boolean') {
            this.windowVisible = v;
            this.syncLoop();
          }
        })
        .catch(() => {});
    }

    this.offVisualVisibility = window.glass?.onVisualVisibility?.(visible => {
      this.windowVisible = visible;
      this.syncLoop();
    });

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.offStore = useApp.subscribe(state => {
      const now = performance.now();
      const trackId = state.queue[state.index]?.id ?? null;
      const trackChanged = trackId !== this.lastTrackId;
      const elapsedSec = Math.max(0, (now - this.lastPositionWallMs) / 1000);
      const posDelta = Math.abs(state.position - (this.lastPosition + (this.lastPlaying ? elapsedSec : 0)));
      const seekJumped = !trackChanged && posDelta > 1.5;

      this.lastTrackId = trackId;
      this.lastPosition = state.position;
      this.lastPositionWallMs = now;

      if (trackChanged || seekJumped) {
        this.analyzer.reset();
        if (this.consumerCount > 0) {
          emitMusicAnalysisFrame({ ...EMPTY_PULSE_FRAME, timestamp: now });
        }
      }

      if (state.playing !== this.lastPlaying) {
        this.lastPlaying = state.playing;
        if (!state.playing && this.consumerCount > 0) {
          emitMusicAnalysisFrame({ ...EMPTY_PULSE_FRAME, timestamp: now });
        }
        this.syncLoop();
      }
    });
  }

  private readonly handleVisibilityChange = (): void => {
    this.syncLoop();
  };

  private shouldRun(): boolean {
    return (
      this.consumerCount > 0 &&
      useApp.getState().playing &&
      !this.isDocHidden() &&
      this.windowVisible &&
      typeof requestAnimationFrame === 'function'
    );
  }

  private syncLoop(): void {
    if (this.shouldRun()) {
      if (!this.rafId) {
        this.rafId = requestAnimationFrame(this.tick);
      }
    } else if (this.rafId) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.rafId);
      }
      this.rafId = 0;
    }
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0;
    if (!this.shouldRun()) return;

    const snapshot = sampleAudioSpectrum();
    if (snapshot) {
      const prefs = useApp.getState().data.preferences.pulseConfig;
      const frame = this.analyzer.analyzeFrame(snapshot, now, prefs);
      emitMusicAnalysisFrame(frame);
    } else {
      emitMusicAnalysisFrame({ ...EMPTY_PULSE_FRAME, timestamp: now });
    }

    if (this.shouldRun()) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  onConsumersChanged(count: number): void {
    this.consumerCount = count;
    if (count > 0) {
      this.attachLifecycleListeners();
    }
    this.syncLoop();
  }

  getLatestFrame(): PulseAnalysisFrame {
    return this.analyzer.getLatestFrame();
  }

  reset(): void {
    this.analyzer.reset();
  }

  dispose(): void {
    if (this.rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.offVisualVisibility?.();
    this.offVisualVisibility = undefined;
    this.offStore?.();
    this.offStore = undefined;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.listenersAttached = false;
  }
}

export const pulseEngine = new RuntimePulseDriver();

let registered = false;

export function ensurePulseEngineRegistered(): MusicAnalysisDriver {
  if (!registered) {
    registered = true;
    registerMusicAnalysisDriver(pulseEngine);
  }
  return pulseEngine;
}

ensurePulseEngineRegistered();
