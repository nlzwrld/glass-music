import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Headphones,
  LoaderCircle,
  Lock,
  LogOut,
  MessageCircle,
  Music2,
  Radio,
  RefreshCw,
  RotateCw,
  Search,
  Share2,
  Unlock,
  UserMinus,
  Users,
} from 'lucide-react';
import { canJam, type JamErrorCode, type JamRoomStatus } from '../../../shared/jam';
import {
  buildDiscordShareText,
  buildJamInviteUrl,
  buildWhatsAppShareUrl,
  parseJamInvite,
  shareNativeInvite,
} from '../../lib/jam';
import { useApp, cleanError } from '../../stores/app';
import { HostAvatar } from './JamInviteModal';
import { JamInteractivePanel } from './JamInteractivePanel';
import { useJam } from './state';
import './jam.css';

function previewStatusLabel(status?: JamRoomStatus, errorCode?: JamErrorCode) {
  if (status === 'active') return { label: 'Ao vivo', tone: 'live' };
  if (status === 'full') return { label: 'Lotada', tone: 'warn' };
  if (status === 'locked') return { label: 'Trancada', tone: 'warn' };
  if (status === 'ended' || errorCode === 'ROOM_ENDED') return { label: 'Encerrada', tone: 'ended' };
  if (status === 'expired' || errorCode === 'INVITE_EXPIRED')
    return { label: 'Expirada', tone: 'ended' };
  return { label: 'Indisponível', tone: 'ended' };
}

