import { useEffect, useState } from 'react';
import type { Playlist } from '../../../shared/types';
import { useApp } from '../../stores/app';
import Cover, { coverURL } from '../glass/Cover';

const cache = new Map<string, Promise<string | null>>();

export default function PlaylistCover({ playlist }: { playlist: Playlist }) {
  const tracks = useApp(s => s.data.tracks),
    allowed = useApp(s => s.data.preferences.onlineConsent);

  const distinctCovers = Array.from(
    new Set(
      playlist.trackIds
        .map(id => tracks.find(t => t.id === id)?.artwork)
        .filter((u): u is string => !!u),
    ),
  ).slice(0, 4);

  const hasCustom = !!playlist.artwork && playlist.artwork.startsWith('data:image/');
  const fallback = distinctCovers[0] || '';
  const [art, setArt] = useState(playlist.artwork || fallback);

  useEffect(() => {
    if (playlist.artwork) {
      setArt(playlist.artwork);
      return;
    }
    if (fallback) {
      setArt(fallback);
      return;
    }
    if (!allowed) return;
    const key = playlist.id;
    let active = true;
    if (!cache.has(key)) cache.set(key, window.glass.playlistArtwork(key).catch(() => null));
    void cache.get(key)!.then(url => {
      if (active && url) setArt(url);
    });
    return () => {
      active = false;
    };
  }, [playlist.id, playlist.artwork, fallback, allowed]);

  if (!hasCustom && distinctCovers.length >= 4) {
    return (
      <div className="cover playlist-mosaic" aria-label={`Capa de ${playlist.name}`}>
        {distinctCovers.map((u, i) => (
          <img
            key={`${u}-${i}`}
            src={coverURL({ artwork: u })}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ))}
      </div>
    );
  }

  return <Cover track={{ artwork: art, title: playlist.name, source: 'link' }} />;
}
