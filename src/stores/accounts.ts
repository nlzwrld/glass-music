import { create } from 'zustand';
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  hasAcceptedCurrentLegal,
} from '../../shared/auth';
import { defaultFreePlusStatus, type LiquidPlusStatus } from '../../shared/plus';
import type {
  AccountStatus,
  HubAuthProvider,
  HubOAuthProvider,
  HubProvidersAvailability,
  HubSessionStatus,
  Preferences,
  ProfileVisibility,
  SocialLinks,
} from '../../shared/types';

export const SYNCABLE_PREFERENCE_KEYS = [
  'theme',
  'uiStyle',
  'beatPulse',
  'accent',
  'shuffleMode',
  'smartShuffleDiscoveries',
  'transition',
  'transitionSeconds',
  'autoplay',
  'notificationMode',
] as const;

export type SyncablePreferenceKey = (typeof SYNCABLE_PREFERENCE_KEYS)[number];

export function pickSyncablePreferences(prefs: Partial<Preferences>): Partial<Preferences> {
  const out: Partial<Preferences> = {};
  for (const key of SYNCABLE_PREFERENCE_KEYS) {
    if (key in prefs && prefs[key] !== undefined) {
      (out as Record<string, unknown>)[key] = prefs[key];
    }
  }
  return out;
}

const SYNC_DIRTY_STORAGE_KEY = 'lh_cloud_sync_dirty';

function readDirtyFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SYNC_DIRTY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDirtyFlag(dirty: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (dirty) localStorage.setItem(SYNC_DIRTY_STORAGE_KEY, '1');
    else localStorage.removeItem(SYNC_DIRTY_STORAGE_KEY);
  } catch {
    // Non-fatal storage restriction
  }
}

let cloudSyncDebounceTimer: ReturnType<typeof setTimeout> | undefined;

