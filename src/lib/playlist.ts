import type { Track } from '../../shared/types';
import { useApp } from '../stores/app';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const playlistReorderLocks = new Map<string, Promise<void>>();

export function reorderTrackIds(ids: string[], fromId: string, toId: string): string[] | null {
  if (!fromId || !toId || fromId === toId) return null;
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

export function syncActiveQueueOrder(
  queue: Track[],
  currentIndex: number,
  orderedIds: string[],
  shufflePlayed: number[],
  shuffleNext: number | null,
): {
  queue: Track[];
  index: number;
  shufflePlayed: number[];
  shuffleNext: number | null;
} | null {
  if (!queue.length || queue.length !== orderedIds.length) return null;
  const byId = new Map<string, Track>();
  for (const track of queue) {
    if (byId.has(track.id)) return null;
    byId.set(track.id, track);
  }
  const uniqueTarget = new Set(orderedIds);
  if (uniqueTarget.size !== orderedIds.length) return null;

  const nextQueue: Track[] = [];
  const nextIndexById = new Map<string, number>();
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]!;
    const track = byId.get(id);
    if (!track) return null;
    nextQueue.push(track);
    nextIndexById.set(id, i);
  }

  const activeId =
    currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex]?.id : undefined;
  const index =
    activeId !== undefined ? (nextIndexById.get(activeId) ?? currentIndex) : currentIndex;

  const remappedPlayed = shufflePlayed
    .map(oldIdx => queue[oldIdx]?.id)
    .filter((id): id is string => Boolean(id))
    .map(id => nextIndexById.get(id))
    .filter((idx): idx is number => idx !== undefined);

  const nextTrackId =
    shuffleNext !== null && shuffleNext >= 0 && shuffleNext < queue.length
      ? queue[shuffleNext]?.id
      : undefined;
  const remappedNext =
    nextTrackId !== undefined ? (nextIndexById.get(nextTrackId) ?? null) : null;

  return {
    queue: nextQueue,
    index,
    shufflePlayed: remappedPlayed,
    shuffleNext: remappedNext,
  };
}

