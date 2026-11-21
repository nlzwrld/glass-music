import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Headphones,
  LoaderCircle,
  Lock,
  Music2,
  Radio,
  Users,
  X,
} from 'lucide-react';
import type { JamErrorCode, JamRoomStatus } from '../../../shared/jam';
import { buildJamInviteUrl } from '../../lib/jam';
import { useAccounts } from '../../stores/accounts';
import { useApp } from '../../stores/app';
import { IconButton } from '../glass/controls';
import { useJam } from './state';
import './jam.css';

function statusInfo(status?: JamRoomStatus, errorCode?: JamErrorCode) {
  if (status === 'active') return { label: 'Ao vivo', tone: 'live' };
  if (status === 'full') return { label: 'Lotada', tone: 'warn' };
  if (status === 'locked') return { label: 'Trancada', tone: 'warn' };
  if (status === 'ended' || errorCode === 'ROOM_ENDED') return { label: 'Encerrada', tone: 'ended' };
  if (status === 'expired' || errorCode === 'INVITE_EXPIRED')
    return { label: 'Expirada', tone: 'ended' };
  return { label: 'Indisponível', tone: 'ended' };
}

export function HostAvatar({
  name,
  avatar,
  size = 44,
}: {
  name: string;
  avatar?: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const initial = (name || 'L').trim().charAt(0).toUpperCase() || 'L';

  return (
    <div
      className="jam-host-avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {avatar && !broken ? (
        <img src={avatar} alt="" onError={() => setBroken(true)} />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
}

export function JamInviteModal() {
  const pending = useJam(s => s.pendingInvite),
    busy = useJam(s => s.busy),
    error = useJam(s => s.error),
    hubSubject = useJam(s => s.hubSubject),
    hubDisplayName = useJam(s => s.hubDisplayName),
    hubAvatar = useJam(s => s.hubAvatar),
    hubAuthenticated = useJam(s => s.hubAuthenticated),
    consent = useApp(s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone);

  const [guestName, setGuestName] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (pending) {
      setGuestName(prev => prev || hubDisplayName || hubSubject || '');
      setCopied(false);
    }
  }, [pending?.raw, hubDisplayName, hubSubject]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        useJam.getState().closeInviteModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, busy]);

  if (!pending) return null;

  const close = () => {
    if (!busy) useJam.getState().closeInviteModal();
  };

  const result = pending.result;
  const preview = result?.preview ?? null;
  const badge = statusInfo(preview?.status, result?.errorCode);
  const shareUrl = preview
    ? buildJamInviteUrl(preview.code, preview.endpoint)
    : pending.raw;

  const handleJoin = async () => {
    if (!preview || !preview.canJoin || busy) return;
    const displayName = guestName.trim() || hubDisplayName || hubSubject || 'Ouvinte';
    const ok = await useJam
      .getState()
      .enter('join', displayName, preview.code, preview.endpoint, {
        avatar: hubAvatar || undefined,
      });
    if (ok) {
      useApp.getState().message(`Você entrou na JAM ${preview.roomName}.`);
      useApp.getState().setPage('settings');
      setTimeout(() => {
        document.getElementById('jam-section')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="jam-invite-modal-title"
        className="modal glass jam-invite-modal"
      >
        <IconButton
          label="Fechar convite"
          disabled={busy}
          className="modal-close"
          onClick={close}
        >
          <X size={16} />
        </IconButton>

        <div className="jam-modal-kicker">
          <Radio size={14} />
          <span>Convite de JAM</span>
          {!pending.loading && (
            <span className={`jam-status-pill ${badge.tone}`}>{badge.label}</span>
          )}
        </div>

        {pending.loading ? (
          <div className="jam-modal-loading" role="status">
            <LoaderCircle size={18} className="spinner" />
            <span>Buscando informações da JAM…</span>
          </div>
        ) : (
          <>
            {preview ? (
              <div className="jam-preview-card modal-variant">
                <div className="jam-preview-head">
                  <HostAvatar name={preview.hostName} avatar={preview.hostAvatar} size={46} />
                  <div className="jam-preview-meta">
                    <h2 id="jam-invite-modal-title">{preview.roomName}</h2>
                    <p>
                      Anfitrião: <strong>{preview.hostName}</strong>
                    </p>
                  </div>
                </div>
                <div className="jam-preview-stats">
                  <span>
                    <Users size={13} />
                    {preview.participantCount}/{preview.maxParticipants} participantes
                  </span>
                  <span>
                    <Headphones size={13} />
                    {preview.mode === 'lan' ? 'Rede local' : 'Online'}
                  </span>
                  {preview.requireAuth && (
                    <span>
                      <Lock size={13} />
                      Conta verificada
                    </span>
                  )}
                </div>
                {preview.currentTrack && (
                  <div className="jam-preview-track">
                    <Music2 size={14} />
                    <span>
                      <strong>{preview.currentTrack.title}</strong>
                      <small>{preview.currentTrack.artist}</small>
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="jam-modal-empty">
                <AlertCircle size={20} />
                <h2 id="jam-invite-modal-title">Convite indisponível</h2>
              </div>
            )}

            {(!result?.found || !preview?.canJoin) && (
              <p className="jam-error-banner" role="alert">
                {result?.error || preview?.reason || 'Não foi possível localizar esta JAM.'}
              </p>
            )}

            {preview?.requireAuth && !hubAuthenticated && preview.canJoin && (
              <div className="jam-auth-notice">
                <span>Esta sala exige autenticação no Liquid Hub.</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const targetInvite = pending.raw;
                    close();
                    useAccounts.getState().openAuthModal({
                      view: 'choose',
                      postAuthJamInvite: targetInvite,
                    });
                  }}
                >
                  Fazer login
                </button>
              </div>
            )}

            {!consent && (
              <div className="jam-auth-notice">
                <span>Ative o acesso online em Configurações → Integrações para participar.</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    close();
                    useApp.getState().setPage('settings');
                  }}
                >
                  Abrir configurações
                </button>
              </div>
            )}

            {preview?.canJoin && consent && (
              <form
                className="jam-modal-form"
                onSubmit={e => {
                  e.preventDefault();
                  void handleJoin();
                }}
              >
                <label className="field-label">
                  Seu nome na JAM
                  <input
                    className="input"
                    aria-label="Seu nome no convite da JAM"
                    maxLength={40}
                    placeholder={hubSubject || 'Ouvinte'}
                    value={guestName}
                    onChange={e => setGuestName(e.target.value)}
                    autoFocus
                  />
                </label>

                {error && (
                  <p className="jam-error" role="alert">
                    {error}
                  </p>
                )}

                <div className="modal-actions">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(shareUrl)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1800);
                        })
                        .catch(() => {})
                    }
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copiado' : 'Copiar link'}
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy}
                  >
                    {busy ? (
                      <>
                        <LoaderCircle size={14} className="spinner" />
                        Entrando…
                      </>
                    ) : (
                      'Entrar na JAM'
                    )}
                  </button>
                </div>
              </form>
            )}

            {(!preview?.canJoin || !consent) && (
              <div className="modal-actions">
                <button type="button" className="button secondary" onClick={close}>
                  Fechar
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
