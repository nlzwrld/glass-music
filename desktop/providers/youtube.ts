import type { MusicProvider, SearchRequest, Track } from '../../shared/types';
import { jsonFetch, durationISO, decodeTitle } from './http';

export class YouTubeProvider implements MusicProvider {
  id = 'youtube' as const;
  capabilities = {
    search: ['track', 'artist', 'playlist'] as ('track' | 'artist' | 'playlist')[],
    playback: 'official-embed' as const,
    equalizer: false,
    background: false,
    downloads: false,
  };
  constructor(private key: () => string) {}

  private get(path: string, params: Record<string, string>, signal: AbortSignal) {
    const key = this.key();
    if (!key) {
      throw new Error(
        'YouTube: configure sua chave de pesquisa em Configurações. Links públicos continuam disponíveis.',
      );
    }
    return jsonFetch(
      `https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`,
      { signal },
    );
  }

  async search(r: SearchRequest, signal: AbortSignal): Promise<{ items: Track[]; next?: string }> {
    if (r.kind === 'album') return { items: [] };
    const type =
      r.kind === 'artist'
        ? 'channel'
        : r.kind === 'playlist'
          ? 'playlist'
          : r.kind === 'all'
            ? 'video,channel,playlist'
            : 'video';
    const params: Record<string, string> = {
      part: 'snippet',
      q: r.query,
      type,
      maxResults: '20',
      relevanceLanguage: 'pt',
    };
    if (type === 'video') params.videoEmbeddable = 'true';
    if (r.cursor?.youtube) params.pageToken = r.cursor.youtube;
    const result = await this.get('search', params, signal);
    const videoIds = result.items.filter((i: any) => i.id.videoId).map((i: any) => i.id.videoId);
    const details = videoIds.length
      ? await this.get('videos', { part: 'contentDetails,status', id: videoIds.join(',') }, signal)
      : { items: [] };
    const items: Track[] = result.items.map((i: any) => {
      const kind = i.id.videoId ? 'track' : i.id.channelId ? 'artist' : 'playlist';
      const id = i.id.videoId || i.id.channelId || i.id.playlistId;
      const d = details.items.find((v: any) => v.id === id);
      const artist = decodeTitle(i.snippet.channelTitle || 'YouTube');
      const duration = durationISO(d?.contentDetails?.duration || '');
      const isTopic = artist.toLowerCase().endsWith(' - topic');
      return {
        id: `youtube:${id}`,
        source: 'youtube',
        sourceId: id,
        kind,
        title: decodeTitle(i.snippet.title),
        artist,
        artwork: i.snippet.thumbnails?.high?.url || i.snippet.thumbnails?.medium?.url,
        duration,
        durationMs: Math.round(duration * 1000),
        catalogSource: isTopic ? 'ytmusic' : 'youtube',
        streamProvider: kind === 'track' ? (isTopic ? 'ytmusic' : 'youtube') : undefined,
        url:
          kind === 'track'
            ? `https://www.youtube.com/watch?v=${id}`
            : kind === 'artist'
              ? `https://www.youtube.com/channel/${id}`
              : `https://www.youtube.com/playlist?list=${id}`,
        available: kind === 'track' ? Boolean(d && d.status?.embeddable !== false) : undefined,
        reason:
          d?.status?.embeddable === false
            ? 'O canal não permite reprodução incorporada.'
            : undefined,
        addedAt: Date.now(),
      };
    });
    return { items, next: result.nextPageToken };
  }

  async metadata(id: string, signal: AbortSignal): Promise<Track> {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Link do YouTube inválido.');
    const url = `https://www.youtube.com/watch?v=${id}`;
    const data = await jsonFetch(
      `https://www.youtube.com/oembed?${new URLSearchParams({ url, format: 'json' })}`,
      { signal },
    );
    const artist = data.author_name || 'YouTube';
    const isTopic = String(artist).toLowerCase().endsWith(' - topic');
    return {
      id: `youtube:${id}`,
      source: 'youtube',
      sourceId: id,
      kind: 'track',
      title: data.title,
      artist,
      artwork: data.thumbnail_url,
      duration: 0,
      durationMs: 0,
      catalogSource: isTopic ? 'ytmusic' : 'youtube',
      streamProvider: isTopic ? 'ytmusic' : 'youtube',
      url,
      addedAt: Date.now(),
    };
  }

  async availability(track: Track, signal: AbortSignal) {
    try {
      await this.metadata(track.sourceId, signal);
      return { available: true };
    } catch (e) {
      return { available: false, reason: (e as Error).message };
    }
  }

  playback(t: Track) {
    return {
      type: (t.streamProvider === 'ytmusic' ? 'ytmusic' : 'youtube') as 'ytmusic' | 'youtube',
      reference: t.resolvedExternalId || t.playbackId || t.sourceId,
    };
  }
}