export interface UpdateProfilePatch {
  brokerUrl?: string;
  displayName?: string;
  publicHandle?: string;
  bio?: string;
  profileVisibility?: ProfileVisibility;
  socialLinks?: SocialLinks;
  showPublicTracks?: boolean;
}
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
  plusStatus: LiquidPlusStatus;
  visitorMode: boolean;
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
  pendingSync: boolean;
  lastCloudSyncAt: number;
  syncState: 'idle' | 'syncing' | 'offline-queued' | 'synced';
  openAuthModal(opts?: OpenAuthModalOptions): void;
  closeAuthModal(): void;
  setAuthModalView(view: AuthModalView): void;
  setPostAuthJamInvite(raw: string | null): void;
  setPreferredBrokerUrl(url: string): void;
  clearAuthError(): void;
  enterVisitorMode(): void;
  exitVisitorMode(): void;
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
  updateProfile(
    patchOrName: string | UpdateProfilePatch,
    brokerUrl?: string,
  ): Promise<boolean>;
  refreshPlusStatus(brokerUrl?: string): Promise<LiquidPlusStatus>;
  syncLibraryFromCloud(brokerUrl?: string): Promise<void>;
  syncLibraryToCloud(brokerUrl?: string): Promise<void>;
  queueCloudSync(brokerUrl?: string): void;
  flushPendingCloudSync(brokerUrl?: string): Promise<void>;
  syncAllMultiplatform(brokerUrl?: string): Promise<void>;
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
  set({
    hub,
    visitorMode: false,
    notice: noticeMsg,
    authError: '',
    authModalView: 'choose',
  });
  await useJam.getState().refresh();
  if (hub.authenticated) {
    void get().syncLibraryFromCloud();
    void get().refreshPlusStatus();
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
  plusStatus: defaultFreePlusStatus(),
  visitorMode: false,
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
  pendingSync: readDirtyFlag(),
  lastCloudSyncAt: 0,
  syncState: readDirtyFlag() ? 'offline-queued' : 'idle',

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
  enterVisitorMode: () =>
    set({
      visitorMode: true,
      authModalOpen: false,
      authError: '',
      plusStatus: defaultFreePlusStatus(false),
      notice: '',
    }),
  exitVisitorMode: () =>
    set({
      visitorMode: false,
      authModalOpen: true,
      authModalView: 'choose',
      authError: '',
    }),

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
        void get().refreshPlusStatus();
      } else {
        set({ plusStatus: defaultFreePlusStatus(false) });
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

  updateProfile: async (patchOrName, brokerUrl) => {
    if (get().busy) return false;
    const rawPatch: UpdateProfilePatch =
      typeof patchOrName === 'string'
        ? { displayName: patchOrName.trim(), brokerUrl }
        : patchOrName;
    const payload: UpdateProfilePatch = {
      brokerUrl: resolveEffectiveBroker(rawPatch.brokerUrl ?? brokerUrl, get()),
    };
    if (rawPatch.displayName !== undefined) {
      const trimmed = rawPatch.displayName.trim();
      if (!trimmed) return false;
      payload.displayName = trimmed;
    }
    if (rawPatch.publicHandle !== undefined) {
      const normalized = rawPatch.publicHandle.trim().replace(/^@+/, '').toLowerCase();
      if (!normalized) return false;
      payload.publicHandle = normalized;
    }
    if (rawPatch.bio !== undefined) {
      payload.bio = rawPatch.bio.trim();
    }
    if (rawPatch.profileVisibility !== undefined) {
      payload.profileVisibility = rawPatch.profileVisibility;
    }
    if (rawPatch.socialLinks !== undefined) {
      const cleanedLinks: SocialLinks = {};
      for (const key of ['website', 'instagram', 'twitter', 'youtube', 'spotify', 'github'] as const) {
        const val = rawPatch.socialLinks[key];
        if (typeof val === 'string') cleanedLinks[key] = val.trim();
      }
      payload.socialLinks = cleanedLinks;
    }
    if (rawPatch.showPublicTracks !== undefined) {
      payload.showPublicTracks = Boolean(rawPatch.showPublicTracks);
    }

    set({ busy: 'hub:profile', authError: '', notice: 'Salvando perfil no Liquid Hub…' });
    try {
      const hub = await window.glass.hubUpdateProfile(payload);
      set({
        hub,
        notice: `Perfil atualizado${hub.publicHandle ? ` (@${hub.publicHandle})` : ''}.`,
      });
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

  refreshPlusStatus: async brokerUrl => {
    const p = useApp.getState().data.preferences;
    const isAuth = get().hub.authenticated;
    if (!p.onlineConsent || !p.onboardingDone || !window.glass?.hubPlusStatus) {
      const fallback = defaultFreePlusStatus(isAuth);
      set({ plusStatus: fallback });
      return fallback;
    }
    try {
      const plusStatus = await window.glass.hubPlusStatus({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
      });
      set({ plusStatus });
      return plusStatus;
    } catch {
      const fallback = defaultFreePlusStatus(isAuth);
      set({ plusStatus: fallback });
      return fallback;
    }
  },

  syncLibraryFromCloud: async brokerUrl => {
    if (!get().hub.authenticated || !window.glass?.hubLibraryPull) return;
    set({ syncState: 'syncing' });
    try {
      const cloud = await window.glass.hubLibraryPull({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
      });
      const local = useApp.getState().data;
      const cloudPlaylists = Array.isArray(cloud?.playlists) ? cloud.playlists : [];
      const cloudTracks = Array.isArray(cloud?.tracks) ? cloud.tracks : [];
      const cloudLikes = Array.isArray(cloud?.likes) ? cloud.likes : [];
      const cloudPrefs =
        cloud?.preferences && typeof cloud.preferences === 'object'
          ? pickSyncablePreferences(cloud.preferences)
          : {};

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

      // Merge remote likes without duplicating existing local likes
      const localLikes = new Set(latest.likes);
      for (const tid of cloudLikes) {
        if (localLikes.has(tid)) continue;
        const tr = cloudTrackMap.get(tid) || latest.tracks.find(t => t.id === tid);
        if (!tr || tr.source === 'local') continue;
        try {
          latest = await window.glass.library({ action: 'like', track: tr });
          localLikes.add(tid);
        } catch {
          // Ignore individual like merge failures
        }
      }

      // Merge cross-device preferences when cloud is newer and no local offline write is pending
      let mergedPrefs = useApp.getState().data.preferences;
      const cloudUpdatedAt = Number(cloud?.updatedAt || 0);
      if (
        Object.keys(cloudPrefs).length > 0 &&
        !get().pendingSync &&
        cloudUpdatedAt > get().lastCloudSyncAt
      ) {
        const nextPrefs = { ...mergedPrefs, ...cloudPrefs };
        if (nextPrefs.uiStyle === 'beat') {
          nextPrefs.uiStyle = 'matte';
          nextPrefs.beatPulse = nextPrefs.beatPulse ?? true;
        }
        const changed = SYNCABLE_PREFERENCE_KEYS.some(
          k => nextPrefs[k] !== mergedPrefs[k],
        );
        if (changed) {
          try {
            await window.glass.preferences(nextPrefs);
            mergedPrefs = nextPrefs;
          } catch {
            // Keep local preferences if validation rejects any field
          }
        }
      }

      useApp.setState({ data: { ...latest, preferences: mergedPrefs } });

      if (
        get().pendingSync ||
        (!cloudPlaylists.length && local.playlists.length > 0) ||
        (!cloudLikes.length && local.likes.length > 0)
      ) {
        await get().syncLibraryToCloud(brokerUrl);
      } else {
        set({
          lastCloudSyncAt: Math.max(get().lastCloudSyncAt, cloudUpdatedAt || Date.now()),
          syncState: 'synced',
        });
      }
    } catch {
      set(s => ({ syncState: s.pendingSync ? 'offline-queued' : 'idle' }));
    }
  },

  syncLibraryToCloud: async brokerUrl => {
    if (!get().hub.authenticated || !window.glass?.hubLibraryPush) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      writeDirtyFlag(true);
      set({ pendingSync: true, syncState: 'offline-queued' });
      return;
    }
    set({ syncState: 'syncing' });
    try {
      const data = useApp.getState().data;
      const referencedIds = new Set<string>(data.likes);
      for (const pl of data.playlists) {
        for (const tid of pl.trackIds) referencedIds.add(tid);
      }
      const tracks = data.tracks.filter(
        t => t.source !== 'local' && referencedIds.has(t.id),
      );
      const res = await window.glass.hubLibraryPush({
        brokerUrl: resolveEffectiveBroker(brokerUrl, get()),
        playlists: data.playlists,
        tracks,
        likes: data.likes,
        preferences: pickSyncablePreferences(data.preferences),
      });
      writeDirtyFlag(false);
      set({
        pendingSync: false,
        lastCloudSyncAt: Number(res?.updatedAt || Date.now()),
        syncState: 'synced',
      });
    } catch {
      writeDirtyFlag(true);
      set({ pendingSync: true, syncState: 'offline-queued' });
    }
  },

  queueCloudSync: brokerUrl => {
    if (!get().hub.authenticated) return;
    writeDirtyFlag(true);
    set({ pendingSync: true });
    if (cloudSyncDebounceTimer) clearTimeout(cloudSyncDebounceTimer);
    cloudSyncDebounceTimer = setTimeout(() => {
      cloudSyncDebounceTimer = undefined;
      void get().syncLibraryToCloud(brokerUrl);
    }, 1200);
  },

  flushPendingCloudSync: async brokerUrl => {
    if (!get().hub.authenticated) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (get().pendingSync) {
      await get().syncLibraryToCloud(brokerUrl);
    }
    await get().syncLibraryFromCloud(brokerUrl);
  },

  syncAllMultiplatform: async brokerUrl => {
    if (!get().hub.authenticated) {
      throw new Error('Entre na sua conta Liquid Hub para sincronizar entre dispositivos.');
    }
    if (get().pendingSync) {
      await get().syncLibraryToCloud(brokerUrl);
    }
    await get().syncLibraryFromCloud(brokerUrl);
    await get().syncLibraryToCloud(brokerUrl);
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
        plusStatus: defaultFreePlusStatus(false),
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
