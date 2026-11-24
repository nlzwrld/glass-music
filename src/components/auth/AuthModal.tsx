import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  LoaderCircle,
  Mail,
  Radio,
  ShieldCheck,
  X,
} from 'lucide-react';
import { LiquidHubLogo } from '../brand/LiquidHubLogo';
import {
  CURRENT_TERMS_VERSION,
  LEGAL_SUMMARY,
  hasAcceptedCurrentLegal,
} from '../../../shared/auth';
import type { HubOAuthProvider } from '../../../shared/types';
import { AutoUpdates } from '../../lib/updates';
import {
  oauthProviderLabel,
  useAccounts,
} from '../../stores/accounts';
import { cleanError, useApp } from '../../stores/app';
import { IconButton } from '../glass/controls';
import { DiscordIcon, GitHubIcon, GoogleIcon } from './ProviderIcons';
import './auth.css';

export function AuthModal({ mandatory = false }: { mandatory?: boolean }) {
  const open = useAccounts(s => s.authModalOpen),
    storeView = useAccounts(s => s.authModalView),
    hub = useAccounts(s => s.hub),
    hubProviders = useAccounts(s => s.hubProviders),
    oauthPending = useAccounts(s => s.oauthPending),
    postAuthJamInvite = useAccounts(s => s.postAuthJamInvite),
    preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl),
    authError = useAccounts(s => s.authError),
    busy = useAccounts(s => s.busy),
    closeAuthModal = useAccounts(s => s.closeAuthModal),
    setView = useAccounts(s => s.setAuthModalView),
    loadHubProviders = useAccounts(s => s.loadHubProviders),
    ensureLegalConsent = useAccounts(s => s.ensureLegalConsent),
    loginHub = useAccounts(s => s.loginHub),
    oauthHub = useAccounts(s => s.oauthHub),
    cancelHubOAuth = useAccounts(s => s.cancelHubOAuth),
    acceptHubTerms = useAccounts(s => s.acceptHubTerms),
    forgotPassword = useAccounts(s => s.forgotPassword),
    resetPassword = useAccounts(s => s.resetPassword),
    verifyEmail = useAccounts(s => s.verifyEmail),
    resendVerification = useAccounts(s => s.resendVerification),
    logoutHub = useAccounts(s => s.logoutHub),
    clearAuthError = useAccounts(s => s.clearAuthError);

  const prefs = useApp(s => s.data.preferences);
  const alreadyConsented =
    prefs.onlineConsent && prefs.onboardingDone && hasAcceptedCurrentLegal(prefs);
  const effectiveOpen = mandatory || open;
  const view = hub.authenticated && hub.needsTermsAcceptance ? 'terms' : storeView;

  const [termsChecked, setTermsChecked] = useState(alreadyConsented);
  const [localError, setLocalError] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    if (effectiveOpen) {
      setTermsChecked(alreadyConsented);
      setLocalError('');
      if (alreadyConsented) {
        void loadHubProviders(preferredBrokerUrl || undefined);
      }
    }
  }, [effectiveOpen, alreadyConsented, preferredBrokerUrl, loadHubProviders]);

  useEffect(() => {
    if (!effectiveOpen || mandatory) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && view !== 'terms' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        closeAuthModal();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) {
        prevFocus.focus();
      }
    };
  }, [effectiveOpen, mandatory, view, busy, closeAuthModal]);

  if (!effectiveOpen) return null;

  const isMustAcceptTerms = view === 'terms';
  const hideClose = mandatory || isMustAcceptTerms;
  const displayedError = localError || authError;

  const requireTerms = async () => {
    if (!termsChecked) {
      setLocalError('Aceite os Termos de Uso e a Política de Privacidade para continuar.');
      return null;
    }
    setLocalError('');
    clearAuthError();
    return ensureLegalConsent();
  };

  const handleOAuth = async (provider: HubOAuthProvider) => {
    const legal = await requireTerms();
    if (!legal) return;
    await oauthHub(provider, 'login');
  };

  const googleUnavailable = hubProviders?.google?.configured === false;

  const handleOpenEmail = async () => {
    const legal = await requireTerms();
    if (!legal) return;
    setView('email-login');
  };

  return (
    <div
      className={mandatory ? 'auth-gate' : 'modal-backdrop'}
      onMouseDown={e => {
        if (e.target === e.currentTarget && !hideClose && !busy) {
          closeAuthModal();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="modal glass auth-modal"
      >
        <div className="auth-modal-head">
          <div>
            {view !== 'choose' && view !== 'terms' && (
              <button
                type="button"
                className="text-button"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 4 }}
                onClick={() => {
                  setLocalError('');
                  clearAuthError();
                  setView(
                    view === 'reset'
                      ? 'forgot'
                      : view === 'forgot' || view === 'verify'
                        ? 'email-login'
                        : 'choose',
                  );
                }}
              >
                <ArrowLeft size={13} />
                Voltar
              </button>
            )}
            <span className="collection-type-label auth-brand-row">
              {mandatory && <LiquidHubLogo size={18} />}
              Liquid Hub
            </span>
            <h2 id="auth-modal-title">
              {view === 'terms'
                ? 'Termos e Privacidade'
                : view === 'email-signup'
                  ? 'Criar conta'
                  : view === 'email-login'
                    ? 'Entrar com e-mail'
                    : view === 'forgot'
                      ? 'Recuperar senha'
                      : view === 'reset'
                        ? 'Redefinir senha'
                        : view === 'verify'
                          ? 'Verificar e-mail'
                          : 'Entrar no Liquid Hub'}
            </h2>
          </div>
          {!hideClose && (
            <IconButton label="Fechar login" onClick={closeAuthModal} disabled={!!busy && !oauthPending}>
              <X size={16} />
            </IconButton>
          )}
        </div>

        {mandatory && <AutoUpdates />}

        {postAuthJamInvite && (
          <div className="auth-jam-banner" role="status">
            <Radio size={15} />
            <span>Você recebeu um convite de JAM — entre na sua conta para continuar.</span>
          </div>
        )}

        {oauthPending && (
          <div className="auth-pending-banner" role="status">
            <span className="auth-pending-label">
              <LoaderCircle size={15} className="auth-spin" />
              <span>
                Aguardando autorização no {oauthProviderLabel(oauthPending)}…
              </span>
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => void cancelHubOAuth()}
            >
              Cancelar
            </button>
          </div>
        )}

        {displayedError && (
          <div className="auth-error-banner" role="alert">
            <AlertCircle size={15} />
            <span>{displayedError}</span>
          </div>
        )}

        {view === 'choose' && (
          <>
            <div className="auth-provider-stack">
              <button
                type="button"
                className="auth-provider-btn auth-provider-btn--google"
                disabled={!!busy || googleUnavailable}
                title={
                  googleUnavailable
                    ? 'O login com Google não está configurado neste servidor.'
                    : undefined
                }
                onClick={() => void handleOAuth('google')}
              >
                {busy === 'hub:oauth:google' ? (
                  <LoaderCircle size={18} className="auth-spin" />
                ) : (
                  <GoogleIcon size={18} />
                )}
                <span>Continuar com Google</span>
              </button>

              <button
                type="button"
                className="auth-provider-btn auth-provider-btn--discord"
                disabled={!!busy}
                onClick={() => void handleOAuth('discord')}
              >
                {busy === 'hub:oauth:discord' ? (
                  <LoaderCircle size={18} className="auth-spin" />
                ) : (
                  <DiscordIcon size={18} />
                )}
                <span>Continuar com Discord</span>
              </button>

              <button
                type="button"
                className="auth-provider-btn auth-provider-btn--github"
                disabled={!!busy}
                onClick={() => void handleOAuth('github')}
              >
                {busy === 'hub:oauth:github' ? (
                  <LoaderCircle size={18} className="auth-spin" />
                ) : (
                  <GitHubIcon size={18} />
                )}
                <span>Continuar com GitHub</span>
              </button>

              <button
                type="button"
                className="auth-provider-btn auth-provider-btn--email"
                disabled={!!busy}
                onClick={() => void handleOpenEmail()}
              >
                <Mail size={17} />
                <span>Entrar com e-mail</span>
              </button>
            </div>

            <label className="auth-legal-check auth-legal-compact">
              <input
                type="checkbox"
                checked={termsChecked}
                onChange={e => {
                  setTermsChecked(e.target.checked);
                  if (e.target.checked) setLocalError('');
                }}
              />
              <span>Aceito os Termos e Privacidade</span>
            </label>

            {mandatory && (
              <button
                type="button"
                className="auth-visitor-btn"
                disabled={!!busy}
                onClick={() => {
                  if (!termsChecked) {
                    setLocalError('Aceite os Termos e Privacidade para continuar.');
                    return;
                  }
                  void ensureLegalConsent()
                    .then(() => {
                      useAccounts.getState().enterVisitorMode();
                    })
                    .catch(e => setLocalError(cleanError(e)));
                }}
              >
                Modo visitante
              </button>
            )}
          </>
        )}

        {view === 'email-login' && (
          <form
            className="auth-form"
            onSubmit={e => {
              e.preventDefault();
              void requireTerms().then(legal => {
                if (!legal) return;
                void loginHub({
                  identifier: identifier.trim(),
                  password,
                  ...legal,
                }).then(ok => {
                  if (ok) setPassword('');
                });
              });
            }}
          >
            <label className="field-label">
              E-mail ou nome de usuário
              <input
                type="text"
                className="input"
                autoComplete="username"
                placeholder="voce@exemplo.com"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="field-label">
              Senha
              <input
                type="password"
                className="input"
                autoComplete="current-password"
                minLength={12}
                maxLength={256}
                placeholder="Mínimo de 12 caracteres"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={!!busy || !identifier.trim() || password.length < 12}
            >
              {busy === 'hub:login' ? 'Entrando…' : 'Entrar'}
            </button>
            <div className="auth-form-links">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setLocalError('');
                  clearAuthError();
                  setView('email-signup');
                }}
              >
                Criar conta com e-mail
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setLocalError('');
                  clearAuthError();
                  setView('forgot');
                }}
              >
                Esqueci minha senha
              </button>
            </div>
            <div className="auth-form-links">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setLocalError('');
                  clearAuthError();
                  setView('verify');
                }}
              >
                Inserir código de verificação
              </button>
            </div>
          </form>
        )}

        {view === 'email-signup' && (
          <form
            className="auth-form"
            onSubmit={e => {
              e.preventDefault();
              void requireTerms().then(legal => {
                if (!legal) return;
                void loginHub({
                  email: email.trim(),
                  displayName: displayName.trim() || undefined,
                  password,
                  register: true,
                  ...legal,
                }).then(ok => {
                  if (ok) setPassword('');
                });
              });
            }}
          >
            <label className="field-label">
              Nome de exibição
              <input
                type="text"
                className="input"
                maxLength={80}
                placeholder="Como você quer aparecer"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field-label">
              E-mail
              <input
                type="email"
                className="input"
                autoComplete="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Senha (mínimo 12 caracteres)
              <input
                type="password"
                className="input"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                placeholder="Use uma frase ou senha forte"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={!!busy || !email.trim() || password.length < 12}
            >
              {busy === 'hub:login' ? 'Criando conta…' : 'Criar conta'}
            </button>
            <div className="auth-form-links">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setLocalError('');
                  clearAuthError();
                  setView('email-login');
                }}
              >
                Já tenho conta
              </button>
            </div>
          </form>
        )}

        {view === 'forgot' && (
          <form
            className="auth-form"
            onSubmit={e => {
              e.preventDefault();
              void ensureLegalConsent()
                .then(() => forgotPassword(email.trim()))
                .then(ok => {
                  if (ok) setView('reset');
                });
            }}
          >
            <p className="auth-modal-subtitle">
              Informe seu e-mail cadastrado para gerar um código de recuperação de senha.
            </p>
            <label className="field-label">
              E-mail
              <input
                type="email"
                className="input"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={!!busy || !email.trim()}
            >
              {busy === 'hub:forgot' ? 'Enviando…' : 'Enviar código de recuperação'}
            </button>
            <div className="auth-form-links">
              <button
                type="button"
                className="text-button"
                onClick={() => setView('reset')}
              >
                Já tenho um código
              </button>
            </div>
          </form>
        )}

        {view === 'reset' && (
          <form
            className="auth-form"
            onSubmit={e => {
              e.preventDefault();
              void ensureLegalConsent()
                .then(() => resetPassword(token.trim(), newPassword))
                .then(ok => {
                  if (ok) {
                    setToken('');
                    setNewPassword('');
                    setView('email-login');
                  }
                });
            }}
          >
            <label className="field-label">
              Código de recuperação
              <input
                type="text"
                className="input"
                value={token}
                onChange={e => setToken(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="field-label">
              Nova senha (mínimo 12 caracteres)
              <input
                type="password"
                className="input"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={!!busy || token.trim().length < 16 || newPassword.length < 12}
            >
              {busy === 'hub:reset' ? 'Redefinindo…' : 'Salvar nova senha'}
            </button>
          </form>
        )}

        {view === 'verify' && (
          <form
            className="auth-form"
            onSubmit={e => {
              e.preventDefault();
              void ensureLegalConsent()
                .then(() => verifyEmail(token.trim()))
                .then(ok => {
                  if (ok) {
                    setToken('');
                    setView(hub.authenticated ? 'choose' : 'email-login');
                    if (hub.authenticated) closeAuthModal();
                  }
                });
            }}
          >
            <p className="auth-modal-subtitle">
              Cole o código de verificação enviado para confirmar seu e-mail.
            </p>
            <label className="field-label">
              Código de verificação
              <input
                type="text"
                className="input"
                value={token}
                onChange={e => setToken(e.target.value)}
                required
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || (!hub.authenticated && !email.trim())}
                onClick={() =>
                  void ensureLegalConsent().then(() =>
                    resendVerification(hub.authenticated ? undefined : email.trim()),
                  )
                }
              >
                Reenviar código
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={!!busy || token.trim().length < 16}
              >
                <CheckCircle2 size={15} />
                Verificar e-mail
              </button>
            </div>
          </form>
        )}

        {view === 'terms' && (
          <div className="auth-form">
            <p className="auth-modal-subtitle">
              Para concluir seu acesso como{' '}
              <strong>{hub.displayName || hub.username || hub.subject}</strong>, revise e confirme
              os documentos vigentes do Liquid Hub (v. {CURRENT_TERMS_VERSION}).
            </p>
            <div className="auth-legal-box">
              <strong>{LEGAL_SUMMARY.termsTitle}</strong>
              <ul className="auth-legal-details" style={{ margin: 0, paddingLeft: 16 }}>
                {LEGAL_SUMMARY.termsHighlights.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <strong style={{ marginTop: 6 }}>{LEGAL_SUMMARY.privacyTitle}</strong>
              <ul className="auth-legal-details" style={{ margin: 0, paddingLeft: 16 }}>
                {LEGAL_SUMMARY.privacyHighlights.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                onClick={() => void logoutHub()}
              >
                Encerrar sessão
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!!busy}
                onClick={() => void acceptHubTerms()}
              >
                <ShieldCheck size={15} />
                {busy === 'hub:terms' ? 'Registrando…' : 'Concordo e continuar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
