import { useEffect, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Globe,
  Link2,
  LoaderCircle,
  Lock,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import type { PlaylistVisibility, SharedPlaylistDetail } from '../../../shared/types';
import { resolveEffectiveBroker, useAccounts } from '../../stores/accounts';
import { cleanError, useApp } from '../../stores/app';

export function PlaylistShareModal({
  playlistId,
  onClose,
}: {
  playlistId: string;
  onClose: () => void;
}) {
  const playlist = useApp(s => s.data.playlists.find(p => p.id === playlistId));
  const allTracks = useApp(s => s.data.tracks);
  const hub = useAccounts(s => s.hub);
  const preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl);
  const brokerUrl = resolveEffectiveBroker(undefined, { preferredBrokerUrl, hub });

  const [visibility, setVisibility] = useState<PlaylistVisibility>(
    playlist?.visibility || 'unlisted',
  );
  const [collaborative, setCollaborative] = useState(Boolean(playlist?.collaborative));
  const [detail, setDetail] = useState<SharedPlaylistDetail | null>(null);
  const [inviteHandle, setInviteHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const shareId = detail?.id || playlist?.shareId || '';
  const tracks = (playlist?.trackIds || [])
    .map(id => allTracks.find(t => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t);
  const shareableTracks = tracks.filter(t => t.source !== 'local');
  const skippedLocalCount = tracks.length - shareableTracks.length;

  useEffect(() => {
    if (!hub.authenticated || !playlist?.shareId || !window.glass?.hubGetSharedPlaylist) return;
    let cancelled = false;
    void window.glass
      .hubGetSharedPlaylist({ brokerUrl, shareId: playlist.shareId })
      .then(data => {
        if (cancelled) return;
        setDetail(data);
        setVisibility(data.visibility);
        setCollaborative(data.collaborative);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hub.authenticated, playlist?.shareId, brokerUrl]);

  if (!playlist) {
    return (
      <div>
        <h2 id="dialog-title">Playlist não encontrada</h2>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    );
  }

  if (!hub.authenticated) {
    return (
      <div className="share-modal-body">
        <h2 id="dialog-title">Compartilhar playlist</h2>
        <p className="subtle">
          Entre na sua conta Liquid Hub para publicar links compartilháveis e convidar colaboradores.
        </p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Fechar
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              onClose();
              useAccounts.getState().openAuthModal({ view: 'choose' });
            }}
          >
            Entrar no Liquid Hub
          </button>
        </div>
      </div>
    );
  }

  const handlePublish = async () => {
    if (!window.glass?.hubPublishPlaylist) return;
    setBusy(true);
    setError('');
    try {
      const published = await window.glass.hubPublishPlaylist({
        brokerUrl,
        ...(shareId ? { shareId } : {}),
        localPlaylistId: playlist.id,
        name: playlist.name,
        description: playlist.description || '',
        artwork: playlist.artwork || '',
        visibility,
        collaborative,
        tracks: shareableTracks,
      });
      setDetail(published);
      if (window.glass.playlistMeta) {
        const snap = await window.glass.playlistMeta(playlist.id, {
          shareId: published.id,
          visibility: published.visibility,
          collaborative: published.collaborative,
          remoteVersion: published.version,
          ownerHandle: published.ownerHandle,
        });
        useApp.setState(curr => ({
          data: { ...snap, preferences: curr.data.preferences },
        }));
      }
      useApp.getState().message('Playlist sincronizada para compartilhamento.');
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = inviteHandle.trim().replace(/^@+/, '').toLowerCase();
    if (!cleaned || !shareId || !window.glass?.hubInviteCollaborator) return;
    setBusy(true);
    setError('');
    try {
      const updated = await window.glass.hubInviteCollaborator({
        brokerUrl,
        shareId,
        handle: cleaned,
      });
      setDetail(updated);
      setInviteHandle('');
      useApp.getState().message(`Convite enviado para @${cleaned}.`);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveCollaborator = async (handle: string) => {
    if (!shareId || !window.glass?.hubRemoveCollaborator) return;
    setBusy(true);
    setError('');
    try {
      const updated = await window.glass.hubRemoveCollaborator({
        brokerUrl,
        shareId,
        handle,
      });
      if (updated && 'collaborators' in updated) {
        setDetail(updated);
      } else if (window.glass.hubGetSharedPlaylist) {
        setDetail(await window.glass.hubGetSharedPlaylist({ brokerUrl, shareId }));
      }
      useApp.getState().message(`@${handle} removido da colaboração.`);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = shareId ? detail?.shareUrl || `${brokerUrl}/p/${encodeURIComponent(shareId)}` : '';
  const deepLinkUrl = shareId ? detail?.deepLinkUrl || `liquidhub://playlist/${shareId}` : '';

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      useApp.getState().message('Link da playlist copiado.');
    } catch {
      useApp.getState().message(shareUrl);
    }
  };

  return (
    <div className="share-modal-body">
      <h2 id="dialog-title">Compartilhar “{playlist.name}”</h2>

      <div className="share-visibility-group" role="radiogroup" aria-label="Privacidade da playlist">
        {(
          [
            ['private', 'Privada', 'Somente você e colaboradores aceitos (link não dá acesso).', Lock],
            ['unlisted', 'Não listada', 'Qualquer pessoa com o link pode abrir; oculta do seu perfil.', Link2],
            ['public', 'Pública', 'Aparece no seu perfil público e pode ser aberta pelo link.', Globe],
          ] as const
        ).map(([val, title, desc, Icon]) => (
          <label
            key={val}
            className={`share-visibility-option ${visibility === val ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="playlist-visibility"
              value={val}
              checked={visibility === val}
              onChange={() => setVisibility(val)}
            />
            <Icon size={15} />
            <div>
              <strong>{title}</strong>
              <small>{desc}</small>
            </div>
          </label>
        ))}
      </div>

      <label className="share-collab-toggle">
        <input
          type="checkbox"
          checked={collaborative}
          onChange={e => setCollaborative(e.target.checked)}
        />
        <Users size={15} />
        <span>Modo colaborativo (colaboradores convidados podem adicionar, remover e reordenar faixas)</span>
      </label>

      {skippedLocalCount > 0 && (
        <p className="fine-print">
          {skippedLocalCount} faixa(s) apenas locais do seu dispositivo não são enviadas para playlists compartilhadas.
        </p>
      )}

      {shareUrl && (
        <div className="share-link-box">
          <code>{shareUrl}</code>
          <small className="subtle">Deep link: {deepLinkUrl}</small>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <button type="button" className="button secondary" onClick={() => void copyShareUrl()}>
              <Copy size={14} />
              Copiar link
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                onClose();
                useApp.getState().setPage(`shared-playlist:${shareId}`);
              }}
            >
              <ExternalLink size={14} />
              Abrir página compartilhada
            </button>
          </div>
        </div>
      )}

      {shareId && collaborative && (
        <div className="share-collaborators-box">
          <h3>Colaboradores</h3>
          <form onSubmit={e => void handleInvite(e)} className="share-invite-form">
            <input
              type="text"
              className="input"
              placeholder="@handle do amigo (ex: ana.silva)"
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
          {detail?.collaborators && detail.collaborators.length > 0 && (
            <ul className="collab-list">
              {detail.collaborators
                .filter(c => c.role !== 'owner')
                .map(c => (
                  <li key={c.handle} className="collab-row">
                    <div>
                      <strong>{c.displayName}</strong>
                      <small>
                        @{c.handle} · {c.status === 'accepted' ? 'Editor ativo' : 'Convite pendente'}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remover @${c.handle}`}
                      disabled={busy}
                      onClick={() => void handleRemoveCollaborator(c.handle)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          Fechar
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void handlePublish()}
        >
          {busy ? (
            <>
              <LoaderCircle size={14} className="spinner" /> Sincronizando…
            </>
          ) : shareId ? (
            'Atualizar compartilhamento'
          ) : (
            'Publicar playlist'
          )}
        </button>
      </div>
    </div>
  );
}
