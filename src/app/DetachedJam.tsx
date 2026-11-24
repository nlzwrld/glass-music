import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  Ban,
  BookmarkPlus,
  Check,
  Copy,
  Edit3,
  Link2,
  ListMusic,
  ListPlus,
  LoaderCircle,
  Lock,
  LogOut,
  MessageCircle,
  MessageSquare,
  Music2,
  Pin,
  PinOff,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Share2,
  ShieldCheck,
  SkipForward,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { DEFAULT_JAM_PERMISSIONS, canJam, type JamRoomPermissions } from '../../shared/jam';
import type { Track } from '../../shared/types';
import { IconButton, Toggle } from '../components/glass/controls';
import { OpticalEngine } from '../components/glass/v3/OpticalEngine';
import { HostAvatar } from '../components/jam/JamInviteModal';
import '../components/jam/jam.css';
import {
  buildDiscordShareText,
  buildJamInviteUrl,
  buildWhatsAppShareUrl,
  shareNativeInvite,
} from '../lib/jam';
import {
  closeJamWindow,
  dispatchJamControl,
  pinJamWindow,
  type JamWindowSnapshot,
} from '../lib/jamWindow';
import { useApp } from '../stores/app';

type JamTab = 'feed' | 'people' | 'invite' | 'permissions';

