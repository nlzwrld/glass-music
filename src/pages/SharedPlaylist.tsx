import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Globe,
  History,
  Link2,
  ListMusic,
  LoaderCircle,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type {
  PlaylistVisibility,
  SharedPlaylistDetail,
  Track,
} from '../../shared/types';
import { reorderTrackIds, syncActiveQueueOrder } from '../lib/playlist';
import { resolveEffectiveBroker, useAccounts } from '../stores/accounts';
import { cleanError, useApp } from '../stores/app';
import { CollectionPlaybackActions } from '../components/library/CollectionPlaybackActions';
import TrackList from '../components/library/TrackList';

function visibilityBadge(v: PlaylistVisibility) {
  if (v === 'public') return { label: 'Pública', Icon: Globe };
  if (v === 'unlisted') return { label: 'Não listada', Icon: Link2 };
  return { label: 'Privada', Icon: Lock };
}

export default function SharedPlaylist({ shareId }: { shareId: string }) {
  const hub = useAccounts(s => s.hub);
  const preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl);
  const onlineConsent = useApp(s => s.data.preferences.onlineConsent);
  const current = useApp(s => s.queue[s.index]);
  const queueContext = useApp(s => s.queueContext);
  const playing = useApp(s => s.playing);
  const localTracks = useApp(s => s.data.tracks);

  const brokerUrl = resolveEffectiveBroker(undefined, { preferredBrokerUrl, hub });

  const [detail, setDetail] = useState<SharedPlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inviteHandle, setInviteHandle] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');

  const versionRef = useRef(0);
  versionRef.current = detail?.version ?? 0;

  const loadFull = useCallback(
    async (quiet = false) => {
      if (!onlineConsent) {
        setLoading(false);
        setError('Ative o acesso online para abrir playlists compartilhadas.');
        return;
      }
      if (!window.glass?.hubGetSharedPlaylist) {
        setLoading(false);
        setError('Playlists compartilhadas indisponíveis neste ambiente.');
        return;
      }
      if (!quiet) setLoading(true);
      setError('');
      try {
        const res = await window.glass.hubGetSharedPlaylist({ shareId, brokerUrl });
        if (!res.unchanged) setDetail(res);
      } catch (e) {
        setDetail(null);
        setError(cleanError(e) || 'Playlist indisponível ou privada.');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [shareId, brokerUrl, onlineConsent],
  );

  useEffect(() => {
    void loadFull(false);
  }, [loadFull, hub.authenticated, hub.publicHandle]);

  useEffect(() => {
    if (!onlineConsent || !window.glass?.hubGetSharedPlaylist) return;
    let disposed = false;

    const pollDelta = async () => {
      if (disposed || document.visibilityState !== 'visible' || !versionRef.current) return;
      try {
        const res = await window.glass.hubGetSharedPlaylist({
          shareId,
          brokerUrl,
          sinceVersion: versionRef.current,
        });
        if (!disposed && res && !res.unchanged) {
          setDetail(res);
        }
      } catch {
        // Keep current state cleanly on transient poll hiccup
      }
    };

    const timer = window.setInterval(() => void pollDelta(), 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pollDelta();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [shareId, brokerUrl, onlineConsent]);

  const syncLocalPlaylistMeta = async (updated: SharedPlaylistDetail) => {
    const linked = useApp
      .getState()
      .data.playlists.find(
        p => p.shareId === updated.id || (updated.localPlaylistId && p.id === updated.localPlaylistId),
      );
    if (linked && window.glass?.playlistMeta) {
      try {
        const snap = await window.glass.playlistMeta(linked.id, {
          shareId: updated.id,
          visibility: updated.visibility,
          collaborative: updated.collaborative,
          remoteVersion: updated.version,
          ownerHandle: updated.ownerHandle,
        });
        useApp.setState(curr => ({
          data: { ...snap, preferences: curr.data.preferences },
        }));
      } catch {}
    }
  };

  const runMutation = async (
    patch: Omit<
      Parameters<NonNullable<typeof window.glass.hubMutateSharedPlaylist>>[0],
      'brokerUrl' | 'shareId' | 'expectedVersion'
    >,
  ) => {
    if (!detail || !window.glass?.hubMutateSharedPlaylist) return null;
    setBusy(true);
    try {
      const updated = await window.glass.hubMutateSharedPlaylist({
        brokerUrl,
        shareId: detail.id,
        expectedVersion: detail.version,
        ...patch,
      });
      setDetail(updated);
      void syncLocalPlaylistMeta(updated);
      return updated;
    } catch (e) {
      const msg = cleanError(e);
      if (/version_conflict|foi modificada/i.test(msg)) {
        await loadFull(true);
        useApp
          .getState()
          .message('A playlist foi modificada por outro colaborador. Versão sincronizada.');
      } else {
        useApp.getState().message(msg);
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !detail) {
    return (
      <div className="loading-page" role="status">
        <LoaderCircle size={16} className="spinner" /> Carregando playlist compartilhada…
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="empty-state profile-empty-state">
        <Lock size={26} />
        <h3>Playlist indisponível</h3>
        <p>{error || 'Esta playlist é privada, foi removida ou você não tem acesso.'}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          {!hub.authenticated && (
            <button
              className="button primary"
              onClick={() => useAccounts.getState().openAuthModal({ view: 'choose' })}
            >
              Entrar no Liquid Hub
            </button>
          )}
          <button className="button secondary" onClick={() => useApp.getState().navigate(-1)}>
            <ArrowLeft size={14} />
            Voltar
          </button>
        </div>
      </div>
    );
  }

  const canManage = detail.role === 'owner';
  const canEdit = detail.role === 'owner' || (detail.role === 'editor' && detail.collaborative);
  const myHandle = hub.authenticated ? hub.publicHandle || '' : '';
  const pendingInvite = Boolean(
    myHandle && detail.collaborators.some(c => c.handle === myHandle && c.status === 'pending'),
  );
  const isAcceptedEditor = Boolean(
    !canManage &&
      myHandle &&
      detail.collaborators.some(
        c => c.handle === myHandle && c.role === 'editor' && c.status === 'accepted',
      ),
  );
  const contextId = `shared-playlist:${detail.id}`;
  const activeHere =
    !!current && queueContext === contextId && detail.tracks.some(t => t.id === current.id);
  const { label: visLabel, Icon: VisIcon } = visibilityBadge(detail.visibility);
  const shareUrl = detail.shareUrl || `${brokerUrl}/p/${encodeURIComponent(detail.id)}`;

  const existingIds = new Set(detail.tracks.map(t => t.id));
  const libraryCandidates = localTracks.filter(
    t =>
      t.source !== 'local' &&
      !existingIds.has(t.id) &&
      (!pickerFilter.trim() ||
        `${t.title} ${t.artist}`
          .toLocaleLowerCase('pt-BR')
          .includes(pickerFilter.trim().toLocaleLowerCase('pt-BR'))),
  );

  const handleReorderRemote = async (fromId: string, toId: string) => {
    const nextIds = reorderTrackIds(
      detail.tracks.map(t => t.id),
      fromId,
      toId,
    );
    if (!nextIds) return;
    const updated = await runMutation({ op: 'reorder', trackIds: nextIds });
    if (updated) {
      const appState = useApp.getState();
      const synced = syncActiveQueueOrder(
        appState.queue,
        appState.index,
        nextIds,
        appState.shufflePlayed,
        appState.shuffleNext,
      );
      if (synced) useApp.setState(synced);
    }
  };

  const handleSaveCopy = async () => {
    setBusy(true);
    try {
      const createdSnap = await window.glass.library({ action: 'create', name: detail.name });
      const createdPl = createdSnap.playlists.find(
        p => p.name === detail.name && !p.shareId,
      ) || createdSnap.playlists[0];
      if (createdPl) {
        let latest = createdSnap;
        for (const tr of detail.tracks) {
          latest = await window.glass.library({ action: 'add', id: createdPl.id, track: tr });
        }
        if (window.glass.playlistMeta) {
          latest = await window.glass.playlistMeta(createdPl.id, {
            ...(detail.artwork ? { artwork: detail.artwork } : {}),
            ...(detail.description ? { description: detail.description } : {}),
            shareId: detail.id,
            visibility: detail.visibility,
            collaborative: detail.collaborative,
            remoteVersion: detail.version,
            ownerHandle: detail.ownerHandle,
          });
        }
        useApp.setState(curr => ({
          data: { ...latest, preferences: curr.data.preferences },
        }));
      }
      useApp.getState().message('Playlist salva na sua biblioteca.');
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRespondInvite = async (accept: boolean) => {
    if (!window.glass?.hubRespondPlaylistInvite) return;
    setBusy(true);
    try {
      const res = await window.glass.hubRespondPlaylistInvite({
        brokerUrl,
        shareId: detail.id,
        accept,
      });
      if (accept && res && 'tracks' in res) {
        setDetail(res);
        useApp.getState().message('Você entrou nesta playlist colaborativa!');
      } else {
        useApp.getState().message('Convite recusado.');
        useApp.getState().setPage('library');
      }
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = inviteHandle.trim().replace(/^@+/, '').toLowerCase();
    if (!cleaned || !window.glass?.hubInviteCollaborator) return;
    setBusy(true);
    try {
      const updated = await window.glass.hubInviteCollaborator({
        brokerUrl,
        shareId: detail.id,
        handle: cleaned,
      });
      setDetail(updated);
      setInviteHandle('');
      useApp.getState().message(`Convite enviado para @${cleaned}.`);
    } catch (err) {
      useApp.getState().message(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveCollaborator = async (handle: string, isSelfLeave = false) => {
    if (!window.glass?.hubRemoveCollaborator) return;
    setBusy(true);
    try {
      await window.glass.hubRemoveCollaborator({
        brokerUrl,
        shareId: detail.id,
        handle,
      });
      if (isSelfLeave) {
        useApp.getState().message('Você saiu da playlist colaborativa.');
        if (detail.visibility === 'private') {
          useApp.getState().setPage('library');
        } else {
          await loadFull(true);
        }
      } else {
        await loadFull(true);
        useApp.getState().message(`@${handle} removido da colaboração.`);
      }
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="playlist-page shared-playlist-page">
      <div className="page-heading collection-hero">
        <div className="playlist-hero-art">
          {detail.artwork ? (
            <img src={detail.artwork} alt="" className="shared-hero-img" />
          ) : (
            <div className="shared-hero-fallback">
              <ListMusic size={34} />
            </div>
          )}
        </div>
        <div>
          <div className="profile-badges-row">
            <span className="entity-badge entity-badge-privacy">
              <VisIcon size={12} />
              {visLabel}
            </span>
            {detail.collaborative && (
              <span className="entity-badge entity-badge-collab">
                <Users size={12} />
                Colaborativa
              </span>
            )}
            <span className="entity-badge">v{detail.version}</span>
          </div>
          <h1>{detail.name}</h1>
          {detail.description && <p className="shared-playlist-desc">{detail.description}</p>}
          <p className="shared-owner-line">
            Por{' '}
            <button
              type="button"
              className="text-button inline-handle-btn"
              onClick={() => useApp.getState().setPage(`profile:${detail.ownerHandle}`)}
            >
              {detail.ownerDisplayName} (@{detail.ownerHandle})
            </button>{' '}
            · {detail.tracks.length} faixa(s)
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl);
                useApp.getState().message('Link da playlist copiado.');
              } catch {
                useApp.getState().message(shareUrl);
              }
            }}
          >
            <Copy size={14} />
            Copiar link
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void handleSaveCopy()}
          >
            <Plus size={14} />
            Salvar na biblioteca
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void loadFull(true)}
            aria-label="Atualizar playlist"
          >
            <RefreshCw size={14} />
          </button>
          <button className="text-button" onClick={() => useApp.getState().navigate(-1)}>
            <ArrowLeft size={14} />
            Voltar
          </button>
        </div>
      </div>

      {pendingInvite && (
        <div className="notice collab-invite-banner" role="status">
          <Users size={16} />
          <span>Você foi convidado para colaborar nesta playlist em tempo real.</span>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void handleRespondInvite(false)}
            >
              <X size={14} />
              Recusar
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void handleRespondInvite(true)}
            >
              <Check size={14} />
              Aceitar convite
            </button>
          </div>
        </div>
      )}

      <div className="library-toolbar">
        <div>
          <CollectionPlaybackActions
            tracks={detail.tracks}
            activeHere={activeHere}
            playing={playing}
            isPlaylist
            contextId={contextId}
          />
          {canEdit && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setPickerOpen(v => !v)}
            >
              <Plus size={14} />
              {pickerOpen ? 'Fechar seleção' : 'Adicionar faixa'}
            </button>
          )}
          {isAcceptedEditor && myHandle && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void handleRemoveCollaborator(myHandle, true)}
            >
              <LogOut size={14} />
              Sair da playlist
            </button>
          )}
        </div>
      </div>

      {pickerOpen && canEdit && (
        <div className="shared-add-track-panel">
          <div className="shared-add-track-head">
            <strong>Adicionar música da sua biblioteca</strong>
            <input
              type="text"
              className="input"
              placeholder="Filtrar por título ou artista…"
              value={pickerFilter}
              onChange={e => setPickerFilter(e.target.value)}
            />
          </div>
          {libraryCandidates.length > 0 ? (
            <div className="shared-add-track-list">
              {libraryCandidates.slice(0, 20).map((t: Track) => (
                <div key={t.id} className="shared-add-track-row">
                  <div>
                    <strong>{t.title}</strong>
                    <small>{t.artist}</small>
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void runMutation({ op: 'addTracks', tracks: [t] })}
                  >
                    <Plus size={14} />
                    Adicionar
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="subtle">
              Nenhuma faixa compatível disponível para adicionar (faixas locais não são compartilháveis).
            </p>
          )}
        </div>
      )}

      <TrackList
        tracks={detail.tracks}
        contextId={contextId}
        showHeaderShuffle={false}
        canReorder={canEdit}
        onReorder={canEdit ? handleReorderRemote : undefined}
        onRemoveTrack={
          canEdit ? track => void runMutation({ op: 'removeTrack', trackId: track.id }) : undefined
        }
      />

      <div className="shared-panels-grid">
        <section className="shared-panel" aria-label="Colaboradores">
          <div className="section-heading">
            <h2>
              <Users size={16} /> Participantes ({detail.collaborators.length})
            </h2>
          </div>

          {canManage && (
            <div className="shared-owner-controls">
              <div className="shared-quick-meta">
                <label className="field-label">
                  Visibilidade
                  <select
                    className="input"
                    disabled={busy}
                    value={detail.visibility}
                    onChange={e =>
                      void runMutation({
                        op: 'meta',
                        visibility: e.target.value as PlaylistVisibility,
                      })
                    }
                  >
                    <option value="private">Privada</option>
                    <option value="unlisted">Não listada (com link)</option>
                    <option value="public">Pública (no perfil)</option>
                  </select>
                </label>
                <label className="share-collab-toggle">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={detail.collaborative}
                    onChange={e =>
                      void runMutation({
                        op: 'meta',
                        collaborative: e.target.checked,
                      })
                    }
                  />
                  <span>Colaborativa</span>
                </label>
              </div>
              {detail.collaborative && (
                <form onSubmit={e => void handleInviteSubmit(e)} className="share-invite-form">
                  <input
                    type="text"
                    className="input"
                    placeholder="Convidar por @handle…"
                    value={inviteHandle}
                    onChange={e => setInviteHandle(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="button secondary"
                    disabled={busy || !inviteHandle.trim()}
                  >
                    <UserPlus size={14} />
                    Convidar
                  </button>
                </form>
              )}
            </div>
          )}

          <ul className="collab-list">
            {detail.collaborators.map(c => (
              <li key={c.handle} className="collab-row">
                <button
                  type="button"
                  className="text-button collab-user-btn"
                  onClick={() => useApp.getState().setPage(`profile:${c.handle}`)}
                >
                  <strong>{c.displayName}</strong>
                  <small>
                    @{c.handle} ·{' '}
                    {c.role === 'owner'
                      ? 'Anfitrião'
                      : c.status === 'accepted'
                        ? 'Editor'
                        : 'Pendente'}
                  </small>
                </button>
                {canManage && c.role !== 'owner' && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remover @${c.handle}`}
                    disabled={busy}
                    onClick={() => void handleRemoveCollaborator(c.handle, false)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="shared-panel" aria-label="Histórico recente">
          <div className="section-heading">
            <h2>
              <History size={16} /> Atividade recente
            </h2>
          </div>
          {detail.activity.length > 0 ? (
            <ul className="activity-list">
              {detail.activity.slice(0, 12).map(item => (
                <li key={item.id} className="activity-row">
                  <div>
                    <strong>@{item.actorHandle}</strong> <span>{item.summary}</span>
                  </div>
                  <small>
                    v{item.version} · {new Date(item.createdAt).toLocaleTimeString()}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="subtle">Nenhuma alteração recente registrada.</p>
          )}
        </section>
      </div>
    </div>
  );
}
