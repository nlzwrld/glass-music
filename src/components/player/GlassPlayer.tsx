import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Heart,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  ListMusic,
  PictureInPicture2,
  Maximize2,
  X,
  ExternalLink,
  Plus,
  Music2,
  PanelRightOpen,
  MicVocal,
  LoaderCircle,
  Radio,
  Sparkles,
} from 'lucide-react';
import {
  useApp,
  formatTime,
  cleanError,
  setPreferencesFromUI,
  upcomingIndex,
} from '../../stores/app';
import { useJam } from '../jam/state';
import { openJamWindow } from '../../lib/jamWindow';
import { PlayerEngine, transport } from './engine';
import Cover from '../glass/Cover';
import { IconButton, OfflineIndicator, SourceBadge } from '../glass/controls';
import {
  GlassContextMenu,
  GlassMaterial,
  GlassPanel,
  GlassSlider,
  LiquidLens,
} from '../glass/materials';
import type { Track } from '../../../shared/types';

export function shouldRenderLyricsButton(state: {
  hasActive: boolean;
  lyricsAvailable: boolean;
}): boolean {
  return Boolean(state.hasActive && state.lyricsAvailable);
}

function useDisplayTrack() {
  return useApp(
    s =>
      s.queue[s.index] ||
      s.data.tracks.find(
        t =>
          t.kind === 'track' &&
          ['local', 'soundcloud', 'youtube', 'link'].includes(t.source) &&
          t.available !== false,
      ),
  );
}

