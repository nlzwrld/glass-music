import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  LoaderCircle,
  MessageCircle,
  Radio,
  Share2,
} from 'lucide-react';
import {
  buildDiscordShareText,
  buildJamInviteUrl,
  buildWhatsAppShareUrl,
  shareNativeInvite,
} from '../../lib/jam';
import { openJamWindow } from '../../lib/jamWindow';
import { useAccounts } from '../../stores/accounts';
import { cleanError, useApp } from '../../stores/app';
import { Input } from '../ui/input';
import { useJam } from './state';
import './jam.css';

export function resolveJamHostIdentity() {
  const hub = useAccounts.getState().hub;
  const identities = hub.identities || [];
  const preferred =
    identities.find(i => i.provider === 'google') ||
    identities.find(i => i.provider === 'discord') ||
    identities.find(i => i.provider === 'github') ||
    null;
  const name = (
    hub.displayName ||
    preferred?.displayName ||
    preferred?.username ||
    hub.username ||
    hub.subject ||
    'Ouvinte'
  )
    .trim()
    .slice(0, 40);
  const providerLabel =
    preferred?.provider === 'google'
      ? 'Google'
      : preferred?.provider === 'discord'
        ? 'Discord'
        : preferred?.provider === 'github'
          ? 'GitHub'
          : null;
  const avatar = hub.avatarUrl || preferred?.avatarUrl || undefined;
  return { name: name || 'Ouvinte', providerLabel, avatar };
}

export function CreateJamDialog({ onClose }: { onClose: () => void }) {
  const jam = useJam();
  const hub = useAccounts(s => s.hub);
  const consent = useApp(
    s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone,
  );
  const [roomName, setRoomName] = useState('');
  const [copied, setCopied] = useState<'link' | 'discord' | ''>('');
  const [localError, setLocalError] = useState('');
  const isAuthenticated = Boolean(hub.authenticated && !hub.needsTermsAcceptance);

  useEffect(() => {
    void useJam.getState().refresh();
  }, []);

  const host = resolveJamHostIdentity();
  const activeSession = jam.session;
  const activeRoomName = jam.room?.roomName || activeSession?.roomName || roomName.trim() || 'JAM';
  const activeInviteUrl = activeSession
    ? buildJamInviteUrl(activeSession.code, activeSession.endpoint || jam.endpoint)
    : '';

  const copyText = (text: string, kind: 'link' | 'discord', feedback: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(kind);
        useApp.getState().message(feedback);
        setTimeout(() => setCopied(prev => (prev === kind ? '' : prev)), 1800);
      })
      .catch(() => useApp.getState().message('Não foi possível copiar o convite.'));
  };

  const handleNativeShare = async () => {
    if (!activeSession) return;
    try {
      const outcome = await shareNativeInvite({
        roomName: activeRoomName,
        inviteUrl: activeInviteUrl,
        code: activeSession.code,
      });
      if (outcome === 'copied') {
        setCopied('link');
        useApp.getState().message('Link da JAM copiado para compartilhar.');
        setTimeout(() => setCopied(''), 1800);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      useApp.getState().message('Não foi possível abrir o compartilhamento.');
    }
  };

  if (activeSession) {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Radio size={18} style={{ color: 'var(--m-accent, var(--accent, #52b79a))' }} />
          <h2 id="dialog-title" style={{ margin: 0 }}>
            {activeRoomName}
          </h2>
        </div>

        <p className="subtle" style={{ margin: 0 }}>
          JAM ao vivo como <strong>{host.name}</strong> · Código{' '}
          <strong>{activeSession.code}</strong>. Envie o link abaixo para convidar um amigo.
        </p>

        <div className="jam-room-code">
          <span>
            Código da sala<strong>{activeSession.code}</strong>
          </span>
          <button
            type="button"
            className="button primary"
            aria-label="Copiar link de convite da JAM"
            onClick={() => copyText(activeInviteUrl, 'link', 'Link de convite copiado.')}
          >
            {copied === 'link' ? <Check size={15} /> : <Copy size={15} />}
            {copied === 'link' ? 'Link copiado' : 'Copiar link'}
          </button>
        </div>

        <input
          className="input jam-invite"
          aria-label="Link de convite da JAM"
          readOnly
          value={activeInviteUrl}
          onFocus={e => e.currentTarget.select()}
        />

        <div className="jam-share-bar" aria-label="Compartilhar convite">
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              void window.glass
                .external(
                  buildWhatsAppShareUrl(activeRoomName, activeInviteUrl, activeSession.code),
                )
                .catch(e => useApp.getState().message(cleanError(e)))
            }
          >
            <MessageCircle size={14} />
            WhatsApp
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              copyText(
                buildDiscordShareText(activeRoomName, activeInviteUrl, activeSession.code),
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
            onClick={() => void handleNativeShare()}
          >
            <Share2 size={14} />
            Compartilhar
          </button>
        </div>

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Fechar
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              void openJamWindow();
              onClose();
            }}
          >
            <Radio size={14} />
            Abrir janela da JAM
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={async e => {
        e.preventDefault();
        const trimmedRoom = roomName.trim();
        if (!trimmedRoom) return;
        setLocalError('');
        if (!isAuthenticated) {
          setLocalError('Entre em uma conta Liquid Hub para criar uma JAM.');
          return;
        }
        if (!consent) {
          setLocalError('Ative o acesso online em Configurações para criar uma JAM.');
          return;
        }
        const ok = await useJam.getState().enter('create', host.name, undefined, undefined, {
          roomName: trimmedRoom,
          avatar: host.avatar,
          requireApproval: true,
        });
        if (ok) {
          useApp.getState().message('JAM criada! Copie o link para convidar seus amigos.');
        }
      }}
    >
      <h2 id="dialog-title">Nova JAM</h2>
      <p className="subtle" style={{ marginTop: 0 }}>
        Anfitrião: <strong>{host.name}</strong>
        {host.providerLabel ? ` (${host.providerLabel})` : ''}
      </p>

      {!isAuthenticated && (
        <div className="jam-auth-notice">
          <span>Apenas usuários autenticados podem criar uma JAM.</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              onClose();
              useAccounts.getState().openAuthModal({ view: 'choose' });
            }}
          >
            Fazer login
          </button>
        </div>
      )}

      <label className="field-label">
        Nome da JAM
        <Input
          autoFocus
          aria-label="Nome da JAM"
          value={roomName}
          maxLength={60}
          onChange={e => setRoomName(e.target.value)}
          placeholder={`Ex: JAM de ${host.name}`}
          required
        />
      </label>

      {(localError || jam.error) && (
        <p className="form-error" role="alert">
          {localError || jam.error}
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={jam.busy} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="submit"
          className="button primary"
          disabled={jam.busy || !roomName.trim() || !isAuthenticated}
        >
          {jam.busy ? (
            <>
              <LoaderCircle size={14} className="spinner" />
              Criando JAM…
            </>
          ) : (
            'Criar JAM'
          )}
        </button>
      </div>
    </form>
  );
}
