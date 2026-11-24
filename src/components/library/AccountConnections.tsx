import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Link2,
  LoaderCircle,
  LogOut,
  Mail,
  Pencil,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unplug,
  UserRound,
} from 'lucide-react';
import type { ProfileVisibility, SocialLinks } from '../../../shared/types';
import { oauthProviderLabel, resolveEffectiveBroker, useAccounts } from '../../stores/accounts';
import { setPreferencesFromUI, useApp } from '../../stores/app';
import { PlatformIcon, Toggle } from '../glass/controls';
import { DiscordIcon, GitHubIcon, GoogleIcon } from '../auth/ProviderIcons';
import '../auth/auth.css';

const names = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' } as const;

export default function AccountConnections() {
  const accounts = useAccounts(s => s.accounts),
    hub = useAccounts(s => s.hub),
    oauthPending = useAccounts(s => s.oauthPending),
    preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl),
    busy = useAccounts(s => s.busy),
    notice = useAccounts(s => s.notice),
    refresh = useAccounts(s => s.refresh),
    connect = useAccounts(s => s.connect),
    sync = useAccounts(s => s.sync),
    disconnect = useAccounts(s => s.disconnect),
    cancel = useAccounts(s => s.cancel),
    oauthHub = useAccounts(s => s.oauthHub),
    cancelHubOAuth = useAccounts(s => s.cancelHubOAuth),
    linkEmail = useAccounts(s => s.linkEmail),
    unlinkIdentity = useAccounts(s => s.unlinkIdentity),
    resendVerification = useAccounts(s => s.resendVerification),
    updateProfile = useAccounts(s => s.updateProfile),
    logoutHub = useAccounts(s => s.logoutHub),
    openAuthModal = useAccounts(s => s.openAuthModal);

  const p = useApp(s => s.data.preferences),
    online = p.onlineConsent && p.catalogConsent && p.onboardingDone;

  const [brokerUrl, setBrokerUrl] = useState(preferredBrokerUrl || hub.brokerUrl || ''),
    [editProfileOpen, setEditProfileOpen] = useState(false),
    [identitiesOpen, setIdentitiesOpen] = useState(false),
    [platformsOpen, setPlatformsOpen] = useState(false),
    [linkEmailOpen, setLinkEmailOpen] = useState(false),
    [newEmail, setNewEmail] = useState(''),
    [newEmailPassword, setNewEmailPassword] = useState(''),
    [nicknameInput, setNicknameInput] = useState(hub.displayName || hub.subject || ''),
    [handleInput, setHandleInput] = useState(hub.publicHandle || ''),
    [bioInput, setBioInput] = useState(hub.bio || ''),
    [visibilityInput, setVisibilityInput] = useState<ProfileVisibility>(
      hub.profileVisibility || 'public',
    ),
    [showPublicTracksInput, setShowPublicTracksInput] = useState(Boolean(hub.showPublicTracks)),
    [socialLinksInput, setSocialLinksInput] = useState<SocialLinks>(hub.socialLinks || {}),
    [socialLinksExpanded, setSocialLinksExpanded] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setNicknameInput(hub.displayName || hub.subject || '');
    setHandleInput(hub.publicHandle || '');
    setBioInput(hub.bio || '');
    setVisibilityInput(hub.profileVisibility || 'public');
    setShowPublicTracksInput(Boolean(hub.showPublicTracks));
    setSocialLinksInput(hub.socialLinks || {});
  }, [
    hub.displayName,
    hub.subject,
    hub.publicHandle,
    hub.bio,
    hub.profileVisibility,
    hub.showPublicTracks,
    hub.socialLinks,
  ]);

  useEffect(() => {
    const next = hub.brokerUrl || preferredBrokerUrl;
    if (next && !brokerUrl) setBrokerUrl(next);
  }, [hub.brokerUrl, preferredBrokerUrl, brokerUrl]);

  const connectedPlatforms = accounts.filter(a => a.connected);
  const connectedPlatformsSummary =
    connectedPlatforms.length > 0
      ? connectedPlatforms.map(a => names[a.provider]).join(', ')
      : 'YouTube, SoundCloud e Spotify';

  return (
    <section className="settings-section account-connections">
      <h2>Conta</h2>
      <Toggle
        label="Acesso online"
        checked={p.onlineConsent}
        onChange={v => setPreferencesFromUI({ onlineConsent: v, catalogConsent: v })}
      />

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

          const linkedLabels: string[] = [];
          if (googleId) linkedLabels.push('Google');
          if (discordId) linkedLabels.push('Discord');
          if (githubId) linkedLabels.push('GitHub');
          if (hub.hasPassword) linkedLabels.push('E-mail');

          const normalizedHandle = handleInput.trim().replace(/^@+/, '').toLowerCase();
          const effectiveBroker = resolveEffectiveBroker(activeBroker);
          const activeHandle = normalizedHandle || hub.publicHandle || '';
          const shareHttpUrl = activeHandle
            ? `${effectiveBroker}/u/${encodeURIComponent(activeHandle)}`
            : '';

          const copyProfileLink = async () => {
            if (!shareHttpUrl) return;
            try {
              await navigator.clipboard.writeText(shareHttpUrl);
              useApp.getState().message('Link público do perfil copiado.');
            } catch {
              useApp.getState().message(shareHttpUrl);
            }
          };

          return (
            <div id="hub-account-section" className="hub-profile-card">
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
                    <small>@{hub.publicHandle || hub.username || hub.subject}</small>
                    {hub.email && (
                      <div className="hub-badge-row">
                        <span className={`hub-badge ${hub.emailVerified ? '' : 'warn'}`}>
                          {hub.emailVerified ? (
                            <CheckCircle2 size={11} />
                          ) : (
                            <ShieldAlert size={11} />
                          )}
                          {hub.email} ({hub.emailVerified ? 'Verificado' : 'Não verificado'})
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="hub-profile-actions">
                  <button
                    type="button"
                    className={`button secondary ${editProfileOpen ? 'active' : ''}`}
                    aria-expanded={editProfileOpen}
                    onClick={() => setEditProfileOpen(v => !v)}
                  >
                    <Pencil size={13} />
                    {editProfileOpen ? 'Fechar edição' : 'Editar perfil'}
                  </button>
                  {hub.publicHandle && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => useApp.getState().setPage(`profile:${hub.publicHandle}`)}
                    >
                      <UserRound size={14} />
                      Ver meu perfil
                    </button>
                  )}
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
              </div>

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

              {editProfileOpen && (
                <form
                  className="hub-nickname-form hub-collapsible-panel"
                  onSubmit={e => {
                    e.preventDefault();
                    void updateProfile({
                      brokerUrl: activeBroker,
                      displayName: nicknameInput,
                      ...(normalizedHandle ? { publicHandle: normalizedHandle } : {}),
                      bio: bioInput,
                      profileVisibility: visibilityInput,
                      socialLinks: socialLinksInput,
                      showPublicTracks: showPublicTracksInput,
                    }).then(ok => {
                      if (ok) setEditProfileOpen(false);
                    });
                  }}
                >
                  <div className="hub-form-grid">
                    <label className="field-label">
                      Nome de exibição / Nickname
                      <input
                        type="text"
                        className="input"
                        maxLength={80}
                        placeholder="Seu nome no Liquid Hub"
                        value={nicknameInput}
                        onChange={e => setNicknameInput(e.target.value)}
                        required
                      />
                    </label>
                    <label className="field-label">
                      @handle público (único)
                      <input
                        type="text"
                        className="input"
                        maxLength={32}
                        placeholder="ex: ana.silva"
                        value={handleInput}
                        onChange={e => setHandleInput(e.target.value)}
                      />
                    </label>
                    <label className="field-label">
                      Privacidade do perfil
                      <select
                        className="input"
                        value={visibilityInput}
                        onChange={e => setVisibilityInput(e.target.value as ProfileVisibility)}
                      >
                        <option value="public">Público (todos e busca)</option>
                        <option value="restricted">Restrito (somente logados)</option>
                        <option value="private">Privado (somente eu)</option>
                      </select>
                    </label>
                  </div>

                  <label className="field-label">
                    Bio ({bioInput.length}/240)
                    <textarea
                      className="input"
                      rows={2}
                      maxLength={240}
                      placeholder="Conte sobre seu gosto musical, mixes e playlists…"
                      value={bioInput}
                      onChange={e => setBioInput(e.target.value)}
                    />
                  </label>

                  <label className="hub-inline-checkbox">
                    <input
                      type="checkbox"
                      checked={showPublicTracksInput}
                      onChange={e => setShowPublicTracksInput(e.target.checked)}
                    />
                    Exibir músicas não-locais das playlists públicas no meu perfil
                  </label>

                  <div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setSocialLinksExpanded(v => !v)}
                    >
                      {socialLinksExpanded ? 'Ocultar links sociais' : 'Editar links sociais (HTTPS)'}
                    </button>
                    {socialLinksExpanded && (
                      <div className="hub-social-grid">
                        {(
                          [
                            ['website', 'Site (HTTPS)', 'https://seusite.com'],
                            ['instagram', 'Instagram', 'https://instagram.com/voce'],
                            ['twitter', 'X / Twitter', 'https://x.com/voce'],
                            ['youtube', 'YouTube', 'https://youtube.com/@voce'],
                            ['spotify', 'Spotify', 'https://open.spotify.com/user/...'],
                            ['github', 'GitHub', 'https://github.com/voce'],
                          ] as const
                        ).map(([key, label, placeholder]) => (
                          <label className="field-label" key={key}>
                            {label}
                            <input
                              type="url"
                              className="input"
                              placeholder={placeholder}
                              value={socialLinksInput[key] || ''}
                              onChange={e =>
                                setSocialLinksInput(prev => ({
                                  ...prev,
                                  [key]: e.target.value,
                                }))
                              }
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="hub-form-actions">
                    <button
                      type="submit"
                      className="button primary"
                      disabled={!!busy || !nicknameInput.trim()}
                    >
                      {busy === 'hub:profile' ? 'Salvando…' : 'Salvar perfil'}
                    </button>
                    {shareHttpUrl && (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => void copyProfileLink()}
                      >
                        <Copy size={14} />
                        Copiar link do perfil
                      </button>
                    )}
                  </div>
                </form>
              )}

              {/* Collapsible Section 1: Contas vinculadas (Google, Discord, GitHub, E-mail) */}
              <div className="account-accordion-block">
                <button
                  type="button"
                  className={`account-accordion-trigger ${identitiesOpen ? 'is-open' : ''}`}
                  aria-expanded={identitiesOpen}
                  onClick={() => setIdentitiesOpen(v => !v)}
                >
                  <div className="account-accordion-copy">
                    <strong>Contas vinculadas</strong>
                    <small>
                      {linkedLabels.length > 0
                        ? linkedLabels.join(' · ')
                        : 'Google, Discord, GitHub e e-mail'}
                    </small>
                  </div>
                  <div className="account-accordion-right">
                    <span className="account-accordion-icons" aria-hidden="true">
                      {googleId && <GoogleIcon size={15} />}
                      {discordId && <DiscordIcon size={15} />}
                      {githubId && <GitHubIcon size={15} />}
                      {hub.hasPassword && <Mail size={14} />}
                    </span>
                    <span className="account-accordion-count">
                      {methodCount} {methodCount === 1 ? 'vinculada' : 'vinculadas'}
                    </span>
                    <ChevronDown size={16} className="account-accordion-chevron" />
                  </div>
                </button>

                {identitiesOpen && (
                  <div className="hub-identities-list account-accordion-body" aria-label="Identidades vinculadas">
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
                )}
              </div>
            </div>
          );
        })()
      ) : (
        <div id="hub-account-section" className="hub-profile-card">
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

      {/* Collapsible Section 2: Plataformas vinculadas (YouTube, SoundCloud e Spotify) */}
      <div className="account-accordion-block" style={{ marginTop: 12 }}>
        <button
          type="button"
          className={`account-accordion-trigger ${platformsOpen ? 'is-open' : ''}`}
          aria-expanded={platformsOpen}
          onClick={() => setPlatformsOpen(v => !v)}
        >
          <div className="account-accordion-copy">
            <strong>Plataformas vinculadas</strong>
            <small>{connectedPlatformsSummary}</small>
          </div>
          <div className="account-accordion-right">
            <span className="account-accordion-icons" aria-hidden="true">
              <PlatformIcon source="youtube" />
              <PlatformIcon source="soundcloud" />
              <PlatformIcon source="spotify" />
            </span>
            <span className="account-accordion-count">
              {connectedPlatforms.length}{' '}
              {connectedPlatforms.length === 1 ? 'conectada' : 'conectadas'}
            </span>
            <ChevronDown size={16} className="account-accordion-chevron" />
          </div>
        </button>

        {platformsOpen && (
          <div className="account-accordion-body">
            {accounts.map(a => (
              <div
                className="hub-identity-row account-row"
                key={a.provider}
                data-provider={a.provider}
              >
                <div className="hub-identity-info">
                  <PlatformIcon source={a.provider} />
                  <div>
                    <strong>{names[a.provider]}</strong>
                    <small>
                      {a.connected
                        ? a.name || 'Conectada'
                        : a.configured
                          ? 'Desconectada'
                          : 'Indisponível'}
                      {a.lastSync > 0 ? ` · ${new Date(a.lastSync).toLocaleDateString()}` : ''}
                    </small>
                  </div>
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
          </div>
        )}
      </div>

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
    </section>
  );
}