export function parseLiquidHubLink(
  raw: string,
): { kind: 'profile'; handle: string } | { kind: 'playlist'; shareId: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (lower.includes('..') || lower.includes('%2e') || trimmed.includes('\\')) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;

  if (parsed.protocol === 'liquidhub:') {
    const host = parsed.hostname.toLowerCase();
    const segs = parsed.pathname.split('/').filter(Boolean);
    if (host === 'profile' && segs.length === 1) {
      let handle = '';
      try {
        handle = decodeURIComponent(segs[0]!).trim().toLowerCase();
      } catch {
        return null;
      }
      if (!handle.includes('..') && HANDLE_PATTERN.test(handle)) {
        return { kind: 'profile', handle };
      }
    }
    if (host === 'playlist' && segs.length === 1) {
      let shareId = '';
      try {
        shareId = decodeURIComponent(segs[0]!).trim();
      } catch {
        return null;
      }
      if (SHARE_ID_PATTERN.test(shareId)) {
        return { kind: 'playlist', shareId };
      }
    }
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isLocalHttp = parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost');
  if (parsed.protocol === 'https:' || isLocalHttp) {
    const segs = parsed.pathname.split('/').filter(Boolean);
    if (segs.length === 2 && segs[0] === 'u') {
      let handle = '';
      try {
        handle = decodeURIComponent(segs[1]!).trim().toLowerCase();
      } catch {
        return null;
      }
      if (!handle.includes('..') && HANDLE_PATTERN.test(handle)) {
        return { kind: 'profile', handle };
      }
    }
    if (segs.length === 2 && segs[0] === 'p') {
      let shareId = '';
      try {
        shareId = decodeURIComponent(segs[1]!).trim();
      } catch {
        return null;
      }
      if (SHARE_ID_PATTERN.test(shareId)) {
        return { kind: 'playlist', shareId };
      }
    }
  }
  return null;
}

export function moveWithinPlaylist(
  playlistId: string,
  trackId: string,
  targetId: string,
): Promise<void> {
  const prev = playlistReorderLocks.get(playlistId) ?? Promise.resolve();
  const nextLock = prev
    .catch(() => {})
    .then(async () => {
      const st = useApp.getState();
      const playlist = st.data.playlists.find(p => p.id === playlistId);
      if (!playlist) return;
      const nextIds = reorderTrackIds(playlist.trackIds, trackId, targetId);
      if (!nextIds) return;

      await st.mutate({ action: 'reorder', id: playlistId, trackIds: nextIds });

      const after = useApp.getState();
      const synced = syncActiveQueueOrder(
        after.queue,
        after.index,
        nextIds,
        after.shufflePlayed,
        after.shuffleNext,
      );
      if (synced) {
        useApp.setState(synced);
      }

      const { useAccounts, resolveEffectiveBroker } = await import('../stores/accounts');
      const acct = useAccounts.getState();
      if (acct.hub.authenticated) {
        void acct.syncLibraryToCloud();
      }

      if (
        playlist.shareId &&
        acct.hub.authenticated &&
        typeof window !== 'undefined' &&
        window.glass?.hubMutateSharedPlaylist
      ) {
        const brokerUrl = resolveEffectiveBroker(undefined, acct);
        try {
          const updated = await window.glass.hubMutateSharedPlaylist({
            brokerUrl,
            shareId: playlist.shareId,
            op: 'reorder',
            expectedVersion: playlist.remoteVersion || 1,
            trackIds: nextIds,
          });
          if (window.glass.playlistMeta) {
            const snap = await window.glass.playlistMeta(playlistId, {
              remoteVersion: updated.version,
            });
            useApp.setState(curr => ({
              data: { ...snap, preferences: curr.data.preferences },
            }));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/version_conflict|foi modificada/i.test(msg) && window.glass.hubGetSharedPlaylist) {
            try {
              const latest = await window.glass.hubGetSharedPlaylist({
                brokerUrl,
                shareId: playlist.shareId,
              });
              const latestIds = latest.tracks.map(t => t.id);
              const localIds = new Set(useApp.getState().data.tracks.map(t => t.id));
              if (
                latestIds.length === playlist.trackIds.length &&
                latestIds.every(id => localIds.has(id))
              ) {
                await useApp.getState().mutate({
                  action: 'reorder',
                  id: playlistId,
                  trackIds: latestIds,
                });
                const syncedRemote = syncActiveQueueOrder(
                  useApp.getState().queue,
                  useApp.getState().index,
                  latestIds,
                  useApp.getState().shufflePlayed,
                  useApp.getState().shuffleNext,
                );
                if (syncedRemote) {
                  useApp.setState(syncedRemote);
                }
              }
              if (window.glass.playlistMeta) {
                const snap = await window.glass.playlistMeta(playlistId, {
                  remoteVersion: latest.version,
                });
                useApp.setState(curr => ({
                  data: { ...snap, preferences: curr.data.preferences },
                }));
              }
              useApp
                .getState()
                .message('A playlist compartilhada foi atualizada remotamente. Versão sincronizada.');
            } catch {
              useApp
                .getState()
                .message('Conflito de edição na playlist compartilhada. Recarregue para sincronizar.');
            }
          }
        }
      }
    })
    .finally(() => {
      if (playlistReorderLocks.get(playlistId) === nextLock) {
        playlistReorderLocks.delete(playlistId);
      }
    });
  playlistReorderLocks.set(playlistId, nextLock);
  return nextLock;
}

export type MusicLinkProviderId =
  | 'spotify'
  | 'ytmusic'
  | 'youtube'
  | 'soundcloud'
  | 'deezer'
  | 'apple'
  | 'bandcamp'
  | 'tidal';

export type LinkEntityKind = 'track' | 'album' | 'playlist' | 'artist';

export interface LinkProviderDescriptor {
  id: MusicLinkProviderId;
  label: string;
  supportsCollections: boolean;
  match: (url: URL) => boolean;
  detectKind: (url: URL, preferCollection?: boolean) => LinkEntityKind | null;
}

export interface MusicLinkInspection {
  valid: boolean;
  supported: boolean;
  provider: LinkProviderDescriptor | null;
  kind: LinkEntityKind | null;
  canonicalInput: string;
  reason?: string;
}

function isBandcampHost(host: string): boolean {
  if (!host.endsWith('.bandcamp.com') || host.length <= '.bandcamp.com'.length) {
    return false;
  }
  const sub = host.slice(0, host.length - '.bandcamp.com'.length);
  return /^[a-z0-9-]+$/i.test(sub);
}

function isIpv4OrIpv6Host(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function isPublicHttpsUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !host.includes('.') ||
      isIpv4OrIpv6Host(host) ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal')
    ) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

export function normalizeMusicLinkInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }
  const spotifyUri = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})$/.exec(
    trimmed,
  );
  if (spotifyUri) {
    return `https://open.spotify.com/${spotifyUri[1]}/${spotifyUri[2]}`;
  }
  const url = isPublicHttpsUrl(trimmed);
  return url ? url.toString() : null;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