export default function DetachedJam() {
  const [snap, setSnap] = useState<JamWindowSnapshot | null>(null);
  const [pinned, setPinned] = useState(false);
  const [tab, setTab] = useState<JamTab>('feed');
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');

  // Lobby create/join inputs
  const [newRoomName, setNewRoomName] = useState('');
  const [requireApprovalCreate, setRequireApprovalCreate] = useState(true);
  const [inviteInput, setInviteInput] = useState('');

  // Inline room rename
  const [editingName, setEditingName] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState('');

  // Queue / recommendations / chat
  const [queueQuery, setQueueQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [chatText, setChatText] = useState('');
  const [copied, setCopied] = useState<'link' | 'code' | 'discord' | ''>('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const syncDocTheme = (prefs: JamWindowSnapshot['preferences']) => {
      const isSystemLight =
        typeof window !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
      const resolved =
        prefs.theme === 'system' ? (isSystemLight ? 'light' : 'dark') : prefs.theme;
      const rawStyle = prefs.uiStyle ?? 'matte';
      document.documentElement.dataset.uiStyle = rawStyle === 'glass' ? 'glass' : 'matte';
      document.documentElement.dataset.beatPulse = String(
        Boolean((prefs.beatPulse ?? rawStyle === 'beat') && !prefs.performance),
      );
      document.documentElement.dataset.theme = resolved === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.motion = prefs.reducedMotion ? 'reduced' : 'full';
      document.documentElement.dataset.performance = String(Boolean(prefs.performance));
      document.documentElement.style.setProperty('--user-accent', prefs.accent || '#52b79a');
    };

    void window.glass.bootstrap().then(data => {
      syncDocTheme(data.preferences);
      useApp.setState({ data, ready: true });
    });

    let disposed = false;
    let off: (() => void) | undefined;

    void listen<JamWindowSnapshot>('jam-state', e => {
      const payload = e.payload;
      setSnap(payload);
      syncDocTheme(payload.preferences);
    }).then(fn => {
      if (disposed) fn();
      else off = fn;
    });

    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const room = snap?.room || snap?.session || null;
  const session = snap?.session || null;
  const messagesCount = room?.messages?.length || 0;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messagesCount]);

  useEffect(() => {
    if (!session?.host && tab === 'permissions') {
      setTab('feed');
    }
  }, [session?.host, tab]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(prev => (prev === msg ? '' : prev)), 2400);
  };

  const sendControl = async (payload: Record<string, unknown> & { action: string }) => {
    setLocalError('');
    try {
      await dispatchJamControl(payload);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Não foi possível executar esta ação.');
    }
  };

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void pinJamWindow(next);
  };

  const copyValue = (value: string, kind: 'link' | 'code' | 'discord', feedback: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(kind);
        showNotice(feedback);
        setTimeout(() => setCopied(prev => (prev === kind ? '' : prev)), 1800);
      })
      .catch(() => setLocalError('Não foi possível copiar para a área de transferência.'));
  };

  const handleSearchQueue = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = queueQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await window.glass.search({
        query: q,
        kind: 'track',
        source: 'all',
        requestId: `jam-win-q-${Date.now()}`,
      });
      setSearchResults((res.items || []).filter(t => canJam(t)).slice(0, 6));
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const renderContent = () => {
    if (!snap) {
      return (
        <div className="jam-waiting-box" role="status">
          <LoaderCircle size={22} className="spinner" />
          <h2>Sincronizando JAM…</h2>
          <p>Conectando com a janela principal do Liquid Hub.</p>
        </div>
      );
    }

    if (!snap.auth.authenticated || snap.auth.needsTermsAcceptance) {
      return (
        <div className="jam-waiting-box" role="region" aria-label="Autenticação necessária">
          <Lock size={24} />
          <h2>Conta Liquid Hub necessária</h2>
          <p>
            Apenas usuários autenticados podem criar ou participar de uma JAM. Visitantes não têm
            acesso às salas compartilhadas.
          </p>
          <button
            type="button"
            className="button primary"
            onClick={() => void closeJamWindow()}
          >
            Voltar ao aplicativo
          </button>
        </div>
      );
    }

    const pendingReq = snap.pendingJoinRequest;
    if (pendingReq && !session) {
      const isPending = pendingReq.status === 'pending';
      return (
        <div className="jam-waiting-box" role="status">
          <HostAvatar name={pendingReq.hostName} avatar={pendingReq.hostAvatar} size={52} />
          {isPending ? (
            <>
              <LoaderCircle size={20} className="spinner" />
              <h2>Aguardando aprovação</h2>
              <p>
                Sua solicitação para <strong>{pendingReq.roomName}</strong> (anfitrião{' '}
                <strong>{pendingReq.hostName}</strong>) foi enviada. Você entrará automaticamente
                assim que for aprovado.
              </p>
              <button
                type="button"
                className="button secondary"
                onClick={() => void sendControl({ action: 'cancelJoinRequest' })}
              >
                Cancelar solicitação
              </button>
            </>
          ) : (
            <>
              <AlertCircle size={22} />
              <h2>
                {pendingReq.status === 'blocked'
                  ? 'Entrada bloqueada'
                  : pendingReq.status === 'rejected'
                    ? 'Solicitação recusada'
                    : 'Solicitação encerrada'}
              </h2>
              <p>{pendingReq.reason || 'Não foi possível entrar nesta JAM.'}</p>
              <button
                type="button"
                className="button primary"
                onClick={() => void sendControl({ action: 'cancelJoinRequest' })}
              >
                Voltar
              </button>
            </>
          )}
        </div>
      );
    }

    if (!session || !room) {
      const lookupPreview = snap.lookupState.result?.preview ?? null;
      return (
        <>
          <div className="jam-card">
            <div className="jam-card-head">
              <Radio size={15} />
              <strong>Criar nova JAM</strong>
            </div>
            <label className="field-label">
              Nome da sala
              <input
                className="input"
                aria-label="Nome da nova JAM"
                maxLength={60}
                placeholder={`JAM de ${snap.auth.displayName}`}
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
              />
            </label>
            <Toggle
              label="Exigir aprovação para entrar"
              description="Recomendado: bloqueia entrada automática pelo link de convite."
              checked={requireApprovalCreate}
              onChange={setRequireApprovalCreate}
            />
            <div className="jam-interactive-bar">
              <button
                type="button"
                className="button primary"
                disabled={snap.busy || !snap.configured || !snap.onlineConsent}
                onClick={() =>
                  void sendControl({
                    action: 'create',
                    local: false,
                    roomName: newRoomName.trim() || `JAM de ${snap.auth.displayName}`,
                    requireApproval: requireApprovalCreate,
                  })
                }
              >
                {snap.busy ? <LoaderCircle size={14} className="spinner" /> : <Radio size={14} />}
                Criar JAM online
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={snap.busy || !snap.onlineConsent}
                onClick={() =>
                  void sendControl({
                    action: 'create',
                    local: true,
                    roomName: newRoomName.trim() || `JAM de ${snap.auth.displayName}`,
                    requireApproval: requireApprovalCreate,
                  })
                }
              >
                <Wifi size={14} />
                Criar na rede local
              </button>
            </div>
          </div>

          <div className="jam-card">
            <div className="jam-card-head">
              <Link2 size={15} />
              <strong>Entrar com convite ou código</strong>
            </div>
            <form
              className="jam-inline-form"
              onSubmit={e => {
                e.preventDefault();
                void sendControl({ action: 'lookup', value: inviteInput });
              }}
            >
              <input
                className="input"
                aria-label="Código ou link da JAM"
                placeholder="Cole o link liquidhub:// ou código"
                value={inviteInput}
                onChange={e => {
                  const val = e.target.value;
                  setInviteInput(val);
                  if (!val.trim()) {
                    void sendControl({ action: 'lookup', value: '' });
                  }
                }}
              />
              <button type="submit" className="button secondary" disabled={!inviteInput.trim()}>
                Verificar
              </button>
            </form>

            {snap.lookupState.loading && (
              <div className="jam-lookup-loading" role="status">
                <LoaderCircle size={15} className="spinner" />
                <span>Buscando sala…</span>
              </div>
            )}

            {lookupPreview && (
              <div className="jam-preview-card">
                <div className="jam-preview-head">
                  <HostAvatar name={lookupPreview.hostName} avatar={lookupPreview.hostAvatar} size={42} />
                  <div className="jam-preview-meta">
                    <strong>{lookupPreview.roomName}</strong>
                    <small>
                      Anfitrião: {lookupPreview.hostName} · {lookupPreview.participantCount}/
                      {lookupPreview.maxParticipants} ouvintes
                    </small>
                  </div>
                </div>
                {lookupPreview.canJoin ? (
                  <button
                    type="button"
                    className="button primary"
                    disabled={snap.busy || !snap.onlineConsent}
                    onClick={() =>
                      void sendControl({
                        action: 'requestJoin',
                        code: lookupPreview.code,
                        endpoint: lookupPreview.endpoint,
                        preview: lookupPreview,
                        direct: lookupPreview.requireApproval === false,
                      })
                    }
                  >
                    {lookupPreview.requireApproval === false
                      ? 'Entrar na JAM'
                      : 'Solicitar entrada'}
                  </button>
                ) : (
                  <p className="jam-error">{lookupPreview.reason || 'Sala indisponível no momento.'}</p>
                )}
              </div>
            )}

            {!lookupPreview && snap.lookupState.result && !snap.lookupState.result.found && (
              <p className="jam-error">
                {snap.lookupState.result.error || 'Nenhuma JAM encontrada com esse convite.'}
              </p>
            )}
          </div>

          <div className="jam-card">
            <div className="jam-card-head" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <Wifi size={15} />
                <strong>JAMs na rede local</strong>
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => void sendControl({ action: 'scanLan' })}
              >
                Procurar
              </button>
            </div>
            {snap.lanRooms.length === 0 ? (
              <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                Nenhuma JAM encontrada na rede local agora.
              </p>
            ) : (
              <div className="jam-pick-list">
                {snap.lanRooms.map(r => (
                  <div key={`${r.endpoint}:${r.code}`} className="jam-queue-row">
                    <div className="jam-queue-meta">
                      <strong>{r.roomName || `JAM ${r.code}`}</strong>
                      <small>
                        {r.hostName} · {r.members}/{r.maxParticipants || 8} ouvintes
                      </small>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        void sendControl({
                          action: 'requestJoin',
                          code: r.code,
                          endpoint: r.endpoint,
                        })
                      }
                    >
                      Solicitar entrada
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      );
    }

    // Active JAM state
    const hostMember = room.members.find(m => m.host);
    const hostName = hostMember?.name || 'Anfitrião';
    const hostAvatar = room.hostAvatar || hostMember?.avatar;
    const perms: JamRoomPermissions = { ...DEFAULT_JAM_PERMISSIONS, ...(room.permissions || {}) };
    const isHost = Boolean(session.host);
    const pendingRequests = room.joinRequests || [];
    const pendingCount = isHost ? pendingRequests.length : room.pendingRequestCount || 0;
    const blockedList = room.blockedList || [];
    const inviteUrl =
      session.inviteUrl || buildJamInviteUrl(session.code, session.endpoint || snap.endpoint);
    const track = room.playback?.track || null;
    const skipVotes = room.skipVotes || [];
    const skipThreshold = room.skipThreshold || 1;
    const hasVotedSkip = skipVotes.includes(session.memberId);
    const jamQueue = room.jamQueue || [];
    const recommendations = room.recommendations || [];
    const messages = room.messages || [];
    const candidateTracks = searchResults.length ? searchResults : snap.libraryTracks;
    const canQueueAdd = isHost || perms.allowQueueAdd;
    const canVoteSkip = isHost || perms.allowVoteSkip;
    const canChat = isHost || perms.allowChat;
    const canRecommend = isHost || perms.allowRecommendations;

    return (
      <>
        {/* Active JAM Room Header */}
        <section className="detached-jam-header">
          <div className="detached-jam-header-top">
            <HostAvatar name={hostName} avatar={hostAvatar} size={44} />
            <div className="detached-jam-title-wrap">
              {editingName && isHost ? (
                <form
                  className="jam-inline-form"
                  onSubmit={e => {
                    e.preventDefault();
                    const trimmed = roomNameDraft.trim();
                    if (trimmed) {
                      void sendControl({ action: 'updateRoom', roomName: trimmed });
                    }
                    setEditingName(false);
                  }}
                >
                  <input
                    className="input"
                    aria-label="Editar nome da JAM"
                    maxLength={60}
                    value={roomNameDraft}
                    onChange={e => setRoomNameDraft(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" className="button primary">
                    Salvar
                  </button>
                </form>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h1 title={room.roomName}>{room.roomName}</h1>
                  {isHost && (
                    <IconButton
                      label="Renomear JAM"
                      onClick={() => {
                        setRoomNameDraft(room.roomName);
                        setEditingName(true);
                      }}
                    >
                      <Edit3 size={13} />
                    </IconButton>
                  )}
                </div>
              )}
              <div className="detached-jam-subtitle">
                <span>
                  Anfitrião: <strong>{hostName}</strong>
                </span>
                <span>·</span>
                <span>
                  <Users size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
                  {room.members.length}/{room.maxParticipants}
                </span>
                <span>·</span>
                <span>{session.mode === 'lan' ? 'Rede local' : 'Online'}</span>
                {snap.rttMs > 0 && (
                  <>
                    <span>·</span>
                    <span>{snap.rttMs}ms</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Current Track & Vote Skip */}
          <div className="detached-jam-now-playing">
            <div className="detached-jam-now-meta">
              <Music2 size={16} />
              <div>
                <strong>{track ? track.title : 'Nenhuma faixa em reprodução'}</strong>
                <small>
                  {track
                    ? `${track.artist} · ${room.playback?.playing ? 'Tocando' : 'Pausada'}`
                    : 'Dê play em uma faixa online para sincronizar'}
                </small>
              </div>
            </div>
            <button
              type="button"
              className={`button ${hasVotedSkip ? 'primary' : 'secondary'}`}
              disabled={!canVoteSkip}
              title={
                canVoteSkip
                  ? 'Votar para pular esta música'
                  : 'O anfitrião desativou votos para pular'
              }
              onClick={() => void sendControl({ action: 'voteSkip' })}
            >
              <SkipForward size={13} />
              {skipVotes.length}/{skipThreshold}
            </button>
          </div>
        </section>

        {/* Navigation Tabs */}
        <nav className="detached-jam-tabs" aria-label="Seções da JAM">
          <button
            type="button"
            className={`detached-jam-tab ${tab === 'feed' ? 'active' : ''}`}
            onClick={() => setTab('feed')}
          >
            <ListPlus size={13} />
            Fila & Chat
          </button>
          <button
            type="button"
            className={`detached-jam-tab ${tab === 'people' ? 'active' : ''}`}
            onClick={() => setTab('people')}
          >
            <Users size={13} />
            Pessoas
            {isHost && pendingCount > 0 && (
              <span className="detached-jam-tab-badge">{pendingCount}</span>
            )}
          </button>
          <button
            type="button"
            className={`detached-jam-tab ${tab === 'invite' ? 'active' : ''}`}
            onClick={() => setTab('invite')}
          >
            <Share2 size={13} />
            Convidar
          </button>
          {isHost && (
            <button
              type="button"
              className={`detached-jam-tab ${tab === 'permissions' ? 'active' : ''}`}
              onClick={() => setTab('permissions')}
            >
              <Settings2 size={13} />
              Permissões
            </button>
          )}
        </nav>

        {/* TAB: FEED (Shared Queue + Recommendations + Chat) */}
        {tab === 'feed' && (
          <>
            <section className="jam-card">
              <div className="jam-card-head">
                <ListPlus size={15} />
                <strong>Fila compartilhada ({jamQueue.length})</strong>
              </div>
              {jamQueue.length > 0 ? (
                <div className="jam-queue-list">
                  {jamQueue.map(item => (
                    <div key={item.id} className="jam-queue-row">
                      <div className="jam-queue-meta">
                        <strong>{item.track.title}</strong>
                        <small>
                          {item.track.artist} · por {item.addedByName}
                        </small>
                      </div>
                      <div className="jam-queue-actions">
                        {isHost && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Tocar agora"
                            aria-label={`Tocar ${item.track.title}`}
                            onClick={() => void sendControl({ action: 'playTrack', track: item.track })}
                          >
                            <Play size={13} />
                          </button>
                        )}
                        {(isHost || item.addedById === session.memberId) && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Remover da fila"
                            aria-label={`Remover ${item.track.title}`}
                            onClick={() =>
                              void sendControl({ action: 'queueRemove', queueItemId: item.id })
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                  Nenhuma música na fila ainda.
                </p>
              )}

              {canQueueAdd ? (
                <>
                  <form className="jam-inline-form" onSubmit={e => void handleSearchQueue(e)}>
                    <input
                      className="input"
                      aria-label="Buscar música para fila da JAM"
                      placeholder="Buscar música online para a fila…"
                      value={queueQuery}
                      onChange={e => setQueueQuery(e.target.value)}
                    />
                    <button type="submit" className="button secondary" disabled={searching}>
                      <Search size={13} />
                      {searching ? 'Buscando…' : 'Buscar'}
                    </button>
                  </form>
                  {candidateTracks.length > 0 && (
                    <div className="jam-pick-list">
                      {candidateTracks.map(t => (
                        <div key={t.id} className="jam-queue-row">
                          <div className="jam-queue-meta">
                            <strong>{t.title}</strong>
                            <small>{t.artist}</small>
                          </div>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => void sendControl({ action: 'queueAdd', track: t })}
                          >
                            <Plus size={13} />
                            Fila
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                  O anfitrião restringiu a adição de músicas à fila.
                </p>
              )}
            </section>

            <section className="jam-card">
              <div className="jam-card-head">
                <ListMusic size={15} />
                <strong>Playlists recomendadas ({recommendations.length})</strong>
              </div>
              {canRecommend && snap.shareablePlaylists.length > 0 && (
                <div className="jam-inline-form">
                  <select
                    className="input"
                    aria-label="Escolher playlist para recomendar"
                    value={selectedPlaylistId || snap.shareablePlaylists[0]?.id || ''}
                    onChange={e => setSelectedPlaylistId(e.target.value)}
                  >
                    {snap.shareablePlaylists.map(pl => (
                      <option key={pl.id} value={pl.id}>
                        {pl.name} ({pl.tracks.length} faixas)
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void sendControl({
                        action: 'recommendPlaylist',
                        playlistId: selectedPlaylistId || snap.shareablePlaylists[0]?.id,
                      })
                    }
                  >
                    Recomendar
                  </button>
                </div>
              )}
              {recommendations.length > 0 && (
                <div className="jam-queue-list">
                  {recommendations.map(rec => (
                    <div key={rec.id} className="jam-queue-row">
                      <div className="jam-queue-meta">
                        <strong>{rec.name}</strong>
                        <small>
                          {rec.trackCount} músicas · por {rec.recommendedByName}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() =>
                          void sendControl({
                            action: 'savePlaylist',
                            playlistName: rec.name,
                            playlistTracks: rec.tracks,
                          })
                        }
                      >
                        <BookmarkPlus size={13} />
                        Salvar
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="jam-card">
              <div className="jam-card-head">
                <MessageSquare size={15} />
                <strong>Chat da sala</strong>
              </div>
              <div className="jam-chat-feed" aria-live="polite">
                {messages.length === 0 ? (
                  <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                    Nenhuma mensagem ainda. Converse com quem está ouvindo junto!
                  </p>
                ) : (
                  messages.map(m => (
                    <div
                      key={m.id}
                      className={`jam-chat-msg ${m.memberId === session.memberId ? 'mine' : ''}`}
                    >
                      <div className="jam-chat-msg-head">
                        <strong>{m.name}</strong>
                        <small>
                          {new Date(m.sentAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </small>
                      </div>
                      <p>{m.text}</p>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
              {canChat ? (
                <form
                  className="jam-inline-form"
                  onSubmit={e => {
                    e.preventDefault();
                    const clean = chatText.trim();
                    if (!clean) return;
                    setChatText('');
                    void sendControl({ action: 'chat', message: clean });
                  }}
                >
                  <input
                    className="input"
                    aria-label="Mensagem no chat da JAM"
                    maxLength={300}
                    placeholder="Escreva uma mensagem…"
                    value={chatText}
                    onChange={e => setChatText(e.target.value)}
                  />
                  <button type="submit" className="button primary" disabled={!chatText.trim()}>
                    <Send size={13} />
                    Enviar
                  </button>
                </form>
              ) : (
                <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                  O anfitrião desativou o chat para os convidados.
                </p>
              )}
            </section>
          </>
        )}

        {/* TAB: PEOPLE (Pending Requests + Participants + Blocked List) */}
        {tab === 'people' && (
          <>
            {isHost && (
              <section className="jam-card">
                <div className="jam-card-head">
                  <UserCheck size={15} />
                  <strong>Pedidos de entrada ({pendingRequests.length})</strong>
                </div>
                {pendingRequests.length === 0 ? (
                  <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                    Nenhum pedido pendente no momento.
                  </p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {pendingRequests.map(req => (
                      <div key={req.id} className="jam-request-card">
                        <div className="jam-request-info">
                          <HostAvatar name={req.name} avatar={req.avatar} size={34} />
                          <div>
                            <strong>{req.name}</strong>
                            <small>
                              Solicitado às{' '}
                              {new Date(req.requestedAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </small>
                          </div>
                        </div>
                        <div className="jam-request-actions">
                          <button
                            type="button"
                            className="button primary"
                            onClick={() =>
                              void sendControl({ action: 'approveJoin', requestId: req.id })
                            }
                          >
                            Aceitar
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() =>
                              void sendControl({
                                action: 'rejectJoin',
                                requestId: req.id,
                                block: false,
                              })
                            }
                          >
                            Recusar
                          </button>
                          <button
                            type="button"
                            className="button danger"
                            title="Recusar e bloquear usuário nesta JAM"
                            aria-label={`Recusar e bloquear ${req.name}`}
                            onClick={() =>
                              void sendControl({
                                action: 'rejectJoin',
                                requestId: req.id,
                                block: true,
                              })
                            }
                          >
                            <Ban size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            <section className="jam-card">
              <div className="jam-card-head">
                <Users size={15} />
                <strong>
                  Participantes ({room.members.length}/{room.maxParticipants})
                </strong>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {room.members.map(m => (
                  <div key={m.id} className="jam-queue-row">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <HostAvatar name={m.name} avatar={m.avatar} size={32} />
                      <div className="jam-queue-meta">
                        <strong>
                          {m.name} {m.id === session.memberId ? '(você)' : ''}
                        </strong>
                        <small>
                          {m.host ? 'Anfitrião' : 'Ouvinte'} ·{' '}
                          {m.online === false ? 'Reconectando…' : 'Online'}
                        </small>
                      </div>
                    </div>
                    {isHost && !m.host && (
                      <div className="jam-request-actions">
                        <button
                          type="button"
                          className="button secondary"
                          title="Remover participante"
                          onClick={() => void sendControl({ action: 'kick', memberId: m.id })}
                        >
                          <UserMinus size={13} />
                          Remover
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          title="Remover e bloquear participante"
                          onClick={() =>
                            void sendControl({ action: 'blockMember', memberId: m.id })
                          }
                        >
                          <Ban size={13} />
                          Bloquear
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {isHost && (
              <section className="jam-card">
                <div className="jam-card-head">
                  <Ban size={15} />
                  <strong>Usuários bloqueados ({blockedList.length})</strong>
                </div>
                {blockedList.length === 0 ? (
                  <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                    Nenhum usuário bloqueado nesta JAM.
                  </p>
                ) : (
                  <div style={{ display: 'grid', gap: 7 }}>
                    {blockedList.map(b => (
                      <div key={b.key} className="jam-blocked-item">
                        <span style={{ fontSize: 12.5, fontWeight: 560 }}>{b.name}</span>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            void sendControl({ action: 'unblockMember', blockKey: b.key })
                          }
                        >
                          Desbloquear
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {/* TAB: INVITE */}
        {tab === 'invite' && (
          <section className="jam-card">
            <div className="jam-card-head" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <Share2 size={15} />
                <strong>Convidar amigos</strong>
              </span>
              <span className="jam-status-pill live">
                <ShieldCheck size={12} />
                {room.requireApproval !== false ? 'Com aprovação' : 'Acesso aberto'}
              </span>
            </div>

            <div className="jam-room-code">
              <span>
                Código da JAM<strong>{session.code}</strong>
              </span>
              <button
                type="button"
                className="button secondary"
                onClick={() => copyValue(session.code, 'code', 'Código da JAM copiado.')}
              >
                {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'code' ? 'Copiado' : 'Copiar código'}
              </button>
            </div>

            <label className="field-label">
              Link de convite
              <div className="jam-inline-form">
                <input
                  className="input jam-invite"
                  readOnly
                  aria-label="Link de convite da JAM"
                  value={inviteUrl}
                  onFocus={e => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="button primary"
                  onClick={() => copyValue(inviteUrl, 'link', 'Link de convite copiado.')}
                >
                  {copied === 'link' ? <Check size={14} /> : <Copy size={14} />}
                  {copied === 'link' ? 'Copiado' : 'Copiar link'}
                </button>
              </div>
            </label>

            <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
              {room.requireApproval !== false
                ? 'Quem abrir o link precisa solicitar entrada e aguardar sua aprovação.'
                : 'A entrada automática está liberada para quem receber este link.'}
            </p>

            <div className="jam-share-bar">
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  void window.glass
                    .external(buildWhatsAppShareUrl(room.roomName, inviteUrl, session.code))
                    .catch(e => setLocalError(e instanceof Error ? e.message : 'Falha ao abrir WhatsApp.'))
                }
              >
                <MessageCircle size={14} />
                WhatsApp
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  copyValue(
                    buildDiscordShareText(room.roomName, inviteUrl, session.code),
                    'discord',
                    'Convite formatado para Discord copiado.',
                  )
                }
              >
                {copied === 'discord' ? <Check size={14} /> : <Copy size={14} />}
                Discord
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  void shareNativeInvite({
                    roomName: room.roomName,
                    inviteUrl,
                    code: session.code,
                  }).catch(() => {});
                }}
              >
                <Share2 size={14} />
                Compartilhar
              </button>
            </div>

            {isHost && (
              <div className="jam-interactive-bar">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void sendControl({ action: 'rotateInvite' })}
                >
                  <RefreshCw size={13} />
                  Gerar novo convite
                </button>
              </div>
            )}
          </section>
        )}

        {/* TAB: PERMISSIONS (Host-only) */}
        {tab === 'permissions' && isHost && (
          <section className="jam-card">
            <div className="jam-card-head">
              <Settings2 size={15} />
              <strong>Controles de acesso e permissões</strong>
            </div>
            <Toggle
              label="Entrada mediante aprovação"
              description="Exige aceitar cada solicitação antes do usuário entrar na sala."
              checked={room.requireApproval !== false}
              onChange={v => void sendControl({ action: 'updateRoom', requireApproval: v })}
            />
            <Toggle
              label="Trancar JAM"
              description="Bloqueia novas solicitações e entradas temporariamente."
              checked={Boolean(room.locked)}
              onChange={v => void sendControl({ action: 'updateRoom', locked: v })}
            />
            <Toggle
              label="Exigir conta autenticada no servidor"
              description="Exige token de conta Liquid Hub válido no coordenador."
              checked={Boolean(room.requireAuth)}
              onChange={v => void sendControl({ action: 'updateRoom', requireAuth: v })}
            />
            <Toggle
              label="Convidados adicionam à fila"
              description="Permite que ouvintes adicionem músicas online à fila compartilhada."
              checked={perms.allowQueueAdd}
              onChange={v =>
                void sendControl({ action: 'updateRoom', permissions: { allowQueueAdd: v } })
              }
            />
            <Toggle
              label="Convidados votam para pular"
              description="Permite votação democrática para pular a faixa atual."
              checked={perms.allowVoteSkip}
              onChange={v =>
                void sendControl({ action: 'updateRoom', permissions: { allowVoteSkip: v } })
              }
            />
            <Toggle
              label="Convidados enviam chat"
              description="Permite mensagens no bate-papo ao vivo da sala."
              checked={perms.allowChat}
              onChange={v =>
                void sendControl({ action: 'updateRoom', permissions: { allowChat: v } })
              }
            />
            <Toggle
              label="Convidados recomendam playlists"
              description="Permite enviar sugestões de playlists na sala."
              checked={perms.allowRecommendations}
              onChange={v =>
                void sendControl({
                  action: 'updateRoom',
                  permissions: { allowRecommendations: v },
                })
              }
            />
          </section>
        )}
      </>
    );
  };

  const errText = localError || snap?.error || '';

  return (
    <div className="app detached-jam">
      <OpticalEngine>
        <div className="detached-jam-shell">
          <header className="detached-jam-bar" data-tauri-drag-region>
            <div className="detached-jam-brand" data-tauri-drag-region>
              <span
                className={`jam-pulse-dot ${snap?.session ? '' : 'idle'}`}
                aria-hidden="true"
                style={!snap?.session ? { opacity: 0.45, animation: 'none' } : undefined}
              />
              <Radio size={15} />
              <span>{room ? `${room.roomName} · JAM` : 'JAM · Liquid Hub'}</span>
            </div>
            <div className="detached-jam-bar-actions">
              <IconButton
                label={pinned ? 'Desafixar janela' : 'Manter janela no topo'}
                active={pinned}
                onClick={togglePin}
              >
                {pinned ? <PinOff size={15} /> : <Pin size={15} />}
              </IconButton>
              <IconButton
                label="Fechar janela (JAM continua em segundo plano)"
                onClick={() => void closeJamWindow()}
              >
                <X size={16} />
              </IconButton>
            </div>
          </header>

          <main className="detached-jam-body">
            {notice && (
              <div className="jam-status-pill live" role="status">
                {notice}
              </div>
            )}
            {errText && (
              <p className="jam-error-banner" role="alert">
                {errText}
              </p>
            )}
            {renderContent()}
          </main>

          {session && room && (
            <footer className="detached-jam-footer">
              <small>Fechar esta janela mantém sua JAM tocando e conectada.</small>
              <button
                type="button"
                className={`button ${session.host ? 'danger' : 'secondary'}`}
                onClick={() => void sendControl({ action: 'leave' })}
              >
                <LogOut size={14} />
                {session.host ? 'Encerrar JAM' : 'Sair da JAM'}
              </button>
            </footer>
          )}
        </div>
      </OpticalEngine>
    </div>
  );
}
