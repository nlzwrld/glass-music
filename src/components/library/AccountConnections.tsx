import { useEffect, useState } from 'react';
import { Link2, RefreshCw, Unplug, LoaderCircle, ShieldCheck, LogOut } from 'lucide-react';
import { useApp } from '../../stores/app';
import { useAccounts } from '../../stores/accounts';

const names = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };

export default function AccountConnections() {
  const {
    accounts,
    hub,
    busy,
    notice,
    refresh,
    configure,
    connect,
    sync,
    disconnect,
    cancel,
    loginHub,
    logoutHub,
  } = useAccounts();
  const p = useApp(s => s.data.preferences),
    online = p.onlineConsent && p.catalogConsent && p.onboardingDone;

  const [brokerUrl, setBrokerUrl] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [registerMode, setRegisterMode] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (hub.brokerUrl && !brokerUrl) setBrokerUrl(hub.brokerUrl);
  }, [hub.brokerUrl]);

  return (
    <section className="settings-section account-connections">
      <h2>Contas</h2>
      {accounts.map(a => (
        <div className="setting-row account-row" key={a.provider} data-provider={a.provider}>
          <div>
            <strong>{names[a.provider]}</strong>
            <small>
              {a.connected
                ? a.name || 'Conectada'
                : a.configured
                  ? 'Desconectada'
                  : 'Indisponível'}
            </small>
            {a.lastSync > 0 && (
              <small>Atualizada em {new Date(a.lastSync).toLocaleString()}</small>
            )}
          </div>
          <div className="account-actions">
            {a.connected ? (
              <>
                <button
                  className="button secondary"
                  aria-label={`Sincronizar ${names[a.provider]}`}
                  disabled={!!busy || !online}
                  onClick={() => void sync(a.provider)}
                >
                  <RefreshCw size={14} />
                  Sincronizar
                </button>
                <button
                  className="icon-button"
                  aria-label={`Desconectar ${names[a.provider]}`}
                  title="Desconectar"
                  disabled={!!busy}
                  onClick={() => void disconnect(a.provider)}
                >
                  <Unplug size={15} />
                </button>
              </>
            ) : (
              <button
                className="button secondary"
                aria-label={`Conectar ${names[a.provider]}`}
                disabled={!!busy || !online || !a.configured}
                title={!a.configured ? a.reason : undefined}
                onClick={() => void connect(a.provider)}
              >
                <Link2 size={14} />
                Conectar
              </button>
            )}
          </div>
        </div>
      ))}
      {!online && <p className="fine-print">Ative o acesso online para conectar.</p>}
      {notice && (
        <p className="account-notice" role="status">
          {busy && <LoaderCircle size={14} className="spinner" />}
          {notice}
        </p>
      )}
      {(busy.startsWith('connect:') || busy.startsWith('sync:')) && (
        <button className="text-button" onClick={() => void cancel()}>
          Cancelar
        </button>
      )}

      <details className="account-setup">
        <summary>Sessão Liquid Hub (Zero-Trust)</summary>
        {hub.authenticated ? (
          <div className="setting-row">
            <span>
              <strong>
                <ShieldCheck size={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />
                {hub.subject}
              </strong>
              <small>Cofre DPAPI ativo · {hub.brokerUrl}</small>
            </span>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => void logoutHub()}
            >
              <LogOut size={14} />
              Encerrar sessão
            </button>
          </div>
        ) : (
          <form
            className="hub-auth-form"
            onSubmit={e => {
              e.preventDefault();
              void loginHub({ brokerUrl, username, password, register: registerMode }).then(() =>
                setPassword(''),
              );
            }}
          >
            <label className="field-label">
              Servidor HTTPS (ou loopback)
              <input
                type="url"
                placeholder="https://hub.exemplo.com"
                value={brokerUrl}
                onChange={e => setBrokerUrl(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Usuário
              <input
                type="text"
                autoComplete="username"
                minLength={3}
                maxLength={80}
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Senha (mínimo 12 caracteres · Argon2id)
              <input
                type="password"
                autoComplete={registerMode ? 'new-password' : 'current-password'}
                minLength={12}
                maxLength={256}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </label>
            <div className="settings-actions-row">
              <button
                type="submit"
                className="button primary"
                disabled={!!busy || !online || !brokerUrl.trim() || password.length < 12}
              >
                {registerMode ? 'Criar conta segura' : 'Entrar com PKCE'}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setRegisterMode(v => !v)}
              >
                {registerMode ? 'Já tenho conta' : 'Registrar nova conta'}
              </button>
            </div>
          </form>
        )}
      </details>

      <details className="account-setup">
        <summary>Cadastro OAuth</summary>
        <p className="fine-print">
          Playlists públicas podem ser importadas diretamente por link sem conectar conta.
        </p>
        <button className="text-button" disabled={!!busy} onClick={() => void configure()}>
          Carregar arquivo JSON…
        </button>
      </details>
    </section>
  );
}