export const LINK_PROVIDERS: LinkProviderDescriptor[] = [
  {
    id: 'spotify',
    label: 'Spotify',
    supportsCollections: true,
    match: url => url.hostname.toLowerCase() === 'open.spotify.com',
    detectKind: (url, preferCollection) => {
      const segs = pathSegments(url);
      const allowed = preferCollection
        ? ['playlist', 'album', 'artist']
        : ['track', 'album', 'playlist', 'artist'];
      const idx = segs.findIndex(s => allowed.includes(s));
      if (idx < 0) return null;
      const id = segs[idx + 1] || '';
      if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
      return segs[idx] as LinkEntityKind;
    },
  },
  {
    id: 'ytmusic',
    label: 'YT Music',
    supportsCollections: true,
    match: url => url.hostname.toLowerCase() === 'music.youtube.com',
    detectKind: (url, preferCollection) => {
      const list = url.searchParams.get('list');
      const hasList = Boolean(list && /^[A-Za-z0-9_-]{5,150}$/.test(list));
      if (preferCollection) return hasList ? 'playlist' : null;
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return 'track';
      return hasList ? 'playlist' : null;
    },
  },
  {
    id: 'youtube',
    label: 'YouTube',
    supportsCollections: true,
    match: url => {
      const h = url.hostname.toLowerCase();
      return (
        h === 'youtube.com' ||
        h === 'www.youtube.com' ||
        h === 'm.youtube.com' ||
        h === 'youtu.be'
      );
    },
    detectKind: (url, preferCollection) => {
      const list = url.searchParams.get('list');
      const hasList = Boolean(list && /^[A-Za-z0-9_-]{5,150}$/.test(list));
      if (preferCollection) return hasList ? 'playlist' : null;
      const h = url.hostname.toLowerCase();
      const segs = pathSegments(url);
      const videoId =
        h === 'youtu.be'
          ? segs[0] || ''
          : url.pathname === '/watch'
            ? url.searchParams.get('v') || ''
            : ['shorts', 'live', 'embed'].includes(segs[0] || '')
              ? segs[1] || ''
              : '';
      if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) return 'track';
      return hasList ? 'playlist' : null;
    },
  },
  {
    id: 'soundcloud',
    label: 'SoundCloud',
    supportsCollections: true,
    match: url => {
      const h = url.hostname.toLowerCase();
      return h === 'soundcloud.com' || h === 'www.soundcloud.com' || h === 'm.soundcloud.com';
    },
    detectKind: (url, preferCollection) => {
      const segs = pathSegments(url);
      if (segs.length === 3 && segs[1] === 'sets') return 'playlist';
      if (preferCollection) return null;
      return segs.length >= 2 ? 'track' : null;
    },
  },
  {
    id: 'deezer',
    label: 'Deezer',
    supportsCollections: true,
    match: url => {
      const h = url.hostname.toLowerCase();
      return h === 'deezer.com' || h === 'www.deezer.com' || h === 'm.deezer.com';
    },
    detectKind: (url, preferCollection) => {
      const segs = pathSegments(url);
      const allowed = preferCollection
        ? ['playlist', 'album', 'artist']
        : ['track', 'album', 'playlist', 'artist'];
      const idx = segs.findIndex(s => allowed.includes(s));
      if (idx < 0) return null;
      const id = segs[idx + 1] || '';
      if (!/^\d{1,25}$/.test(id)) return null;
      return segs[idx] as LinkEntityKind;
    },
  },
  {
    id: 'apple',
    label: 'Apple Music',
    supportsCollections: true,
    match: url => {
      const h = url.hostname.toLowerCase();
      return h === 'music.apple.com' || h === 'itunes.apple.com';
    },
    detectKind: (url, preferCollection) => {
      const segs = pathSegments(url);
      const idx = segs.findIndex(s => ['album', 'artist', 'song'].includes(s));
      if (idx < 0) return null;
      const rawKind = segs[idx];
      if (rawKind === 'album' && url.searchParams.get('i')) {
        return preferCollection ? 'album' : 'track';
      }
      if (preferCollection && !['album', 'artist'].includes(rawKind)) return null;
      if (rawKind === 'artist') return 'artist';
      if (rawKind === 'album') return 'album';
      return 'track';
    },
  },
  {
    id: 'bandcamp',
    label: 'Bandcamp',
    supportsCollections: true,
    match: url => isBandcampHost(url.hostname.toLowerCase()),
    detectKind: (url, preferCollection) => {
      const segs = pathSegments(url);
      if (segs.length !== 2 || !['track', 'album'].includes(segs[0])) return null;
      if (preferCollection && segs[0] !== 'album') return null;
      return segs[0] as LinkEntityKind;
    },
  },
  {
    id: 'tidal',
    label: 'Tidal',
    supportsCollections: false,
    match: url => {
      const h = url.hostname.toLowerCase();
      return h === 'tidal.com' || h === 'www.tidal.com' || h === 'listen.tidal.com';
    },
    detectKind: (url, preferCollection) => {
      if (preferCollection) return null;
      const segs = pathSegments(url).filter(s => s !== 'browse');
      const idx = segs.findIndex(s => ['track', 'album', 'playlist'].includes(s));
      if (idx < 0) return null;
      const id = segs[idx + 1] || '';
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
      return segs[idx] as LinkEntityKind;
    },
  },
];

