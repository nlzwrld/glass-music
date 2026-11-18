import { useEffect, useRef } from 'react';
import { useApp, currentTrack, cleanError, upcomingIndex } from '../../stores/app';
import type { Track } from '../../../shared/types';
import { preparePlayback, invalidatePlayback } from '../../lib/playback';
import { nativeResource } from '../../lib/native';
import { AudioGraph, transitionSeconds } from '../../lib/audioGraph';
import { coverURL } from '../glass/Cover';

type Driver = { play(): void; pause(): void; seek(n: number): void; volume(n: number): void };
let driver: Driver | undefined;

export const transport = {
  toggle: () => {
    if (!currentTrack()) return;
    useApp.getState().playing ? driver?.pause() : driver?.play();
  },
  pause: () => driver?.pause(),
  seek: (n: number) => driver?.seek(n),
  volume: (n: number) => driver?.volume(n),
};

function upcomingTrack(): Track | undefined {
  const s = useApp.getState();
  const idx = upcomingIndex(s, false);
  return idx >= 0 ? s.queue[idx] : undefined;
}

export function PlayerEngine() {
  const first = useRef<HTMLAudioElement>(null),
    second = useRef<HTMLAudioElement>(null),
    iframe = useRef<HTMLIFrameElement>(null);
  const activeDeck = useRef(0),
    graph = useRef<AudioGraph | undefined>(undefined),
    retire = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    outgoingDeck = useRef<HTMLAudioElement | undefined>(undefined),
    staged = useRef<{ id: string; url: string; duration: number } | undefined>(undefined);

  const track = useApp(s => s.queue[s.index]),
    revision = useApp(s => s.revision),
    preferences = useApp(s => s.data.preferences),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    shuffleNext = useApp(s => s.shuffleNext);
  const consent = preferences.onlineConsent && preferences.onboardingDone;
  const playbackAllowed = track?.source === 'local' || track?.offline || consent;
  const activeGeneration = useRef(0);
  const elements = () => [first.current!, second.current!];

  const setupGraph = () => {
    if (!graph.current) {
      graph.current = new AudioGraph();
      elements().forEach(el => graph.current!.attach(el));
    }
    void graph.current
      .configure(useApp.getState().data.preferences)
      .catch(e => useApp.getState().message(cleanError(e)));
    void graph.current.resume();
    return graph.current;
  };

  const stageStandby = () => {
    const info = staged.current;
    if (!info) return;
    const all = elements();
    const standby = all[1 - activeDeck.current];
    if (!standby || standby === outgoingDeck.current) return;
    if (standby.dataset.stagedId === info.id && standby.hasAttribute('src')) return;
    setupGraph().level(standby, 0);
    standby.dataset.stagedId = info.id;
    standby.preload = 'auto';
    standby.src = info.url;
    standby.load();
  };

  useEffect(() => {
    if (!consent) {
      invalidatePlayback();
      staged.current = undefined;
    }
  }, [consent]);

  useEffect(() => {
    const generation = ++activeGeneration.current,
      all = elements();
    clearTimeout(retire.current);

    const isAuto = useApp.getState().autoAdvance;
    const former = all[activeDeck.current],
      hadPrevious = former.hasAttribute('src') && !former.paused;
    const allowOverlap =
      !!track &&
      playbackAllowed &&
      track.source !== 'soundcloud' &&
      hadPrevious &&
      (preferences.transition === 'crossfade' || (!isAuto && preferences.transition === 'fade'));
    const outgoing = allowOverlap ? former : undefined;
    outgoingDeck.current = outgoing;

    const otherDeck = all[1 - activeDeck.current];
    const otherIsStaged =
      !!track &&
      otherDeck.dataset.stagedId === track.id &&
      otherDeck.hasAttribute('src') &&
      !otherDeck.error;
    const selected = allowOverlap || otherIsStaged ? 1 - activeDeck.current : activeDeck.current;
    activeDeck.current = selected;

    const el = all[selected],
      frame = iframe.current!;
    let cancelled = false,
      recorded = false,
      advanced = false,
      started = false,
      fadingOut = false,
      pausedDuringPreparation = false,
      frameOrigin = '',
      resolvedTrack = track;
    let preparation: ReturnType<typeof preparePlayback> | undefined;

    all.forEach((deck, i) => {
      deck.dataset.active = String(i === selected);
      if (deck !== outgoing && deck !== el) {
        deck.pause();
        deck.removeAttribute('src');
        delete deck.dataset.stagedId;
        deck.load();
      }
    });

    frame.src = 'about:blank';
    driver = undefined;

    const update = (state: Partial<ReturnType<typeof useApp.getState>>) => {
      if (!cancelled && generation === activeGeneration.current) useApp.setState(state);
    };
    const stopOutgoing = () => {
      if (outgoing) {
        outgoing.pause();
        outgoing.removeAttribute('src');
        delete outgoing.dataset.stagedId;
        outgoing.load();
        graph.current?.level(outgoing, 0);
      }
      if (outgoingDeck.current === outgoing) {
        outgoingDeck.current = undefined;
        stageStandby();
      }
    };
    const fail = (message: string) => {
      stopOutgoing();
      update({ error: message, playing: false, status: 'Indisponível' });
    };

    // Safety ramp: if outgoing is active while incoming prepares, gently fade outgoing over its remaining tail
    // so it NEVER cuts abruptly at 100% volume if network preparation takes longer than expected.
    if (outgoing && isAuto && preferences.transition === 'crossfade') {
      const rem = Number.isFinite(outgoing.duration)
        ? Math.max(0.25, outgoing.duration - outgoing.currentTime)
        : transitionSeconds(preferences.transitionSeconds);
      graph.current?.level(outgoing, 0, rem);
    }

    const onPlay = () => {
      if (cancelled) return;
      if (!started) {
        started = true;
        const p = useApp.getState().data.preferences,
          g = graph.current;
        if (g) {
          if (outgoing && isAuto && p.transition === 'crossfade') {
            const fullDur = transitionSeconds(p.transitionSeconds);
            const outRem = Number.isFinite(outgoing.duration)
              ? Math.max(0.18, outgoing.duration - outgoing.currentTime)
              : fullDur;
            const fadeOutDur = Math.min(fullDur, outRem);
            g.level(el, 0);
            g.level(el, 1, fullDur, true);
            g.level(outgoing, 0, fadeOutDur, true);
            retire.current = setTimeout(stopOutgoing, Math.max(fullDur, fadeOutDur) * 1000 + 60);
          } else if (outgoing && !isAuto && p.transition !== 'off') {
            // Smooth micro-crossfade on manual song change — zero startup lag!
            g.level(el, 0);
            g.level(el, 1, 0.14);
            g.level(outgoing, 0, 0.22);
            retire.current = setTimeout(stopOutgoing, 260);
          } else if (isAuto && p.transition === 'fade') {
            stopOutgoing();
            const fadeIn = Math.min(transitionSeconds(p.transitionSeconds) * 0.55, 1.5);
            g.level(el, 0);
            g.level(el, 1, fadeIn);
          } else {
            stopOutgoing();
            g.level(el, p.transition === 'off' ? 1 : 0);
            if (p.transition !== 'off') g.level(el, 1, 0.06);
          }
        } else stopOutgoing();
      }
      update({ playing: true, status: 'Reproduzindo', error: '' });
      if (!recorded && resolvedTrack) {
        recorded = true;
        void useApp
          .getState()
          .mutate({ action: 'history', track: resolvedTrack })
          .catch(() => {});
        void window.glass.notify({
          title: resolvedTrack.title,
          artist: resolvedTrack.artist,
        });
      }
    };

    const onPause = () => {
      if (!cancelled && !advanced) update({ playing: false, status: 'Pausado' });
    };
    const onSeeked = () => {
      fadingOut = false;
      if (!el.paused) graph.current?.level(el, 1, 0.06);
    };
    const onTime = () => {
      const duration = Number.isFinite(el.duration) ? el.duration : track?.duration || 0;
      update({ position: el.currentTime, duration });
      if ('mediaSession' in navigator && duration > 0 && el.currentTime <= duration) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: el.playbackRate || 1,
            position: Math.max(0, el.currentTime),
          });
        } catch {}
      }
      const p = useApp.getState().data.preferences,
        remaining = duration - el.currentTime;
      if (duration > 0 && el.currentTime > 0 && !el.paused && !advanced && remaining > 0) {
        const seconds = Math.min(
          transitionSeconds(p.transitionSeconds),
          Math.max(0.5, duration * 0.45),
        );
        if (remaining <= Math.max(15, seconds + 10)) {
          stageStandby();
        }
        if (p.transition === 'crossfade' && remaining <= seconds && upcomingTrack()) {
          advanced = true;
          useApp.getState().next(false);
        } else if (p.transition === 'fade') {
          if (!fadingOut && remaining <= seconds) {
            fadingOut = true;
            graph.current?.level(el, 0, remaining);
          }
          if (remaining <= 0.08 && upcomingTrack() && staged.current?.id === upcomingTrack()?.id) {
            advanced = true;
            useApp.getState().next(false);
          }
        }
      }
    };
    const onEnded = () => {
      if (!advanced) {
        advanced = true;
        useApp.getState().next(false);
      }
    };
    const onError = () => {
      if (track) invalidatePlayback(track.id);
      if (el.hasAttribute('src'))
        fail(
          track?.source !== 'local'
            ? 'O áudio não pôde ser carregado. Tente reproduzir novamente.'
            : 'Não foi possível abrir o arquivo de áudio.',
        );
    };
    const message = (e: MessageEvent) => {
      if (
        e.origin !== frameOrigin ||
        e.source !== frame.contentWindow ||
        e.data?.channel !== 'glass-player' ||
        cancelled
      )
        return;
      const d = e.data;
      if (d.type === 'playing') onPlay();
      if (d.type === 'paused') onPause();
      if (d.type === 'ended') onEnded();
      if (d.type === 'buffering') update({ status: 'Carregando' });
      if (d.type === 'ready') driver?.volume(useApp.getState().data.preferences.volume);
      if (d.type === 'time' && Number.isFinite(d.position) && Number.isFinite(d.duration))
        update({ position: Math.max(0, d.position), duration: Math.max(0, d.duration) });
      if (d.type === 'error' || d.type === 'blocked') {
        // Rescue restricted SoundCloud tracks via native audio stream!
        if (track && consent && !cancelled) {
          frame.src = 'about:blank';
          const playFallback = () => {
            if (!el.hasAttribute('src')) return;
            setupGraph();
            void el.play().catch(() => fail(String(d.message || 'Faixa indisponível.')));
          };
          el.volume = 1;
          setupGraph().level(el, 0);
          driver = {
            play: playFallback,
            pause: () => all.forEach(deck => deck.pause()),
            seek: n => {
              if (Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(n, el.duration));
            },
            volume: n => {
              if (graph.current)
                void graph.current
                  .configure({ ...useApp.getState().data.preferences, volume: n })
                  .catch(() => {});
            },
          };
          void window.glass
            .audioSource('', crypto.randomUUID(), {
              title: track.title,
              artist: track.artist,
              duration: track.duration,
            })
            .then(src => {
              if (cancelled) return;
              update({ duration: src.duration || track.duration });
              el.src = src.url;
              playFallback();
            })
            .catch(() => fail(String(d.message || 'Faixa indisponível.').slice(0, 500)));
          return;
        }
        fail(String(d.message || 'Faixa indisponível.').slice(0, 500));
      }
    };

    el.addEventListener('playing', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    window.addEventListener('message', message);

    if (track && track.available !== false) {
      if (
        track.source === 'local' ||
        (['youtube', 'link'].includes(track.source) && playbackAllowed)
      ) {
        const play = () => {
          pausedDuringPreparation = false;
          if (!el.hasAttribute('src')) return;
          setupGraph();
          void el.play().catch(e => {
            if (e.name === 'NotAllowedError') {
              onPause();
              useApp.getState().message('Clique em reproduzir para iniciar o áudio.');
            } else if (e.name !== 'AbortError') fail('Falha ao reproduzir o áudio.');
          });
        };
        el.volume = 1;
        setupGraph().level(el, 0);
        driver = {
          play,
          pause: () => {
            pausedDuringPreparation = true;
            all.forEach(deck => deck.pause());
          },
          seek: n => {
            if (Number.isFinite(el.duration)) {
              fadingOut = false;
              el.currentTime = Math.max(0, Math.min(n, el.duration));
              graph.current?.level(el, 1, 0.06);
            }
          },
          volume: n => {
            if (graph.current)
              void graph.current
                .configure({ ...useApp.getState().data.preferences, volume: n })
                .catch(() => {});
          },
        };

        const wasPreStaged =
          el.dataset.stagedId === track.id && el.hasAttribute('src') && !el.error;
        delete el.dataset.stagedId;

        if (wasPreStaged) {
          if (staged.current?.id === track.id && staged.current.duration > 0) {
            update({ duration: staged.current.duration });
          }
          try {
            if (el.currentTime > 0.05) el.currentTime = 0;
          } catch {}
          play();
        } else if (track.source === 'local') {
          el.removeAttribute('src');
          el.src = nativeResource(`media/${encodeURIComponent(track.id)}`);
          play();
        } else {
          el.pause();
          el.removeAttribute('src');
          el.load();
          preparation = preparePlayback(track);
          void preparation.promise
            .then(({ track: matched, source }) => {
              if (cancelled) return;
              resolvedTrack = matched;
              if (track.source === 'link' && track.playbackId !== matched.playbackId) {
                update({
                  queue: useApp
                    .getState()
                    .queue.map(t => (t.id === matched.id ? matched : t)),
                });
                void useApp
                  .getState()
                  .mutate({ action: 'save', track: matched })
                  .catch(() => {});
              }
              update({ duration: source.duration || track.duration });
              el.src = source.url;
              if (!pausedDuringPreparation) play();
              else stopOutgoing();
            })
            .catch(error => {
              if (!cancelled) fail(cleanError(error));
            });
        }
      } else if (playbackAllowed && track.source === 'soundcloud') {
        stopOutgoing();
        void window.glass
          .playerUrl()
          .then(url => {
            if (cancelled) return;
            frameOrigin = new URL(url).origin;
            const send = (action: string, value?: number) => {
              if (frameOrigin && frameOrigin !== 'null')
                frame.contentWindow?.postMessage(
                  { channel: 'glass-control', action, value },
                  frameOrigin,
                );
            };
            driver = {
              play: () => send('play'),
              pause: () => send('pause'),
              seek: n => send('seek', n),
              volume: n => send('volume', n),
            };
            frame.src = `${url}?${new URLSearchParams({
              parent: location.origin,
              provider: track.source,
              ref: track.url!,
              volume: String(useApp.getState().data.preferences.volume),
            })}`;
          })
          .catch(e => fail(cleanError(e)));
      } else fail('Ative o acesso online nas configurações ou baixe esta faixa.');
    } else {
      stopOutgoing();
      if (track) fail(track.reason || 'Faixa indisponível.');
    }

    return () => {
      cancelled = true;
      preparation?.release();
      el.removeEventListener('playing', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      window.removeEventListener('message', message);
      frame.src = 'about:blank';
      driver = undefined;
      if (outgoing) stopOutgoing();
    };
  }, [track?.id, revision, playbackAllowed]);

  // Pre-warm AND pre-stage the next track on Standby Deck (including in Shuffle mode & Autoplay Radio!)
  useEffect(() => {
    const next = upcomingTrack();
    if (!next) {
      staged.current = undefined;
      if (
        track &&
        consent &&
        preferences.autoplay &&
        preferences.repeat === 'off' &&
        useApp.getState().queue.length > 0
      ) {
        const timer = setTimeout(() => {
          void useApp.getState().extendWithRecommendations();
        }, 600);
        return () => clearTimeout(timer);
      }
      return;
    }
    if (next.available === false || next.source === 'soundcloud') {
      staged.current = undefined;
      return;
    }
    if (next.source === 'local') {
      staged.current = {
        id: next.id,
        url: nativeResource(`media/${encodeURIComponent(next.id)}`),
        duration: next.duration,
      };
      const t = setTimeout(stageStandby, 120);
      return () => clearTimeout(t);
    }
    if ((!consent && !next.offline) || !['youtube', 'link'].includes(next.source)) return;
    let alive = true,
      release: (() => void) | undefined;
    const timeout = setTimeout(() => {
      const warm = preparePlayback(next, false);
      release = warm.release;
      void warm.promise
        .then(({ track: matched, source }) => {
          if (!alive) return;
          staged.current = {
            id: next.id,
            url: source.url,
            duration: source.duration || matched.duration,
          };
          stageStandby();
          if (next.source === 'link' && next.playbackId !== matched.playbackId) {
            useApp.setState(s => ({
              queue: s.queue.map(t => (t.id === matched.id ? matched : t)),
            }));
            void useApp
              .getState()
              .mutate({ action: 'save', track: matched })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timeout);
      release?.();
    };
  }, [
    track?.id,
    index,
    shuffleNext,
    queue.length,
    consent,
    preferences.repeat,
    preferences.shuffle,
  ]);

  useEffect(() => {
    if (graph.current)
      void graph.current
        .configure(preferences)
        .catch(e => useApp.getState().message(cleanError(e)));
    if (track?.source === 'soundcloud') transport.volume(preferences.volume);
  }, [preferences]);

  useEffect(
    () => () => {
      clearTimeout(retire.current);
      elements().forEach(el => el?.pause());
      void graph.current?.close();
      graph.current = undefined;
    },
    [],
  );

  useEffect(() => {
    const off = window.glass.onMedia(command => {
      if (command === 'playPause') transport.toggle();
      if (command === 'next') useApp.getState().next();
      if (command === 'previous') useApp.getState().previous();
    });
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) ||
        target.isContentEditable ||
        useApp.getState().dialog
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        transport.toggle();
      }
      if (e.altKey && e.code === 'ArrowRight') useApp.getState().next();
      if (e.altKey && e.code === 'ArrowLeft') useApp.getState().previous();
    };
    window.addEventListener('keydown', key);
    return () => {
      off();
      window.removeEventListener('keydown', key);
    };
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !track) return;
    const art = coverURL(track);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || 'Glass Music',
      artwork: art ? [{ src: art, sizes: '512x512' }] : undefined,
    });
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => driver?.play()],
      ['pause', () => driver?.pause()],
      ['nexttrack', () => useApp.getState().next()],
      ['previoustrack', () => useApp.getState().previous()],
      [
        'seekto',
        details => {
          if (typeof details.seekTime === 'number') driver?.seek(details.seekTime);
        },
      ],
    ];
    actions.forEach(([name, action]) => {
      try {
        navigator.mediaSession.setActionHandler(name, action);
      } catch {}
    });
    return () => {
      actions.forEach(([name]) => {
        try {
          navigator.mediaSession.setActionHandler(name, null);
        } catch {}
      });
    };
  }, [track?.id, track?.artwork]);

  const external = track?.source === 'soundcloud';
  return (
    <>
      <audio
        ref={first}
        data-active={activeDeck.current === 0 ? 'true' : 'false'}
        crossOrigin="anonymous"
        preload="auto"
      />
      <audio
        ref={second}
        data-active={activeDeck.current === 1 ? 'true' : 'false'}
        crossOrigin="anonymous"
        preload="auto"
      />
      <section
        className={`official-player ${external ? 'visible' : ''}`}
        aria-label="Áudio SoundCloud"
        aria-hidden={!external}
      >
        <iframe
          ref={iframe}
          title="Áudio SoundCloud"
          allow="autoplay; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </section>
    </>
  );
}
