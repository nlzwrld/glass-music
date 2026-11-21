import { create } from 'zustand';
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  hasAcceptedCurrentLegal,
} from '../../shared/auth';
import type {
  AccountStatus,
  HubAuthProvider,
  HubOAuthProvider,
  HubProvidersAvailability,
  HubSessionStatus,
} from '../../shared/types';
import { purgeSensitiveWebStorage } from '../../shared/validation';
import { useJam } from '../components/jam/state';
import { cleanError, useApp } from './app';

type Provider = AccountStatus['provider'];

export type AuthModalView =
  | 'choose'
  | 'email-login'
  | 'email-signup'
  | 'forgot'
  | 'reset'
  | 'verify'
  | 'terms';

interface OpenAuthModalOptions {
  view?: AuthModalView;
  postAuthJamInvite?: string | null;
  brokerUrl?: string;
}

interface State {
  accounts: AccountStatus[];
  hub: HubSessionStatus;
  hubHydrated: boolean;
  hubProviders: HubProvidersAvailability | null;
  oauthPending: HubOAuthProvider | null;
  authModalOpen: boolean;
  authModalView: AuthModalView;
  postAuthJamInvite: string | null;
  preferredBrokerUrl: string;
  authError: string;
  busy: string;
  notice: string;
  openAuthModal(opts?: OpenAuthModalOptions): void;
  closeAuthModal(): void;
  setAuthModalView(view: AuthModalView): void;
  setPostAuthJamInvite(raw: string | null): void;
  setPreferredBrokerUrl(url: string): void;
  clearAuthError(): void;
  refresh(): Promise<void>;
  loadHubProviders(brokerUrl?: string): Promise<HubProvidersAvailability | null>;
  configure(): Promise<void>;
  connect(id: Provider): Promise<void>;
  sync(id: Provider, quiet?: boolean): Promise<void>;
  disconnect(id: Provider): Promise<void>;
  cancel(): Promise<void>;
  ensureLegalConsent(): Promise<{ termsVersion: string; privacyVersion: string }>;
  loginHub(payload: {
    brokerUrl?: string;
    username?: string;
    email?: string;
    identifier?: string;
    displayName?: string;
    password: string;
    register?: boolean;
    termsVersion?: string;
    privacyVersion?: string;
  }): Promise<boolean>;
  oauthHub(
    provider: HubOAuthProvider,
    mode?: 'login' | 'link',
    brokerUrl?: string,
  ): Promise<boolean>;
  cancelHubOAuth(): Promise<void>;
  acceptHubTerms(brokerUrl?: string): Promise<boolean>;
  linkEmail(payload: {
    brokerUrl?: string;
    email: string;
    password: string;
    username?: string;
    displayName?: string;
  }): Promise<boolean>;
  unlinkIdentity(provider: HubAuthProvider, brokerUrl?: string): Promise<boolean>;
  verifyEmail(token: string, brokerUrl?: string): Promise<boolean>;
  resendVerification(email?: string, brokerUrl?: string): Promise<boolean>;
  forgotPassword(email: string, brokerUrl?: string): Promise<boolean>;
  resetPassword(token: string, newPassword: string, brokerUrl?: string): Promise<boolean>;
  logoutHub(): Promise<void>;
}

const permitted = () => {
  const p = useApp.getState().data.preferences;
  return p.onlineConsent && p.catalogConsent && p.onboardingDone;
};

const commit = (result: Awaited<ReturnType<typeof window.glass.syncAccount>>) => {
  useApp.setState({
    data: { ...result.snapshot, preferences: useApp.getState().data.preferences },
  });
};

function resolveEffectiveBroker(
  explicit?: string,
  state?: Pick<State, 'preferredBrokerUrl' | 'hub'>,
): string {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  const fromPref = state?.preferredBrokerUrl?.trim();
  if (fromPref) return fromPref;
  const fromHub = state?.hub?.brokerUrl?.trim();
  if (fromHub) return fromHub;
  return 'https://api.liquidhub.app';
}

