import { useEffect, useState } from 'react';
import { Check, Copy, Headphones, LogOut, Radio, RefreshCw, Users } from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import { canJam } from '../../../shared/jam';
import { useJam } from './state';
import { parseJamInvite } from '../../lib/jam';
import './jam.css';

export function JamSettings() {
  const jam = useJam(),
    consent = useApp(s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone),
    current = useApp(s => s.queue[s.index]);
  const [name, setName] = useState(''),
    [code, setCode] = useState(''),
    [endpoint, setEndpoint] = useState(''),
    [advanced, setAdvanced] = useState(false),
    [copied, setCopied] = useState(false),
    [saving, setSaving] = useState(false);

  useEffect(() => {
    void useJam.getState().refresh();
    if (consent) void useJam.getState().scanLan();
  }, [consent]);

  useEffect(() => {
    setEndpoint(jam.endpoint);
  }, [jam.endpoint]);

  const invite = parseJamInvite(code, jam.endpoint);
  const join = async () => {
    if (!name.trim()) {
      useJam.setState({ error: 'Digite seu nome para entrar na JAM.' });
      return;
    }
    if (!invite.code) {
      useJam.setState({ error: 'Cole um convite válido ou digite o código de 10 caracteres.' });
      return;
    }
    // A bare room code can refer to a LAN room, even when an online server is configured.
    let target = invite.endpoint;
    if (/^[A-F0-9]{10}$/i.test(code.trim())) {
      await jam.scanLan();
      target = useJam.getState().lanRooms.find(room => room.code === invite.code)?.endpoint || target;
    }
    if (!target) {
      useJam.setState({ error: 'Sala não encontrada. Cole o convite completo ou configure o servidor da JAM.' });
      return;
    }
    await jam.enter('join', name.trim(), invite.code, target);
  };
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

  return (
    <div className="jam-settings" id="jam-section" aria-label="JAM">
      <h2>JAM</h2>
      {!consent ? (
        <p className="fine-print">Ative o acesso online em Integrações para usar a JAM.</p>
      ) : jam.session ? (
        <>
          <div className="jam-room-code">
            <span>
              Código da sala<strong>{jam.session.code}</strong>
            </span>
            <button
              className="button secondary"
              aria-label="Copiar convite da JAM"
              onClick={() =>
                void navigator.clipboard
                  .writeText(`${jam.session!.endpoint || jam.endpoint}/#jam=${jam.session!.code}`)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  })
                  .catch(() => useApp.getState().message('Não foi possível copiar o convite.'))
              }
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              Copiar convite
            </button>
          </div>
          <input
            className="input jam-invite"
            aria-label="Convite desta JAM"
            readOnly
            value={`${jam.session.endpoint || jam.endpoint}/#jam=${jam.session.code}`}
            onFocus={e => e.currentTarget.select()}
          />
          <div className="jam-status" role="status">
            <i data-connected={jam.connected} />
            {jam.connected ? 'Conectado' : 'Reconectando…'} ·{' '}
            {jam.session.host ? 'Anfitrião' : 'Ouvinte'}
            {jam.session.mode && (
              <>
                {' · '}
                {jam.session.mode === 'lan-fallback'
                  ? 'LAN (Fallback)'
                  : jam.session.mode === 'lan'
                    ? 'Rede local'
                    : 'Cloud'}
              </>
            )}
            {jam.rttMs > 0 && ` · ${jam.rttMs} ms`}
          </div>
          <div className="jam-members" aria-label="Pessoas na JAM">
            {jam.room?.members.map(member => (
              <span key={member.id}>
                <Headphones size={14} />
                {member.name}
                {member.host && <small>Anfitrião</small>}
              </span>
            ))}
          </div>
          {jam.session.host && current && !canJam(current) && (
            <p className="fine-print">Selecione uma música online para sincronizar.</p>
          )}
          <button className="button secondary" onClick={() => void jam.leave()}>
            <LogOut size={15} />
            {jam.session.host ? 'Encerrar JAM' : 'Sair da JAM'}
          </button>
        </>
      ) : (
        <>
          <label className="field-label">
            Seu nome
            <input
              className="input"
              aria-label="Seu nome na JAM"
              maxLength={40}
              placeholder="Nome"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </label>
          <div className="jam-create">
            <button
              className="button primary"
              disabled={jam.busy || !name.trim()}
              onClick={() => void jam.enter('createLocal', name)}
            >
              <Radio size={15} />
              {jam.busy ? 'Conectando…' : 'Criar na rede local'}
            </button>
            {jam.configured && (
              <button
                className="button secondary"
                disabled={jam.busy || !name.trim()}
                onClick={() => void jam.enter('create', name)}
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
            <div className="jam-members" aria-label="Salas encontradas na rede local">
              {jam.lanRooms.map(r => (
                <button
                  key={r.code}
                  type="button"
                  className="button secondary"
                  disabled={jam.busy || !name.trim()}
                  onClick={() => void jam.enter('join', name, r.code, r.endpoint)}
                >
                  <Radio size={14} />
                  {r.hostName} ({r.members}/8) · {r.code.slice(0, 6)}
                </button>
              ))}
            </div>
          )}
          <div
            className="jam-join"
          >
            <label className="field-label">
              Convite ou código
              <input
                className="input"
                aria-label="Convite da JAM"
                maxLength={2200}
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Cole o convite"
                value={code}
                onChange={e => setCode(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void join();
                }}
              />
            </label>
            <button
              className="button secondary"
              type="button"
              disabled={jam.busy}
              onClick={() => void join()}
            >
              <Users size={15} />
              Entrar
            </button>
          </div>
        </>
      )}
      {jam.error && (
        <p className="jam-error" role="alert">
          {jam.error}
        </p>
      )}
      {!jam.session && (
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