const customLinkProviders: LinkProviderDescriptor[] = [];

export function registerLinkProvider(descriptor: LinkProviderDescriptor): void {
  const existing = customLinkProviders.findIndex(p => p.id === descriptor.id);
  if (existing >= 0) {
    customLinkProviders[existing] = descriptor;
  } else {
    customLinkProviders.push(descriptor);
  }
}

export function allLinkProviders(): LinkProviderDescriptor[] {
  return [...LINK_PROVIDERS, ...customLinkProviders];
}

export function inspectMusicLink(
  raw: string,
  preferCollection = false,
): MusicLinkInspection {
  const canonicalInput = normalizeMusicLinkInput(raw);
  if (!canonicalInput) {
    return {
      valid: false,
      supported: false,
      provider: null,
      kind: null,
      canonicalInput: '',
      reason: 'Use um link público HTTPS de música ou URI spotify:track:…',
    };
  }
  const url = new URL(canonicalInput);
  for (const provider of allLinkProviders()) {
    if (!provider.match(url)) continue;
    const kind = provider.detectKind(url, preferCollection);
    if (!kind) {
      return {
        valid: true,
        supported: false,
        provider,
        kind: null,
        canonicalInput,
        reason: preferCollection && !provider.supportsCollections
          ? `Importação de coleção completa do ${provider.label} ainda não é suportada.`
          : `Link do ${provider.label} incompleto ou incompatível.`,
      };
    }
    return {
      valid: true,
      supported: true,
      provider,
      kind,
      canonicalInput,
    };
  }
  return {
    valid: true,
    supported: false,
    provider: null,
    kind: preferCollection ? null : 'track',
    canonicalInput,
    reason: preferCollection
      ? 'Use um link de playlist ou álbum de uma plataforma suportada.'
      : undefined,
  };
}
