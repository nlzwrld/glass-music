import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioGraph, boostedGain } from '../../src/lib/audioGraph';
import { invalidatePlayback, preparePlayback } from '../../src/lib/playback';
import { JamClient } from '../../src/lib/jam';
import { isCurrentPlaybackRevision } from '../../src/components/player/engine';
import { useApp } from '../../src/stores/app';
import { defaults, type Track } from '../../shared/types';
import type { JamSession } from '../../shared/jam';

function makeRemoteTrack(id: string, title: string): Track {
  return {
    id: `youtube:${id}`,
    source: 'youtube',
    sourceId: id,
    kind: 'track',
    title,
    artist: 'Artista Teste',
    duration: 180,
    addedAt: 0,
  };
}

function makeHeldAudioContext(heldValue: number) {
  const gainParams: Array<{
    value: number;
    cancelAndHoldAtTime: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    setTargetAtTime: ReturnType<typeof vi.fn>;
  }> = [];

  const makeAudioParam = (initial = 1) => {
    const param = {
      value: initial,
      cancelAndHoldAtTime: vi.fn(() => {
        // Simulate Web Audio thread holding an exact mid-ramp value different from JS initial/target
        param.value = heldValue;
      }),
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
      linearRampToValueAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
      setTargetAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
    };
    gainParams.push(param);
    return param;
  };

  const makeNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const ctx = {
    state: 'running',
    currentTime: 24,
    sampleRate: 48000,
    destination: {},
    createBiquadFilter: vi.fn(() => ({
      ...makeNode(),
      type: 'peaking',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: makeAudioParam(0),
    })),
    createGain: vi.fn(() => ({
      ...makeNode(),
      gain: makeAudioParam(1),
    })),
    createDynamicsCompressor: vi.fn(() => ({
      ...makeNode(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
    createAnalyser: vi.fn(() => ({
      ...makeNode(),
      fftSize: 256,
      frequencyBinCount: 128,
      smoothingTimeConstant: 0.78,
      getByteFrequencyData: vi.fn(),
    })),
    createMediaElementSource: vi.fn(() => makeNode()),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { ctx, gainParams };
}

afterEach(() => {
  invalidatePlayback();
  vi.unstubAllGlobals();
});

describe('Playback, Fade & JAM Concurrency Regressions', () => {
  it('anchors cancelAndHoldAtTime without overwriting the held audio-thread gain and preserves user volume', async () => {
    const { ctx, gainParams } = makeHeldAudioContext(0.63);
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return ctx; }));

    const graph = new AudioGraph();
    const el = {} as HTMLAudioElement;
    graph.attach(el);
    await graph.configure({ ...defaults, volume: 42, volumeBoost: 0 });

    const boostGain = gainParams[5]!;
    const deckGain = gainParams[6]!;
    // Simulate a fade-out interrupted mid-ramp before linearRamp finishes
    deckGain.value = 0.99;

    graph.level(el, 1, 0.25, true);

    expect(deckGain.cancelAndHoldAtTime).toHaveBeenCalledWith(24);
    expect(deckGain.setValueAtTime).not.toHaveBeenCalled();
    expect(deckGain.cancelAndHoldAtTime.mock.invocationCallOrder[0]).toBeLessThan(
      deckGain.linearRampToValueAtTime.mock.invocationCallOrder[0],
    );
    expect(deckGain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 24.25);
    expect(boostGain.setTargetAtTime).toHaveBeenLastCalledWith(
      expect.closeTo(boostedGain(42, 0), 4),
      24,
      0.025,
    );
  });

  it('resolves out-of-order A -> B -> C preparations in favor of C while releasing/cancelling A and B', async () => {
    type Deferred = { resolve: (v: { url: string; duration: number }) => void };
    const deferredById = new Map<string, Deferred>();
    const cancelSearch = vi.fn(async () => {});
    const audioSource = vi.fn((sourceId: string) => {
      return new Promise<{ url: string; duration: number }>(resolve => {
        deferredById.set(sourceId, { resolve });
      });
    });
    vi.stubGlobal('window', { glass: { audioSource, cancelSearch } });

    const trackA = makeRemoteTrack('aaa11111111', 'Música A');
    const trackB = makeRemoteTrack('bbb22222222', 'Música B');
    const trackC = makeRemoteTrack('ccc33333333', 'Música C');

    const prepA = preparePlayback(trackA);
    prepA.release();
    const prepB = preparePlayback(trackB);
    prepB.release();
    const prepC = preparePlayback(trackC);

    // Out-of-order network resolution: C finishes first, then B, then A
    deferredById.get('ccc33333333')!.resolve({ url: 'http://127.0.0.1/audio/c', duration: 180 });
    deferredById.get('bbb22222222')!.resolve({ url: 'http://127.0.0.1/audio/b', duration: 180 });
    deferredById.get('aaa11111111')!.resolve({ url: 'http://127.0.0.1/audio/a', duration: 180 });

    const resC = await prepC.promise;
    expect(resC.track.id).toBe(trackC.id);
    expect(resC.source.url).toBe('http://127.0.0.1/audio/c');
    await expect(prepA.promise).rejects.toThrow();
    await expect(prepB.promise).rejects.toThrow();
    expect(cancelSearch).toHaveBeenCalledTimes(2);
    prepC.release();
  });

  it('prevents stale onEnded / auto-advance races after manual skip increments revision', () => {
    const a = makeRemoteTrack('aaa11111111', 'Faixa A');
    const b = makeRemoteTrack('bbb22222222', 'Faixa B');
    const c = makeRemoteTrack('ccc33333333', 'Faixa C');

    useApp.setState({
      revision: 1,
      queue: [a, b, c],
      index: 0,
      shufflePlayed: [0],
      shuffleNext: null,
      data: {
        tracks: [a, b, c],
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults, shuffle: false, repeat: 'off' },
      },
    });

    const effectRevisionBeforeManualNext = useApp.getState().revision;
    expect(isCurrentPlaybackRevision(effectRevisionBeforeManualNext, false, false)).toBe(true);

    // User clicks "Próxima" manually right as track A's audio element fires `ended`
    useApp.getState().next(true);
    expect(useApp.getState().index).toBe(1);
    expect(useApp.getState().revision).toBe(effectRevisionBeforeManualNext + 1);

    // Stale A effect's onEnded check MUST return false so it cannot double-skip from B to C
    expect(isCurrentPlaybackRevision(effectRevisionBeforeManualNext, false, false)).toBe(false);
    expect(useApp.getState().index).toBe(1);
  });

  it('coalesces concurrent JamClient.enter calls into one single-flight request', async () => {
    let calls = 0;
    const send = vi.fn(async (req: { action: string }) => {
      if (req.action === 'join') {
        calls++;
        await new Promise(r => setTimeout(r, 25));
        return {
          code: 'K9M4P2XR',
          roomId: 'jam_1',
          roomName: 'Sala Unica',
          host: false,
          token: 'tok_single',
          memberId: 'm_1',
          members: [],
          playback: { track: null, playing: false, position: 0, updatedAt: Date.now(), sequence: 0 },
          serverTime: Date.now(),
        } as unknown as JamSession;
      }
      throw new Error(`Unexpected action: ${req.action}`);
    });

    const client = new JamClient(send as unknown as ConstructorParameters<typeof JamClient>[0]);
    const [s1, s2] = await Promise.all([
      client.enter('join', 'Ouvinte', 'K9M4P2XR', 'https://jam.example'),
      client.enter('join', 'Ouvinte', 'K9M4P2XR', 'https://jam.example'),
    ]);

    expect(calls).toBe(1);
    expect(s1.token).toBe('tok_single');
    expect(s2.token).toBe('tok_single');
  });
});
