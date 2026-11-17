import { Heart, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, ListMusic, PictureInPicture2, Maximize2, X, ExternalLink, Plus, Music2, PanelRightOpen, MicVocal, LoaderCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useApp, formatTime, cleanError } from '../../stores/app';
import { PlayerEngine, transport } from './engine';
import Cover from '../glass/Cover';
import { IconButton, SourceBadge } from '../glass/controls';
import { GlassContextMenu, GlassMaterial, GlassPanel, GlassSlider, LiquidLens } from '../glass/materials';
import type { Track } from '../../../shared/types';

function useDisplayTrack() { return useApp(s => s.queue[s.index] || s.data.tracks.find(t => t.kind === 'track' && ['local','soundcloud','youtube'].includes(t.source) && t.available !== false)); }
export function PlaybackControls({ large = false, localSurface=false }: { large?: boolean; localSurface?:boolean }) {
  const active = useApp(s => s.queue[s.index]), track = useDisplayTrack(), playing = useApp(s => s.playing), status=useApp(s=>s.status), p = useApp(s => s.data.preferences);
  return <div className={`transport ${large ? 'large' : ''}`}>
    <IconButton label="Aleatório" active={p.shuffle} aria-pressed={p.shuffle} onClick={() => void useApp.getState().setPreferences({ shuffle: !p.shuffle })}><Shuffle size={23} strokeWidth={1.6} /></IconButton>
    <IconButton label="Faixa anterior" disabled={!active} onClick={() => useApp.getState().previous()}><SkipBack size={27} fill="currentColor" /></IconButton>
    <button className="play-main" data-optic={localSurface?'css':'auto'} data-crystal="thin" data-material="clear" title={playing ? 'Pausar' : 'Reproduzir'} aria-label={playing ? 'Pausar' : 'Reproduzir'} disabled={!track} onClick={() => { if (active) transport.toggle(); else if (track) useApp.getState().play(track, useApp.getState().data.tracks.filter(t => t.kind === 'track')); }}><LiquidLens />{status==='Carregando'&&!playing ? <LoaderCircle className="spinner" size={24}/> : playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}</button>
    <IconButton label="Próxima faixa" disabled={!active} onClick={() => useApp.getState().next()}><SkipForward size={27} fill="currentColor" /></IconButton>
    <IconButton label={`Repetir: ${p.repeat === 'off' ? 'desligado' : p.repeat === 'all' ? 'fila' : 'uma faixa'}`} active={p.repeat !== 'off'} onClick={() => void useApp.getState().setPreferences({ repeat: p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off' })}>{p.repeat === 'one' ? <Repeat1 size={23} /> : <Repeat size={23} strokeWidth={1.6} />}</IconButton>
  </div>;
}
export function Seekbar({ compact = false }: { compact?: boolean }) {
  const position = useApp(s => s.position), measuredDuration = useApp(s => s.duration), track = useApp(s => s.queue[s.index]), preview = useDisplayTrack();
  const duration = track ? measuredDuration : preview?.duration || 0;
  const knownDuration = Number.isFinite(duration) && duration > 0;
  const elapsed = track ? position : 0;
  return <div className={`seek ${compact ? 'compact-seek' : ''}`}><time>{formatTime(elapsed)}{compact && <><span> / </span>{knownDuration ? formatTime(duration) : '—:—'}</>}</time><GlassSlider aria-label="Posição da música" min={0} max={knownDuration ? duration : 1} step={0.25} value={Math.min(elapsed,knownDuration ? duration : 1)} disabled={!track || !knownDuration} onChange={e => { const n = Number(e.target.value); transport.seek(n); useApp.setState({ position: n }); }} style={{ '--progress': `${knownDuration ? elapsed / duration * 100 : 0}%` } as React.CSSProperties} />{!compact && <time>{knownDuration ? formatTime(duration) : '—:—'}</time>}</div>;
}
function VolumeControl() {
  const volume = useApp(s => s.data.preferences.volume);
  return <div className="volume-control"><IconButton label={volume ? 'Silenciar' : 'Ativar som'} onClick={() => void useApp.getState().setPreferences({ volume: volume ? 0 : 65 })}>{volume ? <Volume2 size={24} strokeWidth={1.6} /> : <VolumeX size={24} strokeWidth={1.6} />}</IconButton><GlassSlider aria-label="Volume" min={0} max={100} value={volume} style={{ '--progress': `${volume}%` } as React.CSSProperties} onChange={e => void useApp.getState().setPreferences({ volume: Number(e.target.value) })} /></div>;
}
function TrackMenu({ track, label }: { track?: Track; label: string }) {
  return <GlassContextMenu label={label} disabled={!track} items={track ? [
    { label: 'Adicionar à playlist', icon: <Plus size={17} />, action: () => useApp.getState().setDialog({ type: 'add', track }) },
    { label: 'Adicionar à fila', icon: <ListMusic size={17} />, action: () => useApp.getState().enqueue(track) },
    { label: 'Salvar na biblioteca', icon: <Music2 size={17} />, action: () => { void useApp.getState().mutate({ action: 'save', track }).then(() => useApp.getState().message('Salva na biblioteca.')).catch(() => {}); } },
    ...(track.url ? [{ label: 'Abrir na plataforma', icon: <ExternalLink size={17} />, action: () => { void window.glass.external(track.url!).catch(e => useApp.getState().message(cleanError(e))); } }] : [])
  ] : []} />;
}
function Favorite({ label, track }: { label: string; track?: Track }) {
  const likes = useApp(s => s.data.likes);
  return <IconButton label={label} active={track && likes.includes(track.id)} aria-pressed={!!track && likes.includes(track.id)} disabled={!track} onClick={() => track && void useApp.getState().mutate({ action: 'like', track }).catch(() => {})}><Heart size={25} strokeWidth={1.6} fill={track && likes.includes(track.id) ? 'currentColor' : 'none'} /></IconButton>;
}
function AuxiliaryControls() {
  const queueOpen = useApp(s => s.queueOpen), mini = useApp(s => s.mini);
  return <><IconButton label="Letras" active={useApp(s=>s.lyricsOpen)} disabled={!useApp(s=>s.queue[s.index])} onClick={()=>{if(mini)void window.glass.openLyrics().catch(e=>useApp.getState().message(cleanError(e)));else useApp.setState({lyricsOpen:!useApp.getState().lyricsOpen});}}><MicVocal size={21}/></IconButton><IconButton label={mini ? 'Sair do mini-player' : 'Mini-player'} active={mini} onClick={() => { void window.glass.window(mini ? 'restore' : 'mini').then(() => useApp.setState({ mini: !mini, expanded: false, queueOpen: false, lyricsOpen:false })).catch(e => useApp.getState().message(cleanError(e))); }}><PictureInPicture2 size={22} strokeWidth={1.6} /></IconButton><IconButton label="Fila de reprodução" active={queueOpen} onClick={() => useApp.setState({ queueOpen: !queueOpen })}><ListMusic size={23} strokeWidth={1.6} /></IconButton></>;
}
export function SidePlayer() {
  const track = useDisplayTrack(), active = useApp(s => s.queue[s.index]), ready = useApp(s => s.ready);
  return <GlassPanel className={`side-player ${active && active.source !== 'local' ? 'external-track' : ''}`} aria-label="Player lateral">
    <div className="side-player-header"><IconButton label="Fechar painel lateral" className="side-close" onClick={() => useApp.setState({ sideOpen: false })}><X size={20} /></IconButton><IconButton label="Expandir música" disabled={!active} onClick={() => useApp.setState({ expanded: true })}><Maximize2 size={23} /></IconButton></div>
    <div className="side-art"><AnimatePresence mode="wait"><motion.div className="side-cover" key={track?.id || 'empty'} initial={{ opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .98 }} transition={{ duration: .25 }}><Cover track={track} /></motion.div></AnimatePresence></div>
    <div className="side-info"><div><h2>{track?.title || 'Nada tocando'}</h2><p>{track ? `${track.artist}${track.album ? ` · ${track.album}` : ''}` : ''}</p></div><Favorite label="Curtir no player lateral" track={track} /><TrackMenu label="Opções no player lateral" track={track} /></div>
    <div className="side-badges">{track && <SourceBadge source={track.source} url={track.url} />}</div><Seekbar /><PlaybackControls large localSurface />
    <div className="side-tools"><AuxiliaryControls /><VolumeControl /></div>
  </GlassPanel>;
}
export default function GlassPlayer() {
  const track = useDisplayTrack(), active = useApp(s => s.queue[s.index]), error = useApp(s => s.error);
  return <GlassMaterial as="footer" variant="thick" material="floating" className="player" aria-label="Controles de reprodução">
    <PlayerEngine /><div className="now-playing"><button className="now-cover" aria-label="Abrir player expandido" disabled={!active} onClick={() => useApp.setState({ expanded: true })}><Cover track={track} /><span><Maximize2 size={18} /></span></button><div className="now-info"><strong>{track?.title || 'Glass Music'}</strong><small>{track?.artist || ''}</small></div><Favorite label="Curtir música atual" track={track} /><TrackMenu label="Opções da música atual" track={track} /></div>
    <div className="player-center"><PlaybackControls /><div className="player-progress"><Seekbar /></div></div>
    <div className="player-tools"><div className="compact-tools"><AuxiliaryControls /><IconButton label="Mostrar player lateral" onClick={() => useApp.setState({ sideOpen: !useApp.getState().sideOpen })}><PanelRightOpen size={22} /></IconButton></div><VolumeControl /></div>
    {error && <div className="playback-error" role="alert">{error}{active && <button onClick={() => useApp.getState().play(active,useApp.getState().queue)}>Tentar novamente</button>}<button aria-label="Fechar aviso de reprodução" onClick={() => useApp.setState({ error: '' })}><X size={14} /></button></div>}
  </GlassMaterial>;
}
