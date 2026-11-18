import type { MusicProvider, SearchRequest, SearchResult, StreamResolution, Track } from '../../shared/types';
import { trackSchema } from '../../shared/validation';
import {
  adaptMusicProviderToStreamSource,
  CrossPlatformResolver,
  importSpotifyMetadata,
  type StreamMappingStore,
} from './resolver';

const PROVIDER_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  ytmusic: 'YT Music',
  soundcloud: 'SoundCloud',
  deezer: 'Deezer',
};

export class SearchService {
  private cache = new Map<string, { time: number; value: SearchResult }>();
  private active = new Map<string, AbortController>();
  readonly resolver: CrossPlatformResolver;

  constructor(
    private providers: MusicProvider[],
    mappingStore?: StreamMappingStore,
  ) {
    this.resolver = new CrossPlatformResolver(
      providers
        .filter(p => p.id !== 'local')
        .map(p => adaptMusicProviderToStreamSource(p)),
      mappingStore,
    );
  }

  clear() {
    this.cache.clear();
    this.active.forEach(c => c.abort());
    this.active.clear();
  }

  cancel(id: string) {
    this.active.get(id)?.abort();
    this.active.delete(id);
  }

  /**
   * Imports a Spotify track/playlist/album keeping all Spotify metadata (`catalogSource: 'spotify'`)
   * and optionally pre-resolves the first playable stream across YT Music / Deezer / SoundCloud / YouTube.
   */
  async importSpotify(
    spotifyUrl: string,
    options: { request?: typeof fetch; resolveFirstStream?: boolean } = {},
  ): Promise<{
    kind: 'track' | 'playlist' | 'album';
    name: string;
    artwork?: string;
    tracks: Track[];
    firstResolution?: StreamResolution;
  }> {
    const imported = await importSpotifyMetadata(spotifyUrl, options.request);
    let firstResolution: StreamResolution | undefined;
    if (options.resolveFirstStream !== false && imported.tracks.length > 0) {
      firstResolution = await this.resolver.resolveStream(imported.tracks[0]!);
      imported.tracks[0] = firstResolution.track;
    }
    return { ...imported, firstResolution };
  }

  async search(r: SearchRequest): Promise<SearchResult> {
    // Intercept direct Spotify links pasted into search: never try direct Spotify audio extraction!
    if (/^https:\/\/open\.spotify\.com\/(track|playlist|album)\/[A-Za-z0-9]{22}/.test(r.query.trim())) {
      const imported = await importSpotifyMetadata(r.query.trim());
      return { items: imported.tracks, next: {}, notices: [] };
    }

    const key = JSON.stringify([r.query.toLowerCase(), r.kind, r.source, r.cursor]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < 300000) return cached.value;

    const controller = new AbortController();
    this.active.set(r.requestId, controller);
    try {
      const selected = this.providers.filter(p => r.source === 'all' || p.id === r.source);
      const results = await Promise.allSettled(selected.map(p => p.search(r, controller.signal)));
      if (controller.signal.aborted) throw new Error('Pesquisa cancelada.');

      const value: SearchResult = { items: [], next: {}, notices: [] };
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          const valid = result.value.items.flatMap(item => {
            const parsed = trackSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          });
          value.items.push(...valid);
          if (result.value.next) value.next[selected[i].id] = result.value.next;
        } else {
          const label = PROVIDER_LABELS[selected[i].id] || selected[i].id;
          value.notices.push(`${label}: ${result.reason.message}`);
        }
      });

      value.items.sort((a, b) => {
        const flat = results.flatMap(x => (x.status === 'fulfilled' ? x.value.items : []));
        const ai = flat.findIndex(x => x.id === a.id);
        const bi = flat.findIndex(x => x.id === b.id);
        return (ai % 20) - (bi % 20);
      });
      value.items = [...new Map(value.items.map(t => [t.id, t])).values()];

      if (!value.notices.length) {
        if (this.cache.size >= 80) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { time: Date.now(), value });
      }
      return value;
    } finally {
      this.active.delete(r.requestId);
    }
  }
}
