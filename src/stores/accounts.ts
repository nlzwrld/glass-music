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
  | 'terms'
  | 'oauth-setup';

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
  oauthSetupProvider: HubOAuthProvider;
  oauthSetupMode: 'login' | 'link';
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
    credentials?: { oauthClientId: string; oauthClientSecret: string },
  ): Promise<boolean>;
  cancelHubOAuth(): Promise<void>;
  acceptHubTerms(brokerUrl?: string): Promise<boolean>;
  updateProfile(displayName: string, brokerUrl?: string): Promise<boolean>;
  syncLibraryFromCloud(brokerUrl?: string): Promise<void>;
  syncLibraryToCloud(brokerUrl?: string): Promise<void>;
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

export const DEFAULT_HUB_BROKER_URL = 'https://liquid-hub-jam.nlzezwrld.workers.dev';

export function oauthProviderLabel(provider: HubOAuthProvider): string {
  if (provider === 'google') return 'Google';
  if (provider === 'discord') return 'Discord';
  return 'GitHub';
}

function normalizeBrokerCandidate(raw?: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.toLowerCase() === 'https://api.liquidhub.app') return '';
  return trimmed;
}

export function resolveEffectiveBroker(
  explicit?: string,
  state?: Pick<State, 'preferredBrokerUrl' | 'hub'>,
): string {
  const fromArg = normalizeBrokerCandidate(explicit);
  if (fromArg) return fromArg;
  const fromPref = normalizeBrokerCandidate(state?.preferredBrokerUrl);
  if (fromPref) return fromPref;
  const fromHub = normalizeBrokerCandidate(state?.hub?.brokerUrl);
  if (fromHub) return fromHub;
  return DEFAULT_HUB_BROKER_URL;
}

async function finishAuthenticatedFlow(
  hub: HubSessionStatus,
  set: (patch: Partial<State>) => void,
  get: () => State,
  noticeMsg: string,
): Promise<boolean> {
  set({ hub, notice: noticeMsg, authError: '', authModalView: 'choose' });
  await useJam.getState().refresh();
  if (hub.authenticated) {
    void get().syncLibraryFromCloud();
  }

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
  oauthSetupProvider: 'discord',
  oauthSetupMode: 'login',
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
      if (hub.authenticated) {
        void get().syncLibraryFromCloud();
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

  oauthHub: async (provider, mode = 'login', brokerUrl, credentials) => {
    if (get().busy) return false;
    purgeSensitiveWebStorage();
    const broker = resolveEffectiveBroker(brokerUrl, get());
    const label = oauthProviderLabel(provider);
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
        ...(credentials?.oauthClientId && credentials?.oauthClientSecret
          ? {
              oauthClientId: credentials.oauthClientId.trim(),
              oauthClientSecret: credentials.oauthClientSecret.trim(),
            }
          : {}),
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

  updateProfile: async (displayName, brokerUrl) => {
    if (get().busy) return false;
    const trimmed = displayName.trim();
    if (!trimmed) return false;
    set({ busy: 'hub:profile', authError: '', notice: 'Salvando nickname…' });
    try {
      const hub = await window.glass.hubUpdateProfile({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        displayName: trimmed,
      });
      set({ hub, notice: `Nickname atualizado para ${hub.displayName || trimmed}.` });
      await useJam.getState().refresh();
      return true;
    } catch (e) {
      const msg = cleanError(e);
      set({ notice: msg, authError: msg });
      return false;
    } finally {
      set({ busy: '' });
    }
  },

  syncLibraryFromCloud: async brokerUrl => {
    if (!get().hub.authenticated || !window.glass?.hubLibraryPull) return;
    try {
      const cloud = await window.glass.hubLibraryPull({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
      });
      const local = useApp.getState().data;
      const cloudPlaylists = Array.isArray(cloud?.playlists) ? cloud.playlists : [];
      const cloudTracks = Array.isArray(cloud?.tracks) ? cloud.tracks : [];
      if (!cloudPlaylists.length) {
        if (local.playlists.length > 0) {
          void get().syncLibraryToCloud(brokerUrl);
        }
        return;
      }
      const cloudTrackMap = new Map(cloudTracks.map(t => [t.id, t]));
      const existingByName = new Map(
        local.playlists.map(p => [p.name.trim().toLowerCase(), p]),
      );
      let latest = local;
      for (const cp of cloudPlaylists) {
        if (!cp?.name) continue;
        const key = cp.name.trim().toLowerCase();
        let targetPl = existingByName.get(key);
        if (!targetPl) {
          latest = await window.glass.library({ action: 'create', name: cp.name });
          targetPl = latest.playlists.find(p => p.name.trim().toLowerCase() === key);
          if (targetPl) existingByName.set(key, targetPl);
        }
        if (targetPl && Array.isArray(cp.trackIds)) {
          for (const tid of cp.trackIds) {
            if (targetPl.trackIds.includes(tid)) continue;
            const tr = cloudTrackMap.get(tid);
            if (!tr || tr.source === 'local') continue;
            try {
              latest = await window.glass.library({ action: 'add', id: targetPl.id, track: tr });
              targetPl = latest.playlists.find(p => p.id === targetPl!.id) || targetPl;
            } catch {
              // Ignore individual track merge failures
            }
          }
        }
      }
      useApp.setState(s => ({ data: { ...latest, preferences: s.data.preferences } }));
    } catch {
      // Non-fatal offline/cloud sync failure
    }
  },

  syncLibraryToCloud: async brokerUrl => {
    if (!get().hub.authenticated || !window.glass?.hubLibraryPush) return;
    try {
      const data = useApp.getState().data;
      const referencedIds = new Set<string>(data.likes);
      for (const pl of data.playlists) {
        for (const tid of pl.trackIds) referencedIds.add(tid);
      }
      const tracks = data.tracks.filter(
        t => t.source !== 'local' && referencedIds.has(t.id),
      );
      await window.glass.hubLibraryPush({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        playlists: data.playlists,
        tracks,
        likes: data.likes,
      });
    } catch {
      // Non-fatal offline/cloud sync failure
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