export function JamSettings() {
  const jam = useJam(),
    consent = useApp(s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone),
    current = useApp(s => s.queue[s.index]);
  const [name, setName] = useState(''),
    [roomName, setRoomName] = useState(''),
    [code, setCode] = useState(''),
    [endpoint, setEndpoint] = useState(''),
    [advanced, setAdvanced] = useState(false),
    [copied, setCopied] = useState<'link' | 'discord' | ''>(''),
    [saving, setSaving] = useState(false);

  useEffect(() => {
    void useJam.getState().refresh();
    if (consent) void useJam.getState().scanLan();
  }, [consent]);

  useEffect(() => {
    setEndpoint(jam.endpoint);
  }, [jam.endpoint]);

  // Automatic debounced invite code / link lookup whenever user types or pastes a valid code/link
  useEffect(() => {
    if (!consent || jam.session) return;
    const trimmed = code.trim();
    if (!trimmed) {
      jam.clearLookup();
      return;
    }
    const parsed = parseJamInvite(trimmed, jam.endpoint);
    if (!parsed.code) return;
    const timer = setTimeout(() => {
      void useJam.getState().lookupInvite(trimmed);
    }, 220);
    return () => clearTimeout(timer);
  }, [code, consent, jam.session, jam.endpoint]);

  const parsedInvite = parseJamInvite(code, jam.endpoint);
  const save = async () => {
    setSaving(true);
    try {
      await useApp
        .getState()
        .setPreferences({
          jamEndpoint: endpoint.trim(),
        } as Partial<ReturnType<typeof useApp.getState>['data']['preferences']>);
      await useJam.getState().refresh();
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setSaving(false);
    }
  };

  const activeSession = jam.session;
  const activeMembers = jam.room?.members || activeSession?.members || [];
  const activeRoomName = jam.room?.roomName || activeSession?.roomName || 'JAM';
  const activeLocked = Boolean(jam.room?.locked ?? activeSession?.locked);
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

  const handleLookupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    const res = await useJam.getState().lookupInvite(code);
    if (res?.found && res.preview?.canJoin && name.trim()) {
      // If user already typed their name and pressed Enter on a valid code, show preview (or join cleanly)
    }
  };

  const lookupResult = jam.lookupState.result;
  const lookupPreview = lookupResult?.preview ?? null;
  const lookupBadge = previewStatusLabel(lookupPreview?.status, lookupResult?.errorCode);

  return (
    <div className="jam-settings" id="jam-section" aria-label="JAM">
      <h2>JAM</h2>
      {!consent ? (
        <p className="fine-print">Ative o acesso online em Integrações para usar a JAM.</p>
      ) : activeSession ? (
        <>
          <div className="jam-session-head">
            <div>
              <h3>{activeRoomName}</h3>
              <div className="jam-status" role="status">
                <i data-connected={jam.connected} />
                {jam.connected ? 'Conectado' : 'Reconectando…'} ·{' '}
                {activeSession.host ? 'Anfitrião' : 'Ouvinte'}
                {activeSession.mode && (
                  <>
                    {' · '}
                    {activeSession.mode === 'lan-fallback'
                      ? 'LAN (Fallback)'
                      : activeSession.mode === 'lan'
                        ? 'Rede local'
                        : 'Cloud'}
                  </>
                )}
                {jam.realtimeConnected && ' · Tempo real'}
                {jam.rttMs > 0 && ` · ${jam.rttMs} ms`}
                {activeLocked && ' · Trancada'}
              </div>
            </div>
            <span className="jam-capacity-pill">
              <Users size={13} />
              {activeMembers.length}/{jam.room?.maxParticipants || 8}
            </span>
          </div>

          <div className="jam-room-code">
            <span>
              Código da sala<strong>{activeSession.code}</strong>
            </span>
            <button
              className="button secondary"
              aria-label="Copiar convite da JAM"
              onClick={() => copyText(activeInviteUrl, 'link', 'Link de convite copiado.')}
            >
              {copied === 'link' ? <Check size={15} /> : <Copy size={15} />}
              Copiar convite
            </button>
          </div>

          <input
            className="input jam-invite"
            aria-label="Convite desta JAM"
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
            <button type="button" className="button secondary" onClick={() => void handleNativeShare()}>
              <Share2 size={14} />
              Compartilhar
            </button>
          </div>

          <div className="jam-members" aria-label="Pessoas na JAM">
            {activeMembers.map(member => (
              <span
                key={member.id}
                className="jam-member"
                data-online={member.online !== false}
              >
                <Headphones size={14} />
                {member.name}
                {member.host && <small>Anfitrião</small>}
                {member.online === false && <small>Reconectando</small>}
                {activeSession.host && !member.host && (
                  <button
                    type="button"
                    className="jam-kick-btn"
                    title={`Remover ${member.name}`}
                    aria-label={`Remover ${member.name}`}
                    onClick={() => void jam.kick(member.id)}
                  >
                    <UserMinus size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>

          {activeSession.host && current && !canJam(current) && (
            <p className="fine-print">Selecione uma música online para sincronizar.</p>
          )}

          <JamInteractivePanel />

          <div className="jam-host-actions">
            {activeSession.host && (
              <>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void jam.updateRoom({ locked: !activeLocked })}
                >
                  {activeLocked ? <Unlock size={14} /> : <Lock size={14} />}
                  {activeLocked ? 'Destrancar entrada' : 'Trancar entrada'}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void jam.rotateInvite()}
                >
                  <RotateCw size={14} />
                  Novo convite
                </button>
              </>
            )}
            <button className="button secondary" onClick={() => void jam.leave()}>
              <LogOut size={15} />
              {activeSession.host ? 'Encerrar JAM' : 'Sair da JAM'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="jam-identity-grid">
            <label className="field-label">
              Seu nome
              <input
                className="input"
                aria-label="Seu nome na JAM"
                maxLength={40}
                placeholder={jam.hubSubject || 'Nome'}
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </label>
            <label className="field-label">
              Nome da JAM (opcional)
              <input
                className="input"
                aria-label="Nome da JAM"
                maxLength={60}
                placeholder="Ex.: Sessão da noite"
                value={roomName}
                onChange={e => setRoomName(e.target.value)}
              />
            </label>
          </div>

          <div className="jam-create">
            <button
              className="button primary"
              disabled={jam.busy || !name.trim()}
              onClick={() =>
                void jam.enter('createLocal', name, undefined, undefined, {
                  roomName: roomName.trim() || undefined,
                })
              }
            >
              <Radio size={15} />
              {jam.busy ? 'Conectando…' : 'Criar na rede local'}
            </button>
            {jam.configured && (
              <button
                className="button secondary"
                disabled={jam.busy || !name.trim()}
                onClick={() =>
                  void jam.enter('create', name, undefined, undefined, {
                    roomName: roomName.trim() || undefined,
                  })
                }
              >
                Criar online
              </button>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={jam.busy}
              onClick={() => void jam.scanLan()}
              title="Procurar salas ativas na rede local"
            >
              <RefreshCw size={14} />
              Buscar na LAN
            </button>
          </div>

          {jam.lanRooms.length > 0 && (
            <div className="jam-lan-section">
              <span className="jam-sublabel">Salas na rede local</span>
              <div className="jam-members" aria-label="Salas encontradas na rede local">
                {jam.lanRooms.map(r => (
                  <button
                    key={r.code}
                    type="button"
                    className="button secondary"
                    disabled={jam.busy}
                    onClick={() => {
                      setCode(r.code);
                      void useJam
                        .getState()
                        .lookupInvite(
                          r.endpoint ? `${r.endpoint}/jam/join/${r.code}` : r.code,
                        );
                    }}
                  >
                    <Radio size={14} />
                    {r.roomName || r.hostName} ({r.members}/{r.maxParticipants || 8}) · {r.code}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form className="jam-join" onSubmit={e => void handleLookupSubmit(e)}>
            <label className="field-label">
              Convite ou código
              <input
                className="input"
                aria-label="Convite da JAM"
                maxLength={2200}
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Cole o link (/jam/join/...) ou digite o código"
                value={code}
                onChange={e => setCode(e.target.value)}
              />
            </label>
            <button
              type="submit"
              className="button secondary"
              disabled={jam.busy || jam.lookupState.loading || !code.trim()}
            >
              {jam.lookupState.loading ? (
                <LoaderCircle size={15} className="spinner" />
              ) : (
                <Search size={15} />
              )}
              Buscar JAM
            </button>
          </form>

          {code.trim() && !parsedInvite.code && !jam.lookupState.loading && (
            <p className="fine-print">
              Digite um código de 6 a 16 caracteres ou cole um link de convite válido.
            </p>
          )}

          {jam.lookupState.loading && (
            <div className="jam-lookup-loading" role="status">
              <LoaderCircle size={15} className="spinner" />
              <span>Consultando JAM…</span>
            </div>
          )}

          {!jam.lookupState.loading && lookupResult && (
            <div className="jam-lookup-result">
              {lookupPreview && (
                <div className="jam-preview-card">
                  <div className="jam-preview-head">
                    <HostAvatar
                      name={lookupPreview.hostName}
                      avatar={lookupPreview.hostAvatar}
                      size={42}
                    />
                    <div className="jam-preview-meta">
                      <strong>{lookupPreview.roomName}</strong>
                      <small>
                        Anfitrião: {lookupPreview.hostName} · {lookupPreview.participantCount}/
                        {lookupPreview.maxParticipants} participantes
                      </small>
                    </div>
                    <span className={`jam-status-pill ${lookupBadge.tone}`}>
                      {lookupBadge.label}
                    </span>
                  </div>

                  {lookupPreview.currentTrack && (
                    <div className="jam-preview-track">
                      <Music2 size={14} />
                      <span>
                        <strong>{lookupPreview.currentTrack.title}</strong>
                        <small>{lookupPreview.currentTrack.artist}</small>
                      </span>
                    </div>
                  )}

                  {lookupPreview.canJoin && (
                    <div className="jam-preview-actions">
                      <button
                        type="button"
                        className="button primary"
                        disabled={jam.busy}
                        onClick={() =>
                          void jam.enter(
                            'join',
                            name.trim() || jam.hubSubject || 'Ouvinte',
                            lookupPreview.code,
                            lookupPreview.endpoint,
                          )
                        }
                      >
                        <Users size={15} />
                        {jam.busy ? 'Entrando…' : 'Entrar na JAM'}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() =>
                          copyText(
                            buildJamInviteUrl(lookupPreview.code, lookupPreview.endpoint),
                            'link',
                            'Link de convite copiado.',
                          )
                        }
                      >
                        <Copy size={14} />
                        Copiar link
                      </button>
                    </div>
                  )}
                </div>
              )}

              {(!lookupResult.found || !lookupPreview?.canJoin) && (
                <p className="jam-error-banner" role="alert">
                  {lookupResult.error ||
                    lookupPreview?.reason ||
                    'Não foi possível entrar nesta JAM.'}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {jam.error && (
        <p className="jam-error" role="alert">
          {jam.error}
        </p>
      )}

      {!activeSession && (
        <details
          className="jam-service"
          open={advanced}
          onToggle={e => setAdvanced(e.currentTarget.open)}
        >
          <summary>Servidor da JAM</summary>
          <label className="field-label">
            Endereço
            <input
              className="input"
              aria-label="Servidor da JAM"
              type="url"
              value={endpoint}
              maxLength={2048}
              placeholder="https://jam.exemplo.com"
              onChange={e => setEndpoint(e.target.value)}
            />
          </label>
          <button className="button secondary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Salvando…' : 'Salvar servidor'}
          </button>
        </details>
      )}
    </div>
  );
}
