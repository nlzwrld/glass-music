import { useEffect } from 'react';
import { jamPosition, jamDriftMs, canJam, type JamRoom } from '../../../shared/jam';
import { computeBackoffMs } from '../../lib/jam';
import { useApp, cleanError } from '../../stores/app';
import { transport } from '../player/engine';
import { jamClient, useJam } from './state';

export function JamEngine() {
  const session = useJam(s => s.session),
    consent = useApp(
      s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone,
    );

  useEffect(() => {
    if (!session) {
      transport.rate(1);
      return;
    }
    if (!consent) {
      void useJam.getState().leave();
      transport.pause();
      transport.rate(1);
      return;
    }

    let disposed = false,
      timer: ReturnType<typeof setTimeout>,
      room: JamRoom | null = null,
      lastSeek = 0,
      changing = '',
      failures = 0,
      lastSuccess = Date.now(),
      followTimer: ReturnType<typeof setTimeout>;

    // Initial fast RTT calibration burst for millisecond clock sync
    void (async () => {
      for (let i = 0; i < 2; i++) {
        if (disposed) return;
        try {
          const rtt = await jamClient.ping();
          if (!disposed) useJam.setState({ rttMs: Math.round(rtt) });
        } catch {
          break;
        }
      }
    })();

    const follow = () => {
      if (disposed || session.host || !room) return;
      const target = room.playback,
        s = useApp.getState(),
        current = s.queue[s.index];
      if (!target.track) {
        transport.rate(1);
        if (s.playing) transport.pause();
        return;
      }
      if (current?.id !== target.track.id) {
        if (changing !== target.track.id) {
          changing = target.track.id;
          lastSeek = 0;
          transport.rate(1);
          useApp.getState().play(target.track);
        }
        return;
      }
      changing = '';
      if (s.status === 'Carregando' || s.status === 'Preparando áudio') return;
      if (!target.playing && s.playing) {
        transport.rate(1);
        transport.pause();
      } else if (target.playing && !s.playing && !s.error) {
        transport.toggle();
      }

      const nowCalibrated = jamClient.clock.now();
      const expectedPos = jamPosition(target, nowCalibrated);
      const driftMs = jamDriftMs(s.position, target, nowCalibrated);
      const absDriftMs = Math.abs(driftMs);

      if (absDriftMs >= 380 && Date.now() - lastSeek > 1500) {
        // Large drift: crisp seek alignment
        lastSeek = Date.now();
        transport.rate(1);
        transport.seek(expectedPos);
      } else if (target.playing && absDriftMs >= 45 && absDriftMs < 380) {
        // Sub-380ms drift: gentle inaudible playbackRate nudge (0.97x..1.03x) for ms-level lock
        const nudge = Math.max(-0.03, Math.min(0.03, driftMs / 4000));
        transport.rate(1 + nudge);
      } else {
        transport.rate(1);
      }
    };

    const off = useApp.subscribe((state, previous) => {
      if (session.host) return;
      if (
        state.playing !== previous.playing ||
        state.status !== previous.status ||
        state.queue[state.index]?.id !== previous.queue[previous.index]?.id
      ) {
        clearTimeout(followTimer);
        followTimer = setTimeout(follow, 0);
      }
    });

    const tick = async () => {
      let nextDelay = 850;
      try {
        const s = useApp.getState(),
          track = s.queue[s.index],
          shared = canJam(track) ? track : null;
        const payload = session.host
          ? { track: shared, playing: !!shared && s.playing, position: shared ? s.position : 0 }
          : undefined;
        const value = await jamClient.update(payload);
        if (disposed) return;
        room = value;
        failures = 0;
        lastSuccess = Date.now();
        useJam.setState({
          room: value,
          connected: true,
          error: '',
          rttMs: Math.round(jamClient.clock.rttMs),
        });
        follow();
      } catch (e) {
        if (disposed) return;
        failures++;
        const error = cleanError(e);
        useJam.setState({ connected: false, error });

        // Automatic Hybrid Cloud -> LAN Fallback when Cloud server fails
        if (failures >= 3 && jamClient.session?.mode === 'cloud') {
          try {
            const s = useApp.getState(),
              track = s.queue[s.index],
              shared = canJam(track) ? track : null;
            const migrated = await jamClient.fallbackToLan(
              session.host
                ? {
                    track: shared,
                    playing: !!shared && s.playing,
                    position: shared ? s.position : 0,
                  }
                : undefined,
            );
            if (migrated && !disposed) {
              failures = 0;
              lastSuccess = Date.now();
              useJam.setState({
                session: migrated,
                room: migrated,
                connected: true,
                error: '',
              });
              useApp
                .getState()
                .message('Servidor Cloud indisponível: JAM migrada automaticamente para a rede local (LAN).');
              return;
            }
          } catch {
            // Continue exponential backoff if LAN fallback is not yet reachable
          }
        }

        if (Date.now() - lastSuccess > 25000) {
          if (!session.host) transport.pause();
          transport.rate(1);
          void useJam.getState().leave();
          useApp.getState().message(`JAM desconectada. ${error}`);
          return;
        }
        nextDelay = computeBackoffMs(failures, 600, 8000);
      }
      if (!disposed) timer = setTimeout(() => void tick(), nextDelay);
    };

    void tick();
    return () => {
      disposed = true;
      transport.rate(1);
      clearTimeout(timer);
      clearTimeout(followTimer);
      off();
    };
  }, [session?.token, session?.endpoint, consent]);

  return null;
}
