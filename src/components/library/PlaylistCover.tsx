import { useEffect, useState } from 'react';
import type { Playlist } from '../../../shared/types';
import { useApp } from '../../stores/app';
import Cover from '../glass/Cover';

const cache = new Map<string, Promise<string | null>>();

export default function PlaylistCover({ playlist }: { playlist: Playlist }) {
  const tracks = useApp(s => s.data.tracks);
  const allowed = useApp(s => s.data.preferences.onlineConsent);
  const fallback = tracks.find(t => playlist.trackIds.includes(t.id) && t.artwork);
  const [art, setArt] = useState(playlist.artwork || fallback?.artwork || '');

  useEffect(() => {
    if (playlist.artwork) {
      setArt(playlist.artwork);
      return;
    }
    if (fallback?.artwork) {
      setArt(fallback.artwork);
      return;
    }
    setArt('');
    if (!allowed) return;
    const key = playlist.id;
    let active = true;
    if (!cache.has(key)) {
      cache.set(key, window.glass.playlistArtwork(key).catch(() => null));
    }
    void cache.get(key)!.then(url => {
      if (active && url) setArt(url);
    });
    return () => {
      active = false;
    };
  }, [playlist.id, playlist.artwork, fallback?.artwork, allowed]);

  return <Cover track={{ artwork: art, title: playlist.name, source: 'link' }} />;
}
