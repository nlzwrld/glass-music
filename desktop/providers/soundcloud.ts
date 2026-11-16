import { createHash } from 'node:crypto';
import type { MusicProvider, SearchRequest, Track } from '../../shared/types';
import { trackSchema } from '../../shared/validation';
import { jsonFetch } from './http';
export class SoundCloudProvider implements MusicProvider {
  id = 'soundcloud' as const;
  capabilities = { search: ['track','artist','playlist'] as ('track'|'artist'|'playlist')[], playback: 'official-embed' as const, equalizer: false, background: true, downloads: false };
  constructor(private config: () => { url: string; token: string }) {}
  async search(r: SearchRequest, signal: AbortSignal) {
    if (r.kind === 'album') return { items: [] };
    const config = this.config(); if (!config.url || !config.token) throw new Error('SoundCloud: configure o servidor de acesso em Configurações. Links públicos continuam disponíveis.');
    const result = await jsonFetch(`${config.url}/search?${new URLSearchParams({ q: r.query, kind: r.kind, cursor: r.cursor?.soundcloud || '' })}`, { signal, headers: { Authorization: `Bearer ${config.token}` } });
    return { items: result.items.map((t: unknown) => trackSchema.parse(t)), next: result.next };
  }
  async metadata(url: string, signal: AbortSignal): Promise<Track> {
    const u = new URL(url); if (u.protocol !== 'https:' || !['soundcloud.com','www.soundcloud.com'].includes(u.hostname) || u.pathname.split('/').filter(Boolean).length < 2) throw new Error('Use o link completo de uma faixa ou playlist pública do SoundCloud.');
    u.search = ''; u.hash = ''; const canonical = u.toString();
    const data = await jsonFetch(`https://soundcloud.com/oembed?${new URLSearchParams({ url: canonical, format: 'json' })}`, { signal });
    const id = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    return { id: `soundcloud:${id}`, source: 'soundcloud', sourceId: id, kind: u.pathname.includes('/sets/') ? 'playlist' : 'track', title: data.title || 'SoundCloud', artist: data.author_name || 'SoundCloud', artwork: data.thumbnail_url, duration: 0, url: canonical, addedAt: Date.now() };
  }
  async availability(track: Track, signal: AbortSignal) { try { await this.metadata(track.url!, signal); return { available: true }; } catch (e) { return { available: false, reason: (e as Error).message }; } }
  playback(t: Track) { return { type: 'soundcloud' as const, reference: t.url! }; }
}
