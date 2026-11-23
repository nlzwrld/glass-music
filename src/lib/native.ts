import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { JamRealtimeEvent } from '../../shared/jam';
import type {
  DownloadProgressEvent,
  GlassAPI,
  IntegrationStatus,
  MediaCommand,
  Snapshot,
} from '../../shared/types';

let resourceBase = '';
const resourceBaseListeners = new Set<() => void>();
const call = <T>(action: string, payload?: unknown) =>
  invoke<T>('call', { action, payload: payload ?? null });

export function hasResourceBase() {
  return resourceBase.length > 0;
}

export function onResourceBaseReady(listener: () => void) {
  resourceBaseListeners.add(listener);
  return () => {
    resourceBaseListeners.delete(listener);
  };
}

export function nativeResource(path: string) {
  return `${resourceBase}/${path.replace(/^\//, '')}`;
}

export const glass: GlassAPI = {
  offlineSource: id => call('offlineSource', id),
  downloadOffline: track => call('downloadOffline', track),
  removeOffline: id => call('removeOffline', id),
  cancelDownload: id => call('cancelDownload', id),
  offlineSummary: () => call('offlineSummary'),
  onDownloadProgress: callback => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<DownloadProgressEvent>('download-progress', event => callback(event.payload)).then(
      unlisten => {
        if (disposed) unlisten();
        else off = unlisten;
      },
    );
    return () => {
      disposed = true;
      off?.();
    };
  },
  cacheGet: key => call('cacheGet', { key }),
  cacheSet: entry => call('cacheSet', entry),
  openLyrics: () => call('openLyrics'),
  closeLyrics: () => call('closeLyrics'),
  pinLyrics: pinned => call('pinLyrics', { pinned }),
  updateStatus: (install = false) => call('updateStatus', { install }),
  onUpdateProgress: listener => {
    let active = true;
    let off: (() => void) | undefined;
    void listen<{ downloaded: number; total: number; percent: number }>(
      'update-download-progress',
      event => {
        if (active) listener(event.payload);
      },
    ).then(fn => {
      if (active) off = fn;
      else fn();
    });
    return () => {
      active = false;
      off?.();
    };
  },
  maintenanceStatus: (repair = false) => call('maintenanceStatus', { repair }),
  trackArtwork: id => call('trackArtwork', id),
  lyrics: track => call('lyrics', track),
  playlistArtwork: id => call('playlistArtwork', id),
  bootstrap: async () => {
    const data = await call<Snapshot & { _resourceBase: string }>('bootstrap');
    if (data._resourceBase && data._resourceBase !== resourceBase) {
      resourceBase = data._resourceBase;
      resourceBaseListeners.forEach(fn => fn());
    } else {
      resourceBase = data._resourceBase;
    }
    return data;
  },
  library: payload => call('library', payload),
  preferences: payload => call('preferences', payload),
  search: payload => call('search', payload),
  cancelSearch: id => call('cancelSearch', id),
  discover: requestId => call('discover', { requestId }),
  accounts: () => call('accounts'),
  configureAccounts: () => call('configureAccounts'),
  connectAccount: provider => call('connectAccount', provider),
  disconnectAccount: provider => call('disconnectAccount', provider),
  cancelAccount: () => call('cancelAccount'),
  syncAccount: provider => call('syncAccount', provider),
  hubStatus: () => call('hubStatus'),
  hubProviders: brokerUrl => call('hubProviders', { brokerUrl: brokerUrl || '' }),
  hubLogin: payload => call('hubLogin', payload),
  hubOAuthStart: payload => call('hubOAuthStart', payload),
  hubCancelOAuth: () => call('hubCancelOAuth'),
  hubRefresh: brokerUrl => call('hubRefresh', { brokerUrl: brokerUrl || '' }),
  hubLogout: () => call('hubLogout'),
  hubUnlinkIdentity: payload => call('hubUnlinkIdentity', payload),
  hubLinkEmail: payload => call('hubLinkEmail', payload),
  hubVerifyEmail: payload => call('hubVerifyEmail', payload),
  hubResendVerification: payload => call('hubResendVerification', payload || {}),
  hubForgotPassword: payload => call('hubForgotPassword', payload),
  hubResetPassword: payload => call('hubResetPassword', payload),
  hubAcceptTerms: payload => call('hubAcceptTerms', payload),
  hubUpdateProfile: payload => call('hubUpdateProfile', payload),
  hubGetProfile: payload => call('hubGetProfile', payload),
  hubSearchUsers: payload => call('hubSearchUsers', payload),
  hubPublishPlaylist: payload => call('hubPublishPlaylist', payload),
  hubMyPlaylists: payload => call('hubMyPlaylists', payload || {}),
  hubGetSharedPlaylist: payload => call('hubGetSharedPlaylist', payload),
  hubMutateSharedPlaylist: payload => call('hubMutateSharedPlaylist', payload),
  hubInviteCollaborator: payload => call('hubInviteCollaborator', payload),
  hubRespondPlaylistInvite: payload => call('hubRespondPlaylistInvite', payload),
  hubRemoveCollaborator: payload => call('hubRemoveCollaborator', payload),
  hubPlusStatus: payload => call('hubPlusStatus', payload || {}),
  hubVersionPolicy: payload => call('hubVersionPolicy', payload || {}),
  hubLibraryPull: payload => call('hubLibraryPull', payload || {}),
  hubLibraryPush: payload => call('hubLibraryPush', payload),
  importLink: (url, playlist = false) => call('importLink', { url, playlist }),
  previewCollection: url => call('previewCollection', url),
  recommendations: (seeds, excludeIds) => call('recommendations', { seeds, excludeIds }),
  playlistMeta: (id, meta) => call('playlistMeta', { id, ...meta }),
  importAudio: () => call('importAudio'),
  resolveLink: url => call('resolveLink', url),
  linkPlayback: (track, requestId) => call('linkPlayback', { track, requestId }),
  resolveStream: (track, requestId, options) =>
    call('resolveStream', { track, requestId, ...options }),
  streamCandidates: (track, requestId) => call('streamCandidates', { track, requestId }),
  selectStreamCandidate: (track, candidate) =>
    call('selectStreamCandidate', { track, candidate }),
  exportLibrary: id => call('exportLibrary', id),
  importLibrary: () => call('importLibrary'),
  integrations: async () => {
    const data = await call<IntegrationStatus>('integrations');
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    data.gpu = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return data;
  },
  credentials: payload => call('credentials', payload),
  external: url => call('external', url),
  playerUrl: () => call('playerUrl'),
  audioSource: (videoId, requestId, fallback) =>
    call('audioSource', { videoId, requestId, ...fallback }),
  window: action => call('window', action),
  clearCache: () => call('clearCache'),
  checkUpdates: () => call('checkUpdates'),
  updateMediaMetadata: track => call('mediaMetadata', track),
  notify: track =>
    call('notify', {
      tag: 'liquid-hub-now-playing',
      renotify: false,
      silent: true,
      windowFocused:
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        document.hasFocus(),
      ...track,
    }),
  visualState: () => call('visualState'),
  windowShape: () => call('windowShape'),
  onVisualVisibility: callback => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<boolean>('glass-visual-visible', event => callback(event.payload)).then(unlisten => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  },
  onWindowMaximized: callback => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<boolean>('glass-window-maximized', event => callback(Boolean(event.payload))).then(
      unlisten => {
        if (disposed) unlisten();
        else off = unlisten;
      },
    );
    return () => {
      disposed = true;
      off?.();
    };
  },
  onMedia: callback => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<MediaCommand>('media', event => callback(event.payload)).then(unlisten => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  },
  consumeDeepLink: () => call<string | null>('consumeDeepLink'),
  dispatchDeepLink: url => call<boolean>('dispatchDeepLink', url),
  onDeepLink: callback => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<string>('deep-link', event => callback(event.payload)).then(unlisten => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  },
  onJamEvent: callback => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<JamRealtimeEvent>('jam-event', event => callback(event.payload)).then(unlisten => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  },
};

if (typeof window !== 'undefined') window.glass = glass;