async function finishAuthenticatedFlow(
  hub: HubSessionStatus,
  set: (patch: Partial<State>) => void,
  get: () => State,
  noticeMsg: string,
): Promise<boolean> {
  set({ hub, notice: noticeMsg, authError: '', authModalView: 'choose' });
  await useJam.getState().refresh();

  if (hub.authenticated && hub.needsTermsAcceptance) {
    set({
      authModalOpen: true,
      authModalView: 'terms',
    });
    return true;
  }

  const pendingInvite = get().postAuthJamInvite;
  if (get().authModalOpen || pendingInvite) {
    set({ authModalOpen: false, postAuthJamInvite: null });
  }
  if (pendingInvite) {
    void useJam.getState().openInviteModal(pendingInvite);
  }
  return true;
}

export const useAccounts = create<State>((set, get) => ({
  accounts: [],
  hub: { authenticated: false, subject: '', expiresAt: 0, brokerUrl: '' },
  hubHydrated: false,
  hubProviders: null,
  oauthPending: null,
  authModalOpen: false,
  authModalView: 'choose',
  postAuthJamInvite: null,
  preferredBrokerUrl: '',
  authError: '',
  busy: '',
  notice: '',

  openAuthModal: opts => {
    const hub = get().hub;
    const view: AuthModalView =
      hub.authenticated && hub.needsTermsAcceptance
        ? 'terms'
        : opts?.view || 'choose';
    set({
      authModalOpen: true,
      authModalView: view,
      authError: '',
      ...(opts && 'postAuthJamInvite' in opts
        ? { postAuthJamInvite: opts.postAuthJamInvite ?? null }
        : {}),
      ...(opts?.brokerUrl ? { preferredBrokerUrl: opts.brokerUrl } : {}),
    });
    void get().loadHubProviders(opts?.brokerUrl);
  },

  closeAuthModal: () => {
    if (get().oauthPending) {
      void get().cancelHubOAuth();
    }
    set({ authModalOpen: false, authError: '', oauthPending: null });
  },

  setAuthModalView: view => set({ authModalView: view, authError: '' }),
  setPostAuthJamInvite: raw => set({ postAuthJamInvite: raw }),
  setPreferredBrokerUrl: url => set({ preferredBrokerUrl: url }),
  clearAuthError: () => set({ authError: '' }),

  refresh: async () => {
    purgeSensitiveWebStorage();
    try {
      const p = useApp.getState().data.preferences;
      const canNetwork = p.onlineConsent && p.onboardingDone;
      const hubPromise =
        canNetwork && window.glass.hubRefresh
          ? window.glass
              .hubRefresh(get().preferredBrokerUrl || undefined)
              .catch(() =>
                window.glass.hubStatus ? window.glass.hubStatus() : Promise.resolve(get().hub),
              )
          : window.glass.hubStatus
            ? window.glass.hubStatus()
            : Promise.resolve(get().hub);
      const [accounts, hub] = await Promise.all([window.glass.accounts(), hubPromise]);
      set(s => ({
        accounts,
        hub,
        hubHydrated: true,
        preferredBrokerUrl: s.preferredBrokerUrl || hub.brokerUrl || '',
      }));
      if (hub.authenticated && hub.needsTermsAcceptance) {
        set({ authModalOpen: true, authModalView: 'terms' });
      }
    } catch (e) {
      set({ notice: cleanError(e), hubHydrated: true });
    } finally {
      if (!get().hubHydrated) {
        set({ hubHydrated: true });
      }
    }
  },

  loadHubProviders: async brokerUrl => {
    const p = useApp.getState().data.preferences;
    if (!p.onlineConsent || !p.onboardingDone || !window.glass.hubProviders) return null;
    const target = resolveEffectiveBroker(brokerUrl, get());
    try {
      const avail = await window.glass.hubProviders(target);
      set({ hubProviders: avail, preferredBrokerUrl: avail.brokerUrl || target });
      return avail;
    } catch {
      return null;
    }
  },

  ensureLegalConsent: async () => {
    const prefs = useApp.getState().data.preferences;
    if (!prefs.onlineConsent || !prefs.onboardingDone || !hasAcceptedCurrentLegal(prefs)) {
      const next = {
        ...prefs,
        onboardingDone: true,
        onlineConsent: true,
        catalogConsent: true,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyVersion: CURRENT_PRIVACY_VERSION,
        termsAcceptedAt: Date.now(),
      };
      await window.glass.preferences(next);
      useApp.setState(s => ({ data: { ...s.data, preferences: next } }));
    }
    return {
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    };
  },

  configure: async () => {
    if (get().busy) return;
    set({ busy: 'configure', notice: '' });
    try {
      set({ accounts: await window.glass.configureAccounts() });
    } catch (e) {
      set({ notice: cleanError(e) });
    } finally {
      set({ busy: '' });
    }
  },
  connect: async id => {
    if (get().busy || !permitted()) return;
    set({
      busy: `connect:${id}`,
      notice: 'Autorize a conta no navegador (PKCE S256) e volte ao Liquid Hub.',
    });
    try {
      set({
        accounts: await window.glass.connectAccount(id),
        notice: 'Importando playlists e curtidas…',
        busy: `sync:${id}`,
      });
      const result = await window.glass.syncAccount(id);
      commit(result);
      set({ accounts: result.accounts, notice: `${result.playlists} playlists sincronizadas.` });
    } catch (e) {
      set({ notice: cleanError(e) });
      await get().refresh();
    } finally {
      set({ busy: '' });
    }
  },
  sync: async (id, quiet = false) => {
    if (get().busy || !permitted()) return;
    set({ busy: `sync:${id}`, ...(!quiet ? { notice: 'Sincronizando…' } : {}) });
    try {
      const result = await window.glass.syncAccount(id);
      commit(result);
      set({
        accounts: result.accounts,
        notice: quiet ? '' : `${result.playlists} playlists sincronizadas.`,
      });
    } catch (e) {
      set({ notice: cleanError(e) });
    } finally {
      set({ busy: '' });
    }
  },
  disconnect: async id => {
    if (get().busy) return;
    set({ busy: `disconnect:${id}`, notice: '' });
    try {
      set({
        accounts: await window.glass.disconnectAccount(id),
        notice: 'Conta desconectada. As músicas importadas continuam no Liquid Hub.',
      });
    } catch (e) {
      set({ notice: cleanError(e) });
    } finally {
      set({ busy: '' });
    }
  },
  cancel: async () => {
    await window.glass.cancelAccount();
    set({ notice: 'Cancelando…' });
  },

  loginHub: async payload => {
    if (get().busy) return false;
    purgeSensitiveWebStorage();
    const brokerUrl = resolveEffectiveBroker(payload.brokerUrl, get());
    set({
      busy: 'hub:login',
      authError: '',
      notice: payload.register
        ? 'Criando conta segura no Liquid Hub…'
        : 'Autenticando sessão Zero-Trust (PKCE S256 + Ed25519)…',
    });
    try {
      const prefs = useApp.getState().data.preferences;
      const legal =
        payload.termsVersion && payload.privacyVersion
          ? { termsVersion: payload.termsVersion, privacyVersion: payload.privacyVersion }
          : hasAcceptedCurrentLegal(prefs)
            ? {
                termsVersion: prefs.termsVersion,
                privacyVersion: prefs.privacyVersion,
              }
            : {};
      const hub = await window.glass.hubLogin({
        ...payload,
        brokerUrl,
        ...legal,
      });
      set({ preferredBrokerUrl: brokerUrl });
      return await finishAuthenticatedFlow(
        hub,
        set,
        get,
        `Sessão protegida no cofre do Windows (${hub.displayName || hub.subject}).`,
      );
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  oauthHub: async (provider, mode = 'login', brokerUrl) => {
    if (get().busy) return false;
    purgeSensitiveWebStorage();
    const broker = resolveEffectiveBroker(brokerUrl, get());
    const label = provider === 'discord' ? 'Discord' : 'GitHub';
    set({
      busy: `hub:oauth:${provider}`,
      oauthPending: provider,
      authError: '',
      notice:
        mode === 'link'
          ? `Conclua a autorização do ${label} no navegador para vincular sua conta.`
          : `Conclua a entrada pelo ${label} no navegador e volte ao Liquid Hub.`,
    });
    try {
      const prefs = useApp.getState().data.preferences;
      const legal = hasAcceptedCurrentLegal(prefs)
        ? {
            termsVersion: prefs.termsVersion,
            privacyVersion: prefs.privacyVersion,
          }
        : {};
      const hub = await window.glass.hubOAuthStart({
        brokerUrl: broker,
        provider,
        mode,
        ...legal,
      });
      set({ preferredBrokerUrl: broker, oauthPending: null });
      return await finishAuthenticatedFlow(
        hub,
        set,
        get,
        mode === 'link'
          ? `Identidade ${label} vinculada com segurança.`
          : `Conectado com ${label} (${hub.displayName || hub.subject}).`,
      );
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg, oauthPending: null });
      return false;
    } finally {
      set({ busy: '', oauthPending: null });
    }
  },

  cancelHubOAuth: async () => {
    try {
      await window.glass.hubCancelOAuth();
    } finally {
      set({
        oauthPending: null,
        busy: get().busy.startsWith('hub:oauth:') ? '' : get().busy,
        authError: 'Autenticação OAuth cancelada.',
        notice: 'Autenticação OAuth cancelada.',
      });
    }
  },

  acceptHubTerms: async brokerUrl => {
    if (get().busy) return false;
    set({ busy: 'hub:terms', authError: '' });
    try {
      await get().ensureLegalConsent();
      const hub = await window.glass.hubAcceptTerms({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        termsVersion: CURRENT_TERMS_VERSION,
        privacyVersion: CURRENT_PRIVACY_VERSION,
      });
      return await finishAuthenticatedFlow(
        hub,
        set,
        get,
        'Termos de Uso e Política de Privacidade confirmados.',
      );
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  linkEmail: async payload => {
    if (get().busy) return false;
    set({ busy: 'hub:link-email', authError: '', notice: 'Vinculando login por e-mail…' });
    try {
      const hub = await window.glass.hubLinkEmail({
        ...payload,
        brokerUrl: resolveEffectiveBroker(payload.brokerUrl, get()),
      });
      set({
        hub,
        notice: 'E-mail e senha vinculados à sua conta. Verifique sua caixa de entrada.',
      });
      return true;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  unlinkIdentity: async (provider, brokerUrl) => {
    if (get().busy) return false;
    set({ busy: `hub:unlink:${provider}`, authError: '' });
    try {
      const hub = await window.glass.hubUnlinkIdentity({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        provider,
      });
      set({ hub, notice: 'Provedor desvinculado com segurança.' });
      return true;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  verifyEmail: async (token, brokerUrl) => {
    if (get().busy) return false;
    set({ busy: 'hub:verify', authError: '' });
    try {
      const res = await window.glass.hubVerifyEmail({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        token,
      });
      set({ hub: res.status, notice: 'E-mail verificado com sucesso.' });
      return res.ok;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  resendVerification: async (email, brokerUrl) => {
    if (get().busy) return false;
    set({ busy: 'hub:resend', authError: '' });
    try {
      await window.glass.hubResendVerification({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        ...(email ? { email } : {}),
      });
      set({ notice: 'Novo código de verificação enviado para o seu e-mail.' });
      return true;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  forgotPassword: async (email, brokerUrl) => {
    if (get().busy) return false;
    set({ busy: 'hub:forgot', authError: '' });
    try {
      await window.glass.hubForgotPassword({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        email,
      });
      set({
        notice: 'Se o e-mail estiver cadastrado, você receberá um código de redefinição.',
      });
      return true;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  resetPassword: async (token, newPassword, brokerUrl) => {
    if (get().busy) return false;
    set({ busy: 'hub:reset', authError: '' });
    try {
      await window.glass.hubResetPassword({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        token,
        newPassword,
      });
      set({ notice: 'Senha redefinida com sucesso. Entre com a nova senha.' });
      return true;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  logoutHub: async () => {
    if (get().busy) return;
    set({ busy: 'hub:logout', notice: '' });
    try {
      const hub = await window.glass.hubLogout();
      set({
        hub,
        authModalOpen: false,
        authModalView: 'choose',
        postAuthJamInvite: null,
        authError: '',
        notice: 'Sessão encerrada e removida do cofre do sistema.',
      });
      void useJam.getState().refresh();
    } catch (e) {
      set({ notice: cleanError(e) });
    } finally {
      set({ busy: '' });
    }
  },
}));

export async function autoSyncAccounts() {
  if (!permitted() || useAccounts.getState().busy) return;
  await useAccounts.getState().refresh();
  for (const account of useAccounts.getState().accounts) {
    if (!permitted()) break;
    if (account.connected && Date.now() - account.lastSync >= 30 * 60 * 1000) {
      await useAccounts.getState().sync(account.provider, true);
    }
  }
}
