import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Link2,
  LoaderCircle,
  LogOut,
  Mail,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { oauthProviderLabel, useAccounts } from '../../stores/accounts';
import { useApp } from '../../stores/app';
import { DiscordIcon, GitHubIcon, GoogleIcon } from '../auth/ProviderIcons';
import '../auth/auth.css';

const names = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };

export default function AccountConnections() {
  const {
    accounts,
    hub,
    oauthPending,
    preferredBrokerUrl,
    busy,
    notice,
    refresh,
    configure,
    connect,
    sync,
    disconnect,
    cancel,
    loginHub,
    oauthHub,
    cancelHubOAuth,
    linkEmail,
    unlinkIdentity,
    resendVerification,
    updateProfile,
    logoutHub,
    openAuthModal,
    setPreferredBrokerUrl,
  } = useAccounts();
  const p = useApp(s => s.data.preferences),
    online = p.onlineConsent && p.catalogConsent && p.onboardingDone;

  const [brokerUrl, setBrokerUrl] = useState(preferredBrokerUrl || hub.brokerUrl || ''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [registerMode, setRegisterMode] = useState(false),
    [linkEmailOpen, setLinkEmailOpen] = useState(false),
    [newEmail, setNewEmail] = useState(''),
    [newEmailPassword, setNewEmailPassword] = useState(''),
    [nicknameInput, setNicknameInput] = useState(hub.displayName || hub.subject || '');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setNicknameInput(hub.displayName || hub.subject || '');
  }, [hub.displayName, hub.subject]);

  useEffect(() => {
    const next = hub.brokerUrl || preferredBrokerUrl;
    if (next && !brokerUrl) setBrokerUrl(next);
  }, [hub.brokerUrl, preferredBrokerUrl]);

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

      <div id="hub-account-section" style={{ display: 'grid', gap: 12, marginTop: 8 }}>
        <h3>Conta unificada do Liquid Hub</h3>

        {hub.authenticated ? (
          (() => {
            const identities = hub.identities || [];
            const googleId = identities.find(i => i.provider === 'google');
            const discordId = identities.find(i => i.provider === 'discord');
            const githubId = identities.find(i => i.provider === 'github');
            const emailId = identities.find(i => i.provider === 'email');
            const methodCount =
              (hub.hasPassword ? 1 : 0) + identities.filter(i => i.provider !== 'email').length;
            const activeBroker = brokerUrl.trim() || hub.brokerUrl || undefined;
            return (
              <div className="hub-profile-card">
                <div className="hub-profile-head">
                  <div className="hub-profile-user">
                    <div className="hub-avatar" aria-hidden="true">
                      {hub.avatarUrl ? (
                        <img src={hub.avatarUrl} alt="" />
                      ) : (
                        (hub.displayName || hub.subject || 'L').charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="hub-profile-meta">
                      <strong>{hub.displayName || hub.subject}</strong>
                      <small>
                        @{hub.username || hub.subject} · Cofre DPAPI ativo · {hub.brokerUrl}
                      </small>
                      <div className="hub-badge-row">
                        {hub.email && (
                          <span className={`hub-badge ${hub.emailVerified ? '' : 'warn'}`}>
                            {hub.emailVerified ? (
                              <CheckCircle2 size={11} />
                            ) : (
                              <ShieldAlert size={11} />
                            )}
                            {hub.email} ({hub.emailVerified ? 'Verificado' : 'Não verificado'})
                          </span>
                        )}
                        {hub.termsVersion && (
                          <span
                            className="hub-badge"
                            title={
                              hub.termsAcceptedAt
                                ? `Aceito em ${new Date(hub.termsAcceptedAt).toLocaleString()}`
                                : undefined
                            }
                          >
                            <ShieldCheck size={11} />
                            Termos v. {hub.termsVersion}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
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

                <form
                  className="hub-nickname-form"
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
                  onSubmit={e => {
                    e.preventDefault();
                    void updateProfile(nicknameInput, activeBroker);
                  }}
                >
                  <label className="field-label" style={{ flex: 1, minWidth: 180 }}>
                    Nickname (usado no Google, Discord, GitHub e JAM)
                    <input
                      type="text"
                      className="input"
                      maxLength={80}
                      placeholder="Seu nickname no Liquid Hub"
                      value={nicknameInput}
                      onChange={e => setNicknameInput(e.target.value)}
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    className="button secondary"
                    disabled={
                      !!busy ||
                      !nicknameInput.trim() ||
                      nicknameInput.trim() === (hub.displayName || hub.subject || '').trim()
                    }
                  >
                    {busy === 'hub:profile' ? 'Salvando…' : 'Salvar nickname'}
                  </button>
                </form>

                {hub.email && !hub.emailVerified && (
                  <div className="settings-actions-row">
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => openAuthModal({ view: 'verify', brokerUrl: activeBroker })}
                    >
                      Verificar e-mail com código
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => void resendVerification(undefined, activeBroker)}
                    >
                      Reenviar verificação
                    </button>
                  </div>
                )}

                {hub.needsTermsAcceptance && (
                  <div className="settings-actions-row">
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => openAuthModal({ view: 'terms', brokerUrl: activeBroker })}
                    >
                      Confirmar Termos e Privacidade
                    </button>
                  </div>
                )}

                <div className="hub-identities-list" aria-label="Identidades vinculadas">
                  <div className="hub-identity-row" data-hub-provider="google">
                    <div className="hub-identity-info">
                      <GoogleIcon size={17} />
                      <div>
                        <strong>Google</strong>
                        <small>
                          {googleId
                            ? `${googleId.displayName || googleId.username || googleId.providerSubject}${googleId.email ? ` · ${googleId.email}` : ''}`
                            : 'Não vinculado'}
                        </small>
                      </div>
                    </div>
                    {googleId ? (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || methodCount <= 1}
                        title={
                          methodCount <= 1
                            ? 'Adicione outro método de login antes de desvincular.'
                            : 'Desvincular Google'
                        }
                        onClick={() => void unlinkIdentity('google', activeBroker)}
                      >
                        Desvincular
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || !online}
                        onClick={() => void oauthHub('google', 'link', activeBroker)}
                      >
                        Vincular Google
                      </button>
                    )}
                  </div>

                  <div className="hub-identity-row" data-hub-provider="discord">
                    <div className="hub-identity-info">
                      <DiscordIcon size={17} />
                      <div>
                        <strong>Discord</strong>
                        <small>
                          {discordId
                            ? `${discordId.displayName || discordId.username || discordId.providerSubject}${discordId.email ? ` · ${discordId.email}` : ' · Sem e-mail público'}`
                            : 'Não vinculado'}
                        </small>
                      </div>
                    </div>
                    {discordId ? (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || methodCount <= 1}
                        title={
                          methodCount <= 1
                            ? 'Adicione outro método de login antes de desvincular.'
                            : 'Desvincular Discord'
                        }
                        onClick={() => void unlinkIdentity('discord', activeBroker)}
                      >
                        Desvincular
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || !online}
                        onClick={() => void oauthHub('discord', 'link', activeBroker)}
                      >
                        Vincular Discord
                      </button>
                    )}
                  </div>

                  <div className="hub-identity-row" data-hub-provider="github">
                    <div className="hub-identity-info">
                      <GitHubIcon size={17} />
                      <div>
                        <strong>GitHub</strong>
                        <small>
                          {githubId
                            ? `${githubId.displayName || githubId.username || githubId.providerSubject}${githubId.email ? ` · ${githubId.email}` : ' · E-mail privado'}`
                            : 'Não vinculado'}
                        </small>
                      </div>
                    </div>
                    {githubId ? (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || methodCount <= 1}
                        title={
                          methodCount <= 1
                            ? 'Adicione outro método de login antes de desvincular.'
                            : 'Desvincular GitHub'
                        }
                        onClick={() => void unlinkIdentity('github', activeBroker)}
                      >
                        Desvincular
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || !online}
                        onClick={() => void oauthHub('github', 'link', activeBroker)}
                      >
                        Vincular GitHub
                      </button>
                    )}
                  </div>

                  <div className="hub-identity-row" data-hub-provider="email">
                    <div className="hub-identity-info">
                      <Mail size={16} />
                      <div>
                        <strong>E-mail e senha</strong>
                        <small>
                          {hub.hasPassword
                            ? emailId?.email || hub.email || hub.username
                            : 'Nenhuma senha vinculada'}
                        </small>
                      </div>
                    </div>
                    {hub.hasPassword ? (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || methodCount <= 1}
                        title={
                          methodCount <= 1
                            ? 'Adicione outro método de login antes de remover o acesso por e-mail.'
                            : 'Remover login por e-mail'
                        }
                        onClick={() => void unlinkIdentity('email', activeBroker)}
                      >
                        Desvincular
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy || !online}
                        onClick={() => setLinkEmailOpen(v => !v)}
                      >
                        {linkEmailOpen ? 'Fechar' : 'Vincular e-mail'}
                      </button>
                    )}
                  </div>
                </div>

                {linkEmailOpen && !hub.hasPassword && (
                  <form
                    className="auth-form"
                    onSubmit={e => {
                      e.preventDefault();
                      void linkEmail({
                        brokerUrl: activeBroker,
                        email: newEmail.trim(),
                        password: newEmailPassword,
                      }).then(ok => {
                        if (ok) {
                          setLinkEmailOpen(false);
                          setNewEmailPassword('');
                        }
                      });
                    }}
                  >
                    <label className="field-label">
                      E-mail para vincular
                      <input
                        type="email"
                        className="input"
                        value={newEmail}
                        onChange={e => setNewEmail(e.target.value)}
                        required
                      />
                    </label>
                    <label className="field-label">
                      Senha (mínimo 12 caracteres)
                      <input
                        type="password"
                        className="input"
                        minLength={12}
                        maxLength={256}
                        value={newEmailPassword}
                        onChange={e => setNewEmailPassword(e.target.value)}
                        required
                      />
                    </label>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={!!busy || !newEmail.trim() || newEmailPassword.length < 12}
                    >
                      Salvar acesso por e-mail
                    </button>
                  </form>
                )}
              </div>
            );
          })()
        ) : (
          <div className="hub-profile-card">
            <p className="fine-print">
              Entre com Google, Discord, GitHub ou e-mail para manter um único perfil verificado no Liquid Hub.
            </p>
            <div className="settings-actions-row">
              <button
                type="button"
                className="button primary"
                disabled={!!busy}
                onClick={() =>
                  openAuthModal({ view: 'choose', brokerUrl: brokerUrl.trim() || undefined })
                }
              >
                <ShieldCheck size={15} />
                Entrar no Liquid Hub
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !online}
                onClick={() => void oauthHub('google', 'login', brokerUrl.trim() || undefined)}
              >
                <GoogleIcon size={16} />
                Continuar com Google
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !online}
                onClick={() => void oauthHub('discord', 'login', brokerUrl.trim() || undefined)}
              >
                <DiscordIcon size={16} />
                Continuar com Discord
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !online}
                onClick={() => void oauthHub('github', 'login', brokerUrl.trim() || undefined)}
              >
                <GitHubIcon size={16} />
                Continuar com GitHub
              </button>
            </div>
            {oauthPending && (
              <div className="settings-actions-row">
                <span className="fine-print">
                  Aguardando retorno do {oauthProviderLabel(oauthPending)}…
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void cancelHubOAuth()}
                >
                  Cancelar autenticação
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <details className="account-setup">
        <summary>Sessão Liquid Hub (Zero-Trust)</summary>
        {hub.authenticated ? (
          <div className="setting-row">
            <span>
              <strong>
                <ShieldCheck size={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />
                {hub.displayName || hub.subject}
              </strong>
              <small>
                ID {hub.userId || hub.subject} · Sessão cifrada localmente
              </small>
            </span>
          </div>
        ) : (
          <form
            className="hub-auth-form"
            onSubmit={e => {
              e.preventDefault();
              void loginHub({ brokerUrl, username, password, register: registerMode }).then(ok => {
                if (ok) setPassword('');
              });
            }}
          >
            <label className="field-label">
              Servidor HTTPS (ou loopback)
              <input
                type="url"
                placeholder="https://hub.exemplo.com"
                value={brokerUrl}
                onChange={e => {
                  setBrokerUrl(e.target.value);
                  setPreferredBrokerUrl(e.target.value);
                }}
                required
              />
            </label>
            <label className="field-label">
              E-mail ou usuário
              <input
                type="text"
                autoComplete="username"
                minLength={3}
                maxLength={160}
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