export function PlaybackControls({
  large = false,
  localSurface = false,
}: {
  large?: boolean;
  localSurface?: boolean;
}) {
  const active = useApp(s => s.queue[s.index]),
    track = useDisplayTrack(),
    playing = useApp(s => s.playing),
    playbackIntent = useApp(s => s.playbackIntent),
    status = useApp(s => s.status),
    p = useApp(s => s.data.preferences);
  const isGlass = (p.uiStyle ?? 'matte') === 'glass';
  const wantsPlayback = playing || playbackIntent;
  const preparing =
    !playing &&
    playbackIntent &&
    (status === 'Carregando' || status === 'Sincronizando fonte de áudio...');

  const shuffleMode = p.shuffleMode ?? 'smart';
  const shuffleLabel = !p.shuffle
    ? 'Aleatório'
    : shuffleMode === 'smart'
      ? 'Aleatório Inteligente'
      : 'Aleatório tradicional';

  return (
    <div className={`transport ${large ? 'large' : ''}`}>
      <IconButton
        label={shuffleLabel}
        active={p.shuffle}
        aria-pressed={p.shuffle}
        data-shuffle-mode={p.shuffle ? shuffleMode : 'off'}
        className="shuffle-transport-btn"
        onClick={() => {
          if (!p.shuffle) {
            setPreferencesFromUI({ shuffle: true, shuffleMode: 'smart' });
          } else if (shuffleMode === 'smart') {
            setPreferencesFromUI({ shuffle: true, shuffleMode: 'standard' });
          } else {
            setPreferencesFromUI({ shuffle: false });
          }
        }}
      >
        <Shuffle size={15} />
        {p.shuffle && shuffleMode === 'smart' && (
          <Sparkles size={9} className="shuffle-smart-badge" aria-hidden="true" />
        )}
      </IconButton>
      <IconButton
        label="Faixa anterior"
        disabled={!active}
        onClick={() => useApp.getState().previous()}
      >
        <SkipBack size={17} fill="currentColor" />
      </IconButton>
      <button
        className="play-main"
        data-optic={!isGlass || localSurface ? 'css' : 'auto'}
        data-crystal="thin"
        data-material="clear"
        title={wantsPlayback ? 'Pausar' : 'Reproduzir'}
        aria-label={wantsPlayback ? 'Pausar' : 'Reproduzir'}
        disabled={!track}
        onClick={() => {
          if (active) transport.toggle();
          else if (track)
            useApp
              .getState()
              .play(track, useApp.getState().data.tracks.filter(t => t.kind === 'track'));
        }}
      >
        {isGlass && <LiquidLens />}
        {preparing ? (
          <LoaderCircle className="spinner" size={16} />
        ) : wantsPlayback ? (
          <Pause size={16} fill="currentColor" />
        ) : (
          <Play size={16} fill="currentColor" />
        )}
      </button>
      <IconButton
        label="Próxima faixa"
        disabled={!active}
        onClick={() => useApp.getState().next()}
      >
        <SkipForward size={17} fill="currentColor" />
      </IconButton>
      <IconButton
        label={`Repetir: ${p.repeat === 'off' ? 'desligado' : p.repeat === 'all' ? 'fila' : 'uma faixa'}`}
        active={p.repeat !== 'off'}
        onClick={() =>
          setPreferencesFromUI({
            repeat: p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off',
          })
        }
      >
        {p.repeat === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
      </IconButton>
    </div>
  );
}

export function Seekbar({ compact = false }: { compact?: boolean }) {
  const position = useApp(s => s.position),
    measuredDuration = useApp(s => s.duration),
    track = useApp(s => s.queue[s.index]),
    preview = useDisplayTrack();
  const duration = track ? measuredDuration : preview?.duration || 0;
  const knownDuration = Number.isFinite(duration) && duration > 0;
  const elapsed = track ? position : 0;
  return (
    <div className={`seek ${compact ? 'compact-seek' : ''}`}>
      <time>
        {formatTime(elapsed)}
        {compact && (
          <>
            <span> / </span>
            {knownDuration ? formatTime(duration) : '—:—'}
          </>
        )}
      </time>
      <GlassSlider
        aria-label="Posição da música"
        min={0}
        max={knownDuration ? duration : 1}
        step={0.25}
        value={Math.min(elapsed, knownDuration ? duration : 1)}
        disabled={!track || !knownDuration}
        onChange={e => {
          const n = Number(e.target.value);
          transport.seek(n);
          useApp.setState({ position: n });
        }}
        style={{ '--progress': `${knownDuration ? (elapsed / duration) * 100 : 0}%` } as React.CSSProperties}
      />
      {!compact && <time>{knownDuration ? formatTime(duration) : '—:—'}</time>}
    </div>
  );
}

function VolumeControl() {
  const volume = useApp(s => s.data.preferences.volume);
  return (
    <div className="volume-control">
      <IconButton
        label={volume ? 'Silenciar' : 'Ativar som'}
        onClick={() => setPreferencesFromUI({ volume: volume ? 0 : 65 })}
      >
        {volume ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </IconButton>
      <GlassSlider
        aria-label="Volume"
        min={0}
        max={100}
        value={volume}
        style={{ '--progress': `${volume}%` } as React.CSSProperties}
        onChange={e => setPreferencesFromUI({ volume: Number(e.target.value) })}
      />
    </div>
  );
}

function TrackMenu({ track, label }: { track?: Track; label: string }) {
  return (
    <GlassContextMenu
      label={label}
      disabled={!track}
      items={
        track
          ? [
              {
                label: 'Adicionar à playlist',
                icon: <Plus size={15} />,
                action: () => useApp.getState().setDialog({ type: 'add', track }),
              },
              {
                label: 'Adicionar à fila',
                icon: <ListMusic size={15} />,
                action: () => useApp.getState().enqueue(track),
              },
              {
                label: 'Salvar na biblioteca',
                icon: <Music2 size={15} />,
                action: () => {
                  void useApp
                    .getState()
                    .mutate({ action: 'save', track })
                    .then(() => useApp.getState().message('Salva na biblioteca.'))
                    .catch(() => {});
                },
              },
              ...(track.source !== 'local' && track.kind === 'track'
                ? [
                    {
                      label: 'Trocar fonte de áudio',
                      icon: <Radio size={15} />,
                      action: () =>
                        useApp.getState().setDialog({ type: 'streamSource', track }),
                    },
                  ]
                : []),
              ...(track.url
                ? [
                    {
                      label: 'Abrir na plataforma',
                      icon: <ExternalLink size={15} />,
                      action: () => {
                        void window.glass
                          .external(track.url!)
                          .catch(e => useApp.getState().message(cleanError(e)));
                      },
                    },
                  ]
                : []),
            ]
          : []
      }
    />
  );
}

function Favorite({ label, track }: { label: string; track?: Track }) {
  const likes = useApp(s => s.data.likes);
  const liked = !!track && likes.includes(track.id);
  return (
    <IconButton
      label={label}
      active={liked}
      aria-pressed={liked}
      disabled={!track}
      onClick={() =>
        track &&
        void useApp
          .getState()
          .mutate({ action: 'like', track })
          .catch(() => {})
      }
    >
      <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
    </IconButton>
  );
}

function AuxiliaryControls() {
  const queueOpen = useApp(s => s.queueOpen),
    queueCount = useApp(s => Math.max(0, s.queue.length - (s.index >= 0 ? 1 : 0))),
    lyricsOpen = useApp(s => s.lyricsOpen),
    lyricsAvailable = useApp(s => s.lyricsAvailable),
    hasActive = useApp(s => !!s.queue[s.index]),
    mini = useApp(s => s.mini),
    jamSession = useJam(s => s.session),
    jamConnected = useJam(s => s.connected),
    jamListeners = useJam(s => s.room?.members.length ?? (s.session ? 1 : 0)),
    jamPendingReqCount = useJam(s => (s.session?.host ? s.room?.pendingRequestCount ?? 0 : 0));

  const showLyrics = shouldRenderLyricsButton({ hasActive, lyricsAvailable });

  return (
    <>
      {jamSession && (
        <button
          type="button"
          className={`jam-player-badge ${jamConnected ? 'connected' : 'reconnecting'}`}
          aria-label={`JAM ativa com ${jamListeners} ouvinte(s)${jamPendingReqCount > 0 ? ` e ${jamPendingReqCount} pedido(s) pendente(s)` : ''}`}
          title={`JAM ao vivo · ${jamListeners} ouvinte(s)${jamPendingReqCount > 0 ? ` · ${jamPendingReqCount} pedido(s) pendente(s)` : ''}`}
          onClick={() => {
            if (mini) {
              void window.glass.window('restore').then(() => useApp.setState({ mini: false }));
            }
            void openJamWindow();
          }}
        >
          <span className="jam-pulse-dot" aria-hidden="true" />
          <Radio size={14} />
          <span>{jamListeners}</span>
          {jamPendingReqCount > 0 && (
            <span className="detached-jam-tab-badge" aria-hidden="true">
              +{jamPendingReqCount}
            </span>
          )}
        </button>
      )}
      <AnimatePresence initial={false}>
        {showLyrics && (
          <motion.span
            key="conditional-lyrics-btn"
            className="lyrics-btn-presence"
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.82 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <IconButton
              label="Letras"
              active={lyricsOpen}
              onClick={() => {
                if (mini)
                  void window.glass
                    .openLyrics()
                    .catch(e => useApp.getState().message(cleanError(e)));
                else useApp.setState({ lyricsOpen: !useApp.getState().lyricsOpen });
              }}
            >
              <MicVocal size={16} />
            </IconButton>
          </motion.span>
        )}
      </AnimatePresence>
      <span className="queue-btn-wrap">
        <IconButton
          label="Fila de reprodução"
          active={queueOpen}
          aria-expanded={queueOpen}
          onClick={() => useApp.setState({ queueOpen: !queueOpen })}
        >
          <ListMusic size={16} />
        </IconButton>
        {queueCount > 0 && <span className="queue-count-dot" aria-hidden="true">{queueCount > 99 ? '99+' : queueCount}</span>}
      </span>
      <IconButton
        label={mini ? 'Sair do mini-player' : 'Mini-player'}
        active={mini}
        onClick={() => {
          void window.glass
            .window(mini ? 'restore' : 'mini')
            .then(() =>
              useApp.setState({
                mini: !mini,
                expanded: false,
                queueOpen: false,
                lyricsOpen: false,
              }),
            )
            .catch(e => useApp.getState().message(cleanError(e)));
        }}
      >
        <PictureInPicture2 size={16} />
      </IconButton>
    </>
  );
}

export function SidePlayer() {
  const track = useDisplayTrack(),
    active = useApp(s => s.queue[s.index]),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    shufflePlayed = useApp(s => s.shufflePlayed),
    shuffleNext = useApp(s => s.shuffleNext),
    preferences = useApp(s => s.data.preferences),
    downloadingIds = useApp(s => s.downloadingIds);
  const isDownloading = !!track && downloadingIds.includes(track.id);
  const nextIdx = useMemo(
    () =>
      upcomingIndex(
        {
          queue,
          index,
          shufflePlayed,
          shuffleNext,
          data: { tracks: [], likes: [], history: [], preferences },
        },
        false,
      ),
    [queue, index, shufflePlayed, shuffleNext, preferences],
  );
  const nextTrack = nextIdx >= 0 ? queue[nextIdx] : undefined;

  return (
    <GlassPanel
      className={`side-player ${active && active.source !== 'local' ? 'external-track' : ''}`}
      aria-label="Tocando agora"
    >
      <div className="side-player-header">
        <span className="side-panel-label">Tocando agora</span>
        <div>
          <IconButton
            label="Expandir música"
            disabled={!active}
            onClick={() => useApp.setState({ expanded: true })}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            label="Fechar painel lateral"
            className="side-close"
            onClick={() => useApp.setState({ sideOpen: false })}
          >
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div className="side-art">
        <div className="side-cover">
          <Cover track={track} />
        </div>
      </div>
      <div className="side-info">
        <div>
          <h2>{track?.title || 'Nada tocando'}</h2>
          <p>{track ? `${track.artist}${track.album ? ` · ${track.album}` : ''}` : ''}</p>
        </div>
        <Favorite label="Curtir no player lateral" track={track} />
        <TrackMenu label="Opções no player lateral" track={track} />
      </div>
      {track && (
        <div className="side-badges">
          <OfflineIndicator offline={track.offline} downloading={isDownloading} />
          <SourceBadge
            source={track.source}
            url={track.url}
            catalogSource={track.catalogSource}
            streamProvider={track.streamProvider}
          />
        </div>
      )}
      {nextTrack && (
        <div className="side-next-up">
          <span className="side-panel-label">A seguir</span>
          <button
            type="button"
            className="side-next-card"
            onClick={() => useApp.getState().jumpQueue(nextIdx)}
            aria-label={`Reproduzir a seguir: ${nextTrack.title}`}
          >
            <span className="side-next-cover">
              <Cover track={nextTrack} />
            </span>
            <span className="side-next-meta">
              <strong>{nextTrack.title}</strong>
              <small>{nextTrack.artist}</small>
            </span>
          </button>
        </div>
      )}
    </GlassPanel>
  );
}

export default function GlassPlayer() {
  const track = useDisplayTrack(),
    active = useApp(s => s.queue[s.index]),
    downloadingIds = useApp(s => s.downloadingIds),
    sideOpen = useApp(s => s.sideOpen),
    error = useApp(s => s.error);
  const isDownloading = !!track && downloadingIds.includes(track.id);

  return (
    <GlassMaterial
      as="footer"
      variant="thick"
      material="floating"
      className="player"
      aria-label="Controles de reprodução"
    >
      <PlayerEngine />
      <div className="now-playing">
        <button
          className="now-cover"
          aria-label="Abrir player expandido"
          disabled={!active}
          onClick={() => useApp.setState({ expanded: true })}
        >
          <Cover track={track} />
          <span>
            <Maximize2 size={14} />
          </span>
        </button>
        <div className="now-info">
          <strong>{track?.title || 'Nenhuma faixa'}</strong>
          <small className="now-subline">
            {track && <OfflineIndicator offline={track.offline} downloading={isDownloading} />}
            <span>{track?.artist || '—'}</span>
            {track && track.streamProvider && track.source === 'link' && (
              <SourceBadge
                source={track.source}
                url={track.url}
                catalogSource={track.catalogSource}
                streamProvider={track.streamProvider}
                compact
              />
            )}
          </small>
        </div>
        <Favorite label="Curtir música atual" track={track} />
        <TrackMenu label="Opções da música atual" track={track} />
      </div>
      <div className="player-center">
        <PlaybackControls />
        <div className="player-progress">
          <Seekbar />
        </div>
      </div>
      <div className="player-tools">
        <div className="compact-tools">
          <AuxiliaryControls />
          <IconButton
            label="Mostrar player lateral"
            active={sideOpen}
            onClick={() => useApp.setState({ sideOpen: !useApp.getState().sideOpen })}
          >
            <PanelRightOpen size={16} />
          </IconButton>
        </div>
        <VolumeControl />
      </div>
      {error && (
        <div className="playback-error" role="alert">
          <span>{error}</span>
          {active && (
            <button
              className="button secondary"
              onClick={() => useApp.getState().play(active, useApp.getState().queue)}
            >
              Tentar novamente
            </button>
          )}
          <IconButton
            label="Fechar aviso de reprodução"
            onClick={() => useApp.setState({ error: '' })}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
    </GlassMaterial>
  );
}
